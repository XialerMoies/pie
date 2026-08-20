# Task 1：可信技能系统 MVP 设计

> 状态：已完成
> 日期：2026-08-19
> 范围：第一阶段 Task 1

## 目标

在现有自定义 Agent 和 ToolRegistry 之上，支持人工编写、人工安装、明确授权、按需加载的本地 SKILL.md。技能提供可复用的方法说明，但不增加工具能力，不改变权限边界，也不成为新的插件运行时。

## 设计原则

- 文件是技能内容的事实来源；信任和启用状态单独保存。
- 工作区技能属于项目，应用级技能属于用户配置。
- catalog 只保存摘要和状态，不保存正文。
- 只有 trusted + enabled + valid 的技能正文可以进入模型上下文。
- 每次正文加载都重新校验路径、解析结果、状态和工具声明，不盲信缓存。
- 所有工具调用继续经过现有 ToolRegistry、permissionMode、路径授权和危险命令强制拦截。
- 状态文件损坏、来源不明、解析失败或工具不满足时，不加载正文、不自动启用。
- 第一版只做可解释的本地文件和状态管理，不引入插件平台、远程市场或自动化创作。

## 严格边界

Task 1 包含：

- 扫描应用级和工作区级本地 SKILL.md；
- 解析最小 frontmatter 和 Markdown 正文；
- 生成技能摘要并接入 Task 0 的 skills catalog；
- 保存、读取和校验信任/启用状态；
- 人工信任、取消信任、启用、禁用、删除和重新扫描；
- 按需加载已信任且已启用技能正文；
- 校验技能声明的工具均存在于现有 ToolRegistry；
- 设置页和管理接口所需的最小服务契约；
- 解析、状态、路径和权限失败路径的测试。

Task 1 不包含：

- 自动安装、自动启用、自动永久信任；
- 远程市场、网络下载或 Git 拉取；
- 技能版本管理、依赖解析或升级器；
- 技能生成器或自动修改 SKILL.md；
- 技能自定义工具、脚本、生命周期钩子或独立进程；
- 技能级环境变量治理；
- 技能绕过 permissionMode、路径授权、确认流程或危险命令拦截；
- HTML 文档站、通用插件抽象或独立技能运行时。

## 技能来源与目录

应用级技能：

    <PI_USER_CONFIG>/skills/<skill-id>/SKILL.md

工作区级技能：

    <workspace-root>/agent/skills/<skill-id>/SKILL.md

skill-id 必须是单层目录名，不允许 ..、路径分隔符、绝对路径或符号链接逃逸。扫描器只读取每个来源根目录下的直接子目录，不递归扫描任意项目目录。

同名技能的覆盖规则：

- 工作区级优先于应用级；
- catalog 只输出一个生效摘要，并保留来源字段；
- 被覆盖的应用级技能不进入可加载集合，但诊断中可说明被工作区技能覆盖；
- 工作区切换后重新扫描并重新计算覆盖关系。

## 最小 SKILL.md 格式

技能目录必须包含名为 SKILL.md 的普通文件。文件使用 YAML 风格 frontmatter 和 Markdown 正文：

    ---
    name: release-check
    description: 运行发布前检查并解释失败原因
    tools:
      - file-read
      - command
    ---

    # Release Check

    技能正文……

第一版只支持以下字段：

- name：稳定标识，必须等于 skill-id；
- description：非空摘要文本；
- tools：可选的现有工具名列表，仅用于能力校验和展示；
- frontmatter 后的 Markdown 正文。

未知字段不赋予任何行为。frontmatter 缺失、重复、字段类型错误、名称不匹配或正文为空时，技能为 invalid，不可信任、不可启用、不可加载。

解析器采用现有依赖或受限的本地解析逻辑，不引入 AST 平台。解析结果必须限制在技能文件本身，不执行 Markdown、frontmatter 或其中的代码。

## 状态模型

文件事实和状态文件合并为以下外部状态：

    source: workspace | user
    trust: untrusted | trusted
    enabled: true | false
    parse: valid | invalid

状态文件：

    <PI_USER_CONFIG>/skill-state.json

状态文件只保存用户状态和必要的来源指纹，不复制技能正文。建议记录技能 id、来源范围、信任状态、启用状态、最后确认时间和文件内容指纹。时间只用于审计展示，不参与能力判断。

状态规则：

1. 新发现的技能默认 untrusted + disabled。
2. 未信任技能不能启用；启用操作必须先明确完成信任操作。
3. invalid 技能不能信任、启用或加载；修复文件后需要重新扫描。
4. 取消信任立即使技能不可加载，并将其视为 disabled。
5. 删除是显式操作，删除对应技能目录；不做软删除自动恢复。
6. 状态文件不存在时使用空状态；状态文件损坏或结构不合法时 fail-closed，将所有技能按未信任、未启用处理，并返回诊断。
7. 文件指纹变化后，正文加载按 untrusted 处理并要求再次确认，避免静默信任新内容。

## Catalog 与模型上下文

Task 0 的提交版 capability-catalog.json 保持确定性，不读取用户配置目录，也不把用户实际安装的技能写入提交文件。它只记录技能目录根、摘要 schema 和运行时来源标记，作为 Task 1 的静态契约接缝。

Task 1 的运行时 SkillCatalog 扫描两个本地技能根目录，生成实际摘要。摘要至少包含：id、name、description、source、相对 path、trust、enabled、parse 和 declaredTools。静态 catalog 与运行时 SkillCatalog 共用字段定义，但不共用动态数据。

