---
name: token-rail-usage-compact-plan
description: Token Rail 常驻 + Usage 抽屉面板 + Compact 闭环 — 完整实施计划
metadata:
  type: project
  originSessionId: 4aee0aa4-70ff-4943-966c-a58f781c65ce
---

# Token Rail + Usage 面板 + Compact 实施计划

**原则**：组件挂主区域，数据跟随当前活跃会话，全部会话只做累计统计，不做上下文百分比。

---

## 一、总体架构

### 组件归属

| 组件 | 位置 | 数据源 |
|------|------|--------|
| Token Rail | 主区域标签栏 `.main-tabs` 右侧，常驻 | `/api/usage/current` 轮询 |
| Usage 面板 | 居中模态浮层（复用 `modal-overlay`），从 Rail 点击展开 | `/api/usage/current` + `/api/usage/summary` |
| Compact 弹窗 | 模态浮层内嵌（从 Usage 面板或 Rail 触发） | `POST /api/compact` |

### 数据归属规则

- 当前 session/chat tab 激活 → 显示当前会话数据
- 文件 tab / 空白页 → 显示"未选择会话"或总览简版，Compact 按钮禁用
- Compact 只作用于当前活跃 chat/session

### 长期记录

基于 session JSONL 统计，做轻量索引文件 `data/pi/usage-index.json`，不做每 6 秒全量扫描。

---

## 二、UI 组件设计

### 2.1 Token Rail（折叠态）

主区域标签栏右侧，常驻狭长矩形。

**显示**：
- 上下文占用：`42%`
- 缓存命中率：`78%`
- Compact 按钮：图标或短文案"压缩"
- 状态色：正常 / 接近上限(70%) / 警戒(85%) / 正在压缩 / 无会话

**交互**：
- 点击矩形主体 → 展开 Usage 面板
- 点击 Compact → 打开 focus 弹窗
- 文件 tab/空白页 → Compact 禁用，tooltip"打开会话后可压缩"

**HTML 示意**：
```html
<div class="tr-rail" title="点击查看详情">
  <span class="tr-pct">42%</span>
  <span class="tr-cr">78%</span>
  <button class="tr-compact">压缩</button>
</div>
```

### 2.2 Usage 面板（展开态）

居中偏上模态浮层，宽 520–680px。

**Tab 切换**：
- `当前会话` — 当前 session/runtime 实时数据
- `全部会话` — 累计统计 + 排行

**当前会话页**：

```
┌─────────────────────────────────────────────┐
│  上下文窗口       缓存命中率       费用       │
│  120K / 1M (12%)  80%             $0.12     │
│                                              │
│  输入 token      输出 token      命中/write  │
│  10,000          3,000          8,000/2,000  │
│                                              │
│  Compact 次数: 2                              │
│  最近一次 Compact: 2026-07-20 14:30           │
│  摘要: [当前 bug、已修改文件、后续计划...]      │
│                                              │
│  ┌──────────────────────────────────┐        │
│  │        开始压缩                  │        │
│  └──────────────────────────────────┘        │
└─────────────────────────────────────────────┘
```

**全部会话页**：

```
┌─────────────────────────────────────────────┐
│  会话数: 42                                   │
│  总输入 token    总输出 token   总命中 token  │
│  500,000         120,000       300,000        │
│  总费用: $4.80                                │
│  总 Compact 次数: 12                           │
│  最近活跃会话: pay 项目 · 2026-07-20           │
│                                              │
│  Token 最高会话排行                            │
│  1. pay/xxx   120K tokens                    │
│  2. pay/yyy   80K tokens                     │
└─────────────────────────────────────────────┘
```

注意：全部会话页面**不显示**"上下文窗口占用百分比"。

### 2.3 Compact 弹窗

```
┌─────────────────────────────────┐
│  压缩上下文                       │
│                                  │
│  会把较早对话摘要为上下文摘要，    │
│  最近消息会保留。                │
│                                  │
│  摘要重点（可选）:                │
│  ┌───────────────────────────┐  │
│  │ 例如：当前 bug、已修改     │  │
│  │ 文件、后续计划、关键决策   │  │
│  └───────────────────────────┘  │
│                                  │
│         [取消]  [开始压缩]        │
└─────────────────────────────────┘
```

