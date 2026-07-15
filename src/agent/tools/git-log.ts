import type { AgentTool } from "../types.js"

function getBaseUrl(): string {
  const port = process.env.SERVER_PORT || process.env.PI_DEV_PORT || "3099"
  return `http://127.0.0.1:${port}`
}

export const gitLogTool: AgentTool = {
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

    const url = `${getBaseUrl()}/api/git/log?${params.toString()}`
    const res = await fetch(url)
    const data = await res.json().catch(() => ({ error: `HTTP ${res.status}` }))
    if (!res.ok || data.error) {
      return data.error === "not_a_repo"
        ? "当前目录不是 Git 仓库。"
        : `获取 Git 日志失败：${data.message || data.error || res.status}`
    }

    const entries = data.entries || []
    if (entries.length === 0) return "没有提交记录。"

    const lines: string[] = []
    lines.push(`📋 最近 ${entries.length} 次提交（${data.gitRoot || ""}）`)
    lines.push("")

    for (const e of entries) {
      const date = e.date ? e.date.slice(0, 10) : ""
      lines.push(`  ${e.hash}  ${date}  ${e.message}`)
    }

    return lines.join("\n")
  },

  isReadOnly: true,
  isDestructive: false,
  isConcurrencySafe: true,
}