运行时 catalog 的职责是提供可解释摘要和状态，不是运行时授权缓存。模型上下文分两层：

- 常驻摘要：技能名称、描述、来源和当前状态，不包含正文；
- 按需正文：仅在技能已信任、已启用、解析有效、指纹未变化且当前工作区匹配时加载。

正文加载 API 返回结构化结果，失败时返回原因，不将原始正文或异常堆栈当作成功结果。加载失败不能让会话获得部分技能权限。

## 工具与权限边界

tools 只是技能声明的现有工具名列表：

- 每个声明名必须存在于 ToolRegistry；未知工具声明导致技能不可启用，并返回工具不满足诊断；
- 声明列表不创建、不包装、不扩大工具集合；
- 技能正文只能描述方法，不能注册函数、脚本、MCP server 或新的工具；
- 技能触发的工具调用沿用当前会话的 permissionMode 和确认回调；
- 路径授权仍由现有 PathGuard/RootRegistry 决定；
- 危险命令仍由 isDangerousCommand 强制层拦截；
- 技能不能修改 permission mode、授权规则、环境变量或服务端上下文。

## 最小服务契约

服务层提供可测试的技能管理边界，负责扫描、状态读写、摘要查询和正文按需加载。HTTP/设置页只调用该边界，不直接读取技能文件或状态文件。

最小操作：list、rescan、trust、untrust、enable、disable、remove、load。

所有操作按技能 id 和来源范围定位，拒绝任意路径参数。删除和状态变更必须在服务端再次校验当前工作区、来源根目录和技能目录，不能信任前端传回的绝对路径。

## 失败与诊断

每个技能最多返回一个主状态和可读诊断：invalid_frontmatter、name_mismatch、empty_description、unknown_tool、untrusted、disabled、content_changed、state_corrupt、path_rejected、overridden。

诊断可以进入设置页和结构化日志，但技能正文、状态文件中的敏感值和完整路径不应无必要地写入日志。

## 管理与验证

人工安装时，把技能文件放到以下任一位置：

```text
<PI_USER_CONFIG>/skills/<skill-id>/SKILL.md
<workspace-root>/agent/skills/<skill-id>/SKILL.md
```

然后在“设置 → 技能”中执行“重新扫描 → 信任 → 启用”。禁用或取消信任后，技能正文不再进入 Agent 上下文；修改 `SKILL.md` 会使内容指纹变化，必须重新信任。删除操作会删除对应技能目录，并有二次确认。

验证 Agent 是否实际读取技能时，可以在测试技能正文中定义一个唯一、无副作用的输出标记，再明确要求 Agent 执行该技能的验证动作。工作区技能 `skill-verification` 已用 `SKILL_PROBE_7E42A` 完成一次真实验证，确认启用后的正文进入了当前工作区的 Agent 上下文。该标记只用于验收，不是产品内置协议。

技能是提示说明，不是可执行插件。它不能注册新工具、扩大现有工具集合，也不能绕过 `permissionMode`、路径授权、命令确认或危险命令强制拦截。

## 实现记录

- `SkillService` 负责扫描、状态合并、信任/启用管理、删除和正文加载；`<PI_USER_CONFIG>/skill-state.json` 损坏时整体 fail-closed。
- 设置页已接入查看、重新扫描、信任、取消信任、启用、禁用和删除操作。
- 静态 `capability-catalog.json` 只保存确定性的技能 schema、目录根和运行时来源；实际安装摘要由运行时生成。
- 系统提示词列出技能摘要，只为解析有效、指纹未变化、已信任且已启用的技能附加正文，并按会话工作区绑定技能根目录。
- `c67fb50` 修复了 `PiAgentEngineAdapter` 调用 runtime 会话方法时丢失接收者的问题，避免技能验证请求在 `engine.prompt()` 前因 `_enqueueSessionTransition` 未绑定而失败。

## 测试策略

必须覆盖：

- 应用级和工作区级目录扫描；
- 有效 frontmatter、缺失/错误 frontmatter、名称不匹配、空正文；
- 同名覆盖和工作区切换后的重新计算；
- 新技能默认未信任、未启用；
- 未信任不能启用，未知工具不能启用；
- 启用技能才可加载正文，禁用、取消信任或指纹变化后正文不进入上下文；
- 状态文件不存在、损坏、并发更新和未知字段；
- 删除路径穿越、符号链接逃逸和删除范围限制；
- 工具调用仍经过 permissionMode、路径授权和危险命令强制拦截；
- 静态 capability catalog 保持确定性并可同步检查；运行时 SkillCatalog 只含摘要不含正文；
- 管理接口对无效 id、错误来源和已覆盖技能返回结构化失败。

## 完成标准

- 人工把 SKILL.md 放入任一规定目录后，重新扫描可见；
- 未信任技能不会进入正文上下文；
- 用户显式信任并启用后，技能摘要可见且正文按需加载；
- 禁用、取消信任、内容变化或状态损坏会阻止正文加载；
- 技能声明不会增加工具或绕过现有权限体系；
- 设置页可查看、信任、启用、禁用、删除技能并看到失败原因；
- Task 0 catalog 的 skills 接缝记录静态 schema/来源契约，运行时 SkillCatalog 提供实际技能摘要，且 capabilities:check 继续通过；
- 所有新增测试和现有发布门禁通过。
