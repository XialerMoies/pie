/** Tool authorization, PI conversion, and canonical registry. */
import { createHash } from "node:crypto"
import { canonicalToolName } from "./tool-identity.js"
import type {
  AgentTool,
  CommandConfirmationScope,
  ToolContext,
  ToolExecutionDecision,
  ToolAuthorizationRequest,
  ToolExecutionExtraContext,
  ToolEvidenceScope,
  ToolTraceEmitter,
  ExecutionContractDecision,
} from "./types.js"
import {
  assertStructuredToolResult,
  classifyThrownToolFailure,
  type ToolOutcome,
} from "./tool-outcomes.js"

export async function authorizeToolExecution(tool: AgentTool, args: Record<string, unknown>, ctx: ToolContext): Promise<ToolExecutionDecision> {
  const request: ToolAuthorizationRequest = {
    toolName: tool.name,
    source: tool.permissionSource || `agent.${tool.name}`,
    operations: tool.operations || [],
    riskLevel: tool.riskLevel || "medium",
    workspaceBounded: tool.workspaceBounded !== false,
    authorizationMode: tool.authorizationMode || "generic",
    permissionRequired: tool.needsPermission === true,
    mcpCapabilities: tool.mcpCapabilities,
    args,
  }
  const decisionRequest = { ...request } as ToolExecutionDecision["request"]
  delete (decisionRequest as any).args
  const permissionRequired = tool.needsPermission === true
  if (ctx.getPermissionMode?.() === "yes" || ctx.permissionMode === "yes") {
    return { status: "allow", source: "mode", request: decisionRequest, reason: "Allowed by Yes permission mode", pathDecisions: [] }
  }
  if (!ctx.authorizeTool) {
    if (permissionRequired) throw new Error(`Tool authorization unavailable: ${tool.name}`)
    return {
      status: tool.authorizationMode === "specialized" ? "delegated" : "allow",
      source: tool.authorizationMode === "specialized" ? "specialized" : "implicit",
      request: decisionRequest,
      reason: tool.authorizationMode === "specialized" ? `Authorization is owned by the specialized ${tool.name} policy` : "Tool does not require confirmation",
      pathDecisions: [],
      ...(tool.authorizationMode === "specialized" ? { specialized: { status: "pending" as const } } : {}),
    }
  }
  const result = await ctx.authorizeTool(request)
  const decision = result.decision || {
    status: result.allow ? (tool.authorizationMode === "specialized" ? "delegated" : "allow") : "deny",
    source: tool.authorizationMode === "specialized" ? "specialized" : "implicit",
    request: decisionRequest,
    reason: result.reason,
    pathDecisions: [],
    ...(tool.authorizationMode === "specialized" ? { specialized: { status: "pending" as const } } : {}),
  }
  decision.request ||= decisionRequest
  decision.pathDecisions ||= []
  if (!result.allow) {
    const error = new Error(result.reason || `Tool execution denied: ${tool.name}`) as Error & { metadata?: Record<string, unknown> }
    error.metadata = { authorization: decision, ...(result.failure ? { permissionFailure: result.failure } : {}) }
    throw error
  }
  return decision
}

const AUTHORIZED_TOOL = Symbol.for("my-code-agent.authorized-tool")

export function defineAgentTool(tool: AgentTool): AgentTool {
  if ((tool as AgentTool & { [AUTHORIZED_TOOL]?: boolean })[AUTHORIZED_TOOL]) return tool
  const rawExecute = tool.execute
  const authorizedTool: AgentTool = {
    ...tool,
    execute: async (args, ctx) => {
      const authorizationDecision = await authorizeToolExecution(tool, args, ctx)
      if (tool.resultFormat !== "structured") {
        const error = new Error(`Tool ${tool.name} must declare resultFormat: structured`) as Error & { code: string }
        error.code = "tool_result_contract_required"
        throw error
      }
      const normalized = assertStructuredToolResult(await rawExecute(args, { ...ctx, authorizationDecision }))
      return {
        ...normalized,
        metadata: { ...(normalized.metadata || {}), tool: tool.name, outcome: authorizationDecision.status === "deny" ? "denied" : "completed", toolOutcome: normalized.outcome.status, authorization: authorizationDecision },
      }
    },
  }
  Object.defineProperty(authorizedTool, AUTHORIZED_TOOL, { value: true })
  return authorizedTool
}

