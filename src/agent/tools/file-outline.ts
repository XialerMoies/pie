import type { AgentTool } from "../types.js"

function getBaseUrl(): string {
  const port = process.env.SERVER_PORT || process.env.PI_DEV_PORT || "3099"
  return `http://127.0.0.1:${port}`
}

export const fileOutlineTool: AgentTool = {
  name: "file_outline",
  description:
    "查看代码文件的结构目录——列出所有函数、类型、接口、方法的签名及其行号。" +
    "比直接 file_read 更省 token：先看结构，再决定读哪一段。配合 file_read 使用。",
  parameters: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "文件路径（相对工作区的路径）",
      },
    },
    required: ["path"],
  },
  execute: async (args, ctx) => {
    const path = String(args.path || "").trim()
    if (!path) return "文件路径不能为空。"

    const params = new URLSearchParams({ path, mode: "toc" })
    if (ctx.workspace) params.set("root", ctx.workspace)

    const url = `${getBaseUrl()}/api/file/read?${params.toString()}`
    const res = await fetch(url)
    const data = await res.json().catch(() => ({ error: `HTTP ${res.status}` }))
    if (!res.ok || data.error) {
      return data.error === "Access denied"
        ? `无权限读取"${path}"`
        : `读取失败：${data.error || data.message || res.status}`
    }

    if (data.error === "binary") return `[二进制文件] ${path}，无法提取结构。`

    const symbols = data.symbols || []
    if (symbols.length === 0) return `📄 ${path}\n（没有识别到函数/类型定义，或文件为空）`

    const lines: string[] = []
    lines.push(`📄 ${path}  —  ${data.total} 个符号`)
    lines.push("")

    const kindLabels: Record<string, string> = {
      func: "func", export: "export", class: "class", interface: "interface",
      type: "type", enum: "enum", method: "method", def: "def", fn: "fn",
      const: "const", rs: "rs",
    }

    for (const s of symbols) {
      const label = kindLabels[s.kind] || s.kind
      lines.push(`  L${String(s.line).padStart(4)}  ${label}  ${s.name}`)
    }

    return lines.join("\n")
  },

  isReadOnly: true,
  isDestructive: false,
  isConcurrencySafe: true,
}
