import { readFileSync } from "node:fs"
import { createHash } from "node:crypto"
import type { ToolPresentationMode } from "./tool-presentation.js"

export const AGENT_PROFILE_SESSION_CUSTOM_TYPE = "my-code-agent.profile"
export const AGENT_PROFILE_LIFECYCLE_CUSTOM_TYPE = "my-code-agent.profile.lifecycle"

export type AgentProfileId = "standard" | "minimal" | (string & {})
export type AgentProfileHealth = "ready" | "broken" | "unavailable"
export type AgentProfileSource = "builtin" | "workspace" | "user"
export type AgentFeatureId = "web" | "memory" | "delegation" | "skills" | "planning" | "mcp"

export const AGENT_FEATURE_IDS = ["web", "memory", "delegation", "skills", "planning", "mcp"] as const satisfies readonly AgentFeatureId[]
const AGENT_FEATURE_SET = new Set<string>(AGENT_FEATURE_IDS)

export interface AgentProfile {
  id: AgentProfileId
  revision: number
  description: string
  toolNames: "*" | readonly string[]
  presentation: ToolPresentationMode
  promptSections: "*" | readonly string[]
  featureGates: "*" | readonly AgentFeatureId[]
  allowMcp: boolean
  includeSkills: boolean
}

export interface AgentProfileSelection {
  id: AgentProfileId
  revision: number
}

export interface AgentProfileRef extends AgentProfileSelection {
  generation: number
}

export interface AgentProfileSnapshot {
  id: AgentProfileId
  revision: number
  generation: number
  health: AgentProfileHealth
  source: AgentProfileSource
  profile?: AgentProfile
  fingerprint?: string
  error?: { code: string; message: string }
}

export type AgentProfileLifecycleAction = "create" | "resume" | "switch" | "fork"
export type AgentProfileLifecycleStatus = "applied" | "rejected" | "rolled_back"

export interface AgentProfileLifecycleFact {
  requested: AgentProfileRef
  effective?: AgentProfileRef
  source: AgentProfileSource
  fingerprint?: string
  action: AgentProfileLifecycleAction
  status: AgentProfileLifecycleStatus
  reason?: string
  timestamp: string
}

type SessionEntryLike = {
  type?: unknown
  customType?: unknown
  data?: unknown
}

type ProfileSessionManager = {
  appendCustomEntry(customType: string, data?: unknown): unknown
}

function freezeProfile(profile: AgentProfile): AgentProfile {
  if (profile.featureGates !== "*") {
    if (!Array.isArray(profile.featureGates)) throw new Error(`Agent profile ${profile.id} must declare featureGates`)
    const invalid = profile.featureGates.filter((feature) => !AGENT_FEATURE_SET.has(feature))
    if (invalid.length > 0) throw new Error(`Agent profile ${profile.id} references unknown feature gate(s): ${invalid.join(", ")}`)
    if (new Set(profile.featureGates).size !== profile.featureGates.length) {
      throw new Error(`Agent profile ${profile.id} contains duplicate feature gates`)
    }
  }
  const mcpEnabled = profile.featureGates === "*" || profile.featureGates.includes("mcp")
  if (profile.allowMcp !== mcpEnabled) {
    throw new Error(`Agent profile ${profile.id} has inconsistent allowMcp and mcp feature gate`)
  }
  return Object.freeze({
    ...profile,
    toolNames: profile.toolNames === "*" ? "*" : Object.freeze([...profile.toolNames]),
    promptSections: profile.promptSections === "*" ? "*" : Object.freeze([...profile.promptSections]),
    featureGates: profile.featureGates === "*" ? "*" : Object.freeze([...profile.featureGates]),
  })
}

export class AgentProfileRegistry {
  readonly #profiles = new Map<string, AgentProfile>()
  readonly #snapshots = new Map<string, AgentProfileSnapshot>()
  readonly #history = new Map<string, Map<number, AgentProfileSnapshot>>()
  #generation = 0

  register(profile: AgentProfile): void {
    const id = String(profile.id || "").trim()
    if (!/^[a-z0-9][a-z0-9-]*$/u.test(id)) throw new Error(`Invalid agent profile id: ${id || "(empty)"}`)
    if (!Number.isSafeInteger(profile.revision) || profile.revision < 1) throw new Error(`Invalid agent profile revision: ${profile.revision}`)
    if (this.#profiles.has(id)) throw new Error(`Agent profile already registered: ${id}`)
    const frozen = freezeProfile({ ...profile, id })
    this.#profiles.set(id, frozen)
    this.#publishSnapshot(frozen, "builtin")
  }

  #publishSnapshot(profile: AgentProfile, source: AgentProfileSource, fingerprint?: string): AgentProfileSnapshot {
    const generation = ++this.#generation
    const snapshot: AgentProfileSnapshot = Object.freeze({
      id: profile.id,
      revision: profile.revision,
      generation,
      health: "ready",
      source,
      profile,
      fingerprint: fingerprint ?? profileFingerprint(profile),
    })
    this.#snapshots.set(profile.id, snapshot)
    const history = this.#history.get(profile.id) ?? new Map<number, AgentProfileSnapshot>()
    history.set(generation, snapshot)
    this.#history.set(profile.id, history)
    return snapshot
  }

