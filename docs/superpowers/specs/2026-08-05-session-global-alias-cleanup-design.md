# 会话全局兼容入口清理设计

日期：2026-08-05
状态：已确认，待实施计划

## 背景

早期审查将 `dashboard-sessions.ts` 中约 50 处 `(window as any).App.*` 视为一项大型全局状态债务。经过 TabStore、SessionRestore 和 SessionActivation 重构后，这一判断已经过时：该文件目前只有两处 `(window as any).App`，主要业务代码已经通过有类型的 `App.*` facade 访问会话状态和行为。

当前真正的遗留问题是会话 API 同时发布为两套入口：

- 类型化入口，例如 `App.Session.loadSessions()`、`App.SessionTabs.renderSessionTabs()` 和 `App.SessionActivation.switchSession()`；
- 旧全局入口，例如 `window.loadSessions`、`window.renderSessionTabs` 和 `window.switchSession`。

部分前端模块和测试仍读取旧入口，导致同一个能力存在两套调用约定，`dashboard.d.ts` 也必须同时维护 facade 类型和全局函数声明。新增代码容易继续依赖 `window.xxx`，模块所有权不清晰。

前端当前由 `scripts/compile-frontend-ts.mjs` 按固定顺序拼接 classic scripts，最终生成单个 `gen/dashboard.js`。本阶段不迁移构建系统，不把整个前端改成 ES Module 或依赖注入架构。`window.App` 继续作为当前构建方式下唯一的类型化应用 facade。

## 目标

- 会话相关跨文件调用统一通过类型化 `App.*` facade。
- 删除会话功能的旧 `window.xxx` 发布和对应类型声明。
- 保留现有会话行为、初始化顺序、错误处理和界面表现。
- 增加架构门禁，防止会话旧全局入口重新出现。

## 非目标

- 不删除 `window.App`。
- 不迁移 `dashboard.js` 拼接构建方式。
- 不引入 ES Module、依赖注入容器或新的状态管理框架。
- 不清理 Electron、Monaco、HTML 公共函数等非会话全局接口。
- 不重新划分 `App.Session`、`App.SessionTabs`、`App.SessionRestore` 和 `App.SessionActivation` 已有职责。
- 不改变会话 CRUD、恢复、激活、搜索、标题和标签行为。

## API 归属

跨文件调用按以下 facade 归属：

| 能力 | 唯一入口 |
| --- | --- |
| 会话列表、创建、重命名、删除、置顶、分支、草稿提交、自动标题 | `App.Session` |
| 会话标签 ID 读写、活动标签写入、标签渲染 | `App.SessionTabs` |
| 当前活动会话读取 | `App.Tabs` |
| 恢复启动和恢复完成等待 | `App.SessionRestore` |
| 会话激活和切换 | `App.SessionActivation` |
| 会话标签显示名称 | `App.Session.getTabLabel(id)` |

`dashboard-sessions.ts` 内部函数继续保持本地函数形式，同文件内部可以直接调用；只有跨文件调用必须经过 `App.*`。`App.Session` 中已有的少量转发方法暂时保留，避免本阶段同时进行 facade 职责重构。

## 调用方迁移

本阶段迁移以下模块：

- `dashboard-chat.ts`：删除旧全局优先、facade 兜底的双轨逻辑，直接调用 `App.Session`、`App.SessionTabs`、`App.SessionRestore` 和 `App.Tabs`。
- `dashboard-layout.ts`、`layout-tabs.ts`：通过 `App.Session.getTabLabel()` 获取会话标签标题。
- `dashboard-menus.ts`：通过 `App.SessionTabs.renderSessionTabs()` 和 `App.Session.loadSessions()` 刷新会话 UI。
- `dashboard-startup.ts`：启动完成后通过 `App.Session.loadSessions()` 首载会话。
- `dashboard-helpers.ts`：TabStore 找不到标签时通过 `App.SessionActivation.switchSession()` 走既有降级路径。
- `chat-token.ts`：通过 `App.Tabs.getActiveSessionTabId()` 读取当前会话。
- `pane/chat/index.ts`：会话搜索使用 `App.Session.loadSessions()`、`bumpSessionListSeq()` 和 `isCurrentSessionListSeq()`。
- 其他搜索发现的会话旧全局消费者按同一归属机械迁移。

## 发布入口清理

消费者迁移完成后，删除 `dashboard-sessions.ts` 和 `session-activation.ts` 中对应的会话全局发布，包括但不限于：

- `window.loadSessions`
- `window.bumpSessionListSeq`
- `window.isCurrentSessionListSeq`
- `window.readSessionTabIds`
- `window.writeSessionTabIds`
- `window.sessionTabLabel`
- `window.commitSessionTab`
- `window.maybeAutoTitleSession`
- `window.getActiveSessionTabId`
- `window.setActiveSessionTabId`
- `window.ensureDraftSessionTab`
- `window.whenSessionRestoreReady`
- `window.renderSessionTabs`
- `window.switchSession`

