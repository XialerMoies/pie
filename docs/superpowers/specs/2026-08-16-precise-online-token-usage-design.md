# 精准在线 Token 使用量设计

## 目标

让用户清楚看到当前上下文窗口占用的可信程度：模型回复过程中显示“最近一次服务商精确值 + 当前尾部估算”，回复结束并拿到服务商 usage 后自动替换为精确值。

本批不引入 DeepSeek V3 tokenizer，不增加额外的 token 计数网络请求，也不改变累计费用与缓存命中率的统计口径。

## 已确认语义

- 当前上下文占用和累计 Token 用量是两类数据，不能混为一谈。
- 服务商在已完成 assistant 消息中返回的 usage 是在线精确基线。
- 精确基线之后新增的 user、assistant、tool 等上下文消息暂用 PI 的现有估算器计算。
- 流式回复期间显示“含估算”；最终 usage 到达后自动显示“精确”。
- 尚无任何有效服务商 usage 时，整个上下文显示“估算”。
- `aborted`、`error` 或 token 总数无效的 assistant usage 不得作为精确基线。

## 方案比较

### 方案 A：修改 PI fork 的 `getContextUsage()`

优点是所有 PI 消费方都能拿到来源信息。缺点是扩大 fork 补丁面，增加以后同步上游的成本，而且桌面端展示语义不属于 PI 核心必须承担的职责。

### 方案 B：项目侧重新实现全部上下文计数

优点是完全自主。缺点是会复制 PI 的 compaction、消息可见性和 usage 有效性规则，容易与实际发送给模型的上下文发生偏差。

### 方案 C：项目侧组合 PI 的公开计数原语和消息状态（采用）

在 `my-code-agent` 增加纯计算适配层，复用 PI 包根在运行时确实导出的 `calculateContextTokens()` 和 `estimateTokens()`，只在项目侧扫描最后一个有效 assistant usage，并补充来源分类和 API 展示字段。这样不改 fork、不复制 tokenizer 逻辑，并为未来 `AgentEngine` 适配边界积累稳定接口。

PI `0.84.2` 内部虽然实现了 `estimateContextTokens()`，但包根运行时没有导出它；直接依赖内部路径会绕过 package exports，升级时很脆弱，因此不采用。

## 数据模型

新增项目侧类型：

```ts
type ContextUsageSource = "exact" | "mixed" | "estimated";

interface ContextUsageSnapshot {
  tokens: number | null;
  contextWindow: number;
  percent: number | null;
  source: ContextUsageSource;
  exactTokens: number;
  estimatedTokens: number;
}
```

字段含义：

- `tokens`：当前上下文占用总量，保持现有 API 字段兼容。
- `contextWindow`、`percent`：保持现有含义。
- `source`：前端展示精度状态。
- `exactTokens`：最后一个有效 provider usage 提供的上下文 token 基线。
- `estimatedTokens`：该基线之后消息的估算增量；没有有效基线时等于全部估算量。

来源判定：

| 条件 | source |
| --- | --- |
| 有有效 usage，且其后没有上下文消息 | `exact` |
| 有有效 usage，且其后有需要估算的上下文消息 | `mixed` |
| 没有有效 usage，但存在可估算上下文 | `estimated` |

没有模型或上下文窗口无效时，沿用 `contextUsage: null`，不伪造数值。

## 计算边界

新增 `src/agent/context-usage.ts`，只负责将当前 session 转成 `ContextUsageSnapshot`。它不读取磁盘、不发网络请求、不维护全局状态。

计算步骤：

1. 读取当前模型的 `contextWindow`。
2. 从后向前扫描 `session.messages`，跳过 `aborted`、`error` 和 token 总数为零的 assistant 消息；使用 PI `calculateContextTokens()` 读取最后一个有效 usage。
3. 使用 PI `estimateTokens()` 计算有效 usage 之后的消息；若没有有效 usage，则估算全部当前消息。
4. 按上表生成 `source`、`exactTokens` 和 `estimatedTokens`，并使用总量计算百分比。
5. 读取 PI `getContextUsage()` 作为 compaction 信任边界。若它因“最新 compaction 后尚无有效 usage”返回 `tokens: null`，仍可估算 `session.messages` 的当前可见上下文，但必须强制标为 `estimated`，且 `exactTokens` 为 0；不得把保留下来的压缩前 assistant usage 标为精确。