状态规则：
- `isStreaming === true` → 提示"请等待当前回复完成"
- `isCompacting === true` → 按钮 loading，不允许重复点击
- session 太小（< 2 轮对话）→ "当前会话还不需要压缩"
- 成功 → toast + 刷新 Usage + 刷新消息列表
- 失败 → 显示 SDK error message

---

## 三、后端 API

### 3.1 `GET /api/usage/current`

返回当前 runtime 数据。

```typescript
// Response
{
  sessionId: string;
  hasActiveSession: boolean;
  contextUsage: {
    tokens: number;          // 当前已用 tokens（estimateContextTokens）
    contextWindow: number;   // model.contextWindow
    percent: number;         // Math.round(tokens / contextWindow * 100)
  };
  tokens: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
  };
  cacheHitRate: number;      // cacheRead / (cacheRead + cacheWrite) * 100
  cost: number;              // 估算费用
  compactCount: number;      // 从 session entries 统计
  lastCompactionAt: string | null;
  lastCompactionSummary: string | null;
  isStreaming: boolean;
  isCompacting: boolean;     // session.isCompacting
}
```

数据来源：复用当前 `/api/token-usage` 的 `session.usage` + `session.model`，新增 `session.isCompacting` 和从 session entries 统计 compact 次数。

### 3.2 `GET /api/usage/summary`

返回全部会话累计数据。

```typescript
// Response
{
  sessions: number;          // 总会话数
  tokens: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
  };
  cost: number;
  compactCount: number;
  topSessions: Array<{
    id: string;
    name: string;
    workspace: string;
    totalTokens: number;
    updatedAt: string;
  }>;
}
```

数据来源：`usage-index.json`（首次全量扫描，后续增量更新）。

### 3.3 `POST /api/compact`

```typescript
// Request
{ focus?: string }

// Response
{ ok: boolean; error?: string; compacted: boolean; message?: string }
```

后端调用：
```typescript
runtime.session.compact(focus || undefined);
```

SSE 事件桥接：
- `compaction_start` → 前端 show loading
- `compaction_end` → 前端 refresh usage + reload messages
- `compaction_error` → 前端 show error

---

## 四、数据持久化

### 4.1 usage-index.json

```json
{
  "version": 1,
  "updatedAt": "2026-07-20T14:30:00Z",
  "sessions": {
    "019f49ab-...": {
      "path": "by-project/pay/2026-07-10T01-36-50-735Z_019f49ab-...jsonl",
      "updatedAt": "2026-07-20T12:00:00Z",
      "input": 10000,
      "output": 3000,
      "cacheRead": 8000,
      "cacheWrite": 2000,
      "cost": 0.12,
      "compactCount": 2,
      "lastCompactionAt": "2026-07-20T11:30:00Z"
    }
  }
}
```

### 4.2 扫描策略

- **首次**：全量遍历 `sessions/` 下所有 `.jsonl`，逐行解析 `usage` 字段
- **增量**：按文件 `mtime` 对比索引中 `updatedAt`，只处理更新的文件
- **写时机**：每次 `compaction_end` + 每次会话关闭/切换时更新

### 4.3 Session 回放 — compaction entry 解析

当前 `parseSessionMessages` 不识别 `compaction` type，需新增分支：

```typescript
if (entry.type === "compaction") {
  messages.push({
    role: "assistant" as const,
    content: `📦 上下文已压缩 — 原 ${entry.tokensBefore || "?"} tokens\n\n${entry.summary || ""}`,
    _compacted: true,  // 标记，前端用 .compact-summary 样式渲染
  });
  continue;
}
```

前端渲染时检测 `_compacted` 标记，用专门 card 样式而非标准 assistant 气泡。

---

## 五、分期实施

### P0.5 — parseSessionMessages 修复（~5 行，独立无依赖）

- [ ] `sessions.ts`: `parseSessionMessages` 增加 `type: "compaction"` 分支
- [ ] 前端检测 `_compacted` 标记，使用 `compact-summary` card 样式

