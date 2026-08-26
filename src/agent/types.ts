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
// Compatibility barrel. Concrete result and registry behavior lives in
// tool-outcomes.ts and tool-registry.ts; existing imports remain stable.
import type {
  ToolOutcomeSource,
  ToolCorrelationContext,
  ToolEvidenceScope,
  ToolEvidenceLookup,
  ToolOutcomeObserver,
  AgentToolExecutionResult,
} from "./tool-outcomes.js"
import type { PlanStateSnapshot } from "./plan-state.js"
export * from "./tool-outcomes.js"

function targetMatches(target: string, source: string): boolean {
  const normalizedTarget = target.replace(/\\/g, "/")
  const normalizedSource = source.replace(/\\/g, "/")
  return normalizedTarget === normalizedSource
    || normalizedTarget.endsWith(`/${normalizedSource}`)
    || normalizedSource.endsWith(`/${normalizedTarget}`)
}

export type ShellDialect = "cmd" | "posix-bash" | "powershell"

export type PermissionRuleScope = "session" | "workspace"
export type CommandConfirmationScope = "once" | PermissionRuleScope
export type PermissionMode = "plan" | "standard" | "dontAsk" | "yes"

export type PermissionFailureCode =
  | "permission_denied"
  | "permission_confirmation_required"
  | "confirmation_unavailable"
  | "dangerous"
  | "path_outside_root"
  | "permission_state_unavailable"

export type PermissionFailureCategory = "permission" | "confirmation" | "safety" | "path"
export type PermissionFailureDecision = "deny" | "ask" | "block"
export type PermissionRecoveryAction = "retry" | "reconnect" | "open_permissions"

export interface PermissionFailureSuggestion {
  action: PermissionRecoveryAction
  label: string
}

export interface PermissionFailure {
  code: PermissionFailureCode
  category: PermissionFailureCategory
  decision: PermissionFailureDecision
  message: string
  reason: string
  operation?: string
  target?: string
  recoverable: boolean
  suggestions: PermissionFailureSuggestion[]
}

export interface CommandConfirmationResult {
  allow: boolean
  scope?: CommandConfirmationScope
}

export interface CommandConfirmationRequest {
  permissionSuggestions?: PermissionSuggestion[]
}

export type CommandConfirmationResponse = boolean | CommandConfirmationResult | undefined

export type PermissionDestination = PermissionRuleScope
export type PermissionRuleMatch = "exact" | "prefix" | "wildcard"
export type PathPermissionToolName = "Read" | "Write" | "Create" | "Remove"
export type PermissionToolName = PathPermissionToolName | "Command" | "Tool" | "McpCapability"

export type McpCapabilityName = "readOnly"

export interface McpToolCapabilities {
  readOnly: boolean
  destructive: boolean
  idempotent: boolean
  openWorld: boolean
  declaration: "declared" | "defaulted"
}

export interface McpToolCapabilityDeclaration extends McpToolCapabilities {
  serverName: string
}

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
  alwaysAllowRules: Record<PermissionRuleScope, PermissionRule[]>
  alwaysDenyRules: Record<PermissionRuleScope, PermissionRule[]>
  alwaysAskRules: Record<PermissionRuleScope, PermissionRule[]>
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
  mcpCapabilities?: McpToolCapabilityDeclaration
  args: Record<string, unknown>
}

export interface ToolAuthorizationResult {
  allow: boolean
  reason?: string
  decision?: ToolExecutionDecision
  failure?: PermissionFailure
}

export type ToolAuthorizationDecisionRequest = Omit<ToolAuthorizationRequest, "args">

export type ToolExecutionDecisionStatus = "allow" | "deny" | "delegated"
export type ToolExecutionDecisionSource = "implicit" | "rule" | "confirmation" | "specialized" | "mode"

export interface ToolSpecializedDecision {
  status: "pending" | "allow" | "deny"
  reason?: string
  scope?: CommandConfirmationScope
  appliedRules?: string[]
}

export interface ToolExecutionDecision {
  status: ToolExecutionDecisionStatus
  source: ToolExecutionDecisionSource
  request?: ToolAuthorizationDecisionRequest
  reason?: string
  scope?: CommandConfirmationScope
  appliedRules?: PermissionRule[]
  pathDecisions?: ToolPathAuthorizationResult[]
  specialized?: ToolSpecializedDecision
}

