import type { ToolAuthorizationRequest, ToolAuthorizationResult } from "./types.js"
import type { McpServerStatus } from "./mcp/types.js"
import type { SecurityParseOptions, SecurityParseResult } from "./tools/command/security-ast.js"
import type { AgentTool, ToolTraceEmitter } from "./types.js"
import type { RequiredProviderHealthResult } from "./capability-components.js"
import type { AgentEngine } from "../agent-engine/contracts.js"

/** Stable host-facing capability identifiers. These are not implementation IDs. */
export type RequiredCapability =
  | "agent-engine"
  | "session-store"
  | "permission-evaluator"
  | "security-parser"
  | "mcp-host-integration"

export interface SessionStoreEntry {
  readonly type?: unknown
  readonly customType?: unknown
  readonly data?: unknown
  readonly id?: string
}

/** The small session surface needed by the runtime and persistence projections. */
export interface SessionStoreSession {
  readonly sessionId: string
  readonly sessionFile?: string
  readonly flushed?: boolean
  getEntries(): readonly SessionStoreEntry[]
  buildSessionContext(): { messages: readonly unknown[] }
  appendCustomEntry(customType: string, data?: unknown): unknown
  appendMessage(message: unknown): string
  branch(entryId: string): unknown
  dispose?(): void | Promise<void>
}

export interface SessionStoreCreateOptions {
  cwd: string
  sessionsDir?: string
  existingSessionFile?: string
  forceNew?: boolean
}

export interface SessionStoreProvider {
  readonly kind: "session-store"
  createSession(options: SessionStoreCreateOptions): Promise<SessionStoreSession>
  health?(signal: AbortSignal): RequiredProviderHealthResult | Promise<RequiredProviderHealthResult>
  dispose?(): void | Promise<void>
}

/**
 * Engine providers are factories, not shared AgentEngine instances. The host
 * passes the session-scoped runtime handle and keeps generation/lease state.
 * Ownership metadata makes the PI adapter split explicit at the boundary.
 */
export interface AgentEngineProvider {
  readonly kind: "agent-engine"
  readonly ownership: Readonly<{
    engine: string
    subagentAdapter: string
    providerAdapter: string
  }>
  create(runtime: unknown): AgentEngine
  health?(signal: AbortSignal): RequiredProviderHealthResult | Promise<RequiredProviderHealthResult>
  dispose?(): void | Promise<void>
}

/** Permission decisions remain host-owned; components only implement this narrow call surface. */
export interface PermissionEvaluator {
  readonly kind: "permission-evaluator"
  authorizeTool(request: ToolAuthorizationRequest): Promise<ToolAuthorizationResult>
  authorizePath(
    root: string,
    target: string,
    operation: "read" | "write" | "create" | "remove",
    source: string,
    options?: { suggestedDirectory?: string; internalToolRequest?: boolean },
  ): Promise<{ operation: "read" | "write" | "create" | "remove"; root: string; path: string; relativePath: string }>
  authorizePathSync(
    root: string,
    target: string,
    operation: "read" | "write" | "create" | "remove",
    source: string,
  ): { operation: "read" | "write" | "create" | "remove"; root: string; path: string; relativePath: string }
  authorizeWorkspaceRoot(workspace: string, source: string): Promise<string>
  health?(signal: AbortSignal): RequiredProviderHealthResult | Promise<RequiredProviderHealthResult>
  dispose?(): void | Promise<void>
}

export interface SecurityParserProvider {
  readonly kind: "security-parser"
  parse(command: string, options?: SecurityParseOptions): Promise<SecurityParseResult>
  parseLegacy(command: string, options?: SecurityParseOptions): SecurityParseResult
  parseTreeSitter(command: string, options?: SecurityParseOptions): Promise<SecurityParseResult>
  health?(signal: AbortSignal): RequiredProviderHealthResult | Promise<RequiredProviderHealthResult>
  dispose?(): void | Promise<void>
}

