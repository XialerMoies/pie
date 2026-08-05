# 会话全局兼容入口清理实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 删除会话相关的 `window.xxx` 兼容入口，让前端跨模块调用统一经过真正受 TypeScript 约束的 `App.*` facade，同时保持会话行为不变。

**Architecture:** 保留当前 classic-script 拼接 bundle 和 `window.App` 应用门面。在 `dashboard-helpers.ts` 的初始化边界将 `App` 收窄为 `AppNamespace`，业务模块只使用 `App.Session`、`App.SessionTabs`、`App.Tabs`、`App.SessionRestore` 和 `App.SessionActivation`。按调用方分批迁移，完成后删除旧发布和旧全局声明。

**Tech Stack:** TypeScript、esbuild frontend compiler、Node test runner、happy-dom、`scripts/tsx-test.mjs`。

**设计依据:** `docs/superpowers/specs/2026-08-05-session-global-alias-cleanup-design.md`

---

## 文件地图

| 文件 | 责任 | 本计划中的变化 |
| --- | --- | --- |
| `src/frontend/dashboard/dashboard-helpers.ts` | 创建并初始化 `App` facade | 在唯一边界为 `App` 增加 `AppNamespace` 类型 |
| `src/frontend/dashboard/dashboard-sessions.ts` | 会话 CRUD、列表和标签行为 | 补充 `getTabLabel` facade 绑定，最后删除旧 `window.xxx` 发布 |
| `src/frontend/dashboard/session-activation.ts` | 会话激活和切换 | 最后删除 `window.switchSession` 发布 |
| `src/frontend/dashboard.d.ts` | 前端 facade 和全局类型 | 增加 `getTabLabel`，删除旧会话全局声明 |
| `src/frontend/dashboard/dashboard-chat.ts` | 发送消息和草稿绑定 | 删除 legacy-first / fallback 访问，直接使用 `App.*` |
| `src/frontend/dashboard/dashboard-layout.ts` | 主标签渲染 | 通过 `App.Session.getTabLabel` 取会话标题 |
| `src/frontend/dashboard/layout-tabs.ts` | 标签上下文菜单 | 通过 `App.Session.getTabLabel` 取会话标题 |
| `src/frontend/dashboard/dashboard-menus.ts` | 菜单操作 | 通过 `App.Session` / `App.SessionTabs` 调用 |
| `src/frontend/dashboard/dashboard-startup.ts` | 页面启动 | 通过 `App.Session.loadSessions` 首载 |
| `src/frontend/dashboard/dashboard-helpers.ts` | TabStore 降级分发 | 通过 `App.SessionActivation.switchSession` 切换会话 |
| `src/frontend/chat/chat-token.ts` | Token 使用刷新后的当前会话 | 通过 `App.Tabs` 读取活动会话 |
| `src/frontend/pane/chat/index.ts` | 会话搜索和列表面板 | 通过 `App.Session` 调列表加载和请求序列 |
| `test/frontend-event-ownership.test.mjs` | 前端架构门禁 | 锁定唯一 App 类型边界和旧入口禁用规则 |
| `test/chat-ui-state.test.mjs` | 发送/草稿 UI 行为 | 测试 stub 改为 App facade |
| `test/app-tabs.test.mjs` | TabStore / 会话标签行为 | 测试入口改为 App facade |
| `test/session-ui.test.mjs` | 会话 CRUD 和标签渲染 | 测试入口改为 App facade |

## Task 1: 建立唯一的 App 类型边界

**Files:**
- Modify: `src/frontend/dashboard/dashboard-helpers.ts:584`
- Test: `test/frontend-event-ownership.test.mjs`

- [ ] **Step 1: 写失败的架构测试**

在 `frontend state ownership` describe 中增加：

```js
it("narrows the shared App facade once at the initialization boundary", () => {
  const source = readFileSync(
    resolve(process.cwd(), "src/frontend/dashboard/dashboard-helpers.ts"),
    "utf8",
  );
  assert.match(source, /const App:\s*AppNamespace\s*=\s*window\.App\s*;/);
  assert.doesNotMatch(source, /const App\s*=\s*\(window as any\)\.App/);
});
```

- [ ] **Step 2: 运行测试确认当前实现失败**

运行：

```text
node scripts/tsx-test.mjs --test test/frontend-event-ownership.test.mjs
```

预期：新增测试失败，因为当前共享常量仍是 `const App = (window as any).App;`。

