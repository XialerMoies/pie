# 精准在线 Token 使用量 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在不修改 PI fork 的前提下，为当前上下文占用增加 exact/mixed/estimated 来源，并在流式结束后自动替换为服务商精确值。

**Architecture:** 新建纯函数适配层，组合 PI 包根公开的 `calculateContextTokens` 与 `estimateTokens`；`AgentRuntime` 暴露稳定快照接口，usage 路由只消费该接口。现有 `usage.changed` 事件增加 500ms 时间戳节流，前端只增加来源标签和累计计费文案。

**Tech Stack:** TypeScript、Node test runner、PI Coding Agent 0.84.2、原生 HTTP 路由、全局式前端 TypeScript。

---

### Task 1: 上下文来源纯计算与 Runtime 边界

**Files:**
- Create: `src/agent/context-usage.ts`
- Create: `test/context-usage.test.mjs`
- Modify: `src/agent/runtime.ts`
- Modify: `test/pi-sdk-contract.test.mjs`
- Modify: `package.json`

- [ ] **Step 1: 写 SDK 导出与来源分类失败测试**

覆盖以下输入：最后一条有效 assistant usage 无尾部消息、其后有 user/tool/assistant 消息、完全无 usage、aborted/error/零 usage、PI native usage 因 compaction 返回 null。

测试期望的公共 API：

```ts
calculateContextUsageSnapshot(session)
// => { tokens, contextWindow, percent, source, exactTokens, estimatedTokens }
```

并断言包根运行时导出：

```js
assert.equal(typeof pi.calculateContextTokens, "function")
assert.equal(typeof pi.estimateTokens, "function")
```

- [ ] **Step 2: 运行测试并确认因模块缺失而失败**

Run: `node scripts/tsx-test.mjs --test test/context-usage.test.mjs test/pi-sdk-contract.test.mjs`

Expected: FAIL，原因是 `src/agent/context-usage.ts` 尚不存在或导出缺失。

- [ ] **Step 3: 实现最小纯函数**

核心结构：

```ts
import { calculateContextTokens, estimateTokens } from "@xiamol/pi-coding-agent"

export type ContextUsageSource = "exact" | "mixed" | "estimated"

export interface ContextUsageSnapshot {
  tokens: number | null
  contextWindow: number
  percent: number | null
  source: ContextUsageSource
  exactTokens: number
  estimatedTokens: number
}

export function calculateContextUsageSnapshot(session: ContextUsageSession): ContextUsageSnapshot | undefined {
  // 校验 contextWindow；从后向前找有效 usage；估算尾部。
  // native getContextUsage().tokens === null 时强制整段 estimated。
}
```

在 `AgentRuntime` 增加：

```ts
getContextUsageSnapshot(): ContextUsageSnapshot | undefined {
  return calculateContextUsageSnapshot(this.session)
}
```

将新测试加入 `test:unit`。

- [ ] **Step 4: 运行定向测试并确认通过**

Run: `node scripts/tsx-test.mjs --test test/context-usage.test.mjs test/pi-sdk-contract.test.mjs`

Expected: PASS。

### Task 2: Usage API 暴露 provenance

**Files:**
- Modify: `src/server/routes/dashboard.ts`
- Modify: `test/routes.test.mjs`

- [ ] **Step 1: 写 API 失败测试**

为 mock runtime 增加：

```js
getContextUsageSnapshot: () => ({
  tokens: 1300,
  contextWindow: 200000,
  percent: 0.65,
  source: "mixed",
  exactTokens: 1234,
  estimatedTokens: 66,
})
```

分别断言 `/api/token-usage` 与 `/api/usage/current` 返回全部六个字段，同时保留旧字段。

- [ ] **Step 2: 运行路由测试并确认 provenance 缺失**

Run: `node scripts/tsx-test.mjs --test test/routes.test.mjs`

Expected: FAIL，`contextUsage.source` 为 `undefined`。

- [ ] **Step 3: 路由优先消费 Runtime 快照并保留兼容 fallback**

新增局部读取函数：

```ts
function readContextUsage(runtime: ServerContext["runtime"], session: unknown) {
  return runtime.getContextUsageSnapshot?.() ?? session.getContextUsage?.() ?? null
}
```

两个 API 统一原样复制 `source`、`exactTokens`、`estimatedTokens`；旧 mock/旧 runtime 没有新方法时继续返回旧字段。

- [ ] **Step 4: 运行路由测试并确认通过**

