import type { AgentTool } from "../types.js"

function getBaseUrl(): string {
  const port = process.env.SERVER_PORT || process.env.PI_DEV_PORT || "3099"
  return `http://127.0.0.1:${port}`
}

export const searchTool: AgentTool = {
  name: "search",
  description:
    "在项目中搜索代码。支持两种模式：filename（按文件名匹配）和 text（全文搜索）。" +
    "比 bash grep 更好用：返回结构化结果（文件名+行号+匹配文本），自动跳过二进制文件、node_modules、.git 等无关目录。",
  parameters: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "搜索关键词",
      },
      type: {
        type: "string",
        enum: ["filename", "text"],
        description: "搜索模式：filename 按文件名匹配，text 全文搜索（默认 text）",
      },
      caseSensitive: {
        type: "boolean",
        description: "是否区分大小写（默认 false）",
      },
      maxResults: {
        type: "number",
        description: "最大返回结果数（默认 20，避免刷爆上下文）",
      },
    },
    required: ["query"],
  },
  execute: async (args, ctx) => {
    const query = String(args.query || "").trim()
    if (!query) return "搜索关键词不能为空。请提供 query 参数。"

    const type = String(args.type || "text").trim()
    const caseSensitive = args.caseSensitive === true
    const maxResults = Math.min(Math.max(Number(args.maxResults) || 20, 1), 100)

    const params = new URLSearchParams({
      q: query,
      type,
      caseSensitive: String(caseSensitive),
      maxResults: String(maxResults),
    })
    if (ctx.workspace) params.set("root", ctx.workspace)

    const url = `${getBaseUrl()}/api/search?${params.toString()}`
    const res = await fetch(url)
    const data = await res.json().catch(() => ({ error: `HTTP ${res.status}` }))
    if (!res.ok || data.error) return `搜索失败：${data.error || data.message || res.status}`

    if (!data.results || data.results.length === 0) {
      if (type === "filename") return `没有找到文件名包含"${query}"的文件。`
      return `没有找到内容包含"${query}"的文件（已忽略二进制文件、node_modules、.git 等目录）。`
    }

    const lines: string[] = []
    const truncated = data.truncated ? `（注意：maxResults=${maxResults} 限制的是搜索文件数，不是截断显示）` : ""
    const matchCount = type === "filename" ? data.results.length : data.total
    lines.push(`搜索"${query}"（${type === "filename" ? "文件名" : "全文"}）共 ${matchCount} 处匹配，${data.results.length} 个文件${truncated}`)
    lines.push("")

    // 按扩展名分组
    const codeExt = new Set([".go", ".ts", ".js", ".tsx", ".jsx", ".py", ".java", ".rs", ".c", ".cpp", ".h", ".hpp", ".cs", ".rb", ".php", ".swift", ".kt", ".sh", ".bash", ".sql", ".css", ".scss", ".less", ".vue", ".svelte"])
    const codeFiles: any[] = []
    const docFiles: any[] = []
    const otherFiles: any[] = []

    for (const r of data.results) {
      const ext = r.file.slice(r.file.lastIndexOf(".")).toLowerCase()
      if (codeExt.has(ext)) codeFiles.push(r)
      else if (ext === ".md" || ext === ".txt" || ext === ".json" || ext === ".yaml" || ext === ".yml" || ext === ".toml") docFiles.push(r)
      else otherFiles.push(r)
    }

    function renderGroup(items: any[], label: string): void {
      if (items.length === 0) return
      lines.push(`[${label} ${items.length} 个文件]`)
      for (const r of items) {
        if (type === "filename") {
          lines.push(`  📄 ${r.file}`)
        } else {
          lines.push(`  📄 ${r.file}（${r.matches.length} 处匹配）`)
          for (const m of r.matches.slice(0, 5)) {
            lines.push(`    L${m.line}:${m.column}  ${m.text.trim()}`)
          }
          if (r.matches.length > 5) {
            lines.push(`    ... 还有 ${r.matches.length - 5} 处匹配`)
          }
        }
      }
    }

    renderGroup(codeFiles, "代码")
    renderGroup(docFiles, "文档/配置")
    renderGroup(otherFiles, "其他")

    return lines.join("\n")
  },

  isReadOnly: true,
  isDestructive: false,
  isConcurrencySafe: true,
}
