import { createHash } from "node:crypto"
import type { AgentProfileSnapshot } from "./agent-profile.js"
import type { SkillSummary } from "./skills/types.js"
import type { SubagentDefinition } from "../data/subagent-config.js"
import type { MemoryMetadata } from "./memory-store.js"

/**
 * A declaration-only view of user/workspace capabilities.
 *
 * These records are catalog data, not executable component bindings. In
 * particular, prompts and Skill bodies are intentionally omitted so a catalog
 * reader cannot turn discovery into code loading or instruction injection.
 */
export const DECLARATIVE_RESOURCE_SCHEMA_VERSION = 1 as const
export type DeclarativeResourceKind = "skill" | "subagent" | "profile" | "provider" | "memory"
export type DeclarativeResourceSource = "builtin" | "workspace" | "user"

export interface DeclarativeComponentResource {
  schemaVersion: typeof DECLARATIVE_RESOURCE_SCHEMA_VERSION
  id: string
  kind: DeclarativeResourceKind
  source: DeclarativeResourceSource
  trusted: boolean
  enabled: boolean
  generation: number
  revision: string | number
  fingerprint: string
  declaration: Readonly<Record<string, unknown>>
}

export interface DeclarativeResourceCatalog {
  schemaVersion: typeof DECLARATIVE_RESOURCE_SCHEMA_VERSION
  generation: number
  resources: DeclarativeComponentResource[]
  fingerprint: string
}

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value, (_key, item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return item
    return Object.fromEntries(Object.keys(item).sort().map((key) => [key, item[key]]))
  })).digest("hex")
}

function base(input: Omit<DeclarativeComponentResource, "schemaVersion" | "fingerprint">, fingerprintValue: unknown): DeclarativeComponentResource {
  return {
    schemaVersion: DECLARATIVE_RESOURCE_SCHEMA_VERSION,
    ...input,
    fingerprint: digest(fingerprintValue),
  }
}

export function declarativeSkillResource(summary: SkillSummary, generation = 0): DeclarativeComponentResource {
  const declaration = {
    name: summary.name,
    description: summary.description,
    parse: summary.parse,
    declaredTools: [...summary.declaredTools],
    ...(summary.diagnostic ? { diagnostic: { code: summary.diagnostic.code, message: summary.diagnostic.message } } : {}),
  }
  return base({
    id: summary.id,
    kind: "skill",
    source: summary.source,
    trusted: summary.trust === "trusted",
    enabled: summary.enabled,
    generation,
    revision: summary.fingerprint || digest(declaration),
    declaration,
  }, summary.fingerprint || declaration)
}

export function declarativeSubagentResource(agent: SubagentDefinition, generation = 0): DeclarativeComponentResource {
  const declaration = {
    name: agent.name,
    description: agent.description,
    tools: [...agent.tools],
    ...(agent.model ? { model: { provider: agent.model.provider, id: agent.model.id } } : {}),
  }
  return base({
    id: agent.id,
    kind: "subagent",
    source: "user",
    trusted: true,
    enabled: true,
    generation,
    revision: 1,
    declaration,
  }, declaration)
}

export function declarativeProfileResource(snapshot: AgentProfileSnapshot): DeclarativeComponentResource {
  const profile = snapshot.profile
  const declaration = profile ? {
    description: profile.description,
    presentation: profile.presentation,
    featureGates: profile.featureGates === "*" ? "*" : [...profile.featureGates],
    allowMcp: profile.allowMcp,
    includeSkills: profile.includeSkills,
    toolCount: profile.toolNames === "*" ? "*" : profile.toolNames.length,
  } : { health: snapshot.health, error: snapshot.error?.code || "unavailable" }
  return base({
    id: snapshot.id,
    kind: "profile",
    source: snapshot.source,
    trusted: snapshot.source === "builtin" || snapshot.health === "ready",
    enabled: snapshot.health === "ready" && !!profile,
    generation: snapshot.generation,
    revision: snapshot.revision,
    declaration,
  }, snapshot.fingerprint || { id: snapshot.id, revision: snapshot.revision, health: snapshot.health, declaration })
}

export interface DeclarativeProviderInput {
  id: string
  name: string
  source: "builtin" | "user"
  configured: boolean
  protocol?: string
  modelCount?: number
}

/** Provider configuration is a resource; credentials and endpoint values stay out of the catalog. */
export function declarativeProviderResource(provider: DeclarativeProviderInput, generation = 0): DeclarativeComponentResource {
  const declaration = {
    name: provider.name,
    configured: provider.configured,
    ...(provider.protocol ? { protocol: provider.protocol } : {}),
    ...(provider.modelCount === undefined ? {} : { modelCount: provider.modelCount }),
  }
  return base({
    id: provider.id,
    kind: "provider",
    source: provider.source,
    trusted: true,
    enabled: provider.configured,
    generation,
    revision: 1,
    declaration,
  }, declaration)
}

/** Memory is a user/workspace data resource, not an installable component. */
export function declarativeMemoryResource(memory: MemoryMetadata, generation = 0): DeclarativeComponentResource {
  const declaration = {
    name: memory.name,
    scope: memory.scope,
    summary: memory.summary,
    updatedAt: memory.updatedAt,
  }
  return base({
    id: memory.id,
    kind: "memory",
    source: memory.scope,
    trusted: memory.source !== "legacy",
    enabled: memory.enabled,
    generation,
    revision: memory.updatedAt,
    declaration,
  }, { id: memory.id, ...declaration })
}

export interface DeclarativeResourceCatalogInput {
  skills?: readonly SkillSummary[]
  subagents?: readonly SubagentDefinition[]
  profiles?: readonly AgentProfileSnapshot[]
  providers?: readonly DeclarativeProviderInput[]
  memories?: readonly MemoryMetadata[]
  generation?: number
}

export function buildDeclarativeResourceCatalog(input: DeclarativeResourceCatalogInput = {}): DeclarativeResourceCatalog {
  const resources = [
    ...(input.skills || []).map((skill) => declarativeSkillResource(skill)),
    ...(input.subagents || []).map((agent) => declarativeSubagentResource(agent)),
    ...(input.profiles || []).map((profile) => declarativeProfileResource(profile)),
    ...(input.providers || []).map((provider) => declarativeProviderResource(provider)),
    ...(input.memories || []).map((memory) => declarativeMemoryResource(memory)),
  ].sort((left, right) => `${left.kind}:${left.id}`.localeCompare(`${right.kind}:${right.id}`))
  const generation = input.generation ?? Math.max(0, ...resources.map((resource) => resource.generation))
  const payload = { schemaVersion: DECLARATIVE_RESOURCE_SCHEMA_VERSION, generation, resources }
  return { ...payload, fingerprint: digest(payload) }
}
