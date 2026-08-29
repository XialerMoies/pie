import {
  CapabilityComponentError,
  capabilityComponentManager,
  type CapabilityComponentManager,
  type CapabilityComponentManifest,
  type CapabilityComponentState,
  validateCapabilityComponentManifest,
} from "./capability-components.js"

/** The only lifecycle exposed to installable product extensions. */
export type ExtensionLifecyclePhase =
  | "installed"
  | "validated"
  | "enabled"
  | "active"
  | "disabled"
  | "disposed"
  | "uninstalled"
  | "failed"

export interface ExtensionResource {
  /** Stable per-extension handle, used for diagnostics and duplicate detection. */
  id: string
  dispose(): void | Promise<void>
}

export interface ExtensionLifecycleHooks {
  validate?: () => void | Promise<void>
  activate?: (context: ExtensionActivationContext) => void | Promise<void>
  dispose?: () => void | Promise<void>
}

export interface ExtensionInstallOptions {
  /** Trust is still a host decision; user/workspace packages default to false. */
  trusted?: boolean
}

export interface ExtensionActivationContext {
  readonly componentId: string
  readonly registerResource: (resource: ExtensionResource) => void
}

export interface ExtensionLifecycleSnapshot {
  readonly componentId: string
  readonly phase: ExtensionLifecyclePhase
  readonly generation: number
  readonly resourceCount: number
  readonly error?: string
}

interface ExtensionRecord {
  manifest: Readonly<CapabilityComponentManifest>
  hooks: ExtensionLifecycleHooks
  phase: ExtensionLifecyclePhase
  generation: number
  resources: ExtensionResource[]
  error?: string
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Host-owned lifecycle coordinator for optional extensions.
 *
 * It deliberately does not load an entry point or grant capabilities. An
 * extension is activated only through host-registered hooks, and every
 * resource it registers is disposed in reverse order before uninstall.
 */
export class ExtensionLifecycle {
  readonly #manager: CapabilityComponentManager
  readonly #records = new Map<string, ExtensionRecord>()

  constructor(manager: CapabilityComponentManager) {
    this.#manager = manager
  }