- [ ] **Step 3: 实现最小类型收窄**

将 `dashboard-helpers.ts` 的共享 facade 绑定改为：

```ts
const App: AppNamespace = window.App;
```

保留前面的 `existingApp` 初始化流程和 `window.App = existingApp`，不在此步骤迁移任何业务调用。

- [ ] **Step 4: 运行测试和前端类型检查**

运行：

```text
node scripts/tsx-test.mjs --test test/frontend-event-ownership.test.mjs
npm run typecheck:frontend
```

预期：架构测试通过，前端类型检查报告 `0` 个错误。

- [ ] **Step 5: 提交**

```text
git add src/frontend/dashboard/dashboard-helpers.ts test/frontend-event-ownership.test.mjs
git commit -m "refactor: 为 App facade 建立类型边界"
```

## Task 2: 统一会话标题和低风险 UI 调用方

**Files:**
- Modify: `src/frontend/dashboard.d.ts:190-205`
- Modify: `src/frontend/dashboard/dashboard-sessions.ts:880-899`
- Modify: `src/frontend/dashboard/dashboard-layout.ts:228-231`
- Modify: `src/frontend/dashboard/layout-tabs.ts:224-227`
- Test: `test/frontend-event-ownership.test.mjs`
- Test: `test/session-ui.test.mjs`

- [ ] **Step 1: 写失败的入口测试**

在架构测试中增加标题入口约束：

```js
it("reads session tab labels through App.Session", () => {
  const root = resolve(process.cwd(), "src/frontend");
  for (const file of [
    "dashboard/dashboard-layout.ts",
    "dashboard/layout-tabs.ts",
  ]) {
    const source = readFileSync(resolve(root, file), "utf8");
    assert.doesNotMatch(source, /(?:window|\(window as any\))\.sessionTabLabel/);
    assert.match(source, /App\.Session\.getTabLabel\(/);
  }
});
```

- [ ] **Step 2: 运行测试确认失败**

运行：

```text
node scripts/tsx-test.mjs --test test/frontend-event-ownership.test.mjs
```

预期：标题入口测试失败，因为两个渲染模块仍读取 `window.sessionTabLabel`。

- [ ] **Step 3: 补充并绑定正式标题 API**

在 `AppSession` 中增加：

```ts
getTabLabel(id: string): string;
```

在 `dashboard-sessions.ts` 的 `App.Session` 绑定对象中增加：

```ts
AppSess.getTabLabel = sessionTabLabel;
```

将两个渲染模块统一改为：

```ts
items = items.map(t => t.kind !== 'file'
  ? { ...t, title: App.Session.getTabLabel(t.id) || t.title }
  : t);
```

保留原有 `tab.title` 作为数据来源和显示回退，仅移除旧全局函数检查。

- [ ] **Step 4: 运行行为测试和类型检查**

运行：

```text
node scripts/tsx-test.mjs --test test/session-ui.test.mjs test/app-tabs.test.mjs test/frontend-event-ownership.test.mjs
npm run typecheck:frontend
```

预期：会话标签渲染、重命名和 TabStore 行为通过，类型检查通过。

- [ ] **Step 5: 提交**

```text
git add src/frontend/dashboard.d.ts src/frontend/dashboard/dashboard-sessions.ts src/frontend/dashboard/dashboard-layout.ts src/frontend/dashboard/layout-tabs.ts test/frontend-event-ownership.test.mjs test/session-ui.test.mjs
git commit -m "refactor: 通过 App facade 读取会话标签标题"
```

## Task 3: 迁移启动、菜单、搜索和辅助模块

**Files:**
- Modify: `src/frontend/dashboard.d.ts:190-205`
- Modify: `src/frontend/dashboard/dashboard-startup.ts:24`
- Modify: `src/frontend/dashboard/dashboard-menus.ts:72,118`
- Modify: `src/frontend/dashboard/dashboard-helpers.ts:108-112`
- Modify: `src/frontend/chat/chat-token.ts:505`
- Modify: `src/frontend/pane/chat/index.ts:26-50,204,283`
- Test: `test/frontend-event-ownership.test.mjs`
- Test: `test/search-pane.test.mjs`

- [ ] **Step 1: 写失败的旧入口门禁**

在架构测试中定义本阶段禁止的跨模块旧入口：

