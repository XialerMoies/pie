# 自定义模型厂商设计

> 日期：2026-08-16
> 状态：已确认，待实施计划
> 范围：任务清单中的 E0-a 最小模型契约与“支持用户自定义模型厂商”

## 1. 目标

在设置页现有厂商列表中支持用户添加第三方中转 API，并让主会话和子 Agent 可以选择这些模型。

首版必须做到：

- 配置用户级全局厂商、Base URL、协议、凭据和多个模型。
- 支持手工模型 ID，并可从可选模型列表接口导入。
- 支持无需认证、API Key 和自定义 Header。
- 支持连接测试，但测试失败不阻止保存。
- 凭据不出现在普通列表响应、日志或错误信息中。
- 禁止覆盖官方厂商，禁止删除仍被使用的厂商或模型。
- 通过项目自己的模型契约接入 PI，不让设置页直接绑定 PI `models.json`。

## 2. 首版范围

### 2.1 支持的中转协议

首版支持 PI 0.84 中可以用 HTTP Base URL 和通用凭据表达的协议：

- `openai-completions`
- `openai-responses`
- `anthropic-messages`
- `google-generative-ai`
- `mistral-conversations`
- `azure-openai-responses`
- `pi-messages`

以下协议继续由官方厂商能力负责，不进入自定义中转首版：

- `bedrock-converse-stream`：需要 AWS SigV4。
- `google-vertex`：需要 Google Cloud 凭据和项目配置。
- `openai-codex-responses`：依赖专用 OAuth 和产品语义。

### 2.2 不做

- 不允许自定义厂商覆盖官方厂商。
- 不自动探测 Base URL 或模型列表。
- 不要求测试连接成功后才能保存。
- 不实现 AWS、Google Cloud 或 Codex OAuth 配置中心。
- 不向用户暴露完整 PI JSON schema。
- 不启动 `NativeAgentEngine`，也不重写 Agent 循环。

## 3. 架构决策

采用“项目自有配置 + PI 适配器”。

```text
Settings UI
  -> Custom Provider routes
    -> CustomProviderService
      -> CustomProviderStore            非敏感配置
      -> CustomProviderSecretStore      API Key / Header 值
      -> ProviderReferenceChecker       当前模型 / 默认模型 / 子 Agent 引用
      -> PiCustomProviderAdapter        当前 PI 实现
        -> ModelRuntime registration APIs
```

设置页、路由和数据文件只依赖项目契约。PI 类型和 `registerProvider()` / `registerNativeProvider()` 只允许出现在适配器及 SDK 合约测试中。

## 4. E0-a 最小契约

新增稳定契约，字段名称不跟随 PI 内部命名变化：

### `ProviderProtocol`

上述七种协议的判别联合。服务端通过能力目录返回可用协议和表单能力，前端不维护另一份协议真相。

### `CustomProviderDefinition`

包含：

- `id`：小写字母、数字和短横线组成的稳定 ID。
- `name`：用户可见名称。
- `protocol`：`ProviderProtocol`。
- `baseUrl`：绝对 HTTP(S) URL。
- `authMode`：`none` 或 `apiKey`；必须由用户明确选择。
- `headers`：只保存 Header 名称和凭据引用，不保存值。
- `modelDiscovery`：可选同源模型列表 URL。
- `models`：一个或多个 `ModelDescriptor`。

### `CustomProviderSnapshot`

包含顶层 `schemaVersion`、全局单调递增的 `revision` 和全部 `providers`。跨窗口比较的是整个快照的 `revision`，不是单个厂商版本；任意厂商或凭据变更都生成一个新 revision。

### `ModelDescriptor`

基础字段：

- 模型 ID、显示名称。
- 上下文窗口、最大输出 Token。
- 是否支持推理。
- 输入支持文本或文本加图片。

高级字段：

- 输入、输出、缓存读写价格；币种固定为 USD，计价单位固定为每百万 Token，与 PI `ModelCostRates` 和后续 CostLedger 契约一致。
- 采样参数。
- 受控的协议兼容选项。

模型在项目中的唯一身份始终是 `(providerId, modelId)`。

### `CredentialRef`

只描述用户级凭据位置和用途，不包含秘密值。API Key 和所有 Header 值都作为敏感数据保存。普通读取只返回是否已配置，不返回内容。

### Usage 契约

- `ProviderUsage` 表示单次 provider 响应提供的 input、output、cacheRead、cacheWrite 和可选 reasoning。
- 现有 `ContextUsageSnapshot` 继续表示上下文占用及 `exact`、`mixed`、`estimated` 精度来源。
- PI 适配器负责把 PI usage 转成 `ProviderUsage`，设置页和后续 CostLedger 不读取 PI 原始对象。

