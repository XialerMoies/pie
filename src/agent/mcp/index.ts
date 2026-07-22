/**
 * MCP 客户端模块入口
 *
 * Phase 0: 配置发现 + 信任存储
 * Phase 1: stdio 连接 + tools/list + AgentTool 包装
 */

export type {
  McpTransportType,
  McpServerConfig,
  McpConfigFile,
  McpConfigSource,
  TrustRecord,
  TrustStoreFile,
  McpConnectionState,
  McpServerStatus,
} from "./types"

export {
  validateServerConfig,
  normalizeServerConfig,
  getCandidatePaths,
  loadMcpConfig,
  getEnabledServers,
  defaultGlobalConfigPath,
} from "./config"

export type { McpDiscoveryOptions, McpLoadResult, ValidationError } from "./config"

export {
  TrustStore,
  hashServerCommand,
  defaultTrustStorePath,
} from "./trust-store"

export type { TrustStoreOptions } from "./trust-store"

export {
  normalizeServerName,
  buildMcpToolName,
  formatMcpContent,
  createMcpToolAdapter,
} from "./MCPToolAdapter"

export type { McpToolAdapterOptions } from "./MCPToolAdapter"

export {
  connectAll,
  disconnectAll,
  disconnectAllSync,
  getServersStatus,
  reset as resetMcpService,
} from "./MCPClientService"