export function toolAuthorizationDecisionRequest(
  request: ToolAuthorizationRequest,
): ToolAuthorizationDecisionRequest {
  const { args: _args, ...descriptor } = request
  return descriptor
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
export interface SubagentDelegationModel {
  provider: string
  id: string
}

export type SubagentDelegationProfile = "general" | "explorer" | "reviewer" | "planner"

export interface SubagentDefinition {
  id: string
  name: string
  description: string
  prompt: string
  tools: string[]
  model?: SubagentDelegationModel
}

export interface SubagentDelegationTask {
  profile: SubagentDelegationProfile
  prompt: string
  agentId?: string
  /** Host-resolved immutable snapshot. The model can only provide agentId. */
  agent?: SubagentDefinition
  focusPaths?: string[]
  deliverable?: string
  model?: SubagentDelegationModel
}

export interface SubagentDelegationRequest {
  tasks: SubagentDelegationTask[]
  maxConcurrent: number
  timeoutSeconds: number
  maxTurns: number
  maxToolCalls: number
}

export interface SubagentDelegationLimits {
  maxTasks: number
  maxConcurrent: number
}

export interface SubagentDelegationUsage {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  cost: number
  turns: number
  toolCalls: number
}

export type SubagentDelegationTaskResultStatus =
  | "completed"
  | "failed"
  | "timed_out"
  | "limit_reached"
  | "aborted"

export type SubagentDelegationBatchResultStatus = "completed" | "partial" | "failed" | "aborted"

export interface SubagentDelegationTaskResult {
  taskId: string
  status: SubagentDelegationTaskResultStatus
  summary: string
  findings: string[]
  evidence: string[]
  usage: SubagentDelegationUsage
  error?: string
  limit?: "maxTurns" | "maxToolCalls"
}

export interface SubagentDelegationBatchResult {
  batchId: string
  status: SubagentDelegationBatchResultStatus
  tasks: SubagentDelegationTaskResult[]
  usage: SubagentDelegationUsage
}

export type SubagentModelValidator = (
  model: SubagentDelegationModel,
) => boolean | Promise<boolean>

export type SubagentDefinitionProvider = () => SubagentDefinition[]

export type SubagentDelegateExecutor = (
  request: SubagentDelegationRequest,
  signal?: AbortSignal,
  parentToolCallId?: string,
) => Promise<SubagentDelegationBatchResult>

export interface ToolContext {
  cwd: string
  sessionId: string
  workspace?: string  // 当前 workspace 路径，用于工具 API 调用
  /** Host-owned long-lived memory roots. Tool arguments can only choose scope. */
  userMemoryRoot?: string
  workspaceMemoryRoot?: string
  toolCallId?: string
  /** 宿主提供的协作式中止信号 */
  signal?: AbortSignal
  /** 中间输出回调（工具执行中产生 stdout 时调用） */
  onUpdate?: (chunk: string) => void
  /** 权限模式：由宿主/UI 设置，模型不可控 */
  permissionMode?: PermissionMode
  /** Read the current host-controlled mode at command execution time. */
  getPermissionMode?: () => PermissionMode
  /** Session-scoped planning lifecycle; independent from PermissionMode. */
  getPlanState?: () => PlanStateSnapshot
  enterPlanMode?: (reason?: string) => Promise<PlanStateSnapshot> | PlanStateSnapshot
  requestPlanExit?: (summary: string) => Promise<{ approved: boolean; state: PlanStateSnapshot }>
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
  applyPermissionSuggestions?: (
    suggestions: PermissionSuggestion[],
    scope: PermissionRuleScope,
  ) => void | Promise<void>
  authorizePath?: ToolPathAuthorizer
  authorizeTool?: ToolAuthorizer
  /** One mutable, serializable authorization record shared by the tool and its path/specialized policies. */
  authorizationDecision?: ToolExecutionDecision
  desktopApiToken?: string
  /** Host-only subagent capabilities; model tool arguments cannot provide these. */
  validateSubagentModel?: SubagentModelValidator
  getSubagentDefinitions?: SubagentDefinitionProvider
  getSubagentLimits?: () => SubagentDelegationLimits
  delegateTasks?: SubagentDelegateExecutor
  /** Host-owned observer for structured tool outcome telemetry. */
  toolOutcomeObserver?: ToolOutcomeObserver
  toolOutcomeSource?: ToolOutcomeSource
  /** Host-owned correlation lookup; evaluated at tool execution time. */
  getCorrelationContext?: () => ToolCorrelationContext | undefined
  /** Optional host-owned read-through cache for unchanged successful evidence. */
  evidenceLookup?: (toolName: string, scope: ToolEvidenceScope) => ToolEvidenceLookup | undefined
  /** Host-owned task contract gate. Model input cannot modify the contract. */
  getExecutionContract?: () => ExecutionContract | undefined
  authorizeExecutionContract?: (toolName: string, input: unknown, scope: ToolEvidenceScope) => ExecutionContractDecision
}

/** Host-owned capabilities shared by runtime configuration and tool adapters. */
export type ToolHostContext = Omit<ToolContext,
  | "cwd"
  | "sessionId"
  | "workspace"
  | "toolCallId"
  | "signal"
  | "onUpdate"
  | "authorizationDecision"
>

export type ExecutionContractKind = "fact_verification" | "fact_verification_batch" | "implementation" | "diagnosis" | "exploration" | "conversation"

export interface FactVerificationTaskContract {
  id: string
  targets: readonly string[]
  /** Host-owned instruction files that explain procedure but never satisfy evidence. */
  instructionSources?: readonly string[]
  allowedSources: readonly string[]
  allowedTools: readonly string[]
  requiredEvidence: readonly string[]
  sequence?: readonly string[]
}

export interface ExecutionContract {
  kind: ExecutionContractKind
  targets?: readonly string[]
  /** Host-owned instruction files may be read to understand the requested check,
   * but their contents can never satisfy the task's evidence fields. */
  instructionSources?: readonly string[]
  /** Independent bounded checks in a combined fact-verification turn. */
  tasks?: readonly FactVerificationTaskContract[]
  allowedSources?: readonly string[]
  allowedTools?: readonly string[]
  requiredEvidence?: readonly string[]
  completionCondition: "evidence_satisfied" | "change_verified" | "user_stop"
  onMissingEvidence?: "report_unverified" | "ask_user"
  maxUnrelatedAttempts?: number
  revision: number
}

/** Request-scoped evidence overlay; never persisted as an AgentProfile. */
export type EvidenceContract = ExecutionContract & {
  kind: "fact_verification" | "fact_verification_batch"
}

export interface ExecutionContractDecision {
  allowed: boolean
  code?: "execution_contract_violation" | "execution_contract_complete" | "duplicate_attempt"
  reason?: string
  retryable?: boolean
}

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
  /** Legacy invocation names; aliases are registry-only and never exposed to PI. */
  aliases?: readonly string[]
  description: string
  parameters: ToolParameterSchema
  execute(args: Record<string, unknown>, ctx: ToolContext): Promise<AgentToolExecutionResult>

  // ── 从 Claudecode 借鉴（现在就要） ──
  /** Coordinator 权限隔离：子 Agent 只能调 isReadOnly === true 的 tool */
  isReadOnly: boolean
  /** 危险操作标记（删除/覆盖/推送等），触发二次确认 */
  isDestructive?: boolean
  /** Runtime argument-aware read-only classification used by independent plan state. */
  isPlanReadOnly?: (args: Record<string, unknown>) => boolean
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
  mcpCapabilities?: McpToolCapabilityDeclaration
  /** Every registered tool must explicitly declare the structured result contract. */
  resultFormat: "structured"

  // ── 待后续开发 ──
  // aliases?: string[]
  // searchHint?: string
  // interruptBehavior?: () => 'cancel' | 'block'
}
export type ToolExecutionExtraContext = Partial<ToolHostContext>

export {
  authorizeToolExecution,
  defineAgentTool,
  agentToolToPIToolDefinition,
  ToolRegistry,
} from "./tool-registry.js"