`AgentRuntime` 暴露 `getContextUsageSnapshot()`，路由不再直接理解 PI session 的 usage 细节。以后更换 Agent 引擎时，只需由适配器实现相同快照接口。

## API 与前端

`GET /api/usage/current` 和兼容接口 `GET /api/token-usage` 的 `contextUsage` 增加：

```json
{
  "tokens": 12500,
  "contextWindow": 128000,
  "percent": 9.765625,
  "source": "mixed",
  "exactTokens": 12000,
  "estimatedTokens": 500
}
```

旧字段保持不变，已有消费者无需立即适配新字段。

Token Rail 在百分比旁显示短标签：

- `exact`：`精确`
- `mixed`：`含估算`
- `estimated`：`估算`

Usage 当前会话面板显示相同标签，并将原“Token 用量”标题改为“累计计费用量”，明确 input、output、cacheRead、cacheWrite 和 cost 是已完成请求的累计 provider usage，不包含当前尾部估算。

不新增弹窗、不新增设置项，也不在 Rail 展开精确/估算拆分明细；详细的 `exactTokens` 和 `estimatedTokens` 保留在 API 中，便于后续诊断。

## 流式更新

继续使用现有 `usage.changed` 应用事件，不引入轮询。

- `agent_start` 立即发布一次，显示用户新消息带来的 mixed/estimated 状态。
- `message_update` 期间采用时间戳门控，每 500ms 最多发布一次，更新流式 assistant 尾部估算；不创建延迟计时器。
- `agent_end` 不直接宣称精确；沿用现有 `waitForIdle()` 边界，在 PI 完成消息和 usage 落位后发布最终事件。
- `agent_end` 后没有待触发的流式计时器，因此不会出现旧的 mixed 事件晚于 exact 状态到达。
- session 切换后，现有 source-session 校验继续拒绝旧 session 的延迟事件。
- compaction start/end 继续发布 usage 变化，并重新计算来源；压缩后尚无有效 provider usage 时不得显示 `exact`。

节流只减少事件数量，不缓存 Token 数值。每次 API 请求都从当前 session 重新计算，避免快照过期。

## 错误处理

- 计算异常时 API 保持现有 fail-soft 行为，返回 `contextUsage: null`，不影响累计用量和页面其他区域。
- 未识别的 `source` 在前端按 `估算` 处理，避免误标为精确。
- 旧服务端没有新字段时，前端按当前兼容行为显示数值但不显示“精确”标签。
- 精度标签只描述上下文占用来源，不描述账单数据是否最终结算。

## 测试

### 纯计算

- 有有效 usage、无尾部消息时返回 `exact`。
- 有有效 usage和尾部 user/tool/assistant 内容时返回 `mixed`，拆分 exact/estimated 数量。
- 首次回复完成前无有效 usage 时返回 `estimated`。
- `aborted`、`error` 和零 usage 不作为精确基线。
- compaction 后旧 usage 不得产生 `exact`。
- SDK 合约测试锁定 `calculateContextTokens` 和 `estimateTokens` 是包根运行时导出，防止只看声明文件造成假兼容。

### 服务端与事件

- 两个 usage API 保留旧字段并增加 provenance 字段。
- 流式 `message_update` 发布受 500ms 节流约束。
- `waitForIdle()` 后最终事件能读取到精确 usage。
- 最终事件和 session 切换不发生延迟发布或跨 session 污染。

### 前端

- Rail 和当前会话面板正确显示 `精确`、`含估算`、`估算`。
- 累计区域标题明确为“累计计费用量”。
- 仍只通过 `usage.changed`/`resync` 刷新，不恢复定时轮询。
- 缺少 provenance 字段时保持兼容且不误标精确。

### 验收

手工发送一条能持续数秒的回复：开始后 Rail 应显示“含估算”或“估算”，数值随回复阶段更新；结束后自动变为“精确”。随后执行一次 compaction，确认压缩期间状态正常，压缩后的未知值不会被标成精确。

## 不在本批范围

- DeepSeek V3 或其他离线 tokenizer。
- 调用厂商独立 countTokens API。
- 修改 PI fork 的公共 API。
- 调整计费金额、缓存命中率和全部会话汇总算法。
- 自定义第三方厂商设置页。
