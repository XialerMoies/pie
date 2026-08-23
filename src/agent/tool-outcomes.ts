/**
 * Structured tool outcomes, execution contracts, and bounded evidence metadata.
 *
 * This module is deliberately independent from the registry and PI adapter so
 * server/event code can reason about tool results without importing execution
 * or authorization machinery.
 */

export type ExecutionContractKind = "fact_verification" | "implementation" | "diagnosis" | "exploration" | "conversation"

export interface ExecutionContract {
  kind: ExecutionContractKind
  targets?: readonly string[]
  /** Host-owned instruction files may be read to understand the requested check,
   * but their contents can never satisfy the task's evidence fields. */
  instructionSources?: readonly string[]
  allowedSources?: readonly string[]
  allowedTools?: readonly string[]
  requiredEvidence?: readonly string[]
  completionCondition: "evidence_satisfied" | "change_verified" | "user_stop"
  onMissingEvidence?: "report_unverified" | "ask_user"
  maxUnrelatedAttempts?: number
  revision: number
}

export interface ExecutionContractDecision {
  allowed: boolean
  code?: "execution_contract_violation" | "execution_contract_complete" | "duplicate_attempt"
  reason?: string
  retryable?: boolean
}

export function targetMatches(target: string, source: string): boolean {
  const normalizedTarget = target.replace(/\\/g, "/")
  const normalizedSource = source.replace(/\\/g, "/")
  return normalizedTarget === normalizedSource
    || normalizedTarget.endsWith(`/${normalizedSource}`)
    || normalizedSource.endsWith(`/${normalizedTarget}`)
}

export type ToolOutcomeSource = "live" | "replay" | "test"

export interface ToolCorrelationContext {
  traceId: string
  turnId?: string
  sessionId?: string
}

export interface ToolEvidenceScope {
  workspace?: string
  target?: string
  operation?: string
  argsFingerprint?: string
}

export interface ToolEvidenceLookup {
  evidenceId: string
  summary: string
  payloadHash: string
  evidenceFields?: string[]
}

export interface ToolOutcomeObservation {
  source: ToolOutcomeSource
  toolName: string
  toolCallId: string
  outcome: ToolOutcome["status"]
  failureKind?: ToolFailureKind
  /** Runtime evidence metadata. Payloads are summarized/hashed at the ledger boundary. */
  requestScope?: ToolEvidenceScope
  payloadSummary?: string
  payloadHash?: string
  complete?: boolean
  timestamp?: string
  correlation?: ToolCorrelationContext
  executionContract?: {
    allowed: boolean
    code?: string
    reason?: string
    revision?: number
  }
  evidenceFields?: string[]
}

export type ToolOutcomeObserver = (observation: ToolOutcomeObservation) => void

export type ToolTraceEmitter = (event: {
  type: "tool_execution_start" | "tool_execution_update" | "tool_execution_end"
  toolCallId: string
  toolName: string
  args?: Record<string, unknown>
  result?: string
  data?: unknown
  diagnostics?: AgentToolDiagnostic[]
  metadata?: Record<string, unknown>
  partialResult?: string
  outcome?: ToolOutcome
  isError?: boolean
}) => void

export interface AgentToolDiagnostic {
  code: string
  severity: "info" | "warning" | "error"
  message: string
  details?: unknown
}

export type ToolFailureKind =
  | "not_found"
  | "transport_error"
  | "permission_denied"
  | "validation_error"
  | "cancelled"
  | "execution_error"

export type ToolOutcome =
  | { status: "success" }
  | {
      status: "failed"
      failure: {
        kind: ToolFailureKind
        code: string
        message: string
        details?: unknown
      }
    }

export interface StructuredToolErrorOptions {
  kind: ToolFailureKind
  code?: string
  details?: unknown
  metadata?: Record<string, unknown>
}

export interface AgentToolResult {
  text: string
  data?: unknown
  diagnostics?: AgentToolDiagnostic[]
  metadata?: Record<string, unknown>
  outcome: ToolOutcome
}

export type AgentToolExecutionResult = AgentToolResult

export function structuredToolResult(
  text: string,
  data: unknown,
  diagnostics: AgentToolDiagnostic[] = [],
  metadata?: Record<string, unknown>,
): AgentToolResult {
  return { text, data, diagnostics, outcome: { status: "success" }, ...(metadata ? { metadata } : {}) }
}

export function structuredToolError(
  text: string,
  codeOrOptions: string | StructuredToolErrorOptions = "tool_error",
  details?: unknown,
  metadata?: Record<string, unknown>,
): AgentToolResult {
  const options = typeof codeOrOptions === "string"
    ? { kind: inferToolFailureKind(codeOrOptions, details), code: codeOrOptions, details, metadata }
    : codeOrOptions
  const code = options.code || "tool_error"
  return {
    text,
    data: null,
    diagnostics: [{ code, severity: "error", message: text, ...(options.details === undefined ? {} : { details: options.details }) }],
    outcome: {
      status: "failed",
      failure: {
        kind: options.kind,
        code,
        message: text,
        ...(options.details === undefined ? {} : { details: options.details }),
      },
    },
    ...(options.metadata ? { metadata: options.metadata } : {}),
  }
}

