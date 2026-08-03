# 统一应用 SSE 事件总线设计

日期：2026-08-04
状态：已确认，待实施计划

## 背景

桌面端目前同时存在多路周期请求：

- Dashboard 每 3 秒请求 `/api/dashboard`
- Token Rail 每 6 秒请求 `/api/usage/current`
- MCP 已安装面板每 6 秒请求 `/api/mcp/servers`
- Monaco diagnostics 每 3 秒请求当前文件诊断

仓库已经有 `/api/events` SSE 通道，Explorer 使用它接收文件变更通知和路径权限确认。Explorer 的模式也是“事件通知数据已变化，随后通过 REST 读取最新数据”，因此本阶段升级现有通道，不新建第二套应用事件连接。

本设计的目标是移除 Dashboard、Token、MCP 三路轮询，并把 Explorer 迁移到共享的前端事件服务。Chat 流和 Monaco diagnostics 不属于本阶段。

## 决策

采用通知型总线：SSE 只发布小型失效通知，前端继续调用现有 REST 接口取最新数据。

不采用完整数据快照事件，原因如下：

- REST 已经是 Dashboard、Token 和 MCP 数据的唯一组装口径。
- 在 SSE 发布处重复组装数据会形成两套序列化与错误处理逻辑。
- 桌面端本地 REST 请求成本低，真实变更时多一次请求可以接受。
- 断线重连后执行全量 REST 恢复，比维护事件历史更简单可靠。

## 范围

### 本阶段包含

- 将 `/api/events` 升级为统一应用 SSE 通道。
- 服务端增加统一事件 Hub、类型和发布入口。
- 前端增加唯一的 `App.Events` EventSource 所有者。
- 将 Explorer 的文件刷新和路径确认迁移到 `App.Events`。
- 以事件替换 Dashboard、Token、MCP 的周期请求。
- 保留各 REST 接口，承担首载、事件后刷新和断线恢复。
- 更新测试与能力文档。

### 本阶段不包含

- Chat SSE。`/api/chat/stream` 有逐块流式、单轮状态、事件 ID 和重放语义，继续独立。
- Monaco diagnostics。它属于当前文件和 tsserver 生命周期，后续单独改为编辑、切换文件和 tsserver 事件驱动。
- 应用事件历史重放。普通状态事件通过重连全量恢复解决。
- 修改 Dashboard、Token、MCP REST 响应的数据口径。

## 整体架构

### 服务端 AppEventHub

新增轻量 `AppEventHub`，职责只有：

- 注册和移除 SSE 响应连接。
- 生成单调递增的 `revision`。
- 广播结构化应用事件。
- 清理已关闭或写入失败的连接。

`/api/events` 继续经过现有桌面端鉴权。现有 `sseClients` 裸数组和各处分散写入改为通过 Hub 操作。Agent/MCP 模块不反向依赖 server 模块；MCP 状态变化通过可订阅回调或注入的发布函数通知 server。

事件包格式：

```ts
interface AppEvent<T = unknown> {
  type: AppEventType;
  revision: number;
  payload?: T;
}
```

`revision` 用于日志、测试和客户端去重，不承担断线历史重放。

### 前端 App.Events

新增 `App.Events` 服务，成为 `/api/events` 唯一的 `EventSource` 所有者，并提供：

```ts
App.Events.start(): Promise<void>
App.Events.subscribe(type, handler): () => void
App.Events.resync(): void
```

服务继承 Explorer 当前连接治理能力：

- generation 守卫，旧连接事件不能污染当前页面。
- 5 秒首次握手超时信号。
- 显式清理监听器和旧连接。
- 依赖 EventSource 自动重连。

握手超时只让 `start()` 报告通道暂不可用，不销毁仍在自动重连的当前 EventSource。每次连接重新打开后仍可恢复正常。

Explorer 删除自有 EventSource 和连接状态，只保留领域逻辑，通过 `App.Events` 订阅文件刷新和权限确认。

## 事件契约与发布点

### `dashboard.changed`

收到后刷新 `/api/dashboard`。发布点：

- 回复开始和结束，更新忙闲状态与消息数量。
- 创建、打开或切换会话。
- 切换工作区。
- 切换模型。
- 修改思考级别。
- MCP 重连后工具集合变化。

文件系统普通变更不发布 `dashboard.changed`，因为 `/api/dashboard` 没有对应的文件状态字段。

### `usage.changed`

收到后刷新 `/api/usage/current`。发布点：

- 回复开始和结束。
- 创建、打开或切换当前会话。
- 切换工作区。
- 压缩开始和结束，包括失败后的状态恢复。

Token 不按流式 chunk 发布。用量统计只在上述业务边界刷新，避免事件洪水和无意义的中间请求。

### `mcp.changed`

收到后使 MCP 已安装列表失效。发布点：

- `_setStatus` 导致对外可见状态真实变化。
- disconnect 清空连接和状态。
- toggle、trust、install、uninstall 成功修改配置。
- 工作区切换导致 MCP 配置或运行时状态变化。

MCP 面板保持懒加载。面板关闭时只记录 dirty；打开“已安装”页时立即请求 `/api/mcp/servers`。面板打开时收到事件则立即刷新。

### `explorer.changed`

