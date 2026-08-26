import { createHash } from "node:crypto"
import {
  agentProfileRegistry,
  type AgentProfile,
  type AgentFeatureId,
  type AgentProfileHealth,
  type AgentProfileSnapshot,
} from "./agent-profile.js"
import { listPromptSections, type PromptSection } from "./prompts.js"
import { resolveToolPresentation, type ToolPresentationMode } from "./tool-presentation.js"
import { profileAllowsFeature, ToolPool, type AgentToolAudience, type ToolPoolEntry, type ToolPoolSource } from "./tool-pool.js"
import { toolRegistry } from "./tools/index.js"
import type { AgentTool, ToolOperation } from "./types.js"
import type { CapabilityComponentManager } from "./capability-components.js"

export interface ProfileToolCatalogEntry {
  name: string
  label: string
  presentation: ToolPresentationMode
  executable: boolean
  enabled: boolean
  permissionRequired: boolean
  authorizationMode: string
  riskLevel: string
  operations: ToolOperation[]
  workspaceBounded: boolean
  source: ToolPoolSource
  feature?: AgentFeatureId
  audiences: AgentToolAudience[]
  schemaFingerprint: string
}

export interface ProfilePromptCatalogEntry {
  key: string
  enabled: boolean
  volatile: boolean
  contentFingerprint: string
}

export interface ProfileCatalog {
  schemaVersion: 1
  id: string
  revision: number
  generation: number
  health: AgentProfileHealth
  presentation: ToolPresentationMode
  featureGates: "*" | readonly AgentFeatureId[]
  tools: ProfileToolCatalogEntry[]
  promptSections: ProfilePromptCatalogEntry[]
  dependencies: { mcp: boolean; skills: boolean }
  dynamicSources: string[]
  disabledTools: string[]
  fingerprint: string
  errors?: string[]
}

export interface ProfileCatalogOptions {
  registry?: typeof toolRegistry
  promptSections?: readonly PromptSection[]
  componentManager?: CapabilityComponentManager
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue)
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value as Record<string, unknown>).sort().map((key) => [key, stableValue((value as Record<string, unknown>)[key])]))
  }
  return value
}

function stableJson(value: unknown): string {
  return JSON.stringify(stableValue(value))
}

function fingerprint(value: unknown): string {
  return createHash("sha256").update(stableJson(value)).digest("hex")
}

function promptFingerprint(section: PromptSection): string {
  // Factory output may contain time, cwd, or other volatile data. The catalog
  // fingerprints the declaration in that case so generated output is stable.
  return fingerprint(section.factory && section.volatile
    ? { key: section.key, volatile: true }
    : { key: section.key, content: section.content || "", volatile: section.volatile === true })
}

function healthSnapshot(profileOrSnapshot: AgentProfile | AgentProfileSnapshot): AgentProfileSnapshot {
  if ("health" in profileOrSnapshot) return profileOrSnapshot
  return {
    id: profileOrSnapshot.id,
    revision: profileOrSnapshot.revision,
    generation: 0,
    health: "ready",
    source: "builtin",
    profile: profileOrSnapshot,
  }
}

function selectedPromptSections(profile: AgentProfile, sections: readonly PromptSection[]): PromptSection[] {
  if (profile.promptSections === "*") return [...sections]
  const requested = new Set(profile.promptSections)
  const available = new Set(sections.map((section) => section.key))
  const missing = [...requested].filter((key) => !available.has(key))
  if (missing.length > 0) throw new Error(`Agent profile references unknown prompt section(s): ${missing.join(", ")}`)
  return sections.filter((section) => requested.has(section.key))
}

function toolCatalogEntry(tool: AgentTool, entry: ToolPoolEntry, presentation: ToolPresentationMode): ProfileToolCatalogEntry {
  const enabled = !tool.isEnabled || tool.isEnabled()
  return {
    name: tool.name,
    label: tool.name,
    presentation,
    executable: typeof tool.execute === "function" && enabled,
    enabled,
    permissionRequired: tool.needsPermission === true,
    authorizationMode: tool.authorizationMode || "generic",
    riskLevel: tool.riskLevel || "medium",
    operations: [...(tool.operations || [])],
    workspaceBounded: tool.workspaceBounded !== false,
    source: entry.source,
    ...(entry.feature ? { feature: entry.feature } : {}),
    audiences: [...entry.audiences],
    schemaFingerprint: fingerprint({ name: tool.name, description: tool.description, parameters: tool.parameters }),
  }
}

function catalogFingerprint(catalog: Omit<ProfileCatalog, "fingerprint">): string {
  return fingerprint(catalog)
}