  /** Replace a discovered profile. Existing sessions retain the prior generation. */
  replace(profile: AgentProfile, source: AgentProfileSource = "workspace", fingerprint?: string): AgentProfileSnapshot {
    const id = String(profile.id || "").trim()
    if (!this.#profiles.has(id)) throw new Error(`Unknown agent profile: ${id || "(empty)"}`)
    const frozen = freezeProfile({ ...profile, id })
    this.#profiles.set(id, frozen)
    return this.#publishSnapshot(frozen, source, fingerprint)
  }

  registerBroken(id: string, revision = 1, source: AgentProfileSource = "workspace", error = "Profile configuration is invalid"): AgentProfileSnapshot {
    this.#profiles.delete(String(id || "").trim())
    return this.#publishUnavailable({ id: id as AgentProfileId, revision, health: "broken", source, error: { code: "profile_broken", message: error } })
  }

  markUnavailable(id: string, revision = 1, source: AgentProfileSource = "workspace", error = "Profile is unavailable"): AgentProfileSnapshot {
    this.#profiles.delete(String(id || "").trim())
    return this.#publishUnavailable({ id: id as AgentProfileId, revision, health: "unavailable", source, error: { code: "profile_unavailable", message: error } })
  }

  #publishUnavailable(input: Omit<AgentProfileSnapshot, "generation" | "fingerprint">): AgentProfileSnapshot {
    const generation = ++this.#generation
    const snapshot: AgentProfileSnapshot = Object.freeze({ ...input, generation })
    this.#snapshots.set(input.id, snapshot)
    const history = this.#history.get(input.id) ?? new Map<number, AgentProfileSnapshot>()
    history.set(generation, snapshot)
    this.#history.set(input.id, history)
    return snapshot
  }

  get(id: string): AgentProfile | undefined {
    return this.#profiles.get(String(id || "").trim())
  }

  require(id: string): AgentProfile {
    const profile = this.get(id)
    if (!profile) throw new Error(`Unknown agent profile: ${String(id || "(empty)")}`)
    return profile
  }

  list(): AgentProfile[] {
    return [...this.#profiles.values()]
  }

  getSnapshot(id: string): AgentProfileSnapshot {
    return this.#snapshots.get(String(id || "").trim()) ?? {
      id: String(id || "(empty)") as AgentProfileId,
      revision: 0,
      generation: 0,
      health: "unavailable",
      source: "workspace",
      error: { code: "profile_unavailable", message: `Unknown agent profile: ${String(id || "(empty)")}` },
    }
  }

  getGeneration(id: string): number { return this.getSnapshot(id).generation }

  resolveRef(ref: AgentProfileRef): AgentProfileSnapshot {
    const snapshot = this.#history.get(String(ref.id || "").trim())?.get(ref.generation)
    if (!snapshot || snapshot.revision !== ref.revision || snapshot.health !== "ready" || !snapshot.profile) {
      throw new Error(`Unavailable agent profile generation: ${ref.id}@${ref.revision}#${ref.generation}`)
    }
    return snapshot
  }