  /** Bring a shipped extension under lifecycle management without reinstalling it. */
  adopt(componentId: string, hooks: ExtensionLifecycleHooks = {}): ExtensionLifecycleSnapshot {
    const state = this.#manager.require(componentId)
    if (state.manifest.kind !== "optional") {
      throw new CapabilityComponentError("required_component", `Only optional components can use extension lifecycle: ${componentId}`, componentId)
    }
    if (!this.#records.has(componentId)) {
      this.#records.set(componentId, {
        manifest: state.manifest,
        hooks,
        phase: state.status === "active" ? "active" : state.enabled ? "enabled" : "disabled",
        generation: state.generation,
        resources: [],
      })
    }
    return this.snapshot(componentId)
  }

  async install(manifest: CapabilityComponentManifest, hooks: ExtensionLifecycleHooks = {}, options: ExtensionInstallOptions = {}): Promise<ExtensionLifecycleSnapshot> {
    const normalized = validateCapabilityComponentManifest(manifest)
    if (normalized.kind !== "optional") {
      throw new CapabilityComponentError("required_component", `Only optional components can use extension lifecycle: ${normalized.id}`, normalized.id)
    }
    if (this.#manager.get(normalized.id)) {
      throw new CapabilityComponentError("duplicate_component", `Extension already installed: ${normalized.id}`, normalized.id)
    }
    const previous = this.#records.get(normalized.id)
    if (previous && previous.phase !== "uninstalled") {
      throw new CapabilityComponentError("duplicate_component", `Extension already installed: ${normalized.id}`, normalized.id)
    }
    const state = this.#manager.register(normalized, { trusted: options.trusted ?? normalized.source === "builtin", enabled: false, health: "healthy" })
    const record: ExtensionRecord = { manifest: normalized, hooks, phase: "installed", generation: state.generation, resources: [] }
    this.#records.set(normalized.id, record)
    try {
      await this.validate(normalized.id)
      await this.enable(normalized.id)
      await this.activate(normalized.id)
      return this.snapshot(normalized.id)
    } catch (error) {
      await this.#cleanup(record)
      record.phase = "failed"
      record.error = errorMessage(error)
      try { this.#manager.disable(normalized.id) } catch { /* already disabled */ }
      throw error
    }
  }

  async validate(componentId: string): Promise<ExtensionLifecycleSnapshot> {
    const record = this.#record(componentId)
    try {
      validateCapabilityComponentManifest(record.manifest)
      await record.hooks.validate?.()
      record.phase = "validated"
      record.generation = this.#manager.require(componentId).generation
      return this.snapshot(componentId)
    } catch (error) {
      record.phase = "failed"
      record.error = errorMessage(error)
      throw error
    }
  }

  async enable(componentId: string): Promise<ExtensionLifecycleSnapshot> {
    const record = this.#record(componentId)
    if (record.phase === "active") return this.snapshot(componentId)
    if (record.phase !== "validated" && record.phase !== "disposed" && record.phase !== "disabled") {
      throw new CapabilityComponentError("invalid_lifecycle", `Extension must be validated before enable: ${componentId}`, componentId)
    }
    const result = this.#manager.enableTree(componentId)
    record.phase = "enabled"
    record.generation = result.states.at(-1)?.generation || record.generation
    return this.snapshot(componentId)
  }

  async activate(componentId: string): Promise<ExtensionLifecycleSnapshot> {
    const record = this.#record(componentId)
    if (record.phase === "active") return this.snapshot(componentId)
    if (record.phase !== "enabled") {
      throw new CapabilityComponentError("invalid_lifecycle", `Extension must be enabled before activate: ${componentId}`, componentId)
    }
    try {
      await record.hooks.activate?.({
        componentId,
        registerResource: (resource) => this.#registerResource(record, resource),
      })
      record.phase = "active"
      record.generation = this.#manager.require(componentId).generation
      return this.snapshot(componentId)
    } catch (error) {
      await this.#cleanup(record)
      record.phase = "failed"
      record.error = errorMessage(error)
      try { this.#manager.disable(componentId) } catch { /* preserve original failure */ }
      throw error
    }
  }

  async dispose(componentId: string): Promise<ExtensionLifecycleSnapshot> {
    const record = this.#record(componentId)
    if (record.phase === "uninstalled" || record.phase === "disposed") return this.snapshot(componentId)
    const cleanupError = await this.#cleanup(record)
    try { this.#manager.disableTree(componentId) } catch (error) {
      record.phase = "failed"
      record.error = errorMessage(error)
      throw error
    }
    if (cleanupError) {
      record.phase = "failed"
      record.error = errorMessage(cleanupError)
      throw cleanupError
    }
    record.phase = "disposed"
    record.generation = this.#manager.require(componentId).generation
    return this.snapshot(componentId)
  }

  async uninstall(componentId: string): Promise<ExtensionLifecycleSnapshot> {
    const record = this.#record(componentId)
    if (record.phase !== "disposed") await this.dispose(componentId)
    this.#manager.uninstall(componentId)
    record.phase = "uninstalled"
    record.generation = this.#manager.catalog().generation
    return this.snapshot(componentId)
  }

  snapshot(componentId: string): ExtensionLifecycleSnapshot {
    const record = this.#record(componentId)
    return Object.freeze({
      componentId,
      phase: record.phase,
      generation: record.generation,
      resourceCount: record.resources.length,
      ...(record.error ? { error: record.error } : {}),
    })
  }

  list(): ExtensionLifecycleSnapshot[] {
    return [...this.#records.keys()].sort().map((id) => this.snapshot(id))
  }

  #record(componentId: string): ExtensionRecord {
    const id = String(componentId || "").trim()
    const record = this.#records.get(id)
    if (!record) throw new CapabilityComponentError("unknown_extension", `Unknown extension: ${id || "(empty)"}`, id)
    return record
  }

  #registerResource(record: ExtensionRecord, resource: ExtensionResource): void {
    if (!resource || !/^[a-z0-9][a-z0-9._-]*$/u.test(String(resource.id || "")) || typeof resource.dispose !== "function") {
      throw new CapabilityComponentError("invalid_resource", `Extension ${record.manifest.id} registered an invalid resource`, record.manifest.id)
    }
    if (record.resources.some((candidate) => candidate.id === resource.id)) {
      throw new CapabilityComponentError("duplicate_resource", `Extension ${record.manifest.id} registered duplicate resource: ${resource.id}`, record.manifest.id)
    }
    record.resources.push(resource)
  }

  async #cleanup(record: ExtensionRecord): Promise<Error | undefined> {
    const errors: Error[] = []
    try { await record.hooks.dispose?.() } catch (error) { errors.push(error instanceof Error ? error : new Error(errorMessage(error))) }
    for (const resource of [...record.resources].reverse()) {
      try { await resource.dispose() } catch (error) { errors.push(error instanceof Error ? error : new Error(errorMessage(error))) }
    }
    record.resources.length = 0
    if (errors.length === 0) return undefined
    return errors.length === 1 ? errors[0] : new AggregateError(errors, `Extension ${record.manifest.id} cleanup failed`)
  }
}

export type { CapabilityComponentState }

/** Shared host coordinator used by HTTP/CLI management surfaces. */
export const extensionLifecycle = new ExtensionLifecycle(capabilityComponentManager)