## 5. 数据存储

数据位于共享 `userRoot`，所有项目窗口共用：

```text
<dataRoot>/user/custom-providers.json
<dataRoot>/user/custom-provider-secrets.json
```

`custom-providers.json` 只保存非敏感配置，并作为事务提交点。`custom-provider-secrets.json` 保存按不可变 `CredentialRef` 索引的 API Key 和 Header 值；修改秘密时创建新引用，不覆盖旧引用。

写入规则：

1. 使用跨进程锁读取最新快照。
2. 完整校验新配置和引用关系，并分配新的全局 revision 与不可变凭据引用。
3. 先用临时文件 + 原子替换写入包含新旧引用的秘密文件，再原子替换配置文件；配置文件替换成功才算提交。
4. 配置提交后清理不再被引用的旧秘密。写入中断最多留下不可使用的孤立秘密，旧配置引用的秘密仍然存在。
5. 全部持久化成功后才通知当前运行时加载新 revision；失败时继续使用旧运行时快照。
6. 删除时先提交不再引用秘密的新配置，再清理孤立秘密，不留下指向缺失凭据的可用厂商。

现有官方厂商继续使用 PI `auth.json`。两类配置由服务层合并后提供给设置页。

## 6. PI 适配

`PiCustomProviderAdapter` 负责：

- 把七种项目协议映射到 PI API 名称。
- 把 `ModelDescriptor` 转为 PI 模型结构。
- 从凭据引用解析 API Key 和 Header，仅在运行时内存中组装。
- `authMode: apiKey` 使用 PI `registerProvider()`；`authMode: none` 使用 `registerNativeProvider()` 构造项目自有 Provider，其 `apiKey.check()` 报告本地配置可用，`apiKey.resolve()` 返回空 `ModelAuth`。请求不携带 API Key 或 Authorization，也不创建、保存或发送占位凭据。
- 将 PI 的 usage 和错误转换为项目契约。
- 在每次创建主会话或子 Agent session 时注册同一份自定义厂商快照。

不生成或修改 PI `models.json`。

## 7. 多窗口与热更新

每个窗口仍拥有独立 server 和 `ModelRuntime`，但共享用户级配置文件。

- 保存后，当前窗口空闲时立即重新注册厂商。
- 当前窗口正在流式生成时，持久化可以完成，但运行时切换排队到本轮结束。
- 其他窗口在读取模型列表、切换模型或发送下一条消息前读取配置文件头部的全局 revision；版本变化时，在继续操作前同步完整快照。
- 每个 server 记录 `loadedRevision`。同一进程内并发同步合并为一个 Promise，且只允许较新的 revision 替换当前运行时快照。
- 如果当前模型仍存在，运行时切换到刷新后的模型对象。
- 厂商或模型仍被当前会话、默认模型或自定义 Agent 引用时，禁止删除。

不依赖长期轮询，也不要求用户重启应用。

## 8. 设置页交互

### 8.1 共享新增组件

抽取无业务状态的 `ListAddAction`：

- 会话列表：“开启新对话”。
- 子 Agent 列表：“新建 Agent”。
- 厂商列表：“添加自定义厂商”。

组件统一加号图标、间距、hover、键盘操作和禁用态。三处业务模块只传入标签和 action，不复制 `.ch-new` HTML。

### 8.2 厂商列表

- 官方厂商与自定义厂商保留在同一列表。
- 自定义项显示简短“自定义”标识。
- 继续支持现有拖拽排序。
- 官方厂商沿用当前 Key 和模型选择界面，不显示协议、Base URL、Header 或删除操作。

### 8.3 自定义厂商编辑

基础区域：

- 显示名称。
- 厂商 ID。
- 协议。
- Base URL。

认证区域：

- “无需认证”或“API Key”。
- API Key 默认掩码，只有点击眼睛才单独请求明文。
- 可添加 Header 键值；Header 值不回传，只显示“已保存”，留空表示保留旧值。

模型区域：

- 支持一个厂商添加多个模型。
- 基础项直接显示；价格、采样参数和兼容选项放入折叠高级区域。
- 可选模型列表 URL。点击“获取模型”后导入 OpenAI-compatible `{ data: [{ id }] }`，用户确认后才写入草稿。

操作区域：

- “测试连接”和“保存”分开。
- 测试结果明确显示使用的模型、成功或脱敏后的失败原因。
- 删除只对自定义厂商可见，并采用二次确认。

## 9. API 设计

建议路由：

