/** Host-owned execution stages. Extensions may observe this marker but do not define the chain. */
export const HOST_EXECUTION_CHAIN = Object.freeze([
  "permission",
  "security",
  "pathGuard",
  "trace",
  "abort",
  "terminal",
] as const)

export type HostExecutionStage = typeof HOST_EXECUTION_CHAIN[number]

export interface ToolExecutionBoundary {
  readonly version: 1
  readonly stages: readonly HostExecutionStage[]
}
