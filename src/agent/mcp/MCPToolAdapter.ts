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
import type {
  AgentTool,
  McpToolCapabilities,
  McpToolCapabilityDeclaration,
  ToolParameterSchema,
} from "../types.js"

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

const DEFAULT_MCP_CAPABILITIES: McpToolCapabilities = {
  readOnly: false,
  destructive: true,
  idempotent: false,
  openWorld: true,
  declaration: "defaulted",
}

export function normalizeMcpToolCapabilities(annotations: unknown): McpToolCapabilities {
  if (!annotations || typeof annotations !== "object") return { ...DEFAULT_MCP_CAPABILITIES }
  const value = annotations as Record<string, unknown>
  const keys = ["readOnlyHint", "destructiveHint", "idempotentHint", "openWorldHint"] as const
  if (keys.some((key) => typeof value[key] !== "boolean")) return { ...DEFAULT_MCP_CAPABILITIES }

  const normalized: McpToolCapabilities = {
    readOnly: value.readOnlyHint as boolean,
    destructive: value.destructiveHint as boolean,
    idempotent: value.idempotentHint as boolean,
    openWorld: value.openWorldHint as boolean,
    declaration: "declared",
  }
  if (normalized.readOnly && normalized.destructive) return { ...DEFAULT_MCP_CAPABILITIES }
  return normalized
}

function summarizeMcpContent(content: unknown[]): Array<Record<string, unknown>> {
  return content.map((rawBlock) => {
    if (!rawBlock || typeof rawBlock !== "object") return { type: "unknown" }
    const block = rawBlock as Record<string, unknown>
    const type = typeof block.type === "string" ? block.type : "unknown"
    if (type === "text") {
      return { type, textLength: typeof block.text === "string" ? block.text.length : 0 }
    }
    if (type === "image" || type === "audio") {
      return {
        type,
        ...(typeof block.mimeType === "string" ? { mimeType: block.mimeType } : {}),
        dataLength: typeof block.data === "string" ? block.data.length : 0,
      }
    }
    const uri = typeof block.uri === "string"
      ? block.uri
      : block.resource && typeof block.resource === "object" && typeof (block.resource as Record<string, unknown>).uri === "string"
        ? (block.resource as Record<string, unknown>).uri
        : undefined
    return { type, ...(uri ? { uri } : {}) }
  })
}

function normalizeMcpData(content: unknown[]): unknown[] {
  return content.map((rawBlock) => {
    if (!rawBlock || typeof rawBlock !== "object") return { type: "unknown" }
    const block = rawBlock as Record<string, unknown>
    const type = typeof block.type === "string" ? block.type : "unknown"
    return {
      type,
      ...(typeof block.text === "string" ? { text: block.text } : {}),
      ...(typeof block.mimeType === "string" ? { mimeType: block.mimeType } : {}),
      ...(typeof block.uri === "string" ? { uri: block.uri } : {}),
    }
  })
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
  const normalizedCapabilities = normalizeMcpToolCapabilities(tool.annotations)
  const mcpCapabilities: McpToolCapabilityDeclaration = {
    serverName,
    ...normalizedCapabilities,
  }
  const safeReadOnly = normalizedCapabilities.declaration === "declared" &&
    normalizedCapabilities.readOnly &&
    !normalizedCapabilities.destructive &&
    !normalizedCapabilities.openWorld
  // MCP tool 默认只读。工具本身的读写语义由 server 控制，不由客户端强制。
  // Phase 3 可通过服务器声明或其他标记覆盖此默认值。
  return {
    name: prefixedName,
    description: tool.description ?? "",
    parameters: convertInputSchema(tool.inputSchema),
    isReadOnly: safeReadOnly,
    isDestructive: normalizedCapabilities.destructive,
    isConcurrencySafe: true,
    isEnabled: () => true,
    operations: ["execute"],
    riskLevel: safeReadOnly ? "low" : "high",
    needsPermission: true,
    workspaceBounded: false,
    permissionSource: `mcp.${serverName}.${tool.name}`,
    mcpCapabilities,
    resultFormat: "structured",
    execute: async (args, ctx) => {
      const requestOptions: RequestOptions = {}
      const signal = (ctx as any).signal as AbortSignal | undefined
      if (signal) requestOptions.signal = signal

      const result = await client.callTool(
        { name: tool.name, arguments: args as Record<string, unknown> },
        undefined,
        requestOptions,
      )

      const content = Array.isArray(result.content) ? result.content : []
      const metadata = {
        mcp: {
          serverName,
          toolName: tool.name,
          annotations: tool.annotations ?? null,
          capabilities: normalizedCapabilities,
          ...(result.structuredContent !== undefined ? { structuredContent: result.structuredContent } : {}),
          contentSummary: summarizeMcpContent(content as unknown[]),
          isError: result.isError === true,
        },
      }
      if (result.isError) {
        const error = new Error(formatMcpContent(content as any[])) as Error & { metadata?: Record<string, unknown> }
        error.metadata = {
          ...metadata,
          diagnostics: [{ code: "mcp_tool_error", severity: "error", message: error.message }],
        }
        throw error
      }

      return {
        text: formatMcpContent(content as any[]),
        data: result.structuredContent !== undefined ? result.structuredContent : normalizeMcpData(content as unknown[]),
        diagnostics: [],
        metadata,
      }
    },
  }
}
