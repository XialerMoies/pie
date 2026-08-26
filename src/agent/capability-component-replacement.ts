export const HIGH_RISK_REPLACEMENT_GROUPS = new Set([
  "bootstrap",
  "session-store",
  "permission",
  "security-parser",
  "mcp-host",
])

export interface RequiredComponentGenerationRef {
  generation: number
  providers: Readonly<Record<string, string>>
}

export interface RequiredComponentProviderBinding<T = unknown> {
  readonly componentId: string
  readonly replacementGroup: string
  readonly implementation: T
}

export interface RequiredComponentLease {
  readonly ref: RequiredComponentGenerationRef
  resolve(replacementGroup: string): string
  resolveBinding<T = unknown>(replacementGroup: string): RequiredComponentProviderBinding<T>
  release(): void
}

export interface RequiredReplacementCheck {
  status: "passed" | "failed"
  detail?: string
}

export interface RequiredReplacementPreflightReport {
  isolated: true
  staticCheck: RequiredReplacementCheck
  replay: RequiredReplacementCheck
  failureMatrix: RequiredReplacementCheck
  shadow: RequiredReplacementCheck
}

export interface RequiredReplacementContext {
  currentId: string
  candidateId: string
  replacementGroup: string
  capability: string
  signal: AbortSignal
}

export interface RequiredReplacementOptions {
  approved?: boolean
  preflightTimeoutMs?: number
  verificationTimeoutMs?: number
  preflight(context: RequiredReplacementContext): Promise<RequiredReplacementPreflightReport>
  persist?(ref: RequiredComponentGenerationRef): Promise<void>
  verify?(context: RequiredReplacementContext & { generation: number }): Promise<void>
}

export interface RequiredReplacementResult {
  status: "committed" | "rolled_back"
  replacementGroup: string
  previousId: string
  activeId: string
  generation: number
  preflight: RequiredReplacementPreflightReport
  reason?: string
}

export function failedReplacementChecks(report: RequiredReplacementPreflightReport): string[] {
  if (!report || report.isolated !== true) return ["isolated"]
  return (["staticCheck", "replay", "failureMatrix", "shadow"] as const)
    .filter((name) => report[name]?.status !== "passed")
}