```js
const legacyWindowSessionAccess = /(?:window|\(window as any\))\.(?:loadSessions|bumpSessionListSeq|isCurrentSessionListSeq|sessionTabLabel|switchSession|getActiveSessionTabId|renderSessionTabs)/;
const bareSessionCall = /(?<![.\w])(?:loadSessions|bumpSessionListSeq|isCurrentSessionListSeq)\s*\(/;
```

扫描以下文件，并断言不匹配：

```js
const consumers = [
  "dashboard/dashboard-startup.ts",
  "dashboard/dashboard-menus.ts",
  "dashboard/dashboard-helpers.ts",
  "chat/chat-token.ts",
  "pane/chat/index.ts",
];
```

断言使用每个文件的相对路径作为失败信息。`dashboard-sessions.ts` 内部本地调用不在本测试范围内。

- [ ] **Step 2: 运行门禁确认失败**

运行：

```text
node scripts/tsx-test.mjs --test test/frontend-event-ownership.test.mjs
```

预期：至少命中 `loadSessions`、`bumpSessionListSeq` 或 `window.switchSession` 的旧访问。

- [ ] **Step 3: 迁移调用**

先在 `AppSession` 中补齐搜索序列的正式类型：

```ts
bumpSessionListSeq(): number;
isCurrentSessionListSeq(seq: number): boolean;
```

再按以下固定映射替换：

```ts
// dashboard-startup.ts / dashboard-menus.ts / pane/chat/index.ts
loadSessions()             -> App.Session.loadSessions()
bumpSessionListSeq()      -> App.Session.bumpSessionListSeq()
isCurrentSessionListSeq(x) -> App.Session.isCurrentSessionListSeq(x)

// dashboard-helpers.ts
(window as any).switchSession(id, options)
  -> App.SessionActivation.switchSession(id, options)

// chat-token.ts
(window as any).getActiveSessionTabId?.()
  -> App.Tabs.getActiveSessionTabId()
```

在 `dashboard-menus.ts` 中把 `window.renderSessionTabs?.()` 改为 `App.SessionTabs.renderSessionTabs()`。不改变菜单事件监听、延迟刷新或错误处理。

- [ ] **Step 4: 运行相关测试**

运行：

```text
node scripts/tsx-test.mjs --test test/frontend-event-ownership.test.mjs test/search-pane.test.mjs test/app-tabs.test.mjs
npm run typecheck:frontend
```

预期：旧入口门禁通过，搜索请求序列和标签分发测试通过。

- [ ] **Step 5: 提交**

```text
git add src/frontend/dashboard.d.ts src/frontend/dashboard/dashboard-startup.ts src/frontend/dashboard/dashboard-menus.ts src/frontend/dashboard/dashboard-helpers.ts src/frontend/chat/chat-token.ts src/frontend/pane/chat/index.ts test/frontend-event-ownership.test.mjs
git commit -m "refactor: 迁移会话辅助模块到 App facade"
```

## Task 4: 迁移 dashboard-chat 的发送和草稿链路

**Files:**
- Modify: `src/frontend/dashboard/dashboard-chat.ts:65-155,231,396-515`
- Modify: `test/chat-ui-state.test.mjs: setup and legacy stubs around 398-642`
- Test: `test/frontend-event-ownership.test.mjs`

- [ ] **Step 1: 将聊天入口测试 stub 改为 facade**

在 `test/chat-ui-state.test.mjs` 中，把旧的全局 stub：

```js
env.win.whenSessionRestoreReady = fn;
env.win.ensureDraftSessionTab = fn;
env.win.commitSessionTab = fn;
env.win.getActiveSessionTabId = fn;
env.win.setActiveSessionTabId(id);
```

改为对应的：

```js
env.win.App.SessionRestore.whenReady = fn;
env.win.App.Session.ensureDraftSessionTab = fn;
env.win.App.Session.commitSessionTab = fn;
env.win.App.Tabs.getActiveSessionTabId = fn;
env.win.App.SessionTabs.setActiveSessionTabId(id);
```

恢复测试前保存并恢复同一 facade 属性，不能再通过删除 `window.xxx` 模拟降级。

- [ ] **Step 2: 运行聊天状态测试确认仍能表达行为**

运行：

```text
node scripts/tsx-test.mjs --test test/chat-ui-state.test.mjs
```

预期：新增的 facade 调用计数断言失败，实际调用次数仍为 `0`，证明实现还在读取旧全局入口。

- [ ] **Step 3: 迁移 dashboard-chat 内部 helper**

使用以下固定映射：

