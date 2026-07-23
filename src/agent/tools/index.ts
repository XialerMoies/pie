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
import { commandTool } from "./command.js"

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
toolRegistry.register(commandTool)

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
        const onUpdate = (chunk: string) => {
          emitTrace?.({
            type: "tool_execution_update",
            toolCallId: _toolCallId,
            toolName: tool.name,
            partialResult: chunk,
          })
        }
        const text = await tool.execute(args, {
          cwd: workspace || "",
          sessionId: "",
          workspace,
          toolCallId: _toolCallId,
          onUpdate,
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

// ─── MCP 工具缓存（后台连接，不阻塞工具注册）─────────────
let _mcpWorkspace = ""
let _mcpCache: ReturnType<typeof toolRegistry.toPITools> = []
let _mcpConnecting = false

/** 断开 MCP 连接，清空缓存（随 workspace 切换或 dispose 调用） */
export async function disconnectMcp(): Promise<void> {
  _mcpCache = []
  _mcpWorkspace = ""
  _mcpConnecting = false
  // _mcpGen bumped inside MCPClientService.bumpGeneration()
  try {
    const { disconnectAll, bumpGeneration } = await import("../mcp/MCPClientService")
    bumpGeneration()
    await disconnectAll()
  } catch {}
}

/**
 * 后台刷新 MCP 连接（同 workspace 切 session 时调用，保持缓存不丢）
 * 等待旧后台连接完成，再发起新连接
 */
/** @internal 测试用：返回当前 MCP cache 长度 */
export function _getMcpCacheLen(): number { return _mcpCache.length }
/** @internal 测试用：注入已知 MCP cache，验证命中分支 */
export function _setMcpCache(workspace: string, tools: any[]): void {
  _mcpWorkspace = workspace
  _mcpCache = tools
}

export async function reconnectMcp(workspace: string, emitTrace?: ToolTraceEmitter): Promise<void> {
  // 等已有的后台连接完成
  while (_mcpConnecting) {
    await new Promise((r) => setTimeout(r, 10))
  }
  _connectMcpInBackground(workspace, emitTrace)
}

async function _connectMcpInBackground(workspace: string, emitTrace?: ToolTraceEmitter): Promise<void> {
  if (_mcpConnecting) return
  _mcpConnecting = true
  const { connectAll, currentGeneration } = await import("../mcp/MCPClientService")
  const gen = currentGeneration()
  try {
    const mcpTools = await connectAll(workspace ?? "", emitTrace)
    if (gen === currentGeneration()) {
      _mcpCache = mcpTools.map((t) => agentToolToPiTool(t, workspace, emitTrace))
      _mcpWorkspace = workspace ?? ""
      console.log(`[tools] MCP ${_mcpCache.length} 个工具已就绪`)
    } else {
      // stale：不写 cache，静默丢弃（避免误杀当前 workspace 连接）
      console.log(`[tools] MCP 跳过过期连接 (gen=${gen}, current=${currentGeneration()})`)
    }
  } catch (e) {
    if (gen === currentGeneration()) {
      console.log(`[tools] MCP 加载失败: ${e}`)
    }
  } finally {
    if (gen === currentGeneration()) _mcpConnecting = false
  }
}

/**
 * 获取所有工具（内置自定义 + MCP），异步。
 * MCP 在后台连接，不阻塞工具注册。
 * 首次调用返回内置工具；MCP 连接完成后缓存，下次返回完整列表。
 */
export async function getCustomToolsAsync(
  workspace?: string,
  emitTrace?: ToolTraceEmitter,
): Promise<ReturnType<typeof toolRegistry.toPITools>> {
  // 1. 内置自定义工具
  const builtin = getCustomTools(workspace, emitTrace)

  // 2. MCP 工具：缓存命中或 workspace 未变直接使用
  const ws = workspace ?? ""
  if (_mcpCache.length > 0 && _mcpWorkspace === ws) {
    return [...builtin, ..._mcpCache]
  }

  // 3. 后台连接 MCP，本次先返回内置工具
  console.log(`[tools] MCP 后台连接中...`)
  _connectMcpInBackground(ws, emitTrace)

  return builtin
}
