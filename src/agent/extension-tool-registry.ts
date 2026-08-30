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

type ExtensionLimitWaiter = {
  resolve: (release: () => void) => void
  reject: (error: Error) => void
  signal?: AbortSignal
  onAbort?: () => void
}

type ExtensionLimitState = {
  running: number
  waiters: ExtensionLimitWaiter[]
}

function abortedError(message: string, reason?: unknown): Error {
  const error = reason instanceof Error ? reason : new Error(message)
  if (!error.message) error.message = message
  error.name = "AbortError"
  return error
}

function timeoutError(toolName: string, timeoutMs: number): Error {
  const error = new Error(`Extension tool timed out after ${timeoutMs}ms: ${toolName}`) as Error & { code?: string }
  error.code = "extension_tool_timeout"
  return error
}

function mergedSignal(signals: readonly (AbortSignal | undefined)[]): { signal: AbortSignal; dispose(): void } {
  const controller = new AbortController()
  const listeners: Array<{ signal: AbortSignal; listener: () => void }> = []
  for (const signal of signals) {
    if (!signal) continue
    const abort = () => controller.abort(signal.reason)
    if (signal.aborted) abort()
    else {
      signal.addEventListener("abort", abort, { once: true })
      listeners.push({ signal, listener: abort })
    }
  }
  return {
    signal: controller.signal,
    dispose: () => listeners.forEach(({ signal, listener }) => signal.removeEventListener("abort", listener)),
  }
}

function abortRace(signal: AbortSignal, message: string): { promise: Promise<never>; dispose(): void } {
  let listener: (() => void) | undefined
  const promise = new Promise<never>((_, reject) => {
    if (signal.aborted) {
      reject(abortedError(message, signal.reason))
      return
    }
    listener = () => reject(abortedError(message, signal.reason))
    signal.addEventListener("abort", listener, { once: true })
  })
  return {
    promise,
    dispose: () => {
      if (listener) signal.removeEventListener("abort", listener)
      listener = undefined
    },
  }
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

function executionPolicy(permissions: readonly ExtensionPermission[], maxConcurrent: number): Pick<AgentTool, "operations" | "isReadOnly" | "isDestructive" | "isConcurrencySafe" | "riskLevel" | "needsPermission" | "workspaceBounded" | "authorizationMode"> {
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
    isConcurrencySafe: maxConcurrent > 1,
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
  readonly #limits = new Map<string, ExtensionLimitState>()

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
    const maxConcurrent = state.manifest.agentConfig?.maxConcurrent ?? 1
    const timeoutMs = state.manifest.agentConfig?.timeoutMs
    const policy = executionPolicy(permissions, maxConcurrent)
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
        const release = await this.#acquire(id, maxConcurrent, context.signal)
        if (!isAvailable()) {
          release()
          throw new Error(`Extension tool is unavailable: ${definition.id}`)
        }
        const timeout = new AbortController()
        const combined = mergedSignal([context.signal, timeout.signal])
        const timer = timeoutMs === undefined
          ? undefined
          : setTimeout(() => timeout.abort(timeoutError(definition.id, timeoutMs)), timeoutMs)
        let settled = false
        const execution = Promise.resolve()
          .then(() => definition.execute(args, combined.signal))
          .then(
            (result) => { settled = true; return result },
            (error) => { settled = true; throw error },
          )
        const abort = abortRace(combined.signal, `Extension tool aborted: ${definition.id}`)
        const finish = () => {
          if (timer) clearTimeout(timer)
          combined.dispose()
          abort.dispose()
          release()
        }
        try {
          const result = await Promise.race([
            execution,
            abort.promise,
          ])
          finish()
          return structuredToolResult(resultText(result), result, [], { extension: id })
        } catch (error) {
          if (settled) finish()
          else void execution.catch(() => undefined).finally(finish)
          throw error
        }
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

  async #acquire(componentId: string, maxConcurrent: number, signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) throw abortedError(`Extension tool aborted while waiting: ${componentId}`, signal.reason)
    const limit = this.#limits.get(componentId) || { running: 0, waiters: [] }
    this.#limits.set(componentId, limit)
    if (limit.running < maxConcurrent) {
      limit.running += 1
      return this.#releaseFactory(componentId, limit)
    }
    return new Promise<() => void>((resolve, reject) => {
      const waiter: ExtensionLimitWaiter = { resolve, reject, signal }
      waiter.onAbort = () => {
        const index = limit.waiters.indexOf(waiter)
        if (index >= 0) limit.waiters.splice(index, 1)
        reject(abortedError(`Extension tool aborted while waiting: ${componentId}`, signal?.reason))
      }
      if (signal) signal.addEventListener("abort", waiter.onAbort, { once: true })
      limit.waiters.push(waiter)
    })
  }

  #releaseFactory(componentId: string, limit: ExtensionLimitState): () => void {
    let released = false
    return () => {
      if (released) return
      released = true
      limit.running = Math.max(0, limit.running - 1)
      const waiter = limit.waiters.shift()
      if (waiter) {
        if (waiter.signal && waiter.onAbort) waiter.signal.removeEventListener("abort", waiter.onAbort)
        limit.running += 1
        waiter.resolve(this.#releaseFactory(componentId, limit))
      } else if (limit.running === 0) {
        this.#limits.delete(componentId)
      }
    }
  }
}

export const extensionToolRegistry = new ExtensionToolRegistry()
