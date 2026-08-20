# Spawn 与环境变量治理设计

**日期：** 2026-08-20  
**范围：** Task 2（spawn 与环境变量治理）

## 目标

让每类子进程只继承完成任务所需的环境变量，避免把桌面认证 token、Provider API key 或其他无关凭据传给 MCP、工具进程和未来的外部 agent，同时保持 Windows 用户命令、CLI 终端和项目开发工具的现有可用性。

完成后必须满足：

1. capability catalog 中所有真实 spawn 点都有稳定的 category 和 owner；MCP 的间接 stdio spawn 也有明确事实记录；不存在的外部 agent spawn 不虚构实现。
2. 用户命令和 CLI 终端继续使用开发者的 PATH、包管理器、编译器和自定义变量，但移除桌面认证及内部控制变量。
3. MCP 只获得基础运行变量和配置显式声明的变量；宿主中的无关 API key 不会自动进入 MCP。
4. tsserver、内部 server、Electron 辅助进程拥有彼此独立的环境构造策略。
5. 子进程 stdout/stderr、异常文本、旧 console 边界和诊断输出中的凭据经过同一套小型脱敏函数。

## 非目标

- 不引入全局环境 allowlist/denylist 配置平台。
- 不做自动秘密发现、密钥轮换、权限沙箱或 AST 重写平台。
- 不改变用户命令的权限语义、shell 选择和 Git Bash 兼容行为。
- 不实现外部 agent provider；只有真正出现 child process 边界时才复用本设计。
- 不把所有日志一次性迁移到新框架，只覆盖本任务触及的子进程和异常边界。

## 方案选择

### 方案 A：全局 allowlist

为所有子进程构造统一的最小环境 allowlist。安全边界最清晰，但会破坏用户的开发工具链、自定义编译器变量和 Windows 配置，维护成本也会随工具链增长。

### 方案 B：全局敏感变量正则删除

继续复制 `process.env`，统一删除 `KEY|TOKEN|SECRET` 等名称匹配项。改动小，但会误删用户正常变量，也无法表达 MCP 的显式凭据或内部 server 的桌面 token，不能满足分类治理。

### 方案 C：按进程类型的显式策略函数（推荐）

从宿主环境进入几个小而明确的函数：`user-command`、`mcp`、`tsserver`、`internal-server`、`electron-helper`、`external-agent`。每个函数只做该类别所需的保留/覆盖/删除，并共享一个文本脱敏入口。推荐 C：边界清楚、改动集中，既能阻断凭据横向传播，也能保留 Windows 开发体验，不建立新的治理框架。

## 架构与数据流

```text
宿主 process.env
       |
       +--> createUserCommandEnv       --> command.ts spawn
       +--> createMcpProcessEnv        --> StdioClientTransport
       +--> createTsserverEnv          --> ts-server.ts fork
       +--> createInternalServerEnv    --> server-binding.ts spawn
       +--> createElectronHelperEnv    --> CLI/辅助进程
       +--> createExternalAgentEnv     --> 未来真实外部 agent 边界

子进程输出/异常 --> sanitizeProcessOutput(text, knownSecrets) --> logger/UI/test output
```

策略函数放在一个小型、无框架依赖的 agent/server 共用模块中；如果现有模块边界不适合共享，则保留同一组纯函数接口，避免再建配置 DSL。函数只接受明确的输入对象并返回新的 `NodeJS.ProcessEnv`，不得原地修改 `process.env` 或调用方传入对象。

### 环境策略

| 类别 | 继承 | 明确添加 | 明确移除/禁止 |
|---|---|---|---|
| 用户命令 | 宿主环境 | Windows Git Bash 兼容 PATH | `MY_CODE_AGENT_DESKTOP_TOKEN`、`PI_*` 内部控制变量、`ELECTRON_RUN_AS_NODE` |
| CLI 终端 | 宿主环境 | CLI 启动所需 `ELECTRON_RUN_AS_NODE`、`PI_WORKSPACE`、`PI_DATA_ROOT` 和 Windows 启动变量 | 桌面 token、其他 `PI_*` 内部实例变量 |
| MCP stdio | 基础运行环境（至少 `PATH`、必要的 `SystemRoot/ComSpec/TEMP/TMP` 等平台变量） | `config.env` 中显式声明且值为字符串的变量 | 宿主 Provider/API key、桌面 token、未在配置中声明的秘密 |
| MCP HTTP/SSE | 不创建子进程；请求只使用配置 URL/headers | 配置显式 headers | 日志中的 URL 查询、Authorization、Cookie 等凭据 |
| tsserver | 宿主非秘密开发工具变量 | `TS_INTERNAL` 和项目根相关变量 | 桌面 token、Provider/API key、内部 server 实例 token |
| 内部 server | `spec.env` 经内部策略过滤后的环境 | 全部 `PI_*` 运行变量、`MY_CODE_AGENT_DESKTOP_TOKEN`、`PI_ELECTRON_PARENTED`、`ELECTRON_RUN_AS_NODE` | 不将该环境复用于用户命令/MCP |
| Electron 辅助进程 | 仅辅助进程所需的 Electron、实例和平台变量 | 由调用点显式传入的启动变量 | 桌面 server token，除非该辅助进程就是受保护的内部 server |
| 外部 agent | 当前无实现 | 未来由 provider 明确声明的基础变量 | 默认不继承宿主秘密 |

