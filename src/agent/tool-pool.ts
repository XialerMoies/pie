import { canonicalToolName } from "./tool-identity.js"
import type { AgentFeatureId, AgentProfile } from "./agent-profile.js"
import type { AgentTool } from "./types.js"
import type { CapabilityComponentManager } from "./capability-components.js"
import { capabilityComponentIdForTool } from "./component-package.js"

export type AgentToolAudience = "main" | "coordinator" | "subagent"
export type ToolPoolSource = "native" | "mcp"

export const READ_ONLY_SUBAGENT_TOOL_NAMES = [
  "git-status",
  "search",
  "file_read",
  "explorer_list",
  "git_log",
  "file_outline",
] as const

export const COORDINATOR_TOOL_NAMES = [
  ...READ_ONLY_SUBAGENT_TOOL_NAMES,
  "delegate_tasks",
] as const

const SUBAGENT_TOOL_SET = new Set<string>(READ_ONLY_SUBAGENT_TOOL_NAMES)
const COORDINATOR_TOOL_SET = new Set<string>(COORDINATOR_TOOL_NAMES)

const NATIVE_TOOL_FEATURES = new Map<string, AgentFeatureId>([
  ["web-search", "web"],
  ["web-fetch", "web"],
  ["read_memory", "memory"],
  ["write_memory", "memory"],
  ["list_memory", "memory"],
  ["delete_memory", "memory"],
  ["set_memory_enabled", "memory"],
  ["delegate_tasks", "delegation"],
  ["skill_facts", "skills"],
  ["enter_plan_mode", "planning"],
  ["exit_plan_mode", "planning"],
])

export interface ToolPoolEntry {
  tool: AgentTool
  source: ToolPoolSource
  feature?: AgentFeatureId
  audiences: readonly AgentToolAudience[]
  componentId?: string
}

export interface ToolPoolProjection {
  audience: AgentToolAudience
  names?: "*" | readonly string[]
  featureGates?: "*" | readonly AgentFeatureId[]
  requireAllRequested?: boolean
  componentManager?: CapabilityComponentManager
}

function nativeAudiences(name: string): AgentToolAudience[] {
  return [
    "main",
    ...(COORDINATOR_TOOL_SET.has(name) ? ["coordinator" as const] : []),
    ...(SUBAGENT_TOOL_SET.has(name) ? ["subagent" as const] : []),
  ]
}

export function nativeToolFeature(name: string): AgentFeatureId | undefined {
  return NATIVE_TOOL_FEATURES.get(canonicalToolName(name))
}

export function profileAllowsFeature(profile: Pick<AgentProfile, "featureGates">, feature: AgentFeatureId): boolean {
  return profile.featureGates === "*" || profile.featureGates.includes(feature)
}

export class ToolPool {
  readonly #entries = new Map<string, ToolPoolEntry>()

  addNative(tools: readonly AgentTool[]): this {
    for (const tool of tools) this.#add(tool, "native", nativeToolFeature(tool.name), nativeAudiences(canonicalToolName(tool.name)), capabilityComponentIdForTool(tool.name))
    return this
  }

  addMcp(tools: readonly AgentTool[]): this {
    for (const tool of tools) {
      const match = /^mcp__(.+?)__.+$/u.exec(canonicalToolName(tool.name))
      this.#add(tool, "mcp", "mcp", ["main"], match ? `mcp-server.${match[1].toLowerCase()}` : undefined)
    }
    return this
  }

  #add(tool: AgentTool, source: ToolPoolSource, feature: AgentFeatureId | undefined, audiences: readonly AgentToolAudience[], componentId?: string): void {
    const name = canonicalToolName(tool.name)
    if (!name) throw new Error("Tool pool cannot add an unnamed tool")
    if (this.#entries.has(name)) throw new Error(`Tool pool duplicate identity: ${name}`)
    this.#entries.set(name, {
      tool: name === tool.name ? tool : { ...tool, name },
      source,
      ...(feature ? { feature } : {}),
      audiences: Object.freeze([...audiences]),
      ...(componentId ? { componentId } : {}),
    })
  }

  entries(): ToolPoolEntry[] {
    return [...this.#entries.values()]
  }

  project(request: ToolPoolProjection): AgentTool[] {
    const enabled = request.featureGates === "*" ? undefined : new Set(request.featureGates || [])
    const requested = request.names === undefined || request.names === "*"
      ? undefined
      : new Set(request.names.map((name) => canonicalToolName(name)))
    if (requested?.has("")) throw new Error("Tool pool projection contains an empty tool name")

    const selected = this.entries().filter((entry) => {
      if (requested && !requested.has(entry.tool.name)) return false
      if (!entry.audiences.includes(request.audience)) return false
      if (entry.feature && enabled && !enabled.has(entry.feature)) return false
      if (entry.tool.isEnabled && !entry.tool.isEnabled()) return false
      if (request.componentManager && entry.componentId) {
        const component = request.componentManager.get(entry.componentId)
        // Package-backed native contributions must disappear when their registration is
        // removed. MCP entries remain compatible until MCP server registration is migrated
        // to the component manager and can provide an authoritative component state.
        if (entry.source === "native" && (!component || component.status !== "active")) return false
        if (component && component.status !== "active") return false
      }
      return true
    })

    if (requested && request.requireAllRequested !== false) {
      const selectedNames = new Set(selected.map((tool) => tool.tool.name))
      const missing = [...requested].filter((name) => !selectedNames.has(name))
      if (missing.length > 0) throw new Error(`Tool pool projection denied or unavailable: ${missing.join(", ")}`)
    }
    return selected.map((entry) => entry.tool)
  }
}

export function buildProfileToolPool(
  profile: AgentProfile,
  nativeTools: readonly AgentTool[],
  mcpTools: readonly AgentTool[] = [],
  componentManager?: CapabilityComponentManager,
): ToolPool {
  const pool = new ToolPool().addNative(nativeTools)
  if (mcpTools.length > 0) {
    if (!profile.allowMcp || !profileAllowsFeature(profile, "mcp")) {
      throw new Error(`Profile ${profile.id} cannot load MCP tools`)
    }
    pool.addMcp(mcpTools)
  }
  return pool
}