function inferToolFailureKind(code: string, details?: unknown): ToolFailureKind {
  const status = details && typeof details === "object" && "status" in details
    ? Number((details as { status?: unknown }).status)
    : undefined
  if (status === 401 || status === 403) return "permission_denied"
  if (status === 404) return "not_found"
  if (/(^|_)(not[_-]?found|missing|no[_-]?such)(_|$)/i.test(code)) return "not_found"
  if (/(^|_)(permission|access|authorization|confirmation|denied)(_|$)/i.test(code)) return "permission_denied"
  if (/(^|_)(invalid|validation|malformed|unsupported|required)(_|$)/i.test(code)) return "validation_error"
  if (/(^|_)(cancel|cancelled|aborted|abort)(_|$)/i.test(code)) return "cancelled"
  if (/(^|_)(network|transport|fetch|timeout)(_|$)/i.test(code)) return "transport_error"
  return "execution_error"
}

export function assertStructuredToolResult(result: unknown): AgentToolResult {
  if (!result || typeof result !== "object" || Array.isArray(result)) throw toolResultContractError("Tool must return a structured result object")
  const candidate = result as Record<string, unknown>
  if (typeof candidate.text !== "string" || !isToolOutcome(candidate.outcome)) throw toolResultContractError("Tool result must include a valid outcome envelope")
  if (candidate.diagnostics !== undefined && (!Array.isArray(candidate.diagnostics) || candidate.diagnostics.some((diagnostic) => !isAgentToolDiagnostic(diagnostic)))) {
    throw toolResultContractError("Tool result diagnostics are invalid")
  }
  if (candidate.metadata !== undefined && (!candidate.metadata || typeof candidate.metadata !== "object" || Array.isArray(candidate.metadata))) {
    throw toolResultContractError("Tool result metadata must be an object")
  }
  return result as AgentToolResult
}

function toolResultContractError(message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code: "tool_result_contract_required" })
}

export type ToolFailure = Extract<ToolOutcome, { status: "failed" }>['failure']

export function classifyThrownToolFailure(error: unknown, signal?: AbortSignal): ToolFailure {
  const record = error && typeof error === "object"
    ? error as { name?: unknown; code?: unknown; cause?: unknown; message?: unknown }
    : undefined
  const name = typeof record?.name === "string" ? record.name : ""
  const code = typeof record?.code === "string" ? record.code : ""
  const message = error instanceof Error ? error.message : String(error)
  const cause = record?.cause && typeof record.cause === "object"
    ? record.cause as { code?: unknown; message?: unknown }
    : undefined
  const causeCode = typeof cause?.code === "string" ? cause.code : ""
  const causeMessage = typeof cause?.message === "string" ? cause.message : ""

  // Undici may surface an abort racing a socket teardown as `TypeError: fetch failed`.
  // The caller-owned signal is authoritative for this boundary, so preserve the
  // cancellation terminal state instead of misclassifying it as transport failure.
  if (signal?.aborted) {
    return { kind: "cancelled", code: "tool_cancelled", message: "Tool execution cancelled" }
  }

  if (code === "tool_result_contract_required") {
    return { kind: "validation_error", code, message }
  }

  if (name === "AbortError" || code === "ABORT_ERR" || /\b(?:abort|aborted|cancel|cancelled)\b/i.test(message)) {
    return { kind: "cancelled", code: "tool_cancelled", message }
  }
  if (
    code === "ECONNREFUSED" || code === "ECONNRESET" || code === "ETIMEDOUT" ||
    causeCode === "ECONNREFUSED" || causeCode === "ECONNRESET" || causeCode === "ETIMEDOUT" ||
    /fetch failed|network error|socket|connection reset|connection refused|timed out/i.test(`${message} ${causeMessage}`)
  ) {
    return { kind: "transport_error", code: /timeout|timed out/i.test(`${message} ${causeMessage}`) ? "tool_timeout" : "tool_transport_failed", message }
  }
  return { kind: "execution_error", code: "tool_execution_failed", message }
}

function isToolOutcome(value: unknown): value is ToolOutcome {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const outcome = value as Record<string, unknown>
  if (outcome.status === "success") return true
  if (outcome.status !== "failed" || !outcome.failure || typeof outcome.failure !== "object" || Array.isArray(outcome.failure)) return false
  const failure = outcome.failure as Record<string, unknown>
  return isToolFailureKind(failure.kind) && typeof failure.code === "string" && typeof failure.message === "string"
}

function isAgentToolDiagnostic(value: unknown): value is AgentToolDiagnostic {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const diagnostic = value as Record<string, unknown>
  return typeof diagnostic.code === "string"
    && (diagnostic.severity === "info" || diagnostic.severity === "warning" || diagnostic.severity === "error")
    && typeof diagnostic.message === "string"
}

function isToolFailureKind(value: unknown): value is ToolFailureKind {
  return value === "not_found" || value === "transport_error" || value === "permission_denied"
    || value === "validation_error" || value === "cancelled" || value === "execution_error"
}
