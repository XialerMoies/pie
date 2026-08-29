/**
 * Custom tool registry for the agent.
 *
 * PI 框架内置 7 个工具：read / bash / edit / write / grep / find / ls。
 * 这里注册的是本项目提供的第一方工具包——PI 没有的、项目后端独有的能力。
 *
 * 所有自定义 Tool 通过 ToolRegistry 统一管理，再由 ToolPresentation 转换为
 * PI SDK 需要的 ToolDefinition[] 格式，传给 createAgentSession()。
 */

import {
  ToolRegistry,
} from "../tool-registry.js"
import type { AgentTool, ToolExecutionExtraContext, ToolTraceEmitter } from "../types.js"
import { canonicalToolName } from "../tool-identity.js"
import { gitStatusTool } from "./git-status.js"
import { searchTool } from "./search.js"
import { fileReadTool } from "./file-read.js"
import { explorerListTool } from "./explorer-list.js"
import { gitLogTool } from "./git-log.js"
import { fileOutlineTool } from "./file-outline.js"
import { webSearchTool, setSearchBackend, getSearchBackend } from "./web-search.js"
import { webFetchTool } from "./web-fetch.js"
import { commandTool } from "./command.js"
import { writeAgentMdTool } from "./agent-md.js"
import { readMemoryTool, writeMemoryTool, listMemoryTool, deleteMemoryTool, setMemoryEnabledTool } from "./memory.js"
import { strReplaceEditorTool } from "./str-replace-editor.js"
import { fileWriteTool } from "./file-write.js"
import { delegateTasksTool } from "./delegate-tasks.js"
import { skillFactsTool } from "./skill-facts.js"
import { enterPlanModeTool, exitPlanModeTool } from "./plan-mode.js"
import { resolveAgentProfile, type AgentProfile } from "../agent-profile.js"
import { nativeToolPresentation, presentNativeTool, presentSessionTools } from "../tool-presentation.js"
import { buildProfileToolPool, profileAllowsFeature, ToolPool } from "../tool-pool.js"
import { capabilityComponentManager } from "../capability-components.js"
import { registerFirstPartyComponentPackages } from "../component-package.js"
import type { RequiredComponentLease } from "../capability-component-replacement.js"

/** 全局 Tool 注册表 */
export const toolRegistry = new ToolRegistry()

// Seed application-supplied packages before startup restores the user's install state.
// This only declares shipped implementations; persisted uninstall tombstones win later.
registerFirstPartyComponentPackages(capabilityComponentManager)



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
toolRegistry.register(writeAgentMdTool)
toolRegistry.register(readMemoryTool)
toolRegistry.register(writeMemoryTool)
toolRegistry.register(listMemoryTool)
toolRegistry.register(deleteMemoryTool)
toolRegistry.register(setMemoryEnabledTool)
toolRegistry.register(strReplaceEditorTool)
toolRegistry.register(fileWriteTool)
toolRegistry.register(delegateTasksTool)
toolRegistry.register(skillFactsTool)
toolRegistry.register(enterPlanModeTool)
toolRegistry.register(exitPlanModeTool)

export function registerTool(
  tool: Parameters<typeof toolRegistry.register>[0],
): void {
  toolRegistry.register(tool)
}

/** 获取所有自定义 Tool，转换为 PI SDK 需要的格式 */
export function getCustomTools(workspace?: string, emitTrace?: ToolTraceEmitter, extraCtx?: ToolExecutionExtraContext, profile: AgentProfile = resolveAgentProfile("standard"), componentLease?: RequiredComponentLease) {
  const pool = new ToolPool().addNative(toolRegistry.getAll())
  const tools = pool.project({ audience: "main", names: profile.toolNames, featureGates: profile.featureGates, componentManager: capabilityComponentManager })
  return presentSessionTools(tools, { workspace, emitTrace, extraCtx }, profile.presentation, componentLease) as any
}

function presentProfileTools(tools: readonly AgentTool[], workspace?: string, emitTrace?: ToolTraceEmitter, extraCtx?: ToolExecutionExtraContext, profile: AgentProfile = resolveAgentProfile("standard"), componentLease?: RequiredComponentLease) {
  return presentSessionTools(tools, { workspace, emitTrace, extraCtx }, profile.presentation, componentLease) as any
}