export interface McpHostIntegration {
  readonly kind: "mcp-host"
  connectAllWithReport(workspace: string, emitTrace?: ToolTraceEmitter): Promise<{
    tools: AgentTool[]
    complete: boolean
    configErrors: readonly unknown[]
  }>
  disconnectAll(): Promise<void>
  disconnectAllSync(): void
  getServersStatus(): McpServerStatus[]
  subscribeStatusChanges(listener: (snapshot: McpServerStatus[]) => void): () => void
  health?(signal: AbortSignal): RequiredProviderHealthResult | Promise<RequiredProviderHealthResult>
  dispose?(): void | Promise<void>
}

export type RequiredProviderImplementation =
  | AgentEngineProvider
  | SessionStoreProvider
  | PermissionEvaluator
  | SecurityParserProvider
  | McpHostIntegration

/** Runtime shape check used at the component binding boundary. */
export function assertRequiredProviderContract(
  capability: RequiredCapability,
  implementation: unknown,
): asserts implementation is RequiredProviderImplementation {
  const candidate = implementation as Record<string, unknown> | null
  if (!candidate || typeof candidate !== "object") {
    throw new TypeError(`Required provider ${capability} must be an object`)
  }
  const expectedKind = capability === "mcp-host-integration" ? "mcp-host" : capability
  if (candidate.kind !== expectedKind) {
    throw new TypeError(`Required provider ${capability} has invalid kind`)
  }
  const requiredMethods: Record<RequiredCapability, readonly string[]> = {
    "agent-engine": ["create"],
    "session-store": ["createSession"],
    "permission-evaluator": ["authorizeTool", "authorizePath", "authorizePathSync", "authorizeWorkspaceRoot"],
    "security-parser": ["parse", "parseLegacy", "parseTreeSitter"],
    "mcp-host-integration": ["connectAllWithReport", "disconnectAll", "disconnectAllSync", "getServersStatus", "subscribeStatusChanges"],
  }
  for (const method of requiredMethods[capability]) {
    if (typeof candidate[method] !== "function") throw new TypeError(`Required provider ${capability} is missing ${method}()`)
  }
  if (capability === "agent-engine") {
    const ownership = candidate.ownership as Record<string, unknown> | undefined
    for (const key of ["engine", "subagentAdapter", "providerAdapter"]) {
      if (!ownership || typeof ownership[key] !== "string" || !String(ownership[key]).trim()) {
        throw new TypeError(`Required provider ${capability} is missing ownership.${key}`)
      }
    }
  }
}

/** Adapt an existing permission service without exposing its concrete class to the contract. */
export interface PermissionEvaluatorDelegate {
  authorizeTool(request: ToolAuthorizationRequest): Promise<ToolAuthorizationResult>
  authorizePath(
    root: string,
    target: string,
    operation: "read" | "write" | "create" | "remove",
    source: string,
    options?: { suggestedDirectory?: string; internalToolRequest?: boolean },
  ): Promise<{ root: string; path: string; relativePath: string }>
  authorizePathSync(
    root: string,
    target: string,
    operation: "read" | "write" | "create" | "remove",
    source: string,
  ): { root: string; path: string; relativePath: string }
  authorizeWorkspaceRoot(workspace: string, source: string): Promise<string>
}

export function createPermissionEvaluatorProvider(service: PermissionEvaluatorDelegate): PermissionEvaluator {
  const provider = {
    kind: "permission-evaluator" as const,
    authorizeTool: (request: ToolAuthorizationRequest) => service.authorizeTool(request),
    authorizePath: async (root: string, target: string, operation: "read" | "write" | "create" | "remove", source: string, options?: { suggestedDirectory?: string; internalToolRequest?: boolean }) => ({
      ...(await service.authorizePath(root, target, operation, source, options)), operation,
    }),
    authorizePathSync: (root: string, target: string, operation: "read" | "write" | "create" | "remove", source: string) => ({
      ...service.authorizePathSync(root, target, operation, source), operation,
    }),
    authorizeWorkspaceRoot: (workspace: string, source: string) => service.authorizeWorkspaceRoot(workspace, source),
    health: () => ({ status: "healthy" as const }),
    dispose: () => {},
  }
  assertRequiredProviderContract("permission-evaluator", provider)
  return Object.freeze(provider)
}
