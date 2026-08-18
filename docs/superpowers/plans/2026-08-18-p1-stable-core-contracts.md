# P1 稳定核心契约实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 建立桌面端、服务端和 CLI 共同使用的自有 AgentEngine 契约，彻底删除前端旧全局投影，拆分服务端边界，并提供结构化、可恢复的权限拒绝反馈。

**Architecture:** 新增纯自有类型的 `AgentEngine` 与 `PiAgentEngineAdapter`，adapter 内部调用现有 `AgentRuntime` 和 PI SDK。先用 contract tests 固化事件与终态，再逐步让 server/CLI 依赖 engine；前端由现有 Store/Facade 直接拥有状态，删除 `window.__state` 兼容层；服务端按 bootstrap、context、HTTP 和 lifecycle 拆分，不改变路由业务逻辑。

**Tech Stack:** TypeScript、Node test runner、Electron frontend global TS、现有 PI SDK、HTTP/SSE。

---

### Task 1: 建立 AgentEngine 自有契约

**Files:**
- Create: `src/agent-engine/contracts.ts`
- Create: `src/agent-engine/errors.ts`
- Create: `src/agent-engine/index.ts`
- Test: `test/agent-engine-contract.test.mjs`

- [ ] **Step 1: Write failing contract tests**

测试必须先断言以下公开类型和运行时 helper 尚不存在时失败：

```ts
const event = normalizeEngineEvent({
  version: 1,
  type: "turn.started",
  sessionId: "session-1",
  turnId: "turn-1",
  seq: 1,
});
assert.deepEqual(event, {
  version: 1,
  type: "turn.started",
  sessionId: "session-1",
  turnId: "turn-1",
  seq: 1,
});
assert.throws(() => assertTerminalTransition("turn.completed", "turn.failed"));
```

测试覆盖 `EngineEvent` 判别联合、`EngineUsage` source、`ModelCapabilities` unknown、`AgentEngineError` 稳定字段，以及每个 turn 只能产生一个终态。

- [ ] **Step 2: Run the focused test and confirm the expected missing-symbol failure**

```powershell
node scripts/tsx-test.mjs --test test/agent-engine-contract.test.mjs
```

预期失败原因是契约模块和 helper 尚未实现，而不是测试加载错误。

- [ ] **Step 3: Implement the minimal contract module**

`contracts.ts` 定义 `EngineEvent`、`EngineUsage`、`ModelCapabilities`、`EngineErrorInfo`、`EngineState`、`AgentEngine`；`errors.ts` 定义 `AgentEngineError`、`normalizeEngineError`；`index.ts` 只导出自有类型和 helper，不导出 PI 类型。

```ts
export type UsageSource = "exact" | "mixed" | "estimated";
export type CapabilityState = "supported" | "unsupported" | "unknown";
export type EngineTerminalEvent = "turn.completed" | "turn.failed" | "turn.cancelled";

export interface AgentEngine {
  readonly id: string;
  readonly session: EngineSessionSnapshot;
  prompt(input: EnginePromptInput, signal?: AbortSignal): Promise<void>;
  steer(text: string): Promise<void>;
  followUp(text: string): Promise<void>;
  cancel(turnId?: string): Promise<boolean>;
  compact(): Promise<void>;
  switchWorkspace(workspace: string): Promise<void>;
  openSession(sessionFile: string, workspace: string): Promise<void>;
  createNewSession(): Promise<string>;
  getUsage(): EngineUsage | undefined;
  subscribe(listener: (event: EngineEvent) => void): () => void;
  dispose(): Promise<void> | void;
}
```

没有费用时使用 `cost: { status: "unknown" }`，不能写零；错误的 `cause` 不出现在序列化事件中。

- [ ] **Step 4: Run focused tests and typecheck**

```powershell
node scripts/tsx-test.mjs --test test/agent-engine-contract.test.mjs
npm run typecheck
```

- [ ] **Step 5: Commit the contract unit**

```powershell
git add src/agent-engine test/agent-engine-contract.test.mjs
git commit -m "feat: define agent engine contract"
```

### Task 2: 实现 PI Adapter 和事件归一化

**Files:**
- Create: `src/agent-engine/pi-adapter.ts`
- Create: `src/agent-engine/event-normalizer.ts`
- Modify: `src/agent/runtime.ts`
- Modify: `src/agent/index.ts`
- Test: `test/pi-agent-engine-adapter.test.mjs`

- [ ] **Step 1: Add failing adapter contract tests**

用最小 fake runtime/session 断言 `agent_start` 变成 `turn.started`，`message_update` 变成 `content.delta`，`message_end` 变成带 normalized usage 的 `turn.completed`；重复 `agent_end` 只能生成一个终态；PI 异常被转换为 `AgentEngineError`。

