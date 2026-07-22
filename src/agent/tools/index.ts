/**
 * Custom tool registry for the agent.
 *
 * PI 框架内置 7 个工具：read / bash / edit / write / grep / find / ls。
 * 这里注册的是本项目的自定义工具——PI 没有的、你后端独有的功能。
 *
 * 所有自定义 Tool 通过 ToolRegistry 统一管理，toPITools() 转换为
 * PI SDK 需要的 ToolDefinition[] 格式，传给 createAgentSession()。
 */

import { ToolRegistry, type AgentTool, type ToolTraceEmitter } from "../types"
import { gitStatusTool } from "./git-status.js"
import { searchTool } from "./search.js"
import { fileReadTool } from "./file-read.js"
import { explorerListTool } from "./explorer-list.js"
import { gitLogTool } from "./git-log.js"
import { fileOutlineTool } from "./file-outline.js"
import { webSearchTool, setSearchBackend, getSearchBackend } from "./web-search.js"
import { webFetchTool } from "./web-fetch.js"

/** 全局 Tool 注册表 */
export const toolRegistry = new ToolRegistry()



/**
 * 注册一个自定义工具。
 * 遵循 AgentTool 接口（src/agent/types.ts）。
 */

// 注册自定义工具
toolRegistry.register(gitStatusTool)
toolRegistry.register(searchTool)
toolRegistry.register(fileReadTool)
toolRegistry.register(explorerListTool)
toolRegistry.register(gitLogTool)
toolRegistry.register(fileOutlineTool)
toolRegistry.register(webSearchTool)
toolRegistry.register(webFetchTool)

export function registerTool(
  tool: Parameters<typeof toolRegistry.register>[0],
): void {
  toolRegistry.register(tool)
}

/** 获取所有自定义 Tool，转换为 PI SDK 需要的格式 */
export function getCustomTools(workspace?: string, emitTrace?: ToolTraceEmitter) {
  return toolRegistry.toPITools(workspace, emitTrace)
}

/**
 * 将单个 AgentTool 转换为 PI ToolDefinition 格式。
 * 与 toolRegistry.toPITools 内部逻辑一致，供 MCP 工具等非注册制工具使用。
 */
export function agentToolToPiTool(
  tool: AgentTool,
  workspace?: string,
  emitTrace?: ToolTraceEmitter,
) {
  return {
    name: tool.name,
    label: tool.name,
    description: tool.description,
    parameters: tool.parameters,
    execute: async (_toolCallId: string, params: unknown) => {
      const args = params as Record<string, unknown>
      emitTrace?.({
        type: "tool_execution_start",
        toolCallId: _toolCallId,
        toolName: tool.name,
        args,
      })
      try {
        const text = await tool.execute(args, {
          cwd: workspace || "",
          sessionId: "",
          workspace,
          toolCallId: _toolCallId,
        })
        emitTrace?.({
          type: "tool_execution_end",
          toolCallId: _toolCallId,
          toolName: tool.name,
          result: text,
          isError: false,
        })
        return { content: [{ type: "text" as const, text }], details: {} }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        emitTrace?.({
          type: "tool_execution_end",
          toolCallId: _toolCallId,
          toolName: tool.name,
          result: message,
          isError: true,
        })
        throw error
      }
    },
  } as any
}

/**
 * 获取所有工具（内置自定义 + MCP），异步。
 * 在 _initSession 中替代 getCustomTools。
 */
export async function getCustomToolsAsync(
  workspace?: string,
  emitTrace?: ToolTraceEmitter,
): Promise<ReturnType<typeof toolRegistry.toPITools>> {
  // 1. 内置自定义工具
  const builtin = getCustomTools(workspace, emitTrace)

  // 2. MCP 工具
  let mcpConverted: ReturnType<typeof toolRegistry.toPITools> = []
  try {
    const { connectAll, disconnectAll } = await import("../mcp/MCPClientService")
    // 先断开旧连接（workspace 切换场景，_saveAndDispose 已调用 disconnectAllSync）
    await disconnectAll()
    const mcpTools = await connectAll(workspace ?? "", emitTrace)
    mcpConverted = mcpTools.map((t) => agentToolToPiTool(t, workspace, emitTrace))
  } catch (e) {
    console.log(`[tools] MCP 加载失败: ${e}`)
  }

  return [...builtin, ...mcpConverted]
}
