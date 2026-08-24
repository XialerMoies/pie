import { readFileSync } from "node:fs"

export const AGENT_PROFILE_SESSION_CUSTOM_TYPE = "my-code-agent.profile"

export type AgentProfileId = "standard" | "minimal" | "fact-verification" | (string & {})

export interface AgentProfile {
  id: AgentProfileId
  revision: number
  description: string
  toolNames: "*" | readonly string[]
  promptSections: "*" | readonly string[]
  allowMcp: boolean
  includeSkills: boolean
}

export interface AgentProfileSelection {
  id: AgentProfileId
  revision: number
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
  return Object.freeze({
    ...profile,
    toolNames: profile.toolNames === "*" ? "*" : Object.freeze([...profile.toolNames]),
    promptSections: profile.promptSections === "*" ? "*" : Object.freeze([...profile.promptSections]),
  })
}

export class AgentProfileRegistry {
  readonly #profiles = new Map<string, AgentProfile>()

  register(profile: AgentProfile): void {
    const id = String(profile.id || "").trim()
    if (!/^[a-z0-9][a-z0-9-]*$/u.test(id)) throw new Error(`Invalid agent profile id: ${id || "(empty)"}`)
    if (!Number.isSafeInteger(profile.revision) || profile.revision < 1) throw new Error(`Invalid agent profile revision: ${profile.revision}`)
    if (this.#profiles.has(id)) throw new Error(`Agent profile already registered: ${id}`)
    this.#profiles.set(id, freezeProfile({ ...profile, id }))
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
}

export const agentProfileRegistry = new AgentProfileRegistry()

agentProfileRegistry.register({
  id: "standard",
  revision: 1,
  description: "Full coding-agent capability set.",
  toolNames: "*",
  promptSections: "*",
  allowMcp: true,
  includeSkills: true,
})

agentProfileRegistry.register({
  id: "minimal",
  revision: 1,
  description: "Small deterministic coding surface with one shell and one editor.",
  toolNames: ["command", "str_replace_editor"],
  promptSections: [
    "identity",
    "code_style",
    "response_style",
    "engineering_rules",
    "operation_boundaries",
    "language_preference",
    "env_info",
  ],
  allowMcp: false,
  includeSkills: false,
})

agentProfileRegistry.register({
  id: "fact-verification",
  revision: 1,
  description: "Bounded read-only evidence collection for inspectable fact checks.",
  toolNames: ["file_read", "explorer_list", "skill_facts", "list_memory", "read_memory"],
  promptSections: [
    "fact_verification_identity",
    "evidence_contract",
    "task_lifecycle",
    "response_style",
    "language_preference",
    "token_budget",
    "env_info",
  ],
  allowMcp: false,
  includeSkills: false,
})

export function resolveAgentProfile(id: string | undefined): AgentProfile {
  return agentProfileRegistry.require(id?.trim() || "standard")
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
