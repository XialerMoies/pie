# 功能与缺陷 Backlog

> 更新时间：2026-08-14
> 维护：每项完成 / 定稿后更新状态

## ① 待修缺陷（正确性 / UI 定位，先清）

| ID | 描述 | 范围评估 | 状态 |
|---|---|---|---|
| B-11 | bundle 顶层函数重名遮蔽——UI 状态与偏好 hydrate 同名被覆盖，导致标签/UI 状态无法恢复（`App.State.hydrate` 返回布尔非状态对象） | 重命名 + 编译期 AST 门禁防回流 | ✅ 已解决，见 [bug-log.md](bug-log.md#B-11) |
| B-10 | 会话切换竞态打崩 server——切换时 _session 置空，并发 dashboard 请求读空 session 抛异常 | Runtime 等待 transition + Dashboard 未就绪返回 503 | ✅ 已解决，见 [bug-log.md](bug-log.md#B-10) |
| B-9 | 重启后工作区重置为空——随机 instanceId → userData 丢失 localStorage，且前端从未从 /api/bootstrap 恢复 | 服务端 last-workspace 持久化 + bootstrap 恢复 workspace | ✅ 已解决，见 [bug-log.md](bug-log.md#B-9) |
| B-8 | dev 模式返回 403 bad_token——Electron 生成 token 与 dev.mjs server 不一致 | Electron 复用注入的桌面 token（VITE_DEV_PORT 条件） | ✅ 已解决，见 [bug-log.md](bug-log.md#B-8) |
| B-7 | 回复中"..."等待效果离节点组件太近，且与事件节点流竖线/圆点同一左右，应在其右侧 | 纯 CSS 定位 | ✅ 已解决，见 [bug-log.md](bug-log.md#B-7) |
| B-6 | 新会话标签页对话后，会话框不立即出现对应会话 | 会话被误删（persistent:false） | ✅ 已解决，见 [bug-log.md](bug-log.md#B-6) |
| B-5 | 事件节点流中正文可多次出现，但末尾节点必须是正文节点 | 事件流线性化 + 四轮收尾 | ✅ 已解决，见 [bug-log.md](bug-log.md#B-5) |
| B-4 | 缓存命中率疑似不准确 | 口径漏 input（DeepSeek 恒 100%） | ✅ 已解决，见 [bug-log.md](bug-log.md#B-4) |

## ② 快速功能（纯前端，定义较清晰）

| ID | 描述 | 范围评估 | 状态 |
|---|---|---|---|
| F-8 | 回到最新：圆形组件 + 向下箭头，非最新回复时出现，点击回最新 | 标准 chat UX；判定 = 滚动位置 < 最新节点；纯前端 | ✅ 已完成（`5cf99ee`，实机验收通过） |
| F-1 | Timeline 滑块：横向小格（每次回复一格），可上下滑动，悬停变长变蓝，滚轮滑动会话记录；位置会话页居中高度右侧、滑动条左侧 | 纯前端，中等；与 roadmap 的 Timeline 同源 | ✅ 已完成（`5587121`，前端 162 项 + 实机验收） |
| F-3 | 设置页增加相关功能参数修改 | 依附于 F-1/F-8/外观的开关与参数；实际还含权限面板移入 Settings（mount/unmount + 竞态防护 + YES 确认） | ✅ 已完成（`26c46a9`，前端 237 项） |
| F-2.1 | 外观统合：自定义背景 / 皮肤 | CSS 变量已就位（--bg/--bs 等 + theme-light），加用户覆盖层 + 设置 UI | 待办 |
| F-4 | 任务中接收用户补充：运行中输入框不锁死，消息走 SDK 原生 steer/followUp——当前步骤工具跑完后、下一个 LLM 调用前注入，agent 看到补充并回应（**不打断**）；支持"做完再处理"（followUp）模式 | 三层接线：服务端 `POST /api/chat/note` → `runtime.session.steer/followUp` + SSE 转发 `queue_update` + 前端输入框改造（Enter=补充投递、中止独立按钮）；补充消息作为 `user_note` block（noteId + queued/delivered/failed 状态机） | ✅ 已完成（实机验收通过：补充送达、followUp 排队、工具不中断、中止正常、消息不重复） |

**F-4 设计要点**（2026-08-04 定稿，对比 Claude Code 源码后确认）：

- **机制不用自造**：pi-agent-core 主循环已内置——steer 在内层循环轮询 `getSteeringMessages()`，当前轮工具跑完后、下个 LLM 调用前注入 context（[agent-loop.js](node_modules/@xiamol/pi-coding-agent/node_modules/@earendil-works/pi-agent-core/dist/agent-loop.js)）；followUp 在外层循环、整个任务结束后才查。比 Claude Code 的"入队 + 条件打断（abort('interrupt')）"更贴合"不中断"语义
- **三层接线**：① `POST /api/chat/note`（`{message, mode?:"steer"|"followUp"}`）→ `runtime.session.steer/followUp()`；② SSE 转发 SDK 的 `queue_update` 事件（前端显示"N 条补充已送达/排队中"）；③ 前端运行中输入框 Enter=投递补充（不再中止），中止独立成按钮，补充渲染为对话流一条用户消息（SDK 会持久化到 session 文件）
- **提示词一句**：system prompt 加"运行中用户可能实时补充——简短确认、判断是否调整当前步骤，除非明确要求改方向否则别打断关键步骤"
- **可选增强（MVP 后）**：Claude Code 式排队消息合并（运行中多条补充合成一次 ask）；模型过度反应实测后再调
- **不依赖 ⑥ 事件总线**，SDK 已内置事件，随时可做

## ③ 扩展/插件系统（下一阶段主线）

**定位**：以上大饼全部降级为"可选扩展插件"，前提是先把扩展/插件系统做出来。项目已有接缝（ToolRegistry/defineAgentTool/registerPane/MCP trust-store/Preferences），插件系统是形式化 + 扩展这些接缝，而非从零建。

**第一版最小 API 面**：
- Plugin manifest（name/version/entry/声明能力）
- registerTool（走 ToolRegistry → 自动过 authorizeToolExecution）
- registerPane（走 registerPane）
- registerCommand（slash 命令）
- registerMCP（复用 MCP 连接 + 信任）
- hooks（生命周期）

**信任模型**：建议指纹信任（MCP trust-store 先例，首次确认后信任）+ 手动安装即信任；插件权限仍受 authorizeToolExecution 管。

**四类插件映射**：
| 插件形态 | API | 说明 |
|---|---|---|
| 外观（自定义背景/皮肤） | 主题/资源注入 + 参数 schema | 给开发者准备参数文档 |
| 功能增强（魔改内置） | 扩展/钩子 API | 用户自行增强 |
| 功能新增（SSH/社交） | registerTool | SSH=用户配连接+权限，agent 经插件 tool 访问服务器定位问题（tool 级集成，非远程 FS） |
| 额外支持（安卓/iOS/鸿蒙 VM） | 封装 ADB/simctl/HDC 的 tool 插件 | 与 SSH 同构 |

## ④ 并发与编排（三个能力，按优先级排）

> 说明（2026-08-09 更新）：原"多会话并发"拆成两个不同形态——
> **④-A 多窗口多项目** = 单 Electron 主进程管理多个项目窗口，每项目独立 server 子进程和 AgentRuntime——已交付
> **④-C 单窗口单项目多会话** = 一个窗口内同一项目多个会话同时跑——场景窄，正确形态被 ④-B 覆盖，**降级低优先级**
> **④-B 单会话多 agent 编排** = 一个对话内主导 agent 派生子 agent 分工——**核心 feature，④ 的本意**

### ④-A 单主进程多窗口、多项目 server 隔离（已交付，packaged E2E 通过）

**准确定义（2026-08-09）**：一个 Electron 主进程持有 `WindowManager`，每个项目窗口有独立 `WindowContext`、server child（随机端口）和 AgentRuntime；空窗口不启动 server。第二次启动 executable 通过 single-instance 转发到已有主进程，不再创建第二个 Electron 主进程。每窗口仍是单项目、单会话，不包含 ④-C 的单窗口多会话。

设计依据：[Single-Process Multi-Window Design](superpowers/specs/2026-08-08-single-process-multi-window-design.md)。Task 1-10 的数据/锁/实例隔离基础继续保留；Task 8 完成 E2E 与文档从“多 Electron 进程”到“单主进程多窗口”的迁移。

**自动化验收（2026-08-09，Windows packaged 实测）**：

- A/B 两个项目窗口共享同一 Electron PID，各自 server PID、端口、token fingerprint、workspace 和 instance root 均不同。
- 空窗口选择已打开项目时聚焦已有窗口；空窗口保持 `serverKind=none`，窗口数和 server child 数不变。
- 关闭或 crash B 仅影响 B server；A 的 `/api/dashboard` 保持 200 且不 reload。立即 reopen B 会等待 disposal，不出现 `workspace_locked`。
- 第二次 executable launch 被转发到同一 Electron PID。
- 时序取同一 `contextId + event` 在生命周期边界后的首个事件，避免误取 crash recovery 事件。最终实测：shell visible - created **124 ms**（门限 <300 ms）；workbench loaded - selected **1564 ms**（门限 <3000 ms）。
- diagnostics 仅写入 `E2E_MODE` result file；token 只输出 SHA-256 fingerprint，不暴露 raw token，也没有生产 HTTP diagnostic。

**启动参数（必须明确）**：

- `my-code-agent.exe --workspace "E:\project-a" --data-root "E:\pie-data" --instance-id "instance-a"`
- server 在初始化 runtime、权限根、MCP 和 session 目录前解析 `--workspace` / `--data-root` / `--instance-id`，不依赖启动后的 workspace switch。

server 与 AgentRuntime 仍按项目隔离在独立子进程内，因此 server 侧进程级单例不会跨项目共享。`multi-instance-e2e` 继续覆盖两个独立 server 进程的数据与安全隔离；packaged Electron E2E 覆盖单主进程下的窗口生命周期和 server child 编排。

**已落地的数据划分**：

| 实例私有 | 用户共享 |
| --- | --- |
| port/token/cache 等进程临时状态 | auth、model 配置、MCP 配置、trust store、项目级 session/usage/权限/UI 状态 |

```text
<dataRoot>/user/
<dataRoot>/workspaces/<workspace-hash>/
<dataRoot>/instances/<instance-id>/
```

默认 `<dataRoot>` 为 exe 旁的 `data/`；设置页可选择非 C 盘目录，Electron OS user-data 仅保留 `data-root.json` 指针。共享用户配置已使用跨进程锁；同一 canonical workspace 通过 owner lock 保证单写。旧会话仅在设置页明确预览并确认后复制，源文件不删除、目标文件不覆盖。

不同项目可通过“文件 → 新建窗口”，再在新窗口中“打开文件夹”并行运行；也可再次启动 executable 并携带 `--workspace`，由现有主进程创建或聚焦对应窗口。单窗口同项目多会话并发仍不支持，归入 ④-C。

### ④-B 单会话多 agent 编排（核心 feature，④ 本意）

**定位**：一个对话内主导 agent 派生子 agent 分工，各自并行探索/评审，结果汇回主对话。这是打 Claude Code 的 Coordinator/子 Agent 编排差距的**产品主线 feature**（不是可选项）。

**形态**：

- 并行 fan-out：审计/迁移/方案对比，多 agent 分头探索后收敛
- 会议/辩论：高风险设计决策，1 主导 + N 评审相互批评后收敛（judge panel / 对抗评审）

**关键事实：PI SDK 无子 agent 能力**。SDK `core/tools` 只有 bash/edit/find/grep/ls/read/write 等基础工具，上游 Claude Code 的 AgentTool/TaskCreate/TeamCreate 未被 fork 带过来。项目 `types.ts` 里"Coordinator 权限隔离（子 Agent 只能调 isReadOnly 的 tool）"仅是 AgentTool 接口的权限字段设计，不是运行时。

**实现路径（修正 2026-08-06：不能同进程多 runtime，走子 agent worker 进程）**：

当前进程有全局状态（globals `_currentRuntime`、tools MCP cache、MCPClientService 全局连接池、server 全局权限/SSE/确认），**同进程起多个 runtime 会互相覆盖全局状态**。"基于 AgentSession 起独立实例、不动单活内核"不成立。稳妥路径：

```text
主 AgentRuntime
  └── Task 工具
        └── Subagent Worker 进程
              └── 一个 AgentRuntime / AgentSession
```

子 agent 通过 IPC 或本地协议回传：`started` / `tool_trace` / `text_delta` / `completed` / `failed` / `aborted` / `usage`。这样天然隔离 `_currentRuntime`、MCP 连接池、chat stream、权限确认、workspace cwd、token usage。若坚持同进程多 runtime，必须先显式化全局 runtime/MCP/权限/工具上下文，复杂度明显上升。

**实现路径步骤**：

1. Subagent Worker 进程封装：一个子进程 = 一个 AgentRuntime/AgentSession，跑一次性任务
2. Task 工具：主 agent 调用的 tool，负责 spawn/管理 worker 进程、并发、收集回传事件
3. 编排层：会议 / judge panel / 流式收敛（在主进程聚合各 worker 的回传）
4. 权限隔离：子 agent 工具权限复用已有授权模型（isReadOnly / authorizeToolExecution）

**token 预算约束（第一设计约束，乘法不是加法）**：

- **模型选择是 30 倍成本杠杆**：同一 450k 会议 ≈ $0.5（DeepSeek）/ $3（Sonnet）/ $16（Opus）；同一 20 轮团队 ≈ $12 / $78 / ~$400。选模型比预算上限还狠
- **不对称角色 = 经济地基**：1 个主导（最强模型）+ 2-3 个评审（最廉价 provider，只给短评）；甚至默认全 DeepSeek 档
- **发起前成本预估（硬需求）**：选好参与者（模型 × 预计轮数）→ UI 先显示 `~$X` → 用户确认才开跑
- **运行中实时预算表（硬需求）**：做成 **CostLedger**，到上限自动中止
- **按需发起不默认**：正常开发单 agent，"开会"只在架构决策/评审/方案对比时手动调用
- **流式/异步**：结果边跑边出

**CostLedger 必须独立于 usage-index（修正 2026-08-06）**：现有 usage-index 主要记录 token usage，不足以直接算 $X。成本预估还需：provider/model 输入输出价格表、cache read/write 价格、不同模型计费单位、子 agent 独立 usage 汇总、汇率/币种显示策略、未知模型价格处理、预算超限的原子中止。**不要把 usage-index 当成本数据库**。

**估算（分阶段）**：只读 fan-out MVP 3-4 周；带实时流/预算/中止/权限隔离 4-6 周；带会议/judge/共享上下文 6-10 周。

### ④-C 单窗口单项目多会话同时跑（降级，低优先级，待观察）

**定位**：一个窗口内同一项目开多个会话标签，各自独立对话同时流式——"A 跑长任务时切去 B 用"。

**为什么降级（2026-08-06 产品判断）**：

- **coding/vibe coding 场景需求窄**：同一项目两个 agent 同时改 → 文件竞争、互相覆盖，串行更安全；vibe coding 是单主线对话，F-4（运行中补充）已覆盖"让 agent 别停"的痛点
- **注意：不完全是 ④-B 的覆盖**（2026-08-06 修正）——④-B 是"主 agent 帮用户协调子 agent"，④-C 是"用户自己管理多个独立任务"，产品体验不同（一个是委托协调，一个是用户主动并行）。当前 coding 场景先不做可以接受，但不要把 ④-C 说成完全被 ④-B 替代
- **结论**：优先级最低，留作技术储备；若产品扩展出 coding（多任务工作台/通用 agent），届时再评估是否仍需要"用户自管多会话"这种形态

**正式路线图（2026-08-06 定稿）**：

```text
④-A 单主进程多窗口、多项目 server 隔离（已交付）
  → ④-B 只读子 agent fan-out（3-4 周）
  → ④-B 预算/中止/权限/会议（4-6 周）
  → 观察需求后再决定 ④-C
```

**技术储备（保留调研，未来需要时直接用）**：

- 架构现状：runtime 单 session / chatStream 全局单对象 / 前端 ChatState 单例
- 参考：VS Code `ChatModelStore` 引用计数模型池 + per-session 队列（"跨会话并发、单会话串行"）——业界唯一做对的参考
- SDK 能力核实："后台挂起"不成立——SDK 无 pause()，abort() 只 abort AbortController 不留恢复状态，continue() 在最后一条是 assistant 时 throw（agent.js:235-246）
- 三种方案：视图切换保留（中）/ 后台继续运行（高）/ 真正暂停恢复（高，需 SDK 配合）
- 改造面：Session Registry + 每 session 独立 runtime + SSE 带 sessionId + 前端 per-session + 引用计数四态（UI 引用/正在运行/后台保活/可释放）+ 工作区文件竞争
- 估算：MVP 4-6 周；并发状态/持久化/确认/工作区冲突全稳定 6-10 周

## ⑤ 运行态感知与元素定位（agent 视觉/实机对接，核心 feature）

**定位**：agent 对**正在运行的项目**有持续的感知——不是"用户让我看我才看"，而是 agent 一直看着运行态：dev server 崩了、console 报错了、页面某处坏了，**agent 是第一个发现的**（预防/实时，而非事后修）。这是从"改代码的 agent"到"会测 app 的 agent"的关键一步。

**三窗口信号源（以本项目为例，从启动到运行）**：

| 窗口 | 信息源 | agent 怎么拿 |
|---|---|---|
| powershell 启动窗口 | dev server / 构建的实时输出（崩溃/报错/失败） | 捕获启动子进程 stdout/stderr → 读日志 tool + 事件 |
| dev tool 窗口 | console 错误、network 失败 | Electron `webContents.debugger`（CDP）监听 consoleAPICalled / network.loadingFailed |
| 软件主窗口 | 视觉问题（布局/渲染） | 用户辅助定位（元素选择器）或 LLM 视觉（若模型有） |

**主动监控机制**：agent 持续订阅三个信号源（推送式），新错误/崩溃/失败事件到达 → agent 主动介入排查。不是轮询、不是等用户报告。

**元素定位 + 批注（主窗口辅助定位）**：
- 主窗口注入 inspect 模式，用户点击有问题的组件 → 捕获元素信息（选择器 + DOM 快照）
- **组件的代码 + 用户批注作为上下文传入输入框**——复用现有"拖文件到输入框"的 attachment 机制（点击组件 ≈ 拖入一个"带批注的组件上下文"）
- 源码映射（DOM → 组件文件）为加分项，非前置

**技术要点**：
- 运行态信号走 **AppEventHub（统一 SSE 事件总线，⑥）**——总线扩展承载 terminal.new-output / console.error / network.failed，agent 感知是推送式
- Electron `webContents.debugger` + CDP 是标准协议，构建量可控
- 子进程 stdout/stderr → ring buffer + 读日志 tool + 事件
- 权限体系门控：**观察**（读 console/日志）放行，**交互**（点击/导航/执行）按模式确认
- 浏览器视图可内置（webview）也可外部（MCP/Playwright）

**模型约束（硬性，先写进设计）**：主窗口视觉观察依赖 LLM 视觉能力——当前默认 DeepSeek 无视觉则主窗口走"用户辅助 + DOM 快照"，截图/像素观察留到有视觉模型时。powershell + devtool 两个窗口的信号**不依赖视觉，先行**。

**实现基础**：AppEventHub（设计已确认）+ Electron debugger 协议 + 子进程管理（已有 spawnTerminal）+ attachment 机制（已有）+ 权限体系（已有）。

## 建议执行顺序

1. **第一批（本周可清）**：B-7 → B-6 → B-5 → B-4（先查清口径再改）
2. **第二批（快速功能）**：F-2.1 外观（F-8 / F-1 / F-3 / F-4 已完成）
3. **第三批（扩展/插件系统）**：设计 Plugin API + 信任模型 → 最小加载器 + 一个 demo 插件验证路径
4. **第四批（④-B 单会话多 agent 编排）**：核心 feature，排在 SSH 前（打 CC Coordinator/子 Agent 差距）；先搭子 agent 运行时（AgentSession 独立实例 + Task 工具）→ 会议/judge panel → 预算上限 + 不对称角色。④-C 单窗口多会话并发继续保持低优先级。
5. **第五批（插件形态大饼）**：SSH / VM / 社交 作为插件逐个做（依赖 ③ 就绪）；E-COMPUTER 依赖多模态模型，最末
6. **第六批（统一 SSE 事件总线）** ✅ 已完成：三路轮询清零 + 文件监听跟随工作区 + 实机验收 7/7
7. **第七批（运行态感知 + 元素定位，⑥ 已就绪）**：三窗口信号捕获（powershell 子进程日志 + devtool CDP console/network，主窗口靠用户辅助或视觉）+ 元素选择器点击组件注入代码与批注进输入框（复用 attachment）

## 完成记录

（每完成一项，在此追加一行：日期 / ID / 简述 / 验证）

- 2026-08-09 / ④-A Task 8 / 单 Electron 主进程多窗口迁移：每项目独立 server child/AgentRuntime；duplicate workspace 聚焦、close/crash/reopen 隔离、second-instance 转发与 E2E-only diagnostics / Windows packaged E2E 通过，shell 124 ms、workbench 1564 ms
- 2026-08-14 / 技术债 / server 事件路由抽离：`runtime.onEvent`、trace/block 持久化、assistant block 组装移入 `agent-event-router.ts`，`server.ts` 保持启动编排入口；新增结构防回流测试 / typecheck、事件定向 49 项、unit 1016 项、全量 npm test 通过
- 2026-08-14 / 技术债 / `settings.ts` 路由职责拆分：入口降为薄 dispatcher，auth/models/preferences/storage/subagents/thinking/layout 分模块；新增 settings-route-structure 防回流 / typecheck、settings 定向 27 项、unit 1015 项通过
- 2026-08-08 / 设置页 / 文案中文化 + 弹窗尺寸自适应 + 存储布局重构：Permissions→权限、Smooth/Immediate→平滑滚动/立即到达、标题"回到最新位置效果"；弹窗随窗口 78vw/82vh（全屏 1280×880）；存储位置 grid 布局 + 长路径省略 + 按钮不折行 + 移动端适配 / 前端 261 项 + 实机验收
- 2026-08-08 / 性能 / dev 启动并行化 + 可观测化：移除双编译、Monaco 纯文本兜底、content-ready 埋点；server 提前 spawn 与编译并行、bootstrap 对 5xx/网络退避重试（403 仍即时失败）/ 窗口 6.4s→3.1s、内容可用 ~3.5s，前端 260 项 + 实机验收
- 2026-08-08 / 测试 / 测试并行化：routes 并发度 4 + workspace-lock 独立串行（跨进程锁测试不能并行）、防回流门禁 / 全量 1:44→1:06，routes 330 项
- 2026-08-08 / 精简 / 移除无引用旧实现两批：findAllJsonl/findSessionFileById/searchConversations/parseLogVerbose/statusLabel/legacyUsageIndexFile；session-workspace.ts/focusChatView/_ensureInit 空实现 + 调用点 / 净删约 200 行，全量测试 + typecheck + 防回流门禁
- 2026-08-08 / B-8~B-11 / 四个缺陷修复：dev token 403、重启后工作区重置、会话切换竞态打崩 server、bundle 顶层函数重名遮蔽 / 各自回归测试 + 实机验收，详见 bug-log.md
- 2026-08-08 / ④-A / 多实例多项目进程隔离 Task 1-10：数据隔离（user/workspaces/instances）+ 跨进程锁 + 实例安全 + 启动/迁移 UX + 重启持久化 + E2E 两轮 packaged 验证 / 实机验收通过（并行项目运行、dev token 一致、重启恢复工作区）

- 2026-08-06 / F-4 / 任务中接收用户补充：运行中 Enter=steer 补充、可切 followUp"做完再处理"、独立中止按钮；补充作为 user_note block（noteId 状态机）即时显示，SDK 持久化；SSE 转发 queue_update；运行中补充处理提示词 / 前端 245 项 + 路由 270 项 + 实机验收（补充送达、工具不中断、中止正常、消息不重复）
- 2026-08-06 / ⑥ / 统一 SSE 事件总线：Dashboard/Token/MCP 三路轮询清零，文件监听跟随活动工作区 + 展开目录局部刷新；实机验收 7/7（含权限模式切换、MCP 面板状态保持）
- 2026-08-06 / F-3 / 设置页会话阅读控制：Timeline/Jump 参数即时生效，权限面板移入 Settings（mount/unmount 竞态防护 + YES 确认），策略弹窗拆分（模型菜单接管思考深度、策略菜单承载对话方式与权限切换）/ 前端 238 项 + typecheck

- 2026-08-03 / F-8 / 回到最新：滚动离开底部 72px 显示圆形按钮，点击平滑回底后恢复自动跟随；阅读历史时流式不强制拉回 / 前端 153 项通过 + 实机验收（长对话向上滚动、持续生成不拉回、点击回底、确认框不遮挡、窄窗口自适应）
- 2026-08-03 / F-1 / 会话时间线：右侧折叠 34px 轨道，hover 展开提问目录（最多 9 轮居中），点击定位、滚轮逐轮跳转、滚动同步当前轮；会话切换/恢复/分支/清空/重置同步 / 前端 162 项 + 实机验收（长对话逐轮定位、窄窗口不遮挡滚动条/输入区）