会话 CRUD 的 `window.newSession`、`window.renameSession`、`window.deleteSession`、`window.pinSession` 和 `window.branchSession` 同样迁移到 `App.Session`。当前 HTML 不通过内联事件调用这些函数，前端事件使用委托或显式监听器，因此无需保留 HTML 兼容入口。

`dashboard-sessions.ts` 直接使用已初始化的 `App.Session` 绑定 API，不再通过 `(window as any).App?.Session` 获取。`closeSessionTab()` 等位置直接使用 `App.Tabs`，删除无意义的 `window.App` 回退。

## 初始化时序

`dashboard-helpers.ts` 在 bundle 前部创建 `App` 及其空的 `Session` facade；`dashboard-sessions.ts` 在 bundle 后部绑定具体实现；独立加载的 `dashboard-startup.js` 在整个 `dashboard.js` 执行完成后才启动页面。因此启动脚本调用 `App.Session.loadSessions()` 时，实现已经绑定。

迁移不得在模块顶层立即执行尚未绑定的会话方法。事件处理器和普通函数可以保留延迟调用；现有启动顺序不变。若测试单独加载消费者模块，测试环境必须提供与生产相同形状的 `App` facade，而不是注入旧 `window.xxx`。

## 类型清理

- 在 `AppSession` 中增加 `getTabLabel(id: string): string`。
- 保留各 facade 当前正式方法，避免本阶段产生第二次职责迁移。
- 从 `Window` 和全局 `declare function` 区域删除已移除的会话旧入口。
- 业务代码不再使用 `(window as any).App`；统一使用全局类型化的 `App`。

## 错误与降级行为

本阶段不新增错误处理。原有行为保持：

- 会话激活仍由 `App.SessionActivation` 的序列守卫和失败恢复负责。
- 恢复仍由 `App.SessionRestore` 的单例 Promise 和用户交互守卫负责。
- 标签状态仍以 `App.Tabs`/TabStore 为唯一来源。
- 会话列表请求失败、自动标题失败和 CRUD 失败继续使用现有 toast 或静默策略。

旧入口删除后不保留运行时双轨兜底。初始化错误应在测试或启动时直接暴露，而不是悄悄退回另一套全局 API。

## 测试策略

### 现有测试迁移

将测试中的 `win.loadSessions()`、`win.commitSessionTab()`、`win.switchSession()` 等调用改为正式 facade。测试断言保持不变，确保只是入口变化而不是行为变化。

重点回归：

- 启动恢复已有会话和活动标签；
- 新建草稿并发送首条消息后绑定真实 session；
- 快速切换会话时旧响应不能覆盖新会话；
- 会话关闭、删除、置顶、分支和重命名；
- 自动标题和标签标题更新；
- 会话搜索的请求序列守卫；
- workspace 切换后的标签和会话列表重置；
- 刷新和重启后的 UI 状态一致性。

### 架构门禁

新增源代码扫描测试：

- 禁止在 `src/frontend` 新增已移除的会话 `window.xxx` 读写；
- 禁止在 `dashboard.d.ts` 重新声明这些全局函数；
- 允许 `window.App`、`window.__monaco`、Electron bridge 等明确不在本阶段范围内的全局接口；
- 允许 `dashboard-sessions.ts` 内部本地函数直接互调，不强制同文件也经过 facade。

### 验证命令

- 相关前端会话测试；
- `npm run test:frontend`；
- `npm run typecheck`；
- `npm test`；
- 前端生成文件重建与 bundle 语法校验。

## 实机验收

1. 启动应用，确认上次会话和活动标签正常恢复。
2. 新建会话并发送首条消息，确认不会额外生成错误标签或拆分会话。
3. 在多个会话间快速切换，确认消息、标题和活动标签一致。
4. 执行重命名、置顶、分支、删除和关闭标签，确认列表与主区域同步。
5. 使用会话搜索并快速修改关键词，确认旧结果不覆盖新结果。
6. 切换 workspace，确认旧会话标签被清理，新 workspace 会话正常加载。
7. 执行 Ctrl+R 和完全重启，确认恢复状态与迁移前一致。
8. DevTools 控制台无 `App.Session.* is not a function` 或旧全局未定义错误。

## 完成标准

- 生产源码不再发布或读取本设计列出的会话 `window.xxx`。
- 会话跨模块调用统一使用类型化 `App.*`。
- `dashboard.d.ts` 不再维护对应旧全局声明。
- 架构门禁、前端测试、类型检查和全量测试通过。
- 实机验收无会话行为回归。
