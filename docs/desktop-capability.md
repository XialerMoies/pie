# 桌面端能力清单（与 Claude Code CLI / 桌面 IDE 差距分析）

> 更新时间：2026-08-05 · 基于当前工作区（测试 1193/1193）
> 本地文档

## 已完成

### 编辑器

| 能力 | 实现 | 结论 |
|---|---|---|
| Monaco 编辑器 | 语法高亮、多语言、中文补全 fallback | 持平桌面 IDE |
| TypeScript 语言服务 | 真实 Node tsserver 子进程：诊断/补全/悬停/跳定义/找引用/格式化/code-actions | 持平 |
| 中文 Monaco 文案 | nls.messages.zh-cn + body-level 翻译 observer（ObserverOwner 管理，重建主动断开） | 持平 |
| 多文件标签 | TabStore + 标签栏（关闭/拖拽/右键/更多操作）；标签/会话切换竞态 seq 守卫收口；更多标签菜单窗口适配（长标题省略 + 关闭按钮常显） | 持平 |

### 面板

| 面板 | 实现 |
|---|---|
| Explorer | Tree 组件 + 右键菜单 + 拖放 + SSE 变更刷新（tombstone 调和删除竞态） |
| Chat | 会话列表 + 对话搜索 + 激活跳转 |
| Search | 文件名/全文搜索 + 批量替换 + 对话搜索 |
| Git | 变更列表 + commit/push/pull + 打开文件 |
| MCP | 服务器列表 + 状态枚举验证 + 信任管理 |
| Permissions | 权限中心：审计 + 规则 + 确认通道 |
| Problems | 底部问题面板（经 App.State 取 workspace） |

### 聊天与数据

| 能力 | 实现 |
|---|---|
| 流式渲染 | SSE 节点级 diff 渲染 + block/delta/thinking/done/error |
| Markdown 安全 | renderer 级转义原始 HTML + 拒绝 javascript:/data:/file: URL + decode 二次检查 |
| ChatStream 生命周期 | 代际隔离 EventSource（addEventListener + 存引用），旧连接事件不污染当前聊天 |
| SSE 重放 | 服务端 id 帧 + 512 历史上限 + 首连 baseline + Last-Event-ID 缺口重放 + 每轮重置 |
| 应用事件总线 | 单一认证 `/api/events` 连接覆盖 Explorer、Dashboard、Token、MCP；事件只通知失效，数据仍由 REST 获取；每次 `onopen` 触发全量 `resync`；Chat SSE 独立 |
| 事件所有权门禁 | 源码级测试：dashboard 文件无 `.on*=` 赋值、无 `__state/__tabs` 直读 |
| Token Rail + Usage | 用量抽屉 + 压缩弹窗 |

### 状态架构（本轮治理核心成果）

| 项 | 实现 |
|---|---|
| 状态 facade | App.Tabs / ChatState / Preferences / UiStateStore / ProblemsStore |
| `__state` 归零 | 业务模块零直读；残余仅兼容投影（chat-runtime-store/chat-stream/tab-store 内部） |
| localStorage 归零 | 实际访问仅 Preferences 实现 + UiStateStore 迁移层 |
| UI 状态持久化 | /api/ui-state 服务端持久化（schemaVersion=2，localStorage 一次性迁移） |
| bundle 顺序门禁 | services 先于消费者加载；smoke 语法检查拼接产物 |

### Electron / Windows

| 项 | 实现 |
|---|---|
| 安全加固 | contextIsolation + sandbox + webSecurity + 最小 preload 白名单 |
| IPC 治理 | 全部 handler 校验 sender 为主窗口 + 可信 URL |
| 可信根 | TrustedDesktopRoots + realpath 校验（trash/reveal） |
| 打包 E2E | 发布版 HTTP 探针：token/文件读写/外部读/workspace 切换/路径穿越/单窗口 |
| 测试基建 | scripts/tsx-test.mjs 解决沙箱 os.userInfo() ENOMEM |

### 测试现状

| 套件 | 数量 | 说明 |
|---|---|---|
| Frontend | 199 | 渲染快照、会话/工作区 UI、事件所有权、状态存储、MCP 状态、应用事件总线、事件流增量渲染、标签菜单/主题切换 |
| 打包 E2E | 独立 release gate | packaged-electron.e2e.mjs（需先打包） |

> 全量 1193/1193（unit 728 + routes 266 + frontend 199），typecheck 通过

## 未完成（与桌面 IDE 差距）

| 能力 | 状态 | 优先级 |
|---|---|---|
| 分屏（split editor） | ❌ 单例编辑器，一次一个文件 | 中 |
| 标签脏标记（`*` 未保存提示 / 关闭确认） | ❌ dirty 字段定义了但从未使用 | 中 |
| 快捷键配置 | ❌ 硬编码 + 帮助数组 | 低 |
| 内置终端面板 | ❌ 仅外挂 CLI（spawnTerminal） | 低 |
| Git 交互（暂存/回滚/查看 diff） | ❌ 仅 status/commit/push/pull | 中 |
| Quick Open 智能（最近文件/目录过滤/首字母排序） | ❌ 基础 overlay | 低 |
| Timeline 滑块（对话快速定位） | ❌ 规划中（纯前端） | 低 |
| Monaco 诊断事件化 | ⚠️ 仍保留独立 3 秒诊断轮询，不属于本轮应用事件总线迁移范围 | 低 |
| 主题首屏预读 | ⚠️ 刻意保留一次早期 localStorage 读取（避免闪白） | 刻意保留 |
| 非 Markdown innerHTML | ⚠️ 已按数据来源审计，静态模板保留（形式主义不清零） | 低 |

## 一句话差距结论

**桌面端的功能面已接近轻量 IDE（编辑器 + 语言服务 + 面板 + 权限中心），状态治理与应用事件总线已收口；剩余差距集中在“IDE 生产力细节”（分屏/脏标记/快捷键/终端）和独立的 Monaco 诊断事件化，以及远期远程执行。**
