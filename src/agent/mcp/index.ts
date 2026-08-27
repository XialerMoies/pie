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
} from "./types.js"

export {
  validateServerConfig,
  normalizeServerConfig,
  getCandidatePaths,
  loadMcpConfig,
  getEnabledServers,
  defaultGlobalConfigPath,
} from "./config.js"

export type { McpDiscoveryOptions, McpLoadResult, ValidationError } from "./config.js"

export {
  TrustStore,
  hashServerCommand,
  defaultTrustStorePath,
} from "./trust-store.js"

export type { TrustStoreOptions } from "./trust-store.js"

export {
  normalizeServerName,
  buildMcpToolName,
  formatMcpContent,
  normalizeMcpToolCapabilities,
  createMcpToolAdapter,
} from "./MCPToolAdapter.js"

export type { McpToolAdapterOptions } from "./MCPToolAdapter.js"

export {
  connectAll,
  connectAllWithReport,
  disconnectAll,
  disconnectAllSync,
  getServersStatus,
  mcpHostIntegrationProvider,
  reset as resetMcpService,
} from "./MCPClientService.js"

export type { McpDiscoveryReport } from "./MCPClientService.js"
