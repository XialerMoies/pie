import type { AgentProfile } from "./agent-profile.js"
import type { CapabilityComponentManager } from "./capability-components.js"
import type { ExtensionToolPoolEntry, ToolPoolEntry } from "./tool-pool.js"
import { ToolPool, profileAllowsFeature } from "./tool-pool.js"
import { canonicalToolName } from "./tool-identity.js"
import type { AgentTool } from "./types.js"

/** Host diagnostic tool. It stays available so an Agent can explain disabled tools. */
export const AGENT_TOOL_INVENTORY_TOOL_NAME = "list_agent_tools"

export type AgentToolAvailability = "available" | "component_disabled" | "component_untrusted" | "component_unhealthy" | "component_uninstalled" | "profile_hidden" | "runtime_unavailable"

export interface AgentToolInventoryEntry {
  name: string
  description: string
  source: ToolPoolEntry["source"]
  componentId?: string
  componentName?: string
  componentStatus?: string
  available: boolean
  reasons: readonly AgentToolAvailability[]
}

export interface AgentToolInventoryComponent {
  id: string
  name: string
  status: string
  source: string
  tools: readonly string[]
}

export interface AgentToolInventory {
  profile: { id: string; revision: number }
  available: readonly AgentToolInventoryEntry[]
  unavailable: readonly AgentToolInventoryEntry[]
  components: readonly AgentToolInventoryComponent[]
}

function profileAllowsTool(profile: AgentProfile, entry: ToolPoolEntry): boolean {
  if (!entry.audiences.includes("main")) return false
  if (entry.tool.name === AGENT_TOOL_INVENTORY_TOOL_NAME) return true
  if (profile.toolNames !== "*" && !profile.toolNames.some((name) => canonicalToolName(name) === entry.tool.name)) return false
  return !entry.feature || profileAllowsFeature(profile, entry.feature)
}

function componentReason(status: string | undefined, isNative: boolean): AgentToolAvailability | undefined {
  if (!status) return isNative ? "component_uninstalled" : undefined
  if (status === "active") return undefined
  if (status === "disabled") return "component_disabled"
  if (status === "untrusted") return "component_untrusted"
  return "component_unhealthy"
}

/**
 * Builds a host-owned availability snapshot. It intentionally lists disabled
 * packages without returning their executable AgentTool implementations.
 */
export function buildAgentToolInventory(
  profile: AgentProfile,
  nativeTools: readonly AgentTool[],
  extensionTools: readonly ExtensionToolPoolEntry[],
  componentManager: CapabilityComponentManager,
  mcpTools: readonly AgentTool[] = [],
): AgentToolInventory {
  const pool = new ToolPool().addNative(nativeTools).addExtensions(extensionTools).addMcp(mcpTools)
  const entries = pool.entries()
  const tools = entries.map((entry): AgentToolInventoryEntry => {
    const component = entry.componentId ? componentManager.get(entry.componentId) : undefined
    const reasons: AgentToolAvailability[] = []
    if (!profileAllowsTool(profile, entry)) reasons.push("profile_hidden")
    const reason = componentReason(component?.status, entry.source === "native" && entry.tool.name !== AGENT_TOOL_INVENTORY_TOOL_NAME)
    if (reason) reasons.push(reason)
    if (entry.tool.isEnabled && !entry.tool.isEnabled()) reasons.push("runtime_unavailable")
    return Object.freeze({
      name: entry.tool.name,
      description: entry.tool.description,
      source: entry.source,
      ...(entry.componentId ? { componentId: entry.componentId } : {}),
      ...(component?.manifest.displayName ? { componentName: component.manifest.displayName } : {}),
      ...(component ? { componentStatus: component.status } : {}),
      available: reasons.length === 0,
      reasons: Object.freeze(reasons),
    })
  }).sort((left, right) => left.name.localeCompare(right.name))

  const toolNamesByComponent = new Map<string, string[]>()
  for (const tool of tools) {
    if (!tool.componentId) continue
    const names = toolNamesByComponent.get(tool.componentId) ?? []
    names.push(tool.name)
    toolNamesByComponent.set(tool.componentId, names)
  }
  const components = componentManager.catalog().components
    .filter((component) => component.manifest.kind === "optional" && component.manifest.capability === "agent-tool")
    .map((component): AgentToolInventoryComponent => Object.freeze({
      id: component.manifest.id,
      name: component.manifest.displayName || component.manifest.id,
      status: component.status,
      source: component.manifest.source || "workspace",
      tools: Object.freeze([...(toolNamesByComponent.get(component.manifest.id) || [])].sort()),
    }))
    .sort((left, right) => left.id.localeCompare(right.id))

  return Object.freeze({
    profile: Object.freeze({ id: profile.id, revision: profile.revision }),
    available: Object.freeze(tools.filter((tool) => tool.available)),
    unavailable: Object.freeze(tools.filter((tool) => !tool.available)),
    components: Object.freeze(components),
  })
}
