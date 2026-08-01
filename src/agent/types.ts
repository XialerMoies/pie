/**
 * Agent 层类型定义
 *
 * 核心接口 AgentTool——兼容 PI 的 ToolDefinition 并扩展 Claudecode 式元数据。
 * 所有自定义 Tool 和 Tool 注册表由此文件定义。
 *
 * ── 设计来源 ──
 * PI 的 ToolDefinition:       name / description / parameters / execute
 * Claudecode 的 Tool:         isReadOnly / isDestructive / isConcurrencySafe / isEnabled
 * 自己加的:                   ToolRegistry + toPITools()
 *
 * ── 未来可能扩展 ──
 * - aliases（Tool 别名）
 * - searchHint（ToolSearch 关键字匹配）
 * - interruptBehavior（用户中断行为）
 * - description 动态函数
 * - inputSchema（Zod 类型校验）
 */

export type ShellDialect = "cmd" | "posix-bash" | "powershell"

export type CommandConfirmationScope = "once" | "session"

export interface CommandConfirmationResult {
  allow: boolean
  scope?: CommandConfirmationScope
}

export interface CommandConfirmationRequest {
  permissionSuggestions?: PermissionSuggestion[]
}

export type CommandConfirmationResponse = boolean | CommandConfirmationResult | undefined

export type PermissionDestination = "session"
export type PermissionRuleMatch = "exact" | "prefix" | "wildcard"
export type PathPermissionToolName = "Read" | "Write" | "Create" | "Remove"
export type PermissionToolName = PathPermissionToolName | "Command" | "Tool"

export interface PermissionRule {
  toolName: PermissionToolName
  ruleContent: string
  match?: PermissionRuleMatch
}

export interface AdditionalWorkingDirectory {
  path: string
  source: PermissionDestination
}

export type PermissionSuggestion =
  | {
      type: "addReadRule"
      directory: string
      rule: PermissionRule
      destination: PermissionDestination
    }
  | {
      type: "addPathRule"
      operation: "read" | "write" | "create" | "remove"
      directory: string
      rule: PermissionRule
      destination: PermissionDestination
    }
  | {
      type: "addToolRule"
      toolName: string
      rule: PermissionRule
      destination: PermissionDestination
    }
  | {
      type: "addWorkingDirectory"
      directory: string
      destination: PermissionDestination
    }

export interface SessionPermissionState {
  additionalWorkingDirectories: Map<string, AdditionalWorkingDirectory>
  alwaysAllowRules: Record<PermissionDestination, PermissionRule[]>
  alwaysDenyRules: Record<PermissionDestination, PermissionRule[]>
  alwaysAskRules: Record<PermissionDestination, PermissionRule[]>
}

export type ToolPathOperation = "read" | "write" | "create" | "remove"

export type ToolOperation = ToolPathOperation | "execute"
export type ToolRiskLevel = "low" | "medium" | "high"
export type ToolAuthorizationMode = "generic" | "specialized"

export interface ToolAuthorizationRequest {
  toolName: string
  source: string
  operations: readonly ToolOperation[]
  riskLevel: ToolRiskLevel
  workspaceBounded: boolean
  authorizationMode: ToolAuthorizationMode
  permissionRequired?: boolean
  args: Record<string, unknown>
}

export interface ToolAuthorizationResult {
  allow: boolean
  reason?: string
}

export type ToolAuthorizer = (
  request: ToolAuthorizationRequest,
) => Promise<ToolAuthorizationResult>

export interface ToolPathAuthorizationResult {
  operation: ToolPathOperation
  root: string
  path: string
  relativePath: string
}

export type ToolPathAuthorizer = (
  root: string,
  target: string,
  operation: ToolPathOperation,
  source: string,
) => Promise<ToolPathAuthorizationResult>

/** Tool 执行上下文 */
export interface ToolContext {
  cwd: string
  sessionId: string
  workspace?: string  // 当前 workspace 路径，用于工具 API 调用
  toolCallId?: string
  /** 中间输出回调（工具执行中产生 stdout 时调用） */
  onUpdate?: (chunk: string) => void
  /** 权限模式：由宿主/UI 设置，模型不可控 */
  permissionMode?: "default" | "plan" | "acceptEdits" | "dontAsk"
  /** 实际 shell 方言：由宿主/UI 设置，模型不可控 */
  shellDialect?: ShellDialect
  /** 用户确认回调：返回 true/allow=允许，false/undefined=拒绝。无此回调时默认拒绝（fail-closed） */
  confirmCommand?: (
    cmd: string,
    reason: string,
    request?: CommandConfirmationRequest,
  ) => Promise<CommandConfirmationResponse>
  additionalWorkingDirectories?: SessionPermissionState["additionalWorkingDirectories"]
  alwaysAllowRules?: SessionPermissionState["alwaysAllowRules"]
  alwaysDenyRules?: SessionPermissionState["alwaysDenyRules"]
  alwaysAskRules?: SessionPermissionState["alwaysAskRules"]
  applyPermissionSuggestions?: (suggestions: PermissionSuggestion[]) => void
  authorizePath?: ToolPathAuthorizer
  authorizeTool?: ToolAuthorizer
  desktopApiToken?: string
}

export type ToolTraceEmitter = (event: {
  type: "tool_execution_start" | "tool_execution_update" | "tool_execution_end"
  toolCallId: string
  toolName: string
  args?: Record<string, unknown>
  result?: string
  partialResult?: string
  isError?: boolean
}) => void

/** Tool 参数定义（JSON Schema 格式） */
export interface ToolParameterSchema {
  type: "object"
  properties: Record<string, unknown>
  required?: string[]
}