### P1 — Token Rail + Usage 面板

**前端 HTML/CSS**：
- [ ] 移除输入区 `.fi-token-box`（当前 token 显示区域）
- [ ] `.main-tabs` 右侧新增 `.tr-rail` 容器
- [ ] Rail 样式：狭长、常驻、2 个核心数字 + Compact 按钮
- [ ] Usage 面板 HTML + CSS（模态浮层，520–680px）
- [ ] 面板当前会话页 layout（3 个大指标 + token 细项）
- [ ] 面板全部会话页 layout（累计数字 + 排行）
- [ ] 状态色：正常/70%/85% 警戒

**后端 API**：
- [ ] `GET /api/usage/current` — 封装当前 runtime 数据
- [ ] `GET /api/usage/summary` — 初版走全量扫描（后续优化增量）

**前端 JS**：
- [ ] Rail 点击 → 展开 Usage 面板
- [ ] 6s 轮询（复用现有 `_tokenPollTimer` 机制）
- [ ] 面板 Tab 切换：当前会话 / 全部会话
- [ ] 文件 tab/空白页 → Rail 显示"无会话"

### P2 — Compact 闭环

- [ ] `POST /api/compact` 端点
- [ ] SSE 事件桥接 `compaction_start/end/error`
- [ ] Compact 弹窗 HTML + CSS
- [ ] focus 输入 → 传 `customInstructions`
- [ ] 状态处理：isStreaming / isCompacting / session too small / success / error
- [ ] Compact 成功后：toast + 刷新 Usage + reload 消息列表
- [ ] Rail 和面板中 Compact 按钮的状态联动

### P3 — 当前会话长期统计

- [ ] 从 session JSONL entries 统计 compact 次数、历史 usage
- [ ] `/api/usage/current` 增加 `compactCount`、`lastCompactionAt`、`lastCompactionSummary`
- [ ] 面板"最近一次 Compact"区域

### P4 — 全部会话统计 + 索引

- [ ] `usage-index.json` 格式 + 首次全量扫描
- [ ] 增量更新策略（按 mtime）
- [ ] `/api/usage/summary` 数据来源切换为索引
- [ ] Top sessions 排行

---

## 六、指标定义

| 字段 | 计算公式 | 范围 |
|------|----------|------|
| 缓存命中率 | `cacheRead / (cacheRead + cacheWrite) × 100` | 当前会话 |
| 上下文占用 | `estimateContextTokens / contextWindow × 100` | 当前会话 |
| 费用估算 | 按模型单价 × token 量（复用当前逻辑） | 当前 + 累计 |

> 缓存命中率不跨会话统计，全部会话累计只做 `总和`，不做平均值（无实际意义）。

---

## 七、CSS 变量扩展

新增 Rail 相关 CSS 变量（在 `dashboard.css` 的 `:root` 和 `.theme-light` 中）：

```css
--tr-bg: var(--bc);              /* Rail 背景 */
--tr-fg: var(--tx);              /* Rail 文字 */
--tr-accent: var(--am);          /* Rail 强调 */
--tr-warn: #F97316;              /* 70% 警戒 */
--tr-danger: #EF4444;            /* 85% 警戒 */
```

---

## 八、已知风险

1. **`session.isCompacting`** — 需要确认 PI SDK 的 `AgentSession` 实例上此属性是否公开可读。如果不可读，需要通过 `session.subscribe` 监听 `compaction_start/end` 事件自行维护状态。
2. **token 估算 vs 精确值** — `estimateContextTokens` 是近似值（chars/4 启发式），前端需标注"约"或"近似"。
3. **usage-index 并发** — 多个 session 切换时写索引可能冲突，建议加简单锁或 append-only 写入。
4. **老 session 无 usage 数据** — 旧版 session JSONL 可能没有 `usage` 字段，统计时要 skip 而非当成 0。

---

## 九、参考

- [项目当前阶段评估](project-state-phase-2.md) — 与子 Agent 编排并列的下一个能力块
- [功能与能力审查](feature-capability-review.md) — `/compact` 列为 P2 差距项
