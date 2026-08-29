import { resolve } from "node:path"
import type { RouteHandler } from "./types.js"
import { agentProfileRegistry } from "../../agent/agent-profile.js"
import { buildDeclarativeResourceCatalog } from "../../agent/declarative-resources.js"
import { readSubagentDefinitions } from "../../data/subagent-config.js"
import { readOrRebuildMemoryIndex, resolveMemoryRoot } from "../../agent/memory-store.js"

/** Read-only declaration catalog. It never returns prompts, Skill bodies, or executable entry paths. */
export const handleDeclarativeResources: RouteHandler = async (req, res, ctx) => {
  if (req.url !== "/api/resources/catalog" || req.method !== "GET") return false
  const { paths } = ctx.groups.storage
  const skillService = ctx.groups.core.skillService
  const skills = skillService ? (await skillService.list()).skills : []
  const agentsFile = paths.SUBAGENTS_FILE || resolve(paths.PI_CONFIG_DIR, "subagents.json")
  const workspace = (ctx.groups.core.runtime as any)?.currentWorkspace || paths.APP_ROOT || process.cwd()
  const memories = [
    ...readOrRebuildMemoryIndex(resolveMemoryRoot({ scope: "user", userMemoryRoot: resolve(paths.PI_CONFIG_DIR, "memory") }), "user").entries,
    ...readOrRebuildMemoryIndex(resolveMemoryRoot({ scope: "workspace", workspace }), "workspace").entries,
  ]
  const providerResources = [] as Array<{ id: string; name: string; source: "builtin" | "user"; configured: boolean; protocol?: string; modelCount?: number }>
  const providerService = ctx.groups.providers?.customProviderService
  if (providerService) {
    try {
      const runtime = ctx.groups.providers?.model?.providerRuntime
      if (!runtime) throw new Error("provider runtime unavailable")
      const providers = await providerService.list(runtime)
      providerResources.push(...providers.official.map((provider) => ({ id: provider.id, name: provider.name, source: "builtin" as const, configured: provider.configured })))
      providerResources.push(...providers.custom.map((provider) => ({ id: provider.id, name: provider.name, source: "user" as const, configured: Boolean(provider.apiKeyConfigured || provider.headers.some((header) => header.configured)), protocol: provider.protocol, modelCount: provider.models.length })))
    } catch {
      // Resource discovery is informational; an unavailable provider store must
      // not prevent skills, profiles, and memory metadata from being listed.
    }
  }
  const catalog = buildDeclarativeResourceCatalog({
    skills,
    subagents: readSubagentDefinitions(agentsFile),
    profiles: agentProfileRegistry.listSnapshots(),
    providers: providerResources,
    memories,
  })
  res.writeHead(200, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Cache-Control": "no-store",
  })
  res.end(JSON.stringify(catalog))
  return true
}
