import { randomUUID } from "node:crypto"

export const PLAN_STATE_CUSTOM_TYPE = "my-code-agent.plan.state"

export type PlanStateStatus = "active" | "pending" | "committed" | "cancelled"
export type PlanStateSource = "user" | "agent" | "restore" | "system"
export type PlanStateTarget = Exclude<PlanStateStatus, "pending">

export interface PlanStateSnapshot {
  status: PlanStateStatus
  revision: number
  updatedAt: string
  source: PlanStateSource
  requestId?: string
  pendingTarget?: PlanStateTarget
  summary?: string
  reason?: string
}

export interface PlanStateSessionManager {
  appendCustomEntry(customType: string, data?: unknown): unknown
}

export function defaultPlanState(): PlanStateSnapshot {
  return {
    status: "committed",
    revision: 0,
    updatedAt: new Date(0).toISOString(),
    source: "system",
    reason: "default_execution_state",
  }
}

function validSnapshot(value: unknown): value is PlanStateSnapshot {
  if (!value || typeof value !== "object") return false
  const state = value as Partial<PlanStateSnapshot>
  if (!(["active", "pending", "committed", "cancelled"] as const).includes(state.status as PlanStateStatus)) return false
  if (!Number.isSafeInteger(state.revision) || Number(state.revision) < 0) return false
  if (typeof state.updatedAt !== "string" || !state.updatedAt) return false
  if (!(["user", "agent", "restore", "system"] as const).includes(state.source as PlanStateSource)) return false
  if (state.requestId !== undefined && typeof state.requestId !== "string") return false
  if (state.summary !== undefined && typeof state.summary !== "string") return false
  if (state.reason !== undefined && typeof state.reason !== "string") return false
  if (state.status === "pending" && !(["active", "committed", "cancelled"] as const).includes(state.pendingTarget as PlanStateTarget)) return false
  if (state.status !== "pending" && (state.pendingTarget !== undefined || state.requestId !== undefined)) return false
  return true
}

export function readPlanState(entries: Iterable<unknown>): PlanStateSnapshot {
  let latest: PlanStateSnapshot | undefined
  for (const entry of entries) {
    if (!entry || typeof entry !== "object") continue
    const candidate = entry as { type?: unknown; customType?: unknown; data?: unknown }
    if (candidate.type !== "custom" || candidate.customType !== PLAN_STATE_CUSTOM_TYPE) continue
    if (!validSnapshot(candidate.data)) throw new Error("Invalid persisted plan state")
    if (!latest || candidate.data.revision >= latest.revision) latest = structuredClone(candidate.data)
  }
  return latest ?? defaultPlanState()
}

export function persistPlanState(manager: PlanStateSessionManager, state: PlanStateSnapshot): void {
  manager.appendCustomEntry(PLAN_STATE_CUSTOM_TYPE, state)
}

export function replacePlanState(
  previous: PlanStateSnapshot,
  status: PlanStateStatus,
  source: PlanStateSource,
  details: Partial<Pick<PlanStateSnapshot, "requestId" | "pendingTarget" | "summary" | "reason">> = {},
): PlanStateSnapshot {
  const next: PlanStateSnapshot = {
    status,
    revision: previous.revision + 1,
    updatedAt: new Date().toISOString(),
    source,
    ...details,
  }
  if (status === "pending") {
    next.requestId ||= randomUUID()
    if (!next.pendingTarget) throw new Error("Pending plan state requires a target")
  } else {
    delete next.requestId
    delete next.pendingTarget
  }
  return next
}

/** Settle state left pending by a process interruption at the restore boundary. */
export function recoverPlanState(state: PlanStateSnapshot): PlanStateSnapshot {
  if (state.status !== "pending") return state
  if (state.reason === "awaiting_user_approval") {
    return replacePlanState(state, "active", "restore", {
      summary: state.summary,
      reason: "approval_interrupted_during_restore",
    })
  }
  return replacePlanState(state, state.pendingTarget!, "restore", {
    summary: state.summary,
    reason: "pending_transition_committed_during_restore",
  })
}

export function planStateAllowsMutation(state: PlanStateSnapshot | undefined): boolean {
  return !state || state.status === "committed" || state.status === "cancelled"
}

export function formatPlanStateGuidance(state: PlanStateSnapshot | undefined): string {
  if (!state || state.status === "committed" || state.status === "cancelled") return ""
  if (state.status === "pending") {
    return "[Host plan state: pending] A planning-state transition is awaiting a safe boundary or explicit user decision. Do not perform mutations."
  }
  return "[Host plan state: active] Explore and produce a plan, but do not mutate files or external state. When the plan is ready, call exit_plan_mode with a concise summary; execution requires explicit user approval."
}