```ts
(window as any).getActiveSessionTabId -> App.Tabs.getActiveSessionTabId
(window as any).writeSessionTabIds    -> App.SessionTabs.writeSessionTabIds
(window as any).setActiveSessionTabId -> App.SessionTabs.setActiveSessionTabId
(window as any).commitSessionTab      -> App.Session.commitSessionTab
(window as any).whenSessionRestoreReady -> App.SessionRestore.whenReady
(window as any).ensureDraftSessionTab -> App.Session.ensureDraftSessionTab
(window as any).maybeAutoTitleSession -> App.Session.maybeAutoTitleSession
loadSessions() -> App.Session.loadSessions()
```

删除 `typeof` 检查和旧入口 fallback。`chatGetActiveSessionTabId()` 保留对 `App.Tabs.getActiveTab()` 的现有兼容逻辑，但最终只从 `App.Tabs` 读取。

- [ ] **Step 4: 增加“旧 window stub 不再影响发送链路”回归断言**

在聊天状态测试中设置一个会抛错的旧属性：

```js
env.win.getActiveSessionTabId = () => { throw new Error("legacy path used"); };
```

然后通过已有发送/草稿测试触发链路；断言发送成功且没有抛出 `legacy path used`。同样覆盖 `commitSessionTab` 和 `maybeAutoTitleSession` 的 facade 调用。

- [ ] **Step 5: 运行测试和提交**

运行：

```text
node scripts/tsx-test.mjs --test test/chat-ui-state.test.mjs test/frontend-event-ownership.test.mjs
npm run typecheck:frontend
```

预期：发送、草稿绑定、恢复等待和自动标题测试通过，聊天模块不再读取会话旧全局。

```text
git add src/frontend/dashboard/dashboard-chat.ts test/chat-ui-state.test.mjs test/frontend-event-ownership.test.mjs
git commit -m "refactor: 迁移聊天会话链路到 App facade"
```

## Task 5: 删除旧发布、全局声明并迁移剩余测试

**Files:**
- Modify: `src/frontend/dashboard/dashboard-sessions.ts:857-899`
- Modify: `src/frontend/dashboard/session-activation.ts:192`
- Modify: `src/frontend/dashboard.d.ts:191-235,393-405,443-485`
- Modify: `test/app-tabs.test.mjs`
- Modify: `test/session-ui.test.mjs`
- Modify: `test/frontend-event-ownership.test.mjs`

- [ ] **Step 1: 写最终架构门禁**

在 `test/frontend-event-ownership.test.mjs` 增加固定名称集合：

```js
const legacySessionGlobals = [
  "loadSessions", "bumpSessionListSeq", "isCurrentSessionListSeq",
  "readSessionTabIds", "writeSessionTabIds", "sessionTabLabel",
  "commitSessionTab", "maybeAutoTitleSession", "getActiveSessionTabId",
  "setActiveSessionTabId", "ensureDraftSessionTab", "whenSessionRestoreReady",
  "renderSessionTabs", "migrateSessionTabLabels", "switchSession",
  "newSession", "renameSession", "deleteSession", "pinSession", "branchSession",
];
```

扫描 `src/frontend` 非 `gen` 的 `.ts` 文件，禁止出现 `window.<name>`、`(window as any).<name>` 和 `window.<name> =`。另读取 `dashboard.d.ts`，禁止出现这些名称的 `declare function` 或 `Window` 属性声明。允许 `dashboard-sessions.ts` 内部的本地函数调用。

- [ ] **Step 2: 运行门禁确认失败**

运行：

```text
node scripts/tsx-test.mjs --test test/frontend-event-ownership.test.mjs
```

预期：命中当前发布块和 `session-activation.ts` 的 `window.switchSession`。

- [ ] **Step 3: 迁移测试入口**

将测试中的正式入口统一改为：

```js
win.loadSessions()        -> win.App.Session.loadSessions()
win.newSession()          -> win.App.Session.newSession()
win.renameSession(...)    -> win.App.Session.renameSession(...)
win.deleteSession(id)     -> win.App.Session.deleteSession(id)
win.pinSession(...)       -> win.App.Session.pinSession(...)
win.branchSession(id)     -> win.App.Session.branchSession(id)
win.commitSessionTab(...) -> win.App.Session.commitSessionTab(...)
win.maybeAutoTitleSession -> win.App.Session.maybeAutoTitleSession
win.renderSessionTabs(...) -> win.App.SessionTabs.renderSessionTabs(...)
win.switchSession(id)     -> win.App.SessionActivation.switchSession(id)
```

