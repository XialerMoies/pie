/**
 * MCPClientService — MCP 服务器连接管理器。
 *
 * 职责：
 * - 读取当前 workspace 的 .mcp.json 配置
 * - 对每个 enabled server 执行信任检查 → 连接 → tools/list → 包装为 AgentTool
 * - 管理连接生命周期（workspace 切换 / dispose 时断开旧连接）
 * - 提供 servers 状态查询（Phase 2 UI 用）
 *
 * 设计为静态类（无 new 实例），全局唯一状态。
 * 生命周期绑定到 AgentRuntime 的 workspace 切换。
 *
 * ─── 安全保证 ───
 * - 任何异常路径都确保 client.close() 被调用
 * - 未进入 _connections 的连接也会被清理
 * - timeout 后原 connect() 仍持有但 transport 会被 close() 终止
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js"
import type { AgentTool, ToolTraceEmitter } from "../types.js"
import { loadMcpConfig, getEnabledServers, type McpLoadResult } from "./config.js"
import { TrustStore, hashServerCommand } from "./trust-store.js"
import { createMcpToolAdapter } from "./MCPToolAdapter.js"
import type { McpServerConfig, McpServerStatus, McpConnectionState } from "./types.js"
import { createMcpProcessEnv, sanitizeProcessOutput } from "../../process/env-policy.js"

// ─── 常量 ──────────────────────────────────────────

const CLIENT_INFO = { name: "my-code-agent", version: "0.1.0" }
/** 单台 server 连接超时（ms） */
const CONNECT_TIMEOUT = 10_000

// ─── 服务 ──────────────────────────────────────────

interface ConnectionRecord {
  client: Client
  transport: StdioClientTransport
  serverName: string
  connectedAt: number
}

const _connections = new Map<string, ConnectionRecord>()
const _statusMap = new Map<string, McpServerStatus>()
export type McpStatusChangeListener = (snapshot: McpServerStatus[]) => void
const _statusListeners = new Set<McpStatusChangeListener>()
let _lastVisibleSnapshot = "[]"
let _trustStore: TrustStore | undefined

type CloneAttempt<T> = { ok: true; value: T } | { ok: false }

function tryStructuredClone<T>(value: T): CloneAttempt<T> {
  const clone = globalThis.structuredClone
  if (typeof clone !== "function") return { ok: false }
  try {
    return { ok: true, value: clone(value) }
  } catch {
    return { ok: false }
  }
}

function cloneStringArray(value: unknown): string[] {
  const attempt = tryStructuredClone(value)
  const source = attempt.ok ? attempt.value : value
  return Array.isArray(source) ? source.filter((item): item is string => typeof item === "string") : []
}

function cloneStringRecord(value: unknown): Record<string, string> | undefined {
  if (value === undefined) return undefined
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
  return Object.fromEntries(
    Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  )
}

function cloneConfigFallback(config: McpServerConfig): McpServerConfig {
  const source = config as Record<string, unknown>
  const result: McpServerConfig = {}
  const copyString = (key: "command" | "url" | "cwd" | "transport"): void => {
    if (!Object.hasOwn(source, key)) return
    const value = source[key]
    if (value === undefined || typeof value === "string") (result as Record<string, unknown>)[key] = value
  }

  copyString("command")
  copyString("url")
  copyString("cwd")
  copyString("transport")
  if (Object.hasOwn(source, "enabled") && (source.enabled === undefined || typeof source.enabled === "boolean")) {
    result.enabled = source.enabled as boolean | undefined
  }
  if (Object.hasOwn(source, "args")) {
    result.args = source.args === undefined ? undefined : cloneStringArray(source.args)
  }
  if (Object.hasOwn(source, "env")) result.env = cloneStringRecord(source.env)
  if (Object.hasOwn(source, "headers")) result.headers = cloneStringRecord(source.headers)
  return result
}

function cloneConfig(config: McpServerConfig): McpServerConfig {
  const attempt = tryStructuredClone(config)
  return attempt.ok ? attempt.value : cloneConfigFallback(config)
}

function cloneStatuses(statuses: McpServerStatus[]): McpServerStatus[] {
  const attempt = tryStructuredClone(statuses)
  if (attempt.ok) return attempt.value
  return statuses.map((status) => ({
    name: status.name,
    config: status.config === undefined ? status.config : cloneConfig(status.config),
    state: status.state,
    tools: cloneStringArray(status.tools),
    error: status.error,
  }))
}

let _mcpGen = 0  // connectAll 生成号，stale 连接跳过写入全局状态

function getTrustStore(): TrustStore {
  if (!_trustStore) _trustStore = new TrustStore()
  return _trustStore
}

/** 递增生成号，旧 connectAll 调用不会写入全局状态 */
export function bumpGeneration(): number {
  return ++_mcpGen
}