function assembleProfileTools(profile: AgentProfile, mcpTools: readonly AgentTool[] = []): AgentTool[] {
  const pool = buildProfileToolPool(profile, toolRegistry.getAll(), mcpTools)
  const nativeNames = profile.toolNames === "*" ? "*" : profile.toolNames
  const native = pool.project({ audience: "main", names: nativeNames, featureGates: profile.featureGates, componentManager: capabilityComponentManager })
  const nativeSet = new Set(native.map((tool) => tool.name))
  const dynamic = pool.project({ audience: "main", featureGates: profile.featureGates, requireAllRequested: false, componentManager: capabilityComponentManager })
    .filter((tool) => !nativeSet.has(tool.name))
  return [...native, ...dynamic]
}

/**
 * 将单个 AgentTool 转换为 PI ToolDefinition 格式。
 * 兼容入口：非注册制工具也必须经过 native ToolPresentation。
 */
export function agentToolToPiTool(
  tool: AgentTool,
  workspace?: string,
  emitTrace?: ToolTraceEmitter,
  extraCtx?: ToolExecutionExtraContext,
) {
  const canonical = canonicalToolName(tool.name)
  const normalized = canonical === tool.name ? tool : { ...tool, name: canonical }
  return presentNativeTool(normalized, { workspace, emitTrace, extraCtx }) as any
}

// ─── MCP 原始工具缓存（后台连接，不阻塞工具注册）─────────────
let _mcpWorkspace = ""
let _mcpCache: AgentTool[] = []
let _mcpCacheInitialized = false
let _mcpRequestEpoch = 0
let _mcpInFlight: { workspace: string; epoch: number; promise: Promise<void> } | undefined

type McpService = typeof import("../mcp/MCPClientService.js")
type McpServiceGeneration = { service: McpService; generation: number }

function _isCurrentMcpRequest(workspace: string, epoch: number): boolean {
  return _mcpRequestEpoch === epoch && _mcpWorkspace === workspace
}

function _clearMcpCache(workspace: string): void {
  _mcpCache = []
  _mcpWorkspace = workspace
  _mcpCacheInitialized = false
}

async function _invalidateMcpService(): Promise<McpServiceGeneration | undefined> {
  try {
    const service = await import("../mcp/MCPClientService.js")
    const generation = service.bumpGeneration()
    await service.mcpHostIntegrationProvider.disconnectAll()
    return { service, generation }
  } catch {
    return undefined
  }
}

function _startMcpDiscovery(
  workspace: string,
  epoch: number,
  emitTrace?: ToolTraceEmitter,
  invalidation?: Promise<McpServiceGeneration | undefined>,
): { workspace: string; epoch: number; promise: Promise<void> } {
  let inFlight: { workspace: string; epoch: number; promise: Promise<void> }
  const promise = (async () => {
    let serviceState: McpServiceGeneration | undefined
    try {
      serviceState = invalidation
        ? await invalidation
        : await import("../mcp/MCPClientService.js").then((service) => ({
            service,
            generation: service.currentGeneration(),
          }))
      if (!serviceState) return

      const { service, generation } = serviceState
      if (!_isCurrentMcpRequest(workspace, epoch) || generation !== service.currentGeneration()) return

      const report = await service.mcpHostIntegrationProvider.connectAllWithReport(workspace, emitTrace)
      if (
        _isCurrentMcpRequest(workspace, epoch)
        && generation === service.currentGeneration()
      ) {
        _mcpCache = report.tools
        _mcpCacheInitialized = report.complete
        if (_mcpCacheInitialized) {
          console.log(`[tools] MCP ${_mcpCache.length} 个工具已就绪`)
        } else {
          const configErrorCount = report.configErrors.length
          const detail = configErrorCount > 0 ? `（${configErrorCount} 个配置错误）` : ""
          console.log(`[tools] MCP 本轮 discovery 不完整${detail}，下次请求将重试`)
        }
      } else {
        console.log(`[tools] MCP 跳过过期连接 (gen=${generation}, current=${service.currentGeneration()})`)
      }
    } catch (e) {
      if (
        serviceState
        && _isCurrentMcpRequest(workspace, epoch)
        && serviceState.generation === serviceState.service.currentGeneration()
      ) {
        console.log(`[tools] MCP 加载失败: ${e}`)
      }
    }
  })()

  inFlight = { workspace, epoch, promise }
  _mcpInFlight = inFlight
  void promise.finally(() => {
    if (_mcpInFlight === inFlight) _mcpInFlight = undefined
  })
  return inFlight
}

