import { defineAgentTool, structuredToolError, structuredToolResult, type AgentTool } from "../types.js"
import { getLocalApiBaseUrl, localApiFetch } from "./local-api.js"

export const gitLogTool: AgentTool = defineAgentTool({
  name: "git_log",
  description:
    "查看 Git 提交历史。配合 git-status 使用：git-status 看当前状态，git-log 看历史记录。",
  parameters: {
    type: "object",
    properties: {
      count: {
        type: "number",
        description: "查看最近多少条提交（默认 10，最多 50）",
      },
    },
  },
  execute: async (args, ctx) => {
    const count = Math.min(Math.max(Number(args.count) || 10, 1), 50)

    const params = new URLSearchParams({ count: String(count) })
    if (ctx.workspace) params.set("root", ctx.workspace)

    const url = `${getLocalApiBaseUrl()}/api/git/log?${params.toString()}`
    const res = await localApiFetch(url, ctx)
    const data = await res.json().catch(() => ({ error: `HTTP ${res.status}` }))
    if (!res.ok || data.error) {
      return data.error === "not_a_repo"
        ? "当前目录不是 Git 仓库。"
        : `获取 Git 日志失败：${data.message || data.error || res.status}`
    }

    if (!data || typeof data !== "object" || !Array.isArray(data.entries)) {
      return structuredToolError("获取 Git 日志失败：工具结果不完整（缺少提交条目）", "git_log_incomplete", {
        status: res.status,
        returnedFields: data && typeof data === "object" ? Object.keys(data) : [],
      })
    }

    const entries = data.entries
    if (entries.length === 0) return "没有提交记录。"

    const lines: string[] = []
    lines.push(`📋 最近 ${entries.length} 次提交（${data.gitRoot || ""}）`)
    lines.push("")

    for (const e of entries) {
      const date = e.date ? e.date.slice(0, 10) : ""
      lines.push(`  ${e.hash}  ${date}  ${e.message}`)
    }

    return structuredToolResult(lines.join("\n"), { ...data, entries, count: entries.length, requestedCount: count })
  },

  isReadOnly: true,
  isDestructive: false,
  isConcurrencySafe: true,
  operations: ["read"],
  riskLevel: "low",
  needsPermission: false,
  workspaceBounded: true,
  resultFormat: "structured",
})
