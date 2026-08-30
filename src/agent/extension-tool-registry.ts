/**
 * Host-owned registry for Agent-tool contributions from activated extensions.
 *
 * The registry is intentionally declaration-only. It receives an already
 * namespaced callback from a host activation hook and adapts it to AgentTool;
 * neither extension code nor a contribution receives runtime/server/desktop
 * objects.
 */
import type { CapabilityComponentManager } from "./capability-components.js"
import { capabilityComponentManager } from "./capability-components.js"
import type { ExtensionDisposable, ExtensionToolDefinition } from "./extension-api.js"
import type { ExtensionPermission } from "./extension-manifest.js"
import { HOST_EXECUTION_CHAIN } from "./execution-boundary.js"
import { structuredToolResult } from "./tool-outcomes.js"
import type { AgentTool, ToolOperation } from "./types.js"

export interface ExtensionToolRegistration {
  readonly componentId: string
  readonly tool: AgentTool
}

export interface ExtensionToolRegistrationOptions {
  /** Package-declared capabilities selected by the host, never by the tool. */
  readonly permissions?: readonly ExtensionPermission[]
}

function resultText(value: unknown): string {
  if (typeof value === "string") return value
  try {
    const serialized = JSON.stringify(value)
    return serialized === undefined ? "null" : serialized
  } catch {
    return "[扩展工具返回了不可序列化的结果]"
  }
}

function executionPolicy(permissions: readonly ExtensionPermission[]): Pick<AgentTool, "operations" | "isReadOnly" | "isDestructive" | "isConcurrencySafe" | "riskLevel" | "needsPermission" | "workspaceBounded" | "authorizationMode"> {
  const declared = new Set(permissions)
  const operations = (["read", "write", "create", "remove"] as const)
    .filter((operation) => declared.has(operation)) as ToolOperation[]
  const external = declared.has("network") || declared.has("subprocess") || declared.has("secrets")
  if (external || operations.length === 0) operations.push("execute")
  const mutable = operations.some((operation) => operation === "write" || operation === "create" || operation === "remove" || operation === "execute")
  return {
    operations,
    isReadOnly: !mutable,
    isDestructive: declared.has("remove"),
    isConcurrencySafe: true,
    riskLevel: mutable ? (declared.has("remove") || declared.has("subprocess") ? "high" : "medium") : "low",
    // All installable contributions are explicitly mediated by the host,
    // including read-only declarations. This prevents a package from opting
    // itself out of the authorization path.
    needsPermission: true,
    workspaceBounded: true,
    authorizationMode: "generic",
  }
}

/**
 * Holds only live host registrations. Lifecycle disposal removes a tool from
 * this registry, while the component state check also makes stale session
 * definitions fail closed after disable/uninstall.
 */
export class ExtensionToolRegistry {
  readonly #manager: CapabilityComponentManager
  readonly #tools = new Map<string, ExtensionToolRegistration>()

  constructor(manager: CapabilityComponentManager = capabilityComponentManager) {
    this.#manager = manager
  }

  register(componentId: string, definition: ExtensionToolDefinition, options: ExtensionToolRegistrationOptions = {}): ExtensionDisposable {
    const id = String(componentId || "").trim()
    const state = this.#manager.require(id)
    if (state.manifest.kind !== "optional" || state.manifest.capability !== "agent-tool") {
      throw new Error(`Component is not an optional Agent-tool extension: ${id}`)
    }
    if (state.status !== "active") {
      throw new Error(`Extension must be active before registering tools: ${id}`)
    }
    const prefix = `${id}.`
    if (!definition.id.startsWith(prefix) || definition.id.length === prefix.length) {
      throw new Error(`Extension tool id must be namespaced by ${id}`)
    }
    if (!definition.inputSchema || typeof definition.inputSchema !== "object" || Array.isArray(definition.inputSchema)) {
      throw new Error(`Extension tool schema must be an object: ${definition.id}`)
    }
    if (this.#tools.has(definition.id)) throw new Error(`Extension tool already registered: ${definition.id}`)

    const permissions = [...new Set(options.permissions || [])]
    const policy = executionPolicy(permissions)
    const isAvailable = (): boolean => this.#tools.get(definition.id)?.tool === tool
      && this.#manager.get(id)?.status === "active"
    const tool: AgentTool = {
      name: definition.id,
      description: definition.description,
      parameters: definition.inputSchema as AgentTool["parameters"],
      resultFormat: "structured",
      ...policy,
      isEnabled: isAvailable,
      permissionSource: `extension.${id}`,
      execute: async (args, context) => {
        if (!isAvailable()) throw new Error(`Extension tool is unavailable: ${definition.id}`)
        if (context.executionBoundary?.stages.join(",") !== HOST_EXECUTION_CHAIN.join(",")) {
          throw new Error(`Extension tool bypassed the host execution boundary: ${definition.id}`)
        }
        const result = await definition.execute(args, context.signal || new AbortController().signal)
        return structuredToolResult(resultText(result), result, [], { extension: id })
      },
    }
    const registration: ExtensionToolRegistration = Object.freeze({ componentId: id, tool })
    this.#tools.set(definition.id, registration)
    let disposed = false
    return Object.freeze({
      dispose: () => {
        if (disposed) return
        disposed = true
        if (this.#tools.get(definition.id) === registration) this.#tools.delete(definition.id)
      },
    })
  }

  entries(): ExtensionToolRegistration[] {
    return [...this.#tools.values()].filter((entry) => entry.tool.isEnabled?.() !== false)
  }
}

export const extensionToolRegistry = new ExtensionToolRegistry()