async function _transitionMcpWorkspace(
  workspace: string,
  emitTrace?: ToolTraceEmitter,
): Promise<void> {
  const epoch = ++_mcpRequestEpoch
  // disconnectAll 会关闭 raw tool 绑定的 client，必须先让 cache 对新 session 不可见。
  _clearMcpCache(workspace)
  _mcpInFlight = undefined

  const invalidation = _invalidateMcpService()
  _startMcpDiscovery(workspace, epoch, emitTrace, invalidation)
  await invalidation
}

/** 断开 MCP 连接，清空缓存（随 workspace 切换或 dispose 调用） */
export async function disconnectMcp(): Promise<void> {
  ++_mcpRequestEpoch
  _clearMcpCache("")
  _mcpInFlight = undefined
  try {
    const { mcpHostIntegrationProvider: mcpHost, bumpGeneration } = await import("../mcp/MCPClientService.js")
    bumpGeneration()
    await mcpHost.disconnectAll()
  } catch {}
}

/**
 * 后台刷新 MCP 连接（同 workspace 切 session 时调用）。
 * 断开旧 client 前立即失效 raw tool cache，连接完成后再发布新工具。
 */
export async function reconnectMcp(workspace: string, emitTrace?: ToolTraceEmitter, extraCtx?: ToolExecutionExtraContext): Promise<void> {
  const ws = workspace ?? ""
  const current = _mcpInFlight
  if (current && current.workspace === ws && current.epoch === _mcpRequestEpoch) {
    await current.promise
    return
  }
  await _transitionMcpWorkspace(ws, emitTrace)
}

/**
 * 获取所有工具（第一方工具包 + MCP），异步。
 * MCP 在后台连接，不阻塞工具注册。
 * 首次调用返回第一方工具包；MCP 连接完成后缓存，下次返回完整列表。
 */
export async function getCustomToolsAsync(
  workspace?: string,
  emitTrace?: ToolTraceEmitter,
  extraCtx?: ToolExecutionExtraContext,
  profile: AgentProfile = resolveAgentProfile("standard"),
  componentLease?: RequiredComponentLease,
): Promise<ReturnType<typeof toolRegistry.toPITools>> {
  // 1. 第一方工具包（随应用提供，但仍受组件状态管理）
  const firstParty = getCustomTools(workspace, emitTrace, extraCtx, profile, componentLease)

  // Profile capability projection is independent from PermissionMode. A
  // profile that does not expose MCP must not trigger discovery either.
  if (!profile.allowMcp || !profileAllowsFeature(profile, "mcp")) return firstParty

  // 2. MCP 工具：缓存命中或 workspace 未变直接使用
  const ws = workspace ?? ""
  if (_mcpCacheInitialized && _mcpWorkspace === ws) {
    return presentProfileTools(assembleProfileTools(profile, _mcpCache), workspace, emitTrace, extraCtx, profile, componentLease)
  }

  if (_mcpWorkspace !== ws) {
    console.log(`[tools] MCP 后台连接中...`)
    await _transitionMcpWorkspace(ws, emitTrace)
    return firstParty
  }

  // incomplete cache 中的健康 raw tools 仍按当前 session 上下文重新包装并提供。
  const available = presentProfileTools(assembleProfileTools(profile, _mcpCache), workspace, emitTrace, extraCtx, profile, componentLease)

  const current = _mcpInFlight
  if (current && current.workspace === ws && current.epoch === _mcpRequestEpoch) return available

  // 3. 后台连接 MCP，本次先返回第一方工具包
  console.log(`[tools] MCP 后台连接中...`)
  _startMcpDiscovery(ws, _mcpRequestEpoch, emitTrace)

  return available
}