- `GET /api/custom-providers/capabilities`：协议、默认值和字段能力。
- `GET /api/custom-providers`：官方摘要与自定义厂商脱敏列表。
- `POST /api/custom-providers`：创建。
- `PUT /api/custom-providers/:id`：更新整个厂商草稿。
- `DELETE /api/custom-providers/:id`：删除并执行引用检查。
- `POST /api/custom-providers/reveal`：仅显式回显 API Key，不回显 Header。
- `POST /api/custom-providers/test`：隔离测试草稿。
- `POST /api/custom-providers/discover-models`：手动获取同源模型列表。

现有 `GET /api/models` 合并官方和自定义可用模型；`POST /api/model/switch` 继续只接受已注册的 `(providerId, modelId)`。

所有写路由继续经过桌面 API token、共享路径授权和审计边界。

## 10. 校验与安全

- 厂商 ID 禁止与官方厂商或已有自定义厂商重名。
- Base URL 必须是绝对 HTTP(S) URL，允许 localhost 和内网地址。
- 打开设置页不产生任何自定义网络请求。
- 模型发现只能由用户点击触发，发现 URL 必须与 Base URL 同源。
- 携带凭据的请求不得跟随到不同源重定向。
- Header 名称必须符合 HTTP token 规则；拒绝 `Host`、`Content-Length`、`Connection`、`Transfer-Encoding` 和代理控制类 Header。
- 同一厂商内模型 ID 不得重复。
- `maxTokens` 不得大于 `contextWindow`；Token 数必须为正整数；价格必须非负。
- 高级 JSON 只接受对象并限制大小，不允许函数、命令或环境变量展开。
- API Key、Header 值和 Authorization 内容必须从日志、异常、审计详情和测试快照中脱敏。
- `authMode: none` 必须显式选择，空 Key 不自动改变认证模式。

## 11. 连接测试与模型发现

连接测试使用隔离的临时 PI runtime 和内存凭据：

- 不修改当前会话。
- 不保存草稿。
- 15 秒超时并支持中止。
- 使用用户选择的模型发出最小请求。
- 测试可能产生少量 provider 用量，但不计入当前会话上下文。

模型发现：

- 只解析 OpenAI-compatible 模型列表响应。
- 不支持时返回明确状态，用户仍可手工录入。
- 导入只修改当前前端草稿，保存前可删改。

## 12. 错误处理

- 校验错误返回稳定字段路径，例如 `models[1].contextWindow`。
- 引用冲突返回结构化占用清单：当前模型、默认模型、自定义 Agent。
- 网络错误按 DNS、超时、TLS、认证失败、限流和上游响应分类，但响应正文必须截断和脱敏。
- 运行时重载失败时保留上一份可用快照，磁盘配置标记为待同步，并在下一安全边界重试。
- 配置文件损坏时 fail-closed：不注册受损自定义厂商，官方厂商继续可用，并在设置页显示可恢复错误。

## 13. 测试

### 单元测试

- 契约和字段校验。
- 配置与凭据脱敏。
- 跨进程锁、并发更新和失败回滚。
- 七种协议到 PI 的映射。
- 无认证、API Key、自定义 Header 和 usage 转换。

### 路由测试

- 增删改查和权限 fail-closed。
- 官方重名拒绝。
- 测试连接、同源模型发现和跨源拒绝。
- 当前模型、默认模型和子 Agent 引用阻止删除。
- 普通响应、日志和错误不包含秘密值。

### 前端测试

- `ListAddAction` 被会话、子 Agent 和厂商三处使用。
- 新建草稿、多模型编辑、高级项和 Header 掩码。
- API Key 只在点击眼睛后 reveal。
- 测试失败不阻止保存。
- 引用占用清单和保存失败状态。

### 集成测试

- 本地假 provider 覆盖七种协议的配置映射。
- 至少验证流式文本、工具调用、真实 usage 和中止。
- 两个独立 server 共享配置，并在下一请求前同步 revision。
- 主会话和子 Agent 使用相同自定义模型快照。

### 手工验收

1. 新增中转厂商和两个模型。
2. 测试连接、保存并切换模型。
3. 完成一轮包含工具调用的聊天。
4. 重启应用并确认配置恢复。
5. 让自定义 Agent 使用该模型。
6. 验证被引用的模型和厂商无法删除。
7. 在另一窗口修改配置，确认当前窗口下一请求前同步。

## 14. 实施分批

1. E0-a 契约、数据布局、存储和校验。
2. PI 适配器、运行时同步和协议合约测试。
3. CRUD、连接测试、模型发现和引用检查路由。
4. `ListAddAction` 共享组件，并迁移会话和子 Agent。
5. 自定义厂商设置页和前端测试。
6. 双 server 集成、全量门禁和手工验收。

每批必须独立通过测试，不把 UI、存储和运行时接入压成一次不可审计的大提交。