/** AgentTool——你的核心接口 */
export interface AgentTool {
  // ── PI 兼容字段（直接对应 ToolDefinition） ──
  name: string
  description: string
  parameters: ToolParameterSchema
  execute(args: Record<string, unknown>, ctx: ToolContext): Promise<string>

  // ── 从 Claudecode 借鉴（现在就要） ──
  /** Coordinator 权限隔离：子 Agent 只能调 isReadOnly === true 的 tool */
  isReadOnly: boolean
  /** 危险操作标记（删除/覆盖/推送等），触发二次确认 */
  isDestructive?: boolean
  /** 能否并行执行（FileWrite 设为 false，避免同时写同一个文件） */
  isConcurrencySafe?: boolean
  /** 条件启用：某些 tool 只在特定环境可用 */
  isEnabled?: () => boolean
  /** 通用工具能力声明，由 Registry 在执行前统一接入权限层 */
  operations?: readonly ToolOperation[]
  riskLevel?: ToolRiskLevel
  needsPermission?: boolean
  workspaceBounded?: boolean
  authorizationMode?: ToolAuthorizationMode
  permissionSource?: string

  // ── 待后续开发 ──
  // aliases?: string[]
  // searchHint?: string
  // interruptBehavior?: () => 'cancel' | 'block'
}

/** Tool 注册表 */
export async function authorizeToolExecution(
  tool: AgentTool,
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<void> {
  const permissionRequired = tool.needsPermission === true
  if (!ctx.authorizeTool) {
    if (!permissionRequired) return
    throw new Error(`Tool authorization unavailable: ${tool.name}`)
  }
  const decision = await ctx.authorizeTool({
    toolName: tool.name,
    source: tool.permissionSource || `agent.${tool.name}`,
    operations: tool.operations || [],
    riskLevel: tool.riskLevel || "medium",
    workspaceBounded: tool.workspaceBounded !== false,
    authorizationMode: tool.authorizationMode || "generic",
    permissionRequired,
    args,
  })
  if (!decision.allow) {
    throw new Error(decision.reason || `Tool execution denied: ${tool.name}`)
  }
}

const AUTHORIZED_TOOL = Symbol("authorizedTool")

/**
 * Wrap a tool at its definition boundary so direct callers and registry callers
 * share the same authorization path. The marker keeps wrapping idempotent.
 */
export function defineAgentTool(tool: AgentTool): AgentTool {
  if ((tool as AgentTool & { [AUTHORIZED_TOOL]?: boolean })[AUTHORIZED_TOOL]) return tool

  const rawExecute = tool.execute
  const authorizedTool: AgentTool = {
    ...tool,
    execute: async (args, ctx) => {
      await authorizeToolExecution(tool, args, ctx)
      return rawExecute(args, ctx)
    },
  }
  Object.defineProperty(authorizedTool, AUTHORIZED_TOOL, { value: true })
  return authorizedTool
}

export class ToolRegistry {
  private tools = new Map<string, AgentTool>()

  /** 注册一个 Tool（同名幂等，不会覆盖） */
  register(tool: AgentTool): void {
    if (this.tools.has(tool.name)) return
    this.tools.set(tool.name, defineAgentTool(tool))
  }

  /** 按名称获取 Tool */
  get(name: string): AgentTool | undefined {
    return this.tools.get(name)
  }

  /** 获取所有已注册的 Tool */
  getAll(): AgentTool[] {
    return [...this.tools.values()]
  }

  /** 转换为 PI SDK 需要的 ToolDefinition[] */
  toPITools(
    workspace?: string,
    emitTrace?: ToolTraceEmitter,
    extraCtx?: {
      permissionMode?: ToolContext["permissionMode"]
      confirmCommand?: ToolContext["confirmCommand"]
      shellDialect?: ToolContext["shellDialect"]
      additionalWorkingDirectories?: ToolContext["additionalWorkingDirectories"]
      alwaysAllowRules?: ToolContext["alwaysAllowRules"]
      alwaysDenyRules?: ToolContext["alwaysDenyRules"]
      alwaysAskRules?: ToolContext["alwaysAskRules"]
      applyPermissionSuggestions?: ToolContext["applyPermissionSuggestions"]
      authorizePath?: ToolContext["authorizePath"]
      authorizeTool?: ToolContext["authorizeTool"]
      desktopApiToken?: ToolContext["desktopApiToken"]
    },
  ) {
    return this.getAll().map((tool) => ({
      name: tool.name,
      label: tool.name,
      description: tool.description,
      parameters: tool.parameters,
      execute: async (_toolCallId: string, params: unknown) => {
        const args = params as Record<string, unknown>
        emitTrace?.({
          type: "tool_execution_start",
          toolCallId: _toolCallId,
          toolName: tool.name,
          args,
        })
        try {
          const onUpdate = (chunk: string) => {
            emitTrace?.({
              type: "tool_execution_update",
              toolCallId: _toolCallId,
              toolName: tool.name,
              partialResult: chunk,
            })
          }
          const toolContext: ToolContext = {
            cwd: workspace || "",
            sessionId: "",
            workspace,
            toolCallId: _toolCallId,
            onUpdate,
            ...extraCtx,
          }
          const text = await tool.execute(args, toolContext)
          emitTrace?.({
            type: "tool_execution_end",
            toolCallId: _toolCallId,
            toolName: tool.name,
            result: text,
            isError: false,
          })
          // PI 要求 content 是数组格式，不能直接返回字符串
          return {
            content: [{ type: "text" as const, text }],
            details: {},
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          emitTrace?.({
            type: "tool_execution_end",
            toolCallId: _toolCallId,
            toolName: tool.name,
            result: message,
            isError: true,
          })
          throw error
        }
      },
    })) as any
  }
}