- [ ] **Step 2: Run the adapter tests and verify they fail for missing adapter behavior**

```powershell
node scripts/tsx-test.mjs --test test/pi-agent-engine-adapter.test.mjs
```

- [ ] **Step 3: Implement the adapter with explicit session generation guards**

`PiAgentEngineAdapter` 接受 `AgentRuntime` 和可选 clock/id factory，通过 `runtime.onEvent` 注册监听；切 workspace 或 open session 时取消旧订阅并递增 generation，旧 session 事件只记录 diagnostic，不进入公共事件流。`cancel()` 对重复调用返回 `false` 或当前取消状态，不发第二个终态。

- [ ] **Step 4: Wire adapter creation into `initAgent` without exposing PI types**

`src/agent/index.ts` 增加 `initEngine(config)`，内部仍调用 `AgentRuntime.create`；保留 `initAgent` 作为短期内部兼容函数，但 server/CLI 新代码只调用 `initEngine`。

- [ ] **Step 5: Run adapter, runtime, and type tests**

```powershell
node scripts/tsx-test.mjs --test test/pi-agent-engine-adapter.test.mjs test/agent-memory.test.mjs test/pi-sdk-contract.test.mjs
npm run typecheck
```

- [ ] **Step 6: Commit the adapter**

```powershell
git add src/agent-engine src/agent/runtime.ts src/agent/index.ts test/pi-agent-engine-adapter.test.mjs
git commit -m "feat: adapt PI runtime to agent engine"
```

### Task 3: 迁移 server 和 CLI 到 AgentEngine

**Files:**
- Modify: `src/server/server.ts`
- Modify: `src/server/routes/chat.ts`
- Modify: `src/server/routes/sessions.ts`
- Modify: `src/server/routes/dashboard.ts`
- Modify: `src/server/routes/settings/models.ts`
- Modify: `src/server/routes/settings/thinking.ts`
- Modify: `src/server/subagent-session.ts`
- Modify: `src/server/main.ts`
- Test: `test/agent-engine-server-wiring.test.mjs`
- Test: `test/cli-startup.test.mjs`

- [ ] **Step 1: Write wiring tests that reject PI session access at route boundaries**

测试为 route context 提供 fake `engine`，不提供 `runtime.session`，并断言 chat、session switching、model switching、thinking level、CLI startup 只调用 engine API。结构断言禁止新代码在 route 中访问 `runtime.session`、PI `AgentSession` 或 `createAgentSession`。

- [ ] **Step 2: Run wiring tests and capture existing direct-access failures**

```powershell
node scripts/tsx-test.mjs --test test/agent-engine-server-wiring.test.mjs test/routes.test.mjs test/cli-startup.test.mjs
```

- [ ] **Step 3: Add `engine` to the core route context and migrate chat/session operations**

将 `/api/chat`、`/api/chat/abort`、`/api/chat/note`、session open/switch/new、model switch 和 thinking level 改为调用 `ctx.core.engine`；`agent-event-router` 从 engine 订阅规范化事件，不再解析 PI 原始事件。

- [ ] **Step 4: Migrate CLI prompt loop**

CLI 通过 `initEngine`，使用 `engine.prompt` 和 `engine.subscribe`，只根据 `turn.completed/failed/cancelled` 恢复 readline prompt，并在 close 时 `await engine.dispose()`。

- [ ] **Step 5: Run focused route, CLI, and event tests**

```powershell
node scripts/tsx-test.mjs --test test/agent-engine-server-wiring.test.mjs test/chat-sse.test.mjs test/chat-stream-replay.test.mjs test/routes.test.mjs test/cli-startup.test.mjs test/app-events-server.test.mjs
```

- [ ] **Step 6: Commit the engine migration**

```powershell
git add src/server src/server/main.ts test/agent-engine-server-wiring.test.mjs test/chat-sse.test.mjs test/routes.test.mjs
git commit -m "refactor: consume agent engine from server and cli"
```

### Task 4: 固化 usage、能力、错误、取消和 compaction 集成语义

**Files:**
- Modify: `src/agent-engine/event-normalizer.ts`
- Modify: `src/server/agent-event-router.ts`
- Modify: `src/server/chat-stream.ts`
- Modify: `src/server/routes/types.ts`
- Test: `test/agent-engine-semantic-contract.test.mjs`
- Test: `test/context-usage.test.mjs`
- Test: `test/trace-sse-lifecycle.test.mjs`

- [ ] **Step 1: Write failing semantic tests**

覆盖：unknown cost 不变成零、estimated/mixed usage 保持 source、compaction 前后 usage 成对发布、取消后不出现 done、PI error 不泄漏 provider secret、未知事件只生成 diagnostic。

