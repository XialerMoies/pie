import type { SkillSource } from "../../../agent/skills/types.js"
import type { RouteHandler } from "../types.js"
import { cors } from "./common.js"

const ITEM_ROUTE = /^\/api\/settings\/skills\/(user|workspace)\/([A-Za-z0-9][A-Za-z0-9._-]*)\/(trust|untrust|enable|disable)$/
const REMOVE_ROUTE = /^\/api\/settings\/skills\/(user|workspace)\/([A-Za-z0-9][A-Za-z0-9._-]*)$/

function json(res: Parameters<RouteHandler>[1], status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json", ...cors })
  res.end(JSON.stringify(body))
}

export const handleSkillSettings: RouteHandler = async (req, res, ctx) => {
  const service = ctx.skillService
  const url = req.url?.split("?")[0] || ""
  if (!url.startsWith("/api/settings/skills")) return false
  if (!service) {
    json(res, 503, { ok: false, error: "Skill service unavailable" })
    return true
  }
  try {
    if (url === "/api/settings/skills" && req.method === "GET") {
      json(res, 200, { ok: true, ...await service.list() })
      return true
    }
    if (url === "/api/settings/skills/rescan" && req.method === "POST") {
      const result = await service.rescan()
      const promptRefresh = await ctx.runtime.refreshSystemPrompt()
      json(res, 200, { ok: true, ...result, promptRefresh })
      return true
    }
    const item = url.match(ITEM_ROUTE)
    if (item && req.method === "POST") {
      const [, source, id, action] = item as unknown as [string, SkillSource, string, "trust" | "untrust" | "enable" | "disable"]
      await service[action](source, id)
      const promptRefresh = await ctx.runtime.refreshSystemPrompt()
      json(res, 200, { ok: true, ...await service.list(), promptRefresh })
      return true
    }
    const remove = url.match(REMOVE_ROUTE)
    if (remove && req.method === "DELETE") {
      await service.remove(remove[1] as SkillSource, remove[2])
      const promptRefresh = await ctx.runtime.refreshSystemPrompt()
      json(res, 200, { ok: true, ...await service.list(), promptRefresh })
      return true
    }
    json(res, 400, { ok: false, error: "Invalid skill route" })
  } catch (error: any) {
    const message = error?.message || "Skill operation failed"
    json(res, /untrusted|overridden|content changed/i.test(message) ? 409 : 400, { ok: false, error: message })
  }
  return true
}
