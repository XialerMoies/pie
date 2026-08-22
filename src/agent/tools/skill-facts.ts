import { defineAgentTool, structuredToolError, structuredToolResult, type AgentTool } from "../types.js"
import { getLocalApiBaseUrl, localApiFetch } from "./local-api.js"

/** Read the host-owned normalized skill status instead of reconstructing it from files. */
export const skillFactsTool: AgentTool = defineAgentTool({
  name: "skill_facts",
  description: "读取规范技能状态（trust、enabled、parse）。只用于事实核验，不读取技能正文。",
  parameters: {
    type: "object",
    properties: {
      id: { type: "string", description: "技能 id，例如 skill-verification" },
      source: { type: "string", enum: ["user", "workspace"], description: "技能作用域" },
    },
    required: ["id"],
  },
  isReadOnly: true,
  isConcurrencySafe: true,
  operations: ["read"],
  riskLevel: "low",
  needsPermission: false,
  workspaceBounded: true,
  resultFormat: "structured",
  execute: async (args, ctx) => {
    const id = String(args.id || "").trim()
    const source = args.source === "user" ? "user" : "workspace"
    if (!id || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id)) return structuredToolError("技能 id 无效。", "invalid_skill_id")
    const url = `${getLocalApiBaseUrl()}/api/settings/skills`
    const response = await localApiFetch(url, ctx)
    const body = await response.json().catch(() => ({ error: `HTTP ${response.status}` })) as {
      skills?: Array<{ id?: unknown; source?: unknown; trust?: unknown; enabled?: unknown; parse?: unknown; path?: unknown }>
      revision?: unknown
      workspaceKey?: unknown
      error?: unknown
    }
    if (!response.ok || body.error) return structuredToolError(`技能状态读取失败：${String(body.error || `HTTP ${response.status}`)}`, "skill_facts_failed", { status: response.status })
    const skill = Array.isArray(body.skills)
      ? body.skills.find((entry) => entry && entry.id === id && (entry.source === source || source === "workspace" && entry.source === undefined))
      : undefined
    if (!skill) return structuredToolError(`未找到技能：${id}（${source}）`, "skill_not_found", { id, source })
    const evidenceFields = (["trust", "enabled", "parse"] as const).filter((field) =>
      Object.prototype.hasOwnProperty.call(skill, field) && skill[field] !== undefined,
    )
    const data = {
      id,
      source,
      trust: skill.trust,
      enabled: skill.enabled,
      parse: skill.parse,
      path: skill.path,
      revision: body.revision,
      workspaceKey: body.workspaceKey,
      evidenceFields,
    }
    return structuredToolResult(`技能 ${id}：trust=${String(skill.trust)}，enabled=${String(skill.enabled)}，parse=${String(skill.parse)}`, data, [], { evidenceFields: data.evidenceFields })
  },
})