- [ ] **Step 2: Run semantic tests and confirm failures**

```powershell
node scripts/tsx-test.mjs --test test/agent-engine-semantic-contract.test.mjs test/context-usage.test.mjs test/trace-sse-lifecycle.test.mjs
```

- [ ] **Step 3: Implement normalized event routing**

server SSE、trace persistence、assistant blocks 和 usage updates 只接收 `EngineEvent`；保留现有 JSONL 回放格式的兼容读取，但新写入使用契约字段和 terminal status。

- [ ] **Step 4: Verify all semantic tests and existing persistence tests**

```powershell
node scripts/tsx-test.mjs --test test/agent-engine-semantic-contract.test.mjs test/context-usage.test.mjs test/trace-sse-lifecycle.test.mjs test/tool-trace.test.mjs test/block-persist.test.mjs
```

- [ ] **Step 5: Commit semantic integration**

```powershell
git add src/agent-engine src/server/agent-event-router.ts src/server/chat-stream.ts src/server/routes/types.ts test/agent-engine-semantic-contract.test.mjs
git commit -m "feat: normalize agent engine lifecycle semantics"
```

### Task 5: 彻底删除前端旧状态投影

**Files:**
- Modify: `src/frontend/services/ui-state-store.ts`
- Modify: `src/frontend/services/tab-store.ts`
- Modify: `src/frontend/services/chat-runtime-store.ts`
- Modify: `src/frontend/dashboard/dashboard-layout.ts`
- Modify: `src/frontend/dashboard/dashboard-chat.ts`
- Modify: `src/frontend/dashboard/dashboard-sessions.ts`
- Modify: `src/frontend/dashboard/layout-tabs.ts`
- Modify: `src/frontend/dashboard/session-list-panel.ts`
- Modify: `src/frontend/dashboard.d.ts`
- Modify: all frontend consumers found by `rg -l "window\\.__state|window\\.__tabs" src/frontend`
- Test: `test/frontend-state-ownership.test.mjs`
- Modify: affected frontend tests under `test/`

- [ ] **Step 1: Write the hard source gate before deleting code**

```js
for (const file of productionFrontendFiles) {
  assert.doesNotMatch(readFileSync(file, "utf8"), /window\.__state|window\.__tabs|__state\b|__tabs\b/);
}
```

Add behavioral assertions that bootstrapping exposes Store/Facade APIs only and does not create a global state object.

- [ ] **Step 2: Run the gate and record every remaining production reference**

```powershell
node scripts/tsx-test.mjs --test test/frontend-state-ownership.test.mjs test/frontend-event-ownership.test.mjs test/ui-state-store.test.mjs test/tab-store.test.mjs
```

- [ ] **Step 3: Remove global mounting and migrate callers**

Delete `window.__state`, `window.__tabs`, and `__uiStateStore` mounting. Export the existing Store instances through the established `App.State`, `App.Tabs`, and `App.Chat` facades; replace direct field reads with `getSnapshot`, selectors, and mutation methods. Preserve upgrade safety by moving legacy localStorage import into a pure one-shot migration helper; after import it deletes legacy keys and never mirrors new state back to them.

- [ ] **Step 4: Migrate test harnesses to real stores**

Replace test-only fake `win.__state` fixtures with explicit `createTestTabStore`, `createTestUiStateStore`, and `createTestChatRuntimeStore` factories. Keep test names focused on behavior, not implementation fields.

- [ ] **Step 5: Run frontend typecheck, source gate, and all frontend tests**

```powershell
npm run typecheck
npm run test:frontend
node scripts/tsx-test.mjs --test test/frontend-state-ownership.test.mjs test/frontend-event-ownership.test.mjs
```

- [ ] **Step 6: Commit frontend ownership migration**

```powershell
git add src/frontend test
git commit -m "refactor: remove legacy frontend state projections"
```

### Task 6: 拆分 ServerContext 与 server.ts

**Files:**
- Create: `src/server/server-context.ts`
- Create: `src/server/server-bootstrap.ts`
- Create: `src/server/http-app.ts`
- Create: `src/server/server-lifecycle.ts`
- Modify: `src/server/routes/types.ts`
- Modify: `src/server/server.ts`
- Modify: `src/server/routes/*.ts` where context access changes
- Test: `test/server-context.test.mjs`
- Test: `test/server-bootstrap.test.mjs`

- [ ] **Step 1: Write structural tests for grouped context and module ownership**

Assert `ServerContext` exposes `core/security/storage/providers/infra`, route modules do not import `server.ts`, and `server.ts` no longer contains route dispatch, static asset resolution, or lifecycle cleanup implementations.

- [ ] **Step 2: Run the structural tests and confirm current monolith failures**