  listSnapshots(): AgentProfileSnapshot[] { return [...this.#snapshots.values()] }
}

export const agentProfileRegistry = new AgentProfileRegistry()

agentProfileRegistry.register({
  id: "standard",
  revision: 1,
  description: "Full coding-agent capability set.",
  toolNames: "*",
  presentation: "native",
  promptSections: "*",
  featureGates: "*",
  allowMcp: true,
  includeSkills: true,
})

agentProfileRegistry.register({
  id: "minimal",
  revision: 1,
  description: "Small deterministic coding surface with one shell and one editor.",
  toolNames: ["command", "str_replace_editor", "enter_plan_mode", "exit_plan_mode"],
  presentation: "native",
  promptSections: [
    "identity",
    "code_style",
    "response_style",
    "engineering_rules",
    "operation_boundaries",
    "language_preference",
    "env_info",
  ],
  featureGates: ["planning"],
  allowMcp: false,
  includeSkills: false,
})

export function resolveAgentProfile(id: string | undefined): AgentProfile {
  return agentProfileRegistry.require(id?.trim() || "standard")
}

export function profileFingerprint(profile: AgentProfile): string {
  return createHash("sha256").update(JSON.stringify({
    id: profile.id,
    revision: profile.revision,
    description: profile.description,
    toolNames: profile.toolNames,
    presentation: profile.presentation,
    promptSections: profile.promptSections,
    featureGates: profile.featureGates,
    allowMcp: profile.allowMcp,
    includeSkills: profile.includeSkills,
  })).digest("hex")
}

export function agentProfileRef(profile: AgentProfile): AgentProfileRef {
  return { ...agentProfileSelection(profile), generation: agentProfileRegistry.getGeneration(profile.id) }
}

export function resolveAgentProfileRef(ref: AgentProfileRef): AgentProfile {
  return agentProfileRegistry.resolveRef(ref).profile!
}

export function resolveAgentProfileSelection(selection: AgentProfileSelection): AgentProfile {
  const profile = resolveAgentProfile(selection.id)
  if (profile.revision !== selection.revision) {
    throw new Error(`Unsupported agent profile revision: ${selection.id}@${selection.revision}`)
  }
  return profile
}

export function agentProfileSelection(profile: AgentProfile): AgentProfileSelection {
  return { id: profile.id, revision: profile.revision }
}

function parseSelection(value: unknown): AgentProfileSelection | undefined {
  if (!value || typeof value !== "object") return undefined
  const record = value as { id?: unknown; revision?: unknown }
  if (typeof record.id !== "string" || !record.id.trim()) return undefined
  if (!Number.isSafeInteger(record.revision) || Number(record.revision) < 1) return undefined
  return { id: record.id.trim(), revision: Number(record.revision) }
}

export function readAgentProfileSelection(entries: Iterable<unknown>): AgentProfileSelection | undefined {
  let selection: AgentProfileSelection | undefined
  for (const raw of entries) {
    if (!raw || typeof raw !== "object") continue
    const entry = raw as SessionEntryLike
    if (entry.type !== "custom" || entry.customType !== AGENT_PROFILE_SESSION_CUSTOM_TYPE) continue
    const parsed = parseSelection(entry.data)
    if (!parsed) throw new Error("Invalid persisted agent profile selection")
    if (selection && (selection.id !== parsed.id || selection.revision !== parsed.revision)) {
      throw new Error(`Conflicting persisted agent profiles: ${selection.id}@${selection.revision} and ${parsed.id}@${parsed.revision}`)
    }
    selection = parsed
  }
  return selection
}

export function readAgentProfileSelectionFile(sessionFile: string): AgentProfileSelection | undefined {
  const entries: unknown[] = []
  for (const line of readFileSync(sessionFile, "utf8").split(/\r?\n/u)) {
    if (!line.trim()) continue
    try { entries.push(JSON.parse(line)) } catch {}
  }
  return readAgentProfileSelection(entries)
}

export function persistAgentProfileSelection(sessionManager: ProfileSessionManager, profile: AgentProfile): void {
  sessionManager.appendCustomEntry(AGENT_PROFILE_SESSION_CUSTOM_TYPE, agentProfileSelection(profile))
}

function parseRef(value: unknown): AgentProfileRef | undefined {
  if (!value || typeof value !== "object") return undefined
  const record = value as { id?: unknown; revision?: unknown; generation?: unknown }
  if (typeof record.id !== "string" || !record.id.trim()) return undefined
  if (!Number.isSafeInteger(record.revision) || Number(record.revision) < 1) return undefined
  if (!Number.isSafeInteger(record.generation) || Number(record.generation) < 1) return undefined
  return { id: record.id.trim(), revision: Number(record.revision), generation: Number(record.generation) }
}

export function readAgentProfileLifecycle(entries: Iterable<unknown>): AgentProfileLifecycleFact | undefined {
  let latest: AgentProfileLifecycleFact | undefined
  for (const raw of entries) {
    if (!raw || typeof raw !== "object") continue
    const entry = raw as SessionEntryLike
    if (entry.type !== "custom" || entry.customType !== AGENT_PROFILE_LIFECYCLE_CUSTOM_TYPE) continue
    const data = entry.data
    if (!data || typeof data !== "object") throw new Error("Invalid persisted agent profile lifecycle")
    const value = data as Partial<AgentProfileLifecycleFact>
    const requested = parseRef(value.requested)
    const effective = value.effective === undefined ? undefined : parseRef(value.effective)
    if (!requested || (value.effective !== undefined && !effective)
      || !["create", "resume", "switch", "fork"].includes(String(value.action))
      || !["applied", "rejected", "rolled_back"].includes(String(value.status))
      || typeof value.source !== "string" || typeof value.timestamp !== "string") {
      throw new Error("Invalid persisted agent profile lifecycle")
    }
    latest = {
      requested,
      ...(effective ? { effective } : {}),
      source: value.source as AgentProfileSource,
      ...(typeof value.fingerprint === "string" ? { fingerprint: value.fingerprint } : {}),
      action: value.action as AgentProfileLifecycleAction,
      status: value.status as AgentProfileLifecycleStatus,
      ...(typeof value.reason === "string" ? { reason: value.reason } : {}),
      timestamp: value.timestamp,
    }
  }
  return latest
}

export function persistAgentProfileLifecycle(sessionManager: ProfileSessionManager, fact: AgentProfileLifecycleFact): void {
  sessionManager.appendCustomEntry(AGENT_PROFILE_LIFECYCLE_CUSTOM_TYPE, fact)
}
