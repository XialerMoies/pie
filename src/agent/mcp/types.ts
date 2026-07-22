/**
 * MCP 客户端模块共享类型
 *
 * Phase 4：支持 stdio + http + sse 三种传输层。
 */

// ─── 配置 ──────────────────────────────────────────

/** 支持的传输层 */
export type McpTransportType = 'stdio' | 'http' | 'sse'

/** 单台 MCP server 配置 */
export interface McpServerConfig {
  // stdio 字段
  command?: string
  args?: string[]
  // http/sse 字段
  url?: string
  headers?: Record<string, string>
  // 通用字段
  env?: Record<string, string>
  cwd?: string
  transport?: McpTransportType
  enabled?: boolean
}

/** 完整 .mcp.json 配置 */
export interface McpConfigFile {
  /** server 名 → 配置 */
  servers: Record<string, McpServerConfig>
}

/** 配置发现来源 */
export interface McpConfigSource {
  /** 配置中的 server 名 */
  name: string
  /** 解析后的配置 */
  config: McpServerConfig
  /** 来源文件路径 */
  sourcePath: string
  /** 来源优先级（0=项目根 .mcp.json, 1=.vscode/mcp.json, 2=全局） */
  priority: number
}

// ─── 信任 ──────────────────────────────────────────

/** 单条信任记录 */
export interface TrustRecord {
  /** 信任时的项目路径 */
  workspacePath: string
  /** SHA-256(command + args + env(key排序) + cwd + transport) */
  commandHash: string
  /** 显示名 */
  label: string
  /** 信任时间戳 */
  trustedAt: number
}

/** 信任存储文件格式 */
export interface TrustStoreFile {
  records: TrustRecord[]
}

// ─── 连接状态（Phase 2 用） ──────────────────────────

export type McpConnectionState = 'connecting' | 'connected' | 'disconnected' | 'error'

export interface McpServerStatus {
  name: string
  config: McpServerConfig
  state: McpConnectionState
  tools: string[]
  error?: string
}
