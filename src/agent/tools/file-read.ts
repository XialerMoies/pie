import { defineAgentTool, structuredToolError, structuredToolResult, type AgentTool } from "../types.js"
import { getLocalApiBaseUrl, localApiFetch } from "./local-api.js"

export const fileReadTool: AgentTool = defineAgentTool({
  name: "file_read",
  description:
    "读取文件内容。支持指定行范围、自动截断大文件。比 bash cat 更安全：大文件不会刷爆上下文，" +
    "二进制文件不会输出乱码，显示行号方便引用。",
  parameters: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "文件路径（相对工作区的路径）",
      },
      startLine: {
        type: "number",
        description: "起始行号（从 1 开始，默认 1）",
      },
      maxLines: {
        type: "number",
        description: "最大返回行数（默认 200，超过的部分会被截断并提示）",
      },
    },
    required: ["path"],
  },
  execute: async (args, ctx) => {
    const path = String(args.path || "").trim()
    if (!path) return structuredToolError("文件路径不能为空。", "invalid_path")

    const startLine = Math.max(1, Number(args.startLine) || 1)
    const maxLines = Math.min(Math.max(Number(args.maxLines) || 200, 1), 2000)

    const params = new URLSearchParams({ path })
    if (ctx.workspace) params.set("root", ctx.workspace)

    const url = `${getLocalApiBaseUrl()}/api/file/read?${params.toString()}`
    const res = await localApiFetch(url, ctx)
    const data = await res.json().catch(() => ({ error: `HTTP ${res.status}` }))
    if (!res.ok || data.error) {
      const text = data.error === "Access denied"
        ? `无权限读取"${path}"（路径不在工作区内）`
        : `读取失败：${data.error || data.message || `HTTP ${res.status}`}`
      return structuredToolError(text, data.error === "Access denied" ? "path_access_denied" : "file_read_failed", { path, status: res.status })
    }

    // 二进制文件
    if (data.encoding === "base64") {
      const sizeKB = (data.size / 1024).toFixed(1)
      return structuredToolResult(`[二进制文件] ${path} (${sizeKB}KB)，无法显示文本内容。`, {
        ...data,
        path,
        lineRange: null,
        totalLines: 0,
        truncated: false,
      })
    }

    // 按行切分
    const allLines = (data.content || "").split("\n")
    const totalLines = allLines.length
    const endLine = Math.min(startLine + maxLines - 1, totalLines)

    if (startLine > totalLines) {
      return structuredToolResult(`文件共 ${totalLines} 行，起始行 ${startLine} 超过文件长度。`, {
        ...data,
        path,
        lineRange: { start: startLine, end: startLine - 1 },
        totalLines,
        truncated: false,
      }, [{ code: "line_range_empty", severity: "warning", message: "Requested start line is beyond the file length" }])
    }

    const slice = allLines.slice(startLine - 1, endLine)
    const truncated = endLine < totalLines ? `\n...（文件共 ${totalLines} 行，仅显示 ${startLine}-${endLine} 行）` : ""

    const lines: string[] = []
    const lineWidth = String(endLine).length
    for (let i = 0; i < slice.length; i++) {
      lines.push(`${String(startLine + i).padStart(lineWidth)}|${slice[i]}`)
    }

    // 文件头信息
    const mtime = data.mtime ? data.mtime.slice(0, 16).replace("T", " ") : ""
    const header = `📄 ${path}  (${totalLines} 行, ${(data.size / 1024).toFixed(1)}KB${mtime ? ", " + mtime : ""})`
    return structuredToolResult(header + "\n" + lines.join("\n") + truncated, {
      ...data,
      path,
      lineRange: { start: startLine, end: endLine },
      totalLines,
      truncated: endLine < totalLines,
    })
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