删除 `session-ui.test.mjs` 中把 `global.loadSessions = win.loadSessions` 的兼容桥接；测试 setup 直接从 `win.App.Session` 获取实现。保留测试对 `win.App` 的访问，因为它是正式 facade。

- [ ] **Step 4: 删除生产旧发布**

删除 `dashboard-sessions.ts` 的“公开 API”中所有会话旧全局赋值。`window.newSession`、`window.renameSession`、`window.deleteSession`、`window.pinSession` 和 `window.branchSession` 也属于本阶段，必须删除；非会话全局入口保持不动。`App.Session` 绑定改为直接使用 `App.Session`，并保留其已有 API 赋值：

```ts
const AppSess = App.Session;
AppSess.loadSessions = loadSessions;
AppSess.getTabLabel = sessionTabLabel;
```

同时删除两处不再需要的兼容路径：`closeSessionTab()` 中没有独立用途的
`const T = (window as any).App?.Tabs`，以及 `AppSess.switchSession = switchSession`。
会话切换的唯一跨模块入口是 `App.SessionActivation.switchSession()`。

删除 `session-activation.ts` 的：

```ts
(window as any).switchSession = _switchSession;
```

从 `dashboard.d.ts` 删除对应 `Window` 属性和 `declare function` 声明；保留 `AppSession` 和 `AppSessionTabs` 正式接口。

- [ ] **Step 5: 运行最终门禁和会话回归**

运行：

```text
node scripts/tsx-test.mjs --test test/frontend-event-ownership.test.mjs test/chat-ui-state.test.mjs test/app-tabs.test.mjs test/session-ui.test.mjs test/session-restore.test.mjs test/session-activation.test.mjs
npm run typecheck:frontend
```

预期：旧入口门禁通过，所有会话行为测试通过，类型检查无错误。

- [ ] **Step 6: 提交**

```text
git add src/frontend/dashboard/dashboard-sessions.ts src/frontend/dashboard/session-activation.ts src/frontend/dashboard.d.ts test/app-tabs.test.mjs test/session-ui.test.mjs test/frontend-event-ownership.test.mjs
git commit -m "refactor: 删除会话旧全局入口"
```

## Task 6: 生成产物和全量验证

**Files:**
- Verify: `scripts/compile-frontend-ts.mjs`
- Verify: `src/frontend/gen/dashboard.js`（生成产物，不手改）
- Verify: all tests and typecheck

- [ ] **Step 1: 重建前端产物**

运行：

```text
npm run compile:frontend-ts
```

预期：bundle 拼接成功，`gen/dashboard.js` 不出现旧会话 `window.xxx` 发布，且 `dashboard-helpers` 的 App 初始化先于所有会话消费者。

- [ ] **Step 2: 执行前端测试**

运行：

```text
npm run test:frontend
```

预期：前端测试全通过。

- [ ] **Step 3: 执行类型检查和全量测试**

运行：

```text
npm run typecheck
npm test
```

预期：类型检查通过；全量测试通过；CSS 变量门禁通过。

- [ ] **Step 4: 检查工作区和生成差异**

运行：

```text
git diff --check
git status --short
```

预期：只存在本阶段产生的变更；不触碰用户原有的 `docs/desktop-capability.md` 修改。

- [ ] **Step 5: 实机验收**

在桌面端依次验证：启动恢复、创建会话并发送首条消息、多个会话快速切换、重命名/置顶/分支/删除、会话搜索、workspace 切换、Ctrl+R 和完全重启。DevTools 控制台不得出现 `App.Session.* is not a function`、旧全局未定义、会话重复标签或消息串会话。

- [ ] **Step 6: 记录最终验证结果**

`src/frontend/gen/` 当前未被 Git 跟踪，不提交生成文件，也不创建空提交。把编译、测试、类型检查、工作区状态和实机验收结果记录在最终报告中。

## 执行注意事项

- 每个 Task 完成后再进入下一个 Task，保持中间提交可回滚。
- 不使用 `git reset --hard` 或覆盖 `docs/desktop-capability.md`。
- 迁移期间允许 `dashboard-sessions.ts` 内部继续使用本地函数名；架构门禁只检查跨模块旧全局访问和发布。
- 如果类型检查暴露的是 facade 中已有运行时方法缺少声明，只补声明，不改变实现或行为。