```powershell
node scripts/tsx-test.mjs --test test/server-context.test.mjs test/server-bootstrap.test.mjs
```

- [ ] **Step 3: Create grouped context types and bootstrap factory**

`server-context.ts` defines required groups; `server-bootstrap.ts` moves current runtime/security/provider/storage construction from `main()` into `createServerContext()`. The returned context has no optional production dependencies.

- [ ] **Step 4: Extract HTTP app and lifecycle without changing route behavior**

Move request correlation, auth, static assets, `dispatchRoute`, 404/error handling to `http-app.ts`; move watcher, lock, SSE, signal handling, permission audit flush, subagent disposal and runtime disposal to `server-lifecycle.ts`. `server.ts` calls these modules in order.

- [ ] **Step 5: Run server route and packaged smoke tests**

```powershell
node scripts/tsx-test.mjs --test test/server-context.test.mjs test/server-bootstrap.test.mjs test/routes.test.mjs test/server-security.test.mjs test/multi-instance-e2e.mjs
npm run test:build
```

- [ ] **Step 6: Commit server boundary split**

```powershell
git add src/server test/server-context.test.mjs test/server-bootstrap.test.mjs
git commit -m "refactor: split server bootstrap and context"
```

### Task 7: 结构化权限拒绝与中文恢复反馈

**Files:**
- Modify: `src/agent/types.ts`
- Modify: `src/server/permission-service.ts`
- Modify: `src/server/routes/path-guard.ts`
- Modify: `src/server/routes/*.ts` error writers
- Modify: `src/frontend/pane/permissions/index.ts`
- Modify: `src/frontend/pane/permissions/permissions-views.ts`
- Modify: `src/frontend/dashboard/dashboard-chat.ts`
- Modify: `src/frontend/dashboard.d.ts`
- Test: `test/permission-error-contract.test.mjs`
- Test: `test/server-permission-service.test.mjs`
- Test: `test/permissions-pane.test.mjs`
- Test: `test/chat-sse.test.mjs`

- [ ] **Step 1: Write failing backend and frontend feedback tests**

Backend tests assert a stable error envelope for deny, confirmation unavailable, dangerous, and path guard errors. Frontend tests assert Chinese labels, relative target display, retry/settings actions, and no bypass action for dangerous errors.

- [ ] **Step 2: Run focused tests and verify missing envelope/action failures**

```powershell
node scripts/tsx-test.mjs --test test/permission-error-contract.test.mjs test/server-permission-service.test.mjs test/permissions-pane.test.mjs test/chat-sse.test.mjs
```

- [ ] **Step 3: Implement shared permission error normalization**

Add `PermissionFailure` with `code/category/decision/message/reason/operation/target/recoverable/suggestions`; map existing `ServerPermissionError` and `PathGuardError` without weakening authorization. Absolute paths are converted to workspace-relative summaries where possible.

- [ ] **Step 4: Render actionable feedback while preserving fail-closed behavior**

Use existing toast/permission pane patterns. `confirmation_unavailable` offers reconnect; `permission_denied` opens settings; `permission_confirmation_required` offers once/workspace/deny; `dangerous` has no allow control.

- [ ] **Step 5: Run focused and full frontend/route suites**

```powershell
node scripts/tsx-test.mjs --test test/permission-error-contract.test.mjs test/server-permission-service.test.mjs test/permissions-pane.test.mjs test/chat-sse.test.mjs
npm run test:frontend
npm run test:routes
```

- [ ] **Step 6: Commit permission feedback**

```powershell
git add src/agent/types.ts src/server src/frontend test
git commit -m "feat: clarify fail-closed permission feedback"
```

### Task 8: 集成验证、文档和代码审查

**Files:**
- Modify: `README.md`
- Modify: `ARCHITECTURE.md`
- Modify: `docs/任务清单.md`
- Test: affected suites from Tasks 1-7

- [ ] **Step 1: Add architecture documentation for AgentEngine and state ownership**

Document the adapter boundary, event terminal rules, context groups, and the prohibition on legacy frontend projections.

- [ ] **Step 2: Run the complete verification matrix**

```powershell
npm run typecheck
npm test
npm run build
npm run test:build
npm run test:electron:e2e
npm run release:check
git diff --check
```

Expected result: every command exits 0 and release gate reports `all release gates passed`.

- [ ] **Step 3: Review the final diff and request code review**

Check `git diff --stat`, `git status --short`, all new public exports, and search for `window.__state`, `window.__tabs`, direct PI imports in routes/CLI, and optional context fallback. Resolve all critical/important findings before merge.

- [ ] **Step 4: Commit documentation and verification updates**

```powershell
git add README.md ARCHITECTURE.md test
git add -f docs/任务清单.md
git commit -m "docs: record P1 stable core contract rollout"
```
