import { resolve } from "node:path"
import type { RouteHandler } from "./types.js"
import { agentProfileRegistry } from "../../agent/agent-profile.js"
import { buildDeclarativeResourceCatalog } from "../../agent/declarative-resources.js"
import { readSubagentDefinitions } from "../../data/subagent-config.js"

/** Read-only declaration catalog. It never returns prompts, Skill bodies, or executable entry paths. */
export const handleDeclarativeResources: RouteHandler = async (req, res, ctx) => {
  if (req.url !== "/api/resources/catalog" || req.method !== "GET") return false
  const { paths } = ctx.groups.storage
  const skillService = ctx.groups.core.skillService
  const skills = skillService ? (await skillService.list()).skills : []
  const agentsFile = paths.SUBAGENTS_FILE || resolve(paths.PI_CONFIG_DIR, "subagents.json")
  const catalog = buildDeclarativeResourceCatalog({
    skills,
    subagents: readSubagentDefinitions(agentsFile),
    profiles: agentProfileRegistry.listSnapshots(),
  })
  res.writeHead(200, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Cache-Control": "no-store",
  })
  res.end(JSON.stringify(catalog))
  return true
}