替代现有 `{ type: "refresh" }`，携带可选文件名。继续使用服务端文件监听的 500ms 合并策略。Explorer 收到后执行现有目录树刷新，并保留编辑节点时跳过刷新、pending delete 调和等行为。

### `permission.confirm`

替代现有 `{ type: "permission_confirm" }`，保留完整确认载荷。它是需要立即处理的业务事件，不通过 REST 回拉。连接断开时仍取消绑定到该响应的确认并 fail-closed，不补发旧确认。

## 请求合并与竞态

Dashboard、Token、MCP 的 REST 刷新都使用同一类 single-flight 语义：

- 同类数据同时只允许一个请求在途。
- 请求在途期间再次失效，只记录一次 pending。
- 当前请求结束后若 pending 为真，最多补拉一次。
- 旧响应不能覆盖后发刷新得到的新状态。

该策略同时吸收首次主动加载与首次 `resync` 的重复触发。

## 启动与重连

启动顺序：

1. `bootstrapApi()` 完成桌面端鉴权。
2. 各领域模块注册 `App.Events` 订阅。
3. 启动唯一应用事件连接，确保工作区同步期间可接收路径权限确认。
4. 同步上次工作区。
5. 工作区切换成功后，由服务端发布相关失效事件，刷新正确工作区数据。
6. 继续执行现有会话标签恢复流程。

Dashboard 和 Token 启动时仍主动请求一次，不能只依赖 SSE 首开。MCP 继续在面板首次打开时请求。Explorer 继续在有工作区时加载。

`resync` 的触发时机是每一次 `EventSource.onopen`：既包括首次连接，也包括 EventSource 自动重连后的再次打开。收到 `resync` 后，各已激活订阅者通过 REST 全量恢复：

- Dashboard 和 Token 立即刷新。
- Explorer 在工作区存在且当前不处于禁止刷新状态时刷新。
- MCP 面板已打开时刷新，否则标记 dirty，打开时刷新。

应用总线不实现事件历史。断线期间遗漏的普通失效事件由 `resync` 全量恢复覆盖。

## Dashboard 运行时长

`/api/dashboard` 当前返回进程运行秒数。移除 3 秒轮询后，前端在收到响应时记录 `runtime` 与本地接收时间；系统信息渲染时使用该基准加本地经过时间计算。该方案不修改 REST 数据结构，也不新增网络轮询或计时器。

## 错误处理

- SSE 连接失败不启用周期轮询兜底。
- 首次 REST 请求与 SSE `resync` 相互独立，首屏仍能显示数据。
- EventSource 错误后交由浏览器自动重连。
- 5 秒未完成首次握手时记录告警，但保留当前连接继续重试。
- 单个订阅处理器异常不能中断其他订阅者。
- REST 刷新失败保留最近一次成功数据，后续事件或重连可再次刷新。
- 服务端广播时忽略并清理已结束连接。

## 分阶段实施

每阶段独立提交：

1. 服务端 `AppEventHub`、事件类型、`/api/events` 接线和发布点测试。
2. 前端 `App.Events` 单连接服务，覆盖 generation、握手超时、`onopen -> resync` 和订阅隔离。
3. Explorer 迁移到共享总线，保留权限确认和文件刷新行为，删除自有 EventSource。
4. Dashboard、MCP、Token 接入事件，加入请求合并并删除三处轮询。
5. 全量验证、能力文档同步和实机验收。

Monaco diagnostics 作为后续独立 Phase 2 设计和实施。

## 自动化验收

- 页面生命周期内只创建一个 `/api/events` 连接；Chat SSE 不计入。
- Dashboard、Token、MCP 目标文件不再存在周期刷新。
- 每个服务端业务变更点发布正确事件。
- `revision` 单调递增，关闭连接会从 Hub 移除。
- 连续同类事件只产生一轮 REST；在途期间再次变化时最多补拉一次。
- 每次 `onopen` 都触发 `resync`，包括自动重连。
- generation 守卫阻止旧连接处理事件。
- Explorer 文件刷新、编辑节点保护和路径授权确认无回归。
- MCP 面板关闭时不请求，重新打开后显示最新状态。
- Token 在回复开始/结束、切换会话和压缩后更新。
- Dashboard 的模型、思考、忙闲、工具、消息数和运行时长显示正确。
- `npm test` 和 `npm run typecheck` 全部通过。

## 实机验收

1. 打开 DevTools Network，确认应用只保持一个 `/api/events` 连接，Chat 回复期间另有独立 `/api/chat/stream`。
2. 空闲 30 秒，确认不周期请求 `/api/dashboard`、`/api/usage/current`、`/api/mcp/servers`。
3. 发送消息，确认忙闲和 Token 在开始/结束边界更新。
4. 切换会话、工作区、模型和思考级别，确认 Dashboard 与 Token 数据更新。
5. 打开 MCP 面板，执行配置或连接状态变化，确认列表更新；关闭面板时无 MCP 请求，重开后状态正确。
6. 修改工作区文件，确认 Explorer 自动刷新；触发路径授权，确认确认框正常工作。
7. 模拟 `/api/events` 断开后恢复，确认再次 `onopen` 触发全量恢复且 UI 无状态空洞。
