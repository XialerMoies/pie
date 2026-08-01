import { defineAgentTool, structuredToolError, structuredToolResult, type AgentTool } from "../types.js"
import { getLocalApiBaseUrl, localApiFetch } from "./local-api.js"

export const fileOutlineTool: AgentTool = defineAgentTool({
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
    if (!path) return structuredToolError("文件路径不能为空。", "invalid_path")

    const params = new URLSearchParams({ path, mode: "toc" })
    if (ctx.workspace) params.set("root", ctx.workspace)

    const url = `${getLocalApiBaseUrl()}/api/file/read?${params.toString()}`
    const res = await localApiFetch(url, ctx)
    const data = await res.json().catch(() => ({ error: `HTTP ${res.status}` }))
    if (!res.ok || data.error) {
      const text = data.error === "Access denied" ? `无权限读取"${path}"` : `读取失败：${data.error || data.message || res.status}`
      return structuredToolError(text, data.error === "Access denied" ? "path_access_denied" : "file_outline_failed", { path, status: res.status })
    }

    if (data.error === "binary") return structuredToolResult(`[二进制文件] ${path}，无法提取结构。`, { ...data, path, symbols: [], total: 0 }, [{ code: "binary_file", severity: "warning", message: "The file is binary and has no source outline" }])

    const symbols = data.symbols || []
    if (symbols.length === 0) return structuredToolResult(`📄 ${path}\n（没有识别到函数/类型定义，或文件为空）`, { ...data, path, symbols, total: 0 })

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

    return structuredToolResult(lines.join("\n"), { ...data, path, symbols, total: data.total ?? symbols.length })
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
