/**
 * Custom tool registry for the agent.
 *
 * PI 框架内置 7 个工具：read / bash / edit / write / grep / find / ls。
 * 这里注册的是本项目的自定义工具——PI 没有的、你后端独有的功能。
 *
 * 所有自定义 Tool 通过 ToolRegistry 统一管理，toPITools() 转换为
 * PI SDK 需要的 ToolDefinition[] 格式，传给 createAgentSession()。
 */

import { ToolRegistry, type ToolTraceEmitter } from "../types"
import { gitStatusTool } from "./git-status.js"
import { searchTool } from "./search.js"
import { fileReadTool } from "./file-read.js"
import { explorerListTool } from "./explorer-list.js"
import { gitLogTool } from "./git-log.js"
import { fileOutlineTool } from "./file-outline.js"

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

export function registerTool(
  tool: Parameters<typeof toolRegistry.register>[0],
): void {
  toolRegistry.register(tool)
}

/** 获取所有自定义 Tool，转换为 PI SDK 需要的格式 */
export function getCustomTools(workspace?: string, emitTrace?: ToolTraceEmitter) {
  return toolRegistry.toPITools(workspace, emitTrace)
}
