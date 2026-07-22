/**
 * MCPToolAdapter — 将 MCP SDK 的 Tool 包装为 AgentTool。
 *
 * 职责：
 * - 统一 tool 命名前缀 mcp__<serverName>__<toolName>
 * - 转换 inputSchema（MCP → AgentTool JSON Schema）
 * - 代理 execute 调用到 client.callTool()
 * - 格式化返回结果为纯文本
 */

import type { Client } from "@modelcontextprotocol/sdk/client/index.js"
import type { RequestOptions } from "@modelcontextprotocol/sdk/shared/protocol.js"
import type { Tool } from "@modelcontextprotocol/sdk/types.js"
import type { AgentTool, ToolParameterSchema } from "../types"

// ─── 命名工具 ─────────────────────────────────────

/**
 * 规范化 server 名，确保只含合法标识符字符。
 */
export function normalizeServerName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_]/g, "_")
}

/**
 * 构造 MCP tool 的全限定名。
 * 格式：mcp__<serverName>__<toolName>
 *
 * server 名和 tool 名均做规范化（只保留 [a-zA-Z0-9_]），
 * 避免模型 provider 因工具名含非法字符而拒绝调用。
 */
export function buildMcpToolName(serverName: string, toolName: string): string {
  return `mcp__${normalizeServerName(serverName)}__${normalizeServerName(toolName)}`
}

// ─── Schema 转换 ───────────────────────────────────

/**
 * 将 MCP Tool.inputSchema 映射为 AgentTool 的 JSON Schema。
 * MCP 的 inputSchema 已经是 JSON Schema 格式，多数情况下直接透传。
 */
function convertInputSchema(inputSchema: Tool["inputSchema"]): ToolParameterSchema {
  if (!inputSchema) {
    return { type: "object", properties: {} }
  }
  // MCP inputSchema 是 JSON Schema object，与 AgentTool 格式兼容
  return {
    type: "object",
    properties: (inputSchema as any).properties ?? {},
    required: (inputSchema as any).required,
  }
}

// ─── 结果格式化 ────────────────────────────────────

/**
 * 将 MCP CallToolResult.content 数组格式化为纯文本。
 *
 * 处理策略：
 * - text content → 直接拼接
 * - image content → 标记为 [Image: <mimeType>]
 * - resource content → 标记为 [Resource: <uri>]
 */
export function formatMcpContent(
  content: Array<{ type: string; text?: string; mimeType?: string; uri?: string }>,
): string {
  return content
    .map((block) => {
      switch (block.type) {
        case "text":
          return block.text ?? ""
        case "image":
          return `[Image: ${block.mimeType ?? "unknown"}]`
        case "resource":
          return `[Resource: ${block.uri ?? block.text ?? "unknown"}]`
        default:
          return `[${block.type} content]`
      }
    })
    .join("\n")
}

// ─── 适配器工厂 ────────────────────────────────────

export interface McpToolAdapterOptions {
  /** MCP server 显示名 */
  serverName: string
  /** MCP SDK Tool 定义 */
  tool: Tool
  /** 已连接的 Client 实例 */
  client: Client
}

/**
 * 将 MCP Tool 包装为 AgentTool。
 *
 * execute 通过 client.callTool() 调用 MCP server。
 * MCP tool 相互隔离，不同 server 之间可安全并发。
 */
export function createMcpToolAdapter(opts: McpToolAdapterOptions): AgentTool {
  const { serverName, tool, client } = opts
  const prefixedName = buildMcpToolName(serverName, tool.name)
  // MCP tool 默认只读。工具本身的读写语义由 server 控制，不由客户端强制。
  // Phase 3 可通过服务器声明或其他标记覆盖此默认值。
  return {
    name: prefixedName,
    description: tool.description ?? "",
    parameters: convertInputSchema(tool.inputSchema),
    isReadOnly: false,
    isConcurrencySafe: true,
    isEnabled: () => true,
    execute: async (args, ctx) => {
      const requestOptions: RequestOptions = {}
      const signal = (ctx as any).signal as AbortSignal | undefined
      if (signal) requestOptions.signal = signal

      const result = await client.callTool(
        { name: tool.name, arguments: args as Record<string, unknown> },
        undefined,
        requestOptions,
      )

      if (result.isError) {
        throw new Error(formatMcpContent(result.content as any[]))
      }

      return formatMcpContent(result.content as any[])
    },
  }
}