export function agentToolToPIToolDefinition(tool: AgentTool, workspace?: string, emitTrace?: ToolTraceEmitter, extraCtx?: ToolExecutionExtraContext) {
  const authorizedTool = defineAgentTool(tool)
  const subagentDefinitions = authorizedTool.name === "delegate_tasks" ? extraCtx?.getSubagentDefinitions?.() ?? [] : []
  const description = subagentDefinitions.length > 0
    ? `${authorizedTool.description}\nConfigured Agents (use task.agentId):\n${subagentDefinitions.map((agent) => `- ${agent.id}: ${agent.name}${agent.description ? ` - ${agent.description}` : ""}`).join("\n")}`
    : authorizedTool.description
  return {
    name: authorizedTool.name,
    label: authorizedTool.name,
    description,
    parameters: authorizedTool.parameters,
    execute: async (_toolCallId: string, params: unknown, signal?: AbortSignal, _onUpdate?: (partialResult: unknown) => void) => {
      const args = params as Record<string, unknown>
      const correlation = extraCtx?.getCorrelationContext?.()
      const requestScope: ToolEvidenceScope = {
        ...(workspace ? { workspace } : {}),
        ...((typeof args.target === "string" || typeof args.path === "string" || typeof args.file === "string")
          ? { target: String(args.target || args.path || args.file).slice(0, 512) }
          : (authorizedTool.name === "skill_facts" && typeof args.id === "string" ? { target: `${args.source === "user" ? "user/skills" : "agent/skills"}/${args.id}/SKILL.md`.slice(0, 512) } : {})),
        ...((typeof args.operation === "string" || typeof args.action === "string") ? { operation: String(args.operation || args.action).slice(0, 128) } : {}),
        argsFingerprint: createHash("sha256").update(JSON.stringify(args)).digest("hex"),
      }
      const contract = extraCtx?.getExecutionContract?.()
      let executionContractDecision: ExecutionContractDecision | undefined
      const sourceMatches = (sources: readonly string[] | undefined): boolean => Boolean(sources?.some((source) => {
        const target = (requestScope.target || "").replace(/\\/g, "/")
        const normalized = source.replace(/\\/g, "/")
        return target === normalized || target.endsWith(`/${normalized}`) || normalized.endsWith(`/${target}`)
      }))
      if (contract?.kind === "fact_verification" && contract.targets?.length) {
        const target = requestScope.target || ""
        const instructionSource = sourceMatches(contract.instructionSources)
        const sourceAllowed = !contract.allowedSources?.length || sourceMatches(contract.allowedSources) || instructionSource
        const toolAllowed = !contract.allowedTools?.length || contract.allowedTools.includes(authorizedTool.name)
        executionContractDecision = extraCtx?.authorizeExecutionContract?.(authorizedTool.name, args, requestScope)
        if (!sourceAllowed || !toolAllowed || executionContractDecision?.allowed === false) {
          const reason = executionContractDecision?.reason || (!sourceAllowed ? "source_not_allowed" : "tool_not_allowed")
          const message = reason === "evidence_satisfied" ? "未执行：事实核验所需证据已齐全，必须停止继续调查。" : `未执行：事实核验契约禁止${reason === "source_not_allowed" ? "读取该来源" : "使用该工具"}。`
          const contractCode = executionContractDecision?.code === "execution_contract_complete" ? "execution_contract_complete" as const : "execution_contract_violation" as const
          const failure: ToolOutcome = { status: "failed", failure: { kind: "validation_error", code: contractCode, message, details: { reason, revision: contract.revision, target: target.slice(0, 512) } } }
          emitTrace?.({ type: "tool_execution_start", toolCallId: _toolCallId, toolName: authorizedTool.name, args })
          emitTrace?.({ type: "tool_execution_end", toolCallId: _toolCallId, toolName: authorizedTool.name, result: message, outcome: failure, metadata: { executionContract: reason, retryable: false }, isError: true })
          extraCtx?.toolOutcomeObserver?.({ source: extraCtx.toolOutcomeSource || "live", toolName: authorizedTool.name, toolCallId: _toolCallId, outcome: "failed", failureKind: "validation_error", requestScope, payloadSummary: message, complete: false, ...(correlation ? { correlation } : {}), executionContract: { allowed: false, code: contractCode, reason, revision: contract.revision } })
          return { content: [{ type: "text" as const, text: message }], details: { executionContract: reason, retryable: false, toolOutcome: "failed", outcome: failure } }
        }
      }
      emitTrace?.({ type: "tool_execution_start", toolCallId: _toolCallId, toolName: authorizedTool.name, args })
      try {
        const cached = extraCtx?.evidenceLookup?.(authorizedTool.name, requestScope)
        if (cached) {
          const text = cached.summary || "已使用此前验证的结果。"
          emitTrace?.({ type: "tool_execution_end", toolCallId: _toolCallId, toolName: authorizedTool.name, result: text, outcome: { status: "success" }, metadata: { evidenceId: cached.evidenceId, deduplicated: true } })
          extraCtx?.toolOutcomeObserver?.({ source: extraCtx.toolOutcomeSource || "live", toolName: authorizedTool.name, toolCallId: _toolCallId, outcome: "success", requestScope, payloadSummary: text, payloadHash: cached.payloadHash, complete: true, evidenceFields: cached.evidenceFields, ...(correlation ? { correlation } : {}) })
          return { content: [{ type: "text" as const, text }], details: { evidenceId: cached.evidenceId, deduplicated: true } }
        }
        const onUpdate = (chunk: string) => emitTrace?.({ type: "tool_execution_update", toolCallId: _toolCallId, toolName: authorizedTool.name, partialResult: chunk })
        const toolContext: ToolContext = { cwd: workspace || "", sessionId: "", workspace, toolCallId: _toolCallId, signal, onUpdate, getExecutionContract: extraCtx?.getExecutionContract, ...extraCtx }
        const normalized = assertStructuredToolResult(await authorizedTool.execute(args, toolContext))
        const instructionSource = contract?.kind === "fact_verification" && sourceMatches(contract.instructionSources)
        const normalizedMetadata = instructionSource ? Object.fromEntries(Object.entries(normalized.metadata || {}).filter(([key]) => key !== "evidenceFields")) : (normalized.metadata || {})
        emitTrace?.({ type: "tool_execution_end", toolCallId: _toolCallId, toolName: authorizedTool.name, result: normalized.text, data: normalized.data, diagnostics: normalized.diagnostics, ...(Object.keys(normalizedMetadata).length > 0 ? { metadata: normalizedMetadata } : {}), outcome: normalized.outcome, isError: normalized.outcome.status === "failed" })
        extraCtx?.toolOutcomeObserver?.({ source: extraCtx.toolOutcomeSource || "live", toolName: authorizedTool.name, toolCallId: _toolCallId, outcome: normalized.outcome.status, ...(normalized.outcome.status === "failed" ? { failureKind: normalized.outcome.failure.kind } : {}), requestScope, payloadSummary: normalized.text.slice(0, 240), complete: normalized.outcome.status === "success", ...(contract && executionContractDecision ? { executionContract: { allowed: true, revision: contract.revision } } : {}), evidenceFields: Array.isArray(normalizedMetadata.evidenceFields) ? normalizedMetadata.evidenceFields.filter((field): field is string => typeof field === "string").slice(0, 32) : undefined, ...(correlation ? { correlation } : {}) })
        return { content: [{ type: "text" as const, text: normalized.text }], details: { ...normalizedMetadata, data: normalized.data ?? null, diagnostics: normalized.diagnostics || [], outcome: normalized.outcome } }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        const failure = classifyThrownToolFailure(error, signal)
        const metadata = error && typeof error === "object" && "metadata" in error && (error as { metadata?: unknown }).metadata && typeof (error as { metadata?: unknown }).metadata === "object" ? (error as { metadata: Record<string, unknown> }).metadata : undefined
        emitTrace?.({ type: "tool_execution_end", toolCallId: _toolCallId, toolName: authorizedTool.name, result: message, ...(metadata ? { metadata } : {}), outcome: { status: "failed", failure }, isError: true })
        extraCtx?.toolOutcomeObserver?.({ source: extraCtx.toolOutcomeSource || "live", toolName: authorizedTool.name, toolCallId: _toolCallId, outcome: "failed", failureKind: failure.kind, requestScope, payloadSummary: message.slice(0, 240), complete: false, ...(correlation ? { correlation } : {}) })
        throw error
      }
    },
  } as any
}

