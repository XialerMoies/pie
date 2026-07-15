import type { AgentTool } from "../types.js"

function getBaseUrl(): string {
  const port = process.env.SERVER_PORT || process.env.PI_DEV_PORT || "3099"
  return `http://127.0.0.1:${port}`
}

export const explorerListTool: AgentTool = {
  name: "explorer_list",
  description:
    "列出目录内容，返回结构化的文件和文件夹列表。比 bash ls 更好用：自动过滤 node_modules/.git、" +
    "目录排前面、显示完整相对路径。配合 file_read / search 使用：用这个看目录结构，用 search 找代码，用 file_read 读内容。",
  parameters: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "要列出的子目录路径（相对工作区根目录，不传或空字符串则列出根目录）",
      },
      filter: {
        type: "boolean",
        description: "是否启用过滤（隐藏文件、node_modules、.gitignore 匹配的目录，默认 true）",
      },
    },
  },
  execute: async (args, ctx) => {
    const subPath = String(args.path || "").trim()
    const filter = args.filter !== false

    const params = new URLSearchParams()
    if (subPath) params.set("path", subPath)
    if (filter) params.set("filter", "1")
    if (ctx.workspace) params.set("root", ctx.workspace)

    const url = `${getBaseUrl()}/api/explorer?${params.toString()}`
    const res = await fetch(url)
    const data = await res.json().catch(() => ({ error: `HTTP ${res.status}` }))
    if (!res.ok || data.error) return `列出目录失败：${data.error || data.message || res.status}`

    const items = data.items || []
    if (items.length === 0) return `目录"${subPath || "/"}"为空。`

    const dirs = items.filter((i: any) => i.isDir)
    const files = items.filter((i: any) => !i.isDir)

    const lines: string[] = []
    const displayPath = subPath || "/"
    lines.push(`📁 ${displayPath}  （${items.length} 项，${dirs.length} 目录 / ${files.length} 文件）`)
    lines.push("")

    if (dirs.length > 0) {
      for (const d of dirs) {
        lines.push(`  📁 ${d.path}/`)
      }
      lines.push("")
    }

    if (files.length > 0) {
      for (const f of files) {
        const sizeStr = f.size > 1024 ? `${(f.size / 1024).toFixed(0)}KB` : `${f.size}B`
        const mtimeStr = f.mtime ? f.mtime.slice(0, 10) : ""
        lines.push(`  📄 ${f.path}  (${sizeStr}, ${mtimeStr})`)
      }
    }

    return lines.join("\n")
  },

  isReadOnly: true,
  isDestructive: false,
  isConcurrencySafe: true,
}