Run: `node scripts/tsx-test.mjs --test test/routes.test.mjs`

Expected: PASS。

### Task 3: 流式 usage.changed 时间戳节流

**Files:**
- Modify: `src/server/agent-event-router.ts`
- Modify: `test/app-events-server.test.mjs`

- [ ] **Step 1: 写事件失败测试**

使用可注入或可控制的时间，验证：

```text
agent_start          -> 立即 usage.changed
message_update @100  -> 不发布
message_update @500  -> 发布一次
message_update @700  -> 不发布
message_update @1000 -> 再发布一次
agent_end + idle     -> 最终发布一次
```

同时验证旧 session 的 `message_update` 不发布。

- [ ] **Step 2: 运行事件测试并确认流式阶段无发布**

Run: `node scripts/tsx-test.mjs --test test/app-events-server.test.mjs`

Expected: FAIL，当前 `message_update` 不触发 `usage.changed`。

- [ ] **Step 3: 实现无计时器节流**

在 `attachSessionEvents` 闭包维护：

```ts
let lastStreamingUsagePublishAt = 0
const publishStreamingUsageChanged = () => {
  const now = Date.now()
  if (now - lastStreamingUsagePublishAt < 500) return
  lastStreamingUsagePublishAt = now
  publishUsageChanged()
}
```

`agent_start` 记录本次发布时间；有效 assistant `message_update` 调用节流函数。保留现有 `waitForIdle()` 最终发布和 source-session 防护。

- [ ] **Step 4: 运行事件测试并确认通过**

Run: `node scripts/tsx-test.mjs --test test/app-events-server.test.mjs`

Expected: PASS。

### Task 4: 前端精度标签与累计计费文案

**Files:**
- Modify: `src/frontend/dashboard/dashboard-layout.ts`
- Modify: `src/frontend/chat/chat-token.ts`
- Modify: `src/frontend/dashboard.css`
- Modify: `src/frontend/dashboard.d.ts`
- Modify: `test/app-tabs.test.mjs`
- Modify: `test/app-events-frontend.test.mjs`

- [ ] **Step 1: 写前端失败测试**

构造 exact、mixed、estimated 和缺字段响应，断言：

- Rail 的 `#tr-source` 显示 `精确`、`含估算`、`估算`。
- 缺字段时标签为空，不误标精确。
- 当前会话面板包含相同标签。
- 当前会话累计区域标题是 `累计计费用量`。
- 更新仍无 `setInterval`。

- [ ] **Step 2: 运行前端定向测试并确认标签不存在**

Run: `node scripts/tsx-test.mjs --test --test-concurrency=1 test/app-tabs.test.mjs test/app-events-frontend.test.mjs`

Expected: FAIL，`#tr-source` 或精度文案不存在。

- [ ] **Step 3: 实现最小 UI**

类型增加可选 provenance，兼容旧服务端：

```ts
type ContextUsageSource = "exact" | "mixed" | "estimated"
source?: ContextUsageSource
exactTokens?: number
estimatedTokens?: number
```

新增安全映射：

```ts
function contextUsageSourceLabel(source: unknown): string {
  if (source === "exact") return "精确"
  if (source === "mixed") return "含估算"
  if (source === "estimated") return "估算"
  return ""
}
```

Rail 增加固定尺寸 `tr-source` 行；无活跃会话或缺字段时清空。Usage 卡片标签只使用上述固定映射，不插入外部字符串。将当前会话的 `Token 用量` 改为 `累计计费用量`，全部会话页文案保持不变。

- [ ] **Step 4: 运行前端定向测试并确认通过**

Run: `node scripts/tsx-test.mjs --test --test-concurrency=1 test/app-tabs.test.mjs test/app-events-frontend.test.mjs`

Expected: PASS。

### Task 5: 回归验证

**Files:**
- Verify only

- [ ] **Step 1: 类型检查**

Run: `npm run typecheck`

Expected: PASS。

- [ ] **Step 2: 全量测试**

Run: `npm test`

Expected: PASS，包含 CSS 变量门禁。

- [ ] **Step 3: 构建检查**

Run: `npm run build`

Expected: PASS。

- [ ] **Step 4: 手工桌面验收**

Run: `npm run dev`

发送持续数秒的回复，确认流式期间显示 `含估算`/`估算`，结束后自动变成 `精确`；打开 Usage 面板确认“累计计费用量”；执行 compaction 后确认不会把压缩前 usage 标为精确。
