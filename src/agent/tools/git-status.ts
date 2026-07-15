import type { AgentTool } from "../types.js"

/** 获取后端 API 的 base URL */
function getBaseUrl(): string {
  // 优先用 SERVER_PORT（server.ts 启动时设置），fallback dev port，最后 3099
  const port = process.env.SERVER_PORT || process.env.PI_DEV_PORT || "3099"
  return `http://127.0.0.1:${port}`
}

export const gitStatusTool: AgentTool = {
  name: "git-status",
  description:
    "查看当前 Git 仓库的状态，包括已修改的文件、暂存区、未跟踪的文件、分支信息",
  parameters: {
    type: "object",
    properties: {},
  },
  execute: async (args, ctx) => {
    const ws = ctx.workspace || ""
    const url = ws
      ? `${getBaseUrl()}/api/git/status?root=${encodeURIComponent(ws)}`
      : `${getBaseUrl()}/api/git/status`
    const res = await fetch(url)
    const data = await res.json().catch(() => ({ error: "parse_error", message: `HTTP ${res.status}` }))
    if (!res.ok || data.error) {
      const hint = data.error === "not_a_repo"
        ? "当前目录不是 Git 仓库。需要先 `git init` 初始化，或切换到有 .git 的工作区。"
        : `Git 操作失败：${data.message || data.error || `HTTP ${res.status}`}`
      return hint
    }
    // 构建 LLM 友好的摘要
    const lines: string[] = []
    if (data.gitRoot) lines.push(`Git 根目录：${data.gitRoot}`)
    if (data.branch) lines.push(`分支：${data.branch}`)
    if (data.ahead !== undefined || data.behind !== undefined) {
      if (data.ahead > 0 && data.behind > 0) lines.push(`远程差异：领先 ${data.ahead} / 落后 ${data.behind}`)
      else if (data.ahead > 0) lines.push(`远程差异：领先 ${data.ahead}`)
      else if (data.behind > 0) lines.push(`远程差异：落后 ${data.behind}`)
      else if (data.ahead === 0 && data.behind === 0) lines.push(`远程差异：与远程一致`)
    }
    if (data.lastCommit) lines.push(`最新提交：${data.lastCommit}`)
    if (data.total !== undefined) {
      lines.push(`变更总数：${data.total}`)
      if (data.modified) lines.push(`修改：${data.modified}`)
      if (data.added) lines.push(`新增：${data.added}`)
      if (data.deleted) lines.push(`删除：${data.deleted}`)
      if (data.entries) {
        const untracked = data.entries.filter((e: any) => e.y === "?").length
        if (untracked > 0) lines.push(`未跟踪：${untracked}`)
      }
    }
    if (data.entries?.length > 0) {
      lines.push("")
      lines.push("文件详情：")
      for (const e of data.entries) {
        const tag = e.x === "?" ? "新增" : e.y === "?" ? "未跟踪" : e.x === "M" ? "暂存" : e.y === "M" ? "修改" : e.y === "D" ? "删除" : e.y === "R" ? "重命名" : e.x || e.y
        lines.push(`  ${tag}\t${e.path}`)
      }
    }
    return lines.join("\n") || "没有变更，工作区干净"
  },

  isReadOnly: true,
  isDestructive: false,
  isConcurrencySafe: true,
}