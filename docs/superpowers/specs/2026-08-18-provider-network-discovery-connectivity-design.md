# Provider Network Discovery and Connectivity Design

## 背景

自定义厂商设置目前把模型发现和连接测试绑定在一个较窄的实现上：模型发现要求用户手填路径，连接测试要求已有模型并向聊天接口发送 `ping`。这导致常见的 OpenAI 兼容服务无法自动获取模型，也会把网络可达、认证、路径、模型和聊天协议问题混成一个失败结果。

本次改动只覆盖自定义厂商设置中的两条网络能力：模型列表发现，以及轻量连接探测。保存、运行时模型契约、密钥存储和模型切换协议保持不变。

## 目标

- 用户不填写模型发现路径时，也能从常见 Base URL 自动尝试模型列表端点。
- 模型发现请求沿用当前协议的认证头和自定义 Header，并保持同源与密钥脱敏约束。
- “测试连接”只验证网络可达性，不发送模型生成请求、不要求先填写模型、不消耗模型额度。
- 测试结果能区分网络失败与“服务已到达但 HTTP 状态不表示配置可用”。
- 保留现有的用户确认导入、请求取消、保存密钥复用和 revision 行为。

## 非目标

- 不新增供应商预设目录或为每家供应商维护硬编码配置。
- 不把模型发现结果直接写入配置；仍由用户确认后导入并保存。
- 不在本次改动中新增真实模型请求测试按钮。
- 不放宽跨源请求、重定向或响应体大小限制。

## 方案

### 模型发现

`ProviderNetworkClient.discoverModels` 继续作为唯一的网络入口，但把单一 URL 改为候选 URL 流程：

1. 用户填写的 `modelDiscovery` 非空时，只尝试该路径，作为明确覆写。
2. 留空时根据 Base URL 生成去重后的候选：
   - Base URL 已以 `/vN` 版本段结尾时，追加 `/models`。
   - 其他 Base URL 追加 `/models` 和 `/v1/models`，按更可能成功的顺序尝试。
   - Base URL 以常见兼容子路径（如 `/anthropic`、`/claude`、`/api/anthropic`）结尾时，再追加剥离该子路径后的 `/models` 与 `/v1/models` 候选。
3. 每个候选都必须是 HTTP(S)、且与 Base URL 同源；禁止自动跟随重定向。
4. 对 404/405 继续尝试下一个候选；401/403、429、其他 HTTP 错误和传输错误立即返回分类错误。
5. 成功响应只接受 OpenAI 风格 `{ data: [{ id: string }] }`，去重、去空白、限制响应体大小；所有候选都失败时返回稳定的 `upstream` 错误，不把上游响应正文暴露给前端。

认证头沿用现有协议映射：Anthropic 使用 `x-api-key`，Azure 使用 `api-key`，其余 API Key 协议使用 `Authorization: Bearer ...`；自定义 Header 覆盖同名默认头。`none` 认证和仅 Header 认证继续支持。

前端在发现动作中自动把 Base URL 转换为上述请求候选所需的请求草稿；不再要求用户先展开高级设置填写路径。发现成功后仍只添加未存在的模型 ID，并要求用户确认导入。

### 轻量连接探测

新增与模型生成解耦的 `probeConnection` 网络流程，`testConnection` 对外 API 名称可保持不变以避免路由和前端调用扩散：

- 请求方法为 `GET`，目标为用户配置的 Base URL。
- 使用当前协议认证头和自定义 Header，设置与模型发现一致的超时和请求生命周期信号。
- 收到任何 HTTP 响应都表示网络层可达，结果包含 `httpStatus` 和 `latencyMs`。
- 2xx 表示服务响应正常；401/403 显示鉴权失败；404/405 显示服务可达但路径可能不正确；429 和 5xx 显示服务可达但上游拒绝或异常。
- 只有 DNS、TLS、超时、连接拒绝、调用方取消等网络级错误才是不可达失败。
- 不创建临时模型运行时，不调用 `completeSimple`，不要求 `models` 非空。

连接结果在既有 `ConnectionTestResult` 上扩展状态信息，前端不再只按 `ok === false` 判断失败，而是根据可达性、HTTP 状态和错误代码显示明确反馈。调用方仍可通过 `ok` 判断探测请求是否完成于网络层。

### 安全与生命周期

- Base URL 和模型发现路径继续拒绝用户名、密码、非 HTTP(S) 协议和跨源 URL。
- `redirect: manual` 保持不变；不向重定向目标发起第二次请求。
- API Key、自定义 Header 值、模型 ID 中可能出现的密钥片段在网络错误、前端结果和测试断言中都必须脱敏。
- 请求取消、组件卸载和服务端响应关闭仍通过 `AbortSignal` 结束操作，后台 Promise 不得产生未处理 rejection。

## 数据流

```text
设置表单
  -> 读取 Base URL / 协议 / 认证 / Header
  -> POST /api/custom-providers/discover-models 或 /test
  -> custom-provider-service 解析草稿与已保存密钥
  -> ProviderNetworkClient
       -> 生成候选模型端点，或 GET Base URL
       -> 协议认证头 + 自定义 Header
       -> 分类 HTTP / DNS / TLS / timeout 结果
  -> 前端显示结果
  -> 模型发现经用户确认后追加到表单
```

## 错误处理

错误代码沿用现有 `dns`、`timeout`、`tls`、`authentication`、`rate_limit`、`upstream`、`aborted`。模型发现的 `unsupported_response` 仍只作为内部解析错误使用，并映射为对外稳定的上游失败。连接探测额外携带 `httpStatus` 和 `reachable`，使 HTTP 错误不再伪装成网络不可达。

前端显示遵循以下优先级：

- `reachable === false`：显示网络错误代码和稳定消息。
- `reachable === true` 且状态为 2xx：显示连接成功和延迟。
- `reachable === true` 且状态为其他状态：显示“服务可达”以及 HTTP 状态和对应原因。

## 测试

先添加失败测试，再实现代码。覆盖范围包括：

- 留空模型发现路径时，`/models`、`/v1/models`、版本段和兼容子路径候选的顺序、去重与成功回退。
- OpenAI、Anthropic、Azure 认证头、自定义 Header 覆盖和 Header-only 认证。
- 401/403、404/405、429、5xx、无效 JSON、空模型列表、超大响应体、重定向、跨源 URL。
- 连接探测无需模型即可执行，只发送一次 GET，不调用运行时或 `completeSimple`。
- 连接探测对 HTTP 401/404/500 返回可达结果，对 DNS/TLS/超时/取消返回不可达结果。
- 前端在没有模型和没有显式发现路径时能发起发现；连接结果按可达性和 HTTP 状态显示。
- 现有保存、密钥复用、模型导入确认、请求取消和敏感信息脱敏测试保持通过。

验证命令：`npm run typecheck`、相关单测、`npm run test:routes`、`npm run test:frontend`，最后运行完整 `npm test`。