export function buildProfileCatalog(
  profileOrSnapshot: AgentProfile | AgentProfileSnapshot,
  options: ProfileCatalogOptions = {},
): ProfileCatalog {
  const snapshot = healthSnapshot(profileOrSnapshot)
  const base = {
    schemaVersion: 1 as const,
    id: snapshot.id,
    revision: snapshot.revision,
    generation: snapshot.generation,
    health: snapshot.health,
    presentation: snapshot.profile?.presentation || "native" as const,
    featureGates: snapshot.profile?.featureGates || [] as readonly AgentFeatureId[],
    tools: [] as ProfileToolCatalogEntry[],
    promptSections: [] as ProfilePromptCatalogEntry[],
    dependencies: { mcp: false, skills: false },
    dynamicSources: [] as string[],
    disabledTools: [] as string[],
  }

  if (snapshot.health !== "ready" || !snapshot.profile) {
    const errors = snapshot.error ? [`${snapshot.error.code}: ${snapshot.error.message}`] : [`profile_${snapshot.health}`]
    return { ...base, fingerprint: catalogFingerprint({ ...base, errors }), errors }
  }

  const profile = snapshot.profile
  const registry = options.registry || toolRegistry
  const sections = options.promptSections || listPromptSections()
  const pool = new ToolPool().addNative(registry.getAll())
  const requestedNames = profile.toolNames === "*"
    ? "*"
    : profile.toolNames.map((name) => registry.resolveName(name) || name)
  const hostTools = pool.project({ audience: "main", names: requestedNames, featureGates: profile.featureGates, componentManager: options.componentManager })
  if (profile.toolNames !== "*") {
    const declaredNames = profile.toolNames.map((name) => registry.resolveName(name))
    if (declaredNames.some((name): name is undefined => !name)) {
      throw new Error(`Agent profile references unknown tool(s): ${profile.toolNames.filter((_, index) => !declaredNames[index]).join(", ")}`)
    }
    const declaredSet = new Set(declaredNames as string[])
    const hostSet = new Set(hostTools.map((tool) => tool.name))
    if (declaredSet.size !== hostSet.size || [...declaredSet].some((name) => !hostSet.has(name))) {
      throw new Error(`Profile tool projection mismatch for ${profile.id}: declared=[${[...declaredSet].join(",")}] projected=[${[...hostSet].join(",")}]`)
    }
  }
  const presentation = resolveToolPresentation(profile.presentation)
  const presentedTools = presentation.present(hostTools)
  const hostNames = hostTools.map((tool) => tool.name)
  const presentedNames = presentedTools.map((tool) => String(tool.name))
  const errors: string[] = []
  if (stableJson(hostNames) !== stableJson(presentedNames)) {
    errors.push(`presentation tool mismatch: host=[${hostNames.join(",")}] model=[${presentedNames.join(",")}]`)
  }
  for (let index = 0; index < hostTools.length; index += 1) {
    const host = hostTools[index]
    const model = presentedTools[index] as { execute?: unknown } | undefined
    if (!model || typeof model.execute !== "function") errors.push(`model-visible tool is not executable: ${host.name}`)
    if (typeof host.execute !== "function" || (host.isEnabled && !host.isEnabled())) errors.push(`host tool is not executable: ${host.name}`)
  }

  const selectedSections = selectedPromptSections(profile, sections)
  const entriesByName = new Map(pool.entries().map((entry) => [entry.tool.name, entry]))
  const tools = hostTools.map((tool) => toolCatalogEntry(tool, entriesByName.get(tool.name)!, profile.presentation))
  const hostNamesSet = new Set(hostTools.map((tool) => tool.name))
  const disabledTools = pool.entries().filter((entry) => !hostNamesSet.has(entry.tool.name)).map((entry) => entry.tool.name)
  const promptCatalog = selectedSections.map((section) => ({
    key: section.key,
    enabled: section.enabled !== false,
    volatile: section.volatile === true,
    contentFingerprint: promptFingerprint(section),
  }))
  const dependencies = { mcp: profile.allowMcp && profileAllowsFeature(profile, "mcp"), skills: profile.includeSkills }
  const dynamicSources = dependencies.mcp ? ["mcp"] : []
  const completed = { ...base, tools, promptSections: promptCatalog, dependencies, dynamicSources, disabledTools }
  if (errors.length > 0) throw new Error(`Invalid profile catalog for ${profile.id}: ${errors.join("; ")}`)
  return { ...completed, fingerprint: catalogFingerprint(completed) }
}

export function buildAllProfileCatalogs(options: ProfileCatalogOptions = {}): ProfileCatalog[] {
  return agentProfileRegistry.listSnapshots().sort((left, right) => left.id.localeCompare(right.id)).map((snapshot) => buildProfileCatalog(snapshot, options))
}

export function assertProfileCatalogsReady(options: ProfileCatalogOptions = {}): ProfileCatalog[] {
  const catalogs = buildAllProfileCatalogs(options)
  const invalid = catalogs.filter((catalog) => catalog.health !== "ready" || catalog.errors?.length)
  if (invalid.length > 0) {
    throw new Error(`Agent profile catalog preflight failed: ${invalid.map((catalog) => `${catalog.id}:${catalog.health}`).join(", ")}`)
  }
  return catalogs
}