/** 读取当前 generation，用于调用方判断是否过期 */
export function currentGeneration(): number {
  return _mcpGen
}

/** 单次 MCP discovery 的工具与健康结果，不依赖全局 status 快照。 */
export interface McpDiscoveryReport {
  tools: AgentTool[]
  complete: boolean
  configErrors: McpLoadResult["errors"]
}

/**
 * 连接指定 workspace 的所有 enabled MCP server，
 * 返回与本次调用绑定的工具和完整性报告。
 *
 * 调用前清空旧 status——确保 status 只反映当前 workspace。
 * 每个 server 独立连接，失败只影响自身。
 * 内置 generation 检查：如果 _mcpGen 在连接过程中变化，跳过后续写入。
 */
export async function connectAllWithReport(
  workspace: string,
  emitTrace?: ToolTraceEmitter,
): Promise<McpDiscoveryReport> {
  const tools: AgentTool[] = []
  const gen = _mcpGen
  const result = loadMcpConfig({ projectRoot: workspace })
  const enabled = getEnabledServers(result)
  let complete = result.errors.length === 0
  const trustStore = getTrustStore()
  await trustStore.refresh()

  if (gen !== _mcpGen) {
    return {
      tools,
      complete: false,
      configErrors: result.errors.map((error) => ({ ...error })),
    }
  }

  // 清空旧 status，避免跨 workspace 残留
  _clearStatuses()

  for (const source of enabled) {
    if (gen !== _mcpGen) {
      console.log(`[mcp] ⏭ connectAll 跳过过期 server: ${source.name}`)
      complete = false
      break
    }
    const hash = hashServerCommand(source.config)
    if (!trustStore.isTrusted(workspace, hash)) {
      console.log(`[mcp] 跳过未信任的 server: ${source.name}（在 ${source.sourcePath} 中配置）`)
      _setStatus(source.name, "error", `未信任：请确认"${source.name}"后使用`, source.config)
      complete = false
      continue
    }

    try {
      const toolList = await connectServer(source.name, source.config, source.sourcePath, emitTrace)
      tools.push(...toolList)
    } catch (err) {
      complete = false
      const msg = sanitizeProcessOutput(err, Object.values(source.config.env ?? {}))
      console.log(`[mcp] server 连接失败: ${source.name}: ${msg}`)
    }
  }

  return {
    tools,
    complete: complete && gen === _mcpGen,
    configErrors: result.errors.map((error) => ({ ...error })),
  }
}

/** 兼容旧调用方，仅返回本轮 discovery 得到的工具列表。 */
export async function connectAll(
  workspace: string,
  emitTrace?: ToolTraceEmitter,
): Promise<AgentTool[]> {
  return (await connectAllWithReport(workspace, emitTrace)).tools
}

/**
 * 连接单个 MCP server，返回可用工具列表。
 *
 * 异常安全：
 * - 所有异常路径（超时/connect/listTools/包装）都关闭 client+transport
 * - 不依赖 _connections 作清理——即使未注册也关闭
 *
 * generation 检查：连接完成后若 _mcpGen 已变化，不写入全局状态并关闭 client。
 */
async function connectServer(
  name: string,
  config: McpServerConfig,
  sourcePath: string,
  emitTrace?: ToolTraceEmitter,
): Promise<AgentTool[]> {
  const gen = _mcpGen
  const client = new Client(CLIENT_INFO, { capabilities: {} })
  const transport = createTransport(config)

  try {
    await Promise.race([
      client.connect(transport),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`连接超时 ${CONNECT_TIMEOUT}ms`)), CONNECT_TIMEOUT),
      ),
    ])

    const result = await client.listTools()
    const tools = result.tools.map((tool) =>
      createMcpToolAdapter({ serverName: name, tool, client }),
    )

    // 写入全局状态前检查 generation，过期则关闭 client 不注册
    if (gen !== _mcpGen) {
      console.log(`[mcp] ⏭ 跳过过期 server: ${name} (gen=${gen}, current=${_mcpGen})`)
      await safeClose(client)
      return []
    }

    // 部分失败后的重试会重新连接已成功 server；替换前关闭旧 client，避免连接泄漏。
    const previous = _connections.get(name)
    if (previous) await safeClose(previous.client)
    if (gen !== _mcpGen) {
      await safeClose(client)
      return []
    }
    _connections.set(name, { client, transport: transport as any, serverName: name, connectedAt: Date.now() })
    _setStatus(name, "connected", undefined, config, tools.map((t) => t.name))
    console.log(`[mcp] ✅ ${name}: ${tools.length} 个工具可用`)
    return tools
  } catch (err) {
    await safeClose(client)
    if (gen !== _mcpGen) {
      console.log(`[mcp] ⏭ 忽略过期 server 错误: ${name} (gen=${gen}, current=${_mcpGen})`)
      return []
    }
    _setStatus(name, "error", sanitizeProcessOutput(err, Object.values(config.env ?? {})), config)
    throw err
  }
}