“基础运行环境”不是全局正则删除结果，而是按平台和用途定义的少量稳定变量；开发者希望传给 MCP 的凭据必须写入该 MCP 的 `env` 配置，不能靠宿主继承。

## Capability catalog 接缝

保持 Task 0 的生成式目录，不引入 AST：

- 为 `src/server/routes/git.ts` 增加显式 owner/category 映射，消除 `unassigned`。
- 为 `src/agent/mcp/MCPClientService.ts` 增加一个标注为 `mcp` 的间接 stdio spawn fact，说明实际由 `StdioClientTransport` 创建子进程。
- 将脚本、Electron、server、command、tsserver 的 owner 映射集中在生成器的小型事实表中；生成器仍只扫描代码文本并输出确定性 JSON。
- catalog 只记录事实（文件、行号、API、category、owner、是否间接），不记录环境中的秘密或完整变量名。
- CI 继续使用 `capabilities:check`，并增加 `owner === "unassigned"` 的失败断言。

## 脱敏与错误处理

复用 `redactMetadata` 的字段识别和 Bearer/token 规则，补一个面向文本的 `sanitizeProcessOutput`：

- 接受文本和本次 spawn 已知的敏感值；先替换已知值，再处理 Bearer、常见 API key/token、密码和 cookie 形式。
- 对 URL 只保留路径和非敏感查询参数；MCP headers/env 永不直接写日志。
- tsserver、server-binding、MCP 连接错误、命令 shadow diff 和 CLI 启动错误在输出前调用该函数。
- 保留退出码、signal、category、request/trace correlation 等诊断事实；删除或替换原始 stdout/stderr 中的秘密。
- 脱敏函数失败时返回固定 `[redacted]` 或空文本，不因日志处理异常放行进程。

环境构造失败遵循现有 fail-closed 原则：拒绝启动对应子进程并返回可诊断的非敏感错误；不回退到全量 `process.env`。

## 测试与验收

先写单元测试，再改实现。测试重点：

1. 用户命令/CLI 保留自定义 `PATH`、包管理器变量和工作区变量，同时移除桌面 token 与内部 `PI_*`。
2. MCP 不继承 `OPENAI_API_KEY`、`ANTHROPIC_API_KEY`、`GITHUB_TOKEN` 等宿主变量；显式 `config.env.GITHUB_TOKEN` 仍传入；HTTP/SSE 凭据不出现在状态、错误和日志。
3. tsserver 保留 `PATH`、`TS_INTERNAL` 和项目工具变量，移除桌面 token/API key。
4. 内部 server 保留桌面 token 与全部规定的 `PI_*`，且与用户命令/MCP 环境对象相互独立。
5. 每类 spawn 的错误、stdout/stderr 和测试快照不含原始 secret、Bearer、cookie 或密码。
6. 生成器输出包含 MCP 间接事实，所有 spawn 点有 category/owner，`capabilities:check` 和 catalog owner 门禁通过。
7. 现有 command、MCP、server-binding、tsserver、CLI、observability 测试全量回归；不改变 Linux 分支的既有行为。

## 分阶段实施边界

1. 先添加纯策略/脱敏函数及其测试，不改 spawn 调用。
2. 逐类接入用户命令、MCP、tsserver、内部 server、Electron CLI；每类接入后运行对应测试。
3. 最后更新生成器/catalog、旧输出边界和发布门禁测试。

任何需要扩大到 Provider 认证重构、Windows sandbox 或外部 agent 进程实现的工作，都不属于 Task 2，应另立任务。