export class ToolRegistry {
  private tools = new Map<string, AgentTool>()
  private aliases = new Map<string, string>()
  register(tool: AgentTool): void {
    if (this.tools.has(tool.name)) return
    const canonical = canonicalToolName(tool.name)
    if (!canonical) throw new Error("Tool name cannot be empty")
    if (this.tools.has(canonical) || this.aliases.has(canonical)) throw new Error(`Tool identity conflicts with an existing tool: ${canonical}`)
    const aliases = [...new Set([...(tool.aliases || []), ...(canonical !== tool.name ? [tool.name] : [])])]
      .map((alias) => String(alias || "").trim())
      .filter((alias) => alias && alias !== canonical)
    for (const alias of aliases) if (this.tools.has(alias) || this.aliases.has(alias)) throw new Error(`Tool alias conflicts with an existing tool: ${alias}`)
    const normalizedTool = canonical === tool.name ? tool : { ...tool, name: canonical }
    this.tools.set(canonical, defineAgentTool(normalizedTool))
    for (const alias of aliases) this.aliases.set(alias, canonical)
  }
  resolveName(name: string): string | undefined {
    const raw = String(name || "").trim()
    if (this.tools.has(raw)) return raw
    const directAlias = this.aliases.get(raw)
    if (directAlias) return directAlias
    const candidate = canonicalToolName(raw)
    if (this.tools.has(candidate)) return candidate
    return this.aliases.get(candidate)
  }
  get(name: string): AgentTool | undefined { const canonical = this.resolveName(name); return canonical ? this.tools.get(canonical) : undefined }
  getCanonicalName(name: string): string | undefined { return this.resolveName(name) }
  getAliases(): ReadonlyMap<string, string> { return new Map(this.aliases) }
  getAll(): AgentTool[] { return [...this.tools.values()] }
  toPITools(workspace?: string, emitTrace?: ToolTraceEmitter, extraCtx?: ToolExecutionExtraContext) { return this.getAll().map((tool) => agentToolToPIToolDefinition(tool, workspace, emitTrace, extraCtx)) as any }
}