/** 根据配置创建对应传输层实例 */
function createTransport(config: McpServerConfig): import("@modelcontextprotocol/sdk/shared/transport.js").Transport {
  const transport = config.transport || "stdio"
  if (transport === "stdio") {
    return new StdioClientTransport({
      command: config.command!,
      args: config.args ?? [],
      env: createMcpProcessEnv(process.env, config.env),
      ...(config.cwd ? { cwd: config.cwd } : {}),
    })
  }
  // sse: 使用传统的 Server-Sent Events transport
  if (transport === "sse") {
    return new SSEClientTransport(new URL(config.url!))
  }
  // http: 使用 Streamable HTTP transport
  return new StreamableHTTPClientTransport(new URL(config.url!), config.headers
    ? { requestInit: { headers: config.headers } as any }
    : undefined)
}

/**
 * 安全关闭 client 及其 transport。
 * 必须 await 以保证子进程确实终止。
 */
async function safeClose(client: Client): Promise<void> {
  try { await client.close() } catch { /* 关闭失败不影响其他清理 */ }
}

/**
 * 断开所有 MCP 连接并清空状态。
 * workspace 切换 / session dispose 时调用。
 *
 * 所有 close 操作并发执行。返回 Promise 供测试等待完成。
 */
export async function disconnectAll(): Promise<void> {
  const closePromises: Promise<void>[] = []
  for (const [, conn] of _connections) {
    closePromises.push(safeClose(conn.client))
  }
  _connections.clear()
  _clearStatuses()
  await Promise.all(closePromises)
}

// ─── 状态查询（Phase 2 用） ─────────────────────────

export function _setStatus(
  name: string,
  state: McpConnectionState,
  error?: string,
  config?: McpServerConfig,
  tools?: string[],
): void {
  const existing = _statusMap.get(name)
  const nextConfig = config !== undefined
    ? cloneConfig(config)
    : existing?.config ? cloneConfig(existing.config) : undefined
  const nextTools = tools !== undefined
    ? cloneStringArray(tools)
    : existing?.tools ? cloneStringArray(existing.tools) : []
  _statusMap.set(name, {
    name,
    config: nextConfig as McpServerConfig,
    state,
    tools: nextTools,
    // state 切换为 connected 时清空旧错误文案
    error: state === "connected" ? undefined : (error ?? existing?.error),
  })
  _notifyStatusChanges()
}

function _visibleSnapshotKey(): string {
  const sortedRecord = (record?: Record<string, string>): Record<string, string> | undefined => record
    ? Object.fromEntries(Object.entries(record).sort(([left], [right]) => left.localeCompare(right)))
    : undefined
  const snapshot = [..._statusMap.values()]
    .map((status) => ({
      name: status.name,
      state: status.state,
      tools: [...status.tools],
      error: status.error ?? null,
      enabled: status.config?.enabled ?? true,
      config: status.config ? {
        command: status.config.command,
        args: status.config.args ? [...status.config.args] : undefined,
        url: status.config.url,
        headers: sortedRecord(status.config.headers),
        env: sortedRecord(status.config.env),
        cwd: status.config.cwd,
        transport: status.config.transport ?? "stdio",
        enabled: status.config.enabled ?? true,
      } : null,
    }))
    .sort((left, right) => left.name.localeCompare(right.name))
  return JSON.stringify(snapshot)
}

function _notifyStatusChanges(): void {
  const nextSnapshot = _visibleSnapshotKey()
  if (nextSnapshot === _lastVisibleSnapshot) return
  _lastVisibleSnapshot = nextSnapshot
  const snapshot = getServersStatus()
  for (const listener of [..._statusListeners]) {
    try { listener(cloneStatuses(snapshot)) } catch {}
  }
}

function _clearStatuses(): void {
  if (_statusMap.size === 0) return
  _statusMap.clear()
  _notifyStatusChanges()
}

export function subscribeStatusChanges(listener: McpStatusChangeListener): () => void {
  _statusListeners.add(listener)
  return () => { _statusListeners.delete(listener) }
}

/** 获取所有 MCP server 的当前状态 */
export function getServersStatus(): McpServerStatus[] {
  return cloneStatuses([..._statusMap.values()])
}

/** 同步版本——给 _saveAndDispose / dispose 等同步上下文用（不 await close） */
export function disconnectAllSync(): void {
  for (const [, conn] of _connections) {
    try { conn.client.close() } catch {}
  }
  _connections.clear()
  _clearStatuses()
}

/** 重置所有状态（测试用） */
export function reset(): void {
  _connections.clear()
  _clearStatuses()
  _statusListeners.clear()
  _lastVisibleSnapshot = "[]"
  _trustStore = undefined
}
