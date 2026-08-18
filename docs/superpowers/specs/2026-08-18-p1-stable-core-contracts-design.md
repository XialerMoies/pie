# P1 稳定核心契约设计

**日期：** 2026-08-18  
**状态：** 已确认，待实施

## 目标

在不重写 PI 的前提下，建立桌面端、服务端和 CLI 共同依赖的自有 `AgentEngine` 契约，固化跨层语义，清除前端 `window.__state` 及全部旧投影，拆分服务端启动与上下文职责，并让权限拒绝保持 fail-closed 同时更易理解和恢复。

## 设计决策

### 1. AgentEngine 防腐层

新增自有契约模块，PI 类型不得出现在桌面端、CLI、HTTP route 或前端边界。现有 `AgentRuntime` 不被重写，而由 `PiAgentEngineAdapter` 实现契约并负责：

- session 创建、恢复、切换 workspace、切换模型和释放资源；
- prompt、steer、follow-up、取消和 compaction；
- 将 PI 原始事件、usage、model metadata、错误和取消原因转成自有类型；
- 对未知 PI 事件只记录诊断，不向消费者透传未知结构。

`AgentEngine` 同时是桌面服务端和 CLI 的入口。第一阶段允许 adapter 内部继续调用现有 `AgentRuntime`，不做双引擎并行和 PI session 重写。

### 2. 核心语义

所有公开事件是 `version: 1` 判别联合，并包含 `sessionId`、`turnId`、单调 `seq` 和时间戳。turn 生命周期为：

```text
turn.started
  -> content/tool/usage/permission/diagnostic events
  -> turn.completed | turn.failed | turn.cancelled
```

终态互斥且只能出现一次。取消是幂等操作，取消成功后只允许 `turn.cancelled`，不能补发 `turn.completed`。

usage 固定字段为 `input`、`output`、`cacheRead`、`cacheWrite`、`reasoning` 和可选费用，并标记 `source: exact | mixed | estimated`。缺失费用保持 `unknown`，不能用零值伪造。

模型能力字段显式表示 `supported | unsupported | unknown`；上下文窗口、最大输出、图片输入和推理能力允许未知。

错误统一为 `AgentEngineError`，包含稳定 `code`、`category`、`retryable`、用户消息和可选内部 cause。Provider/PI 原始错误只留在 adapter/诊断日志中。

compaction 生命周期为：

```text
compaction.started -> compaction.completed | compaction.failed
```

完成事件携带压缩前后的 usage。普通 turn 取消不被解释成 compaction 失败。

### 3. 前端状态所有权

彻底删除生产代码和类型声明中的 `window.__state`、`window.__tabs` 及同义旧投影。状态归属如下：

- `ChatRuntimeStore`：消息、流状态、turn 和 usage；
- `TabStore`：文件、草稿、会话标签页和活动标签；
- `UiStateStore`：布局、面板和工作区 UI 持久化状态；
- `AppStateFacade`：仅协调 Store，不复制字段；
- 组件：通过 Store/Facade API 读写，DOM 只保存短期交互状态。

所有旧初始化、全局别名、兼容 getter/setter、测试夹具和声明均删除。新增源码门禁禁止重新出现这些投影名称。

### 4. 服务端边界

`server.ts` 收缩为启动入口。职责拆分为：

- `server-bootstrap.ts`：创建 engine、服务和依赖；
- `server-context.ts`：定义并构造完整分组上下文；
- `http-app.ts`：认证、安全头、correlation、静态资源和路由分发；
- `server-lifecycle.ts`：watcher、SSE、锁、子 Agent 和关闭清理。

上下文分为 `core`、`security`、`storage`、`providers` 和 `infra`。生产路由收到的分组依赖必须完整，不通过可选字段静默降级。测试可使用最小分组 fixture。

### 5. 权限反馈

权限和路径失败统一为结构化错误，至少包含 `code`、`category`、`decision`、用户消息、原因、操作、脱敏目标、`recoverable` 和建议动作。

前端将 `confirmation_unavailable`、`permission_denied`、`permission_confirmation_required` 和 `dangerous` 映射为不同反馈。可恢复错误提供重新连接、打开权限设置或按建议授权的动作；危险命令只说明硬拦截，不显示绕过按钮。完整路径和敏感命令不进入普通 UI。

任何确认通道缺失、响应断开、权限服务异常、路径越界和危险命令仍然 fail-closed。

## 测试策略

1. 先为自有契约、adapter 事件映射、终态互斥、usage 来源、取消和 compaction 写单元测试。
2. 为 CLI 和服务端增加 engine contract tests，使用同一测试套件验证 adapter 行为。
3. 迁移前端测试夹具到真实 Store，加入源码门禁确保生产 TypeScript 不包含旧投影。
4. 对拆分后的 bootstrap/context/http/lifecycle 增加结构测试和最小集成测试。
5. 为权限错误结构、中文反馈、恢复动作、断线 fail-closed 和危险拦截增加 route/frontend 回归测试。
6. 运行 `npm run typecheck`、`npm test`、`npm run build`、`npm run test:build`、`npm run test:electron:e2e` 和 `npm run release:check`。

## 非目标

- 不重写 PI SDK 或现有 AgentRuntime 的内部会话实现；
- 不在本阶段引入第二套并行引擎；
- 不改变安全策略来降低拒绝率；
- 不把 Provider 原始错误、PI 事件或绝对敏感路径暴露给前端。

