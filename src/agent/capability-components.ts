import { createHash } from "node:crypto"

export const CAPABILITY_COMPONENT_SCHEMA_VERSION = 1 as const

export type CapabilityComponentKind = "required" | "optional"
export type CapabilityComponentSource = "builtin" | "workspace" | "user" | "mcp"
export type CapabilityComponentHealth = "unknown" | "healthy" | "broken" | "unavailable"
export type CapabilityComponentStatus = "active" | "disabled" | "untrusted" | "unhealthy"

export interface CapabilityComponentManifest {
  schemaVersion?: typeof CAPABILITY_COMPONENT_SCHEMA_VERSION
  id: string
  version: string
  kind: CapabilityComponentKind
  capability: string
  replacementGroup?: string
  dependencies?: readonly string[]
  source?: CapabilityComponentSource
  description?: string
}

export interface CapabilityComponentState {
  manifest: Readonly<CapabilityComponentManifest>
  trusted: boolean
  enabled: boolean
  health: CapabilityComponentHealth
  generation: number
  status: CapabilityComponentStatus
}

export type CapabilityComponentLifecycleAction =
  | "registered"
  | "trusted"
  | "untrusted"
  | "enabled"
  | "disabled"
  | "health_changed"
  | "uninstalled"
  | "rejected"

export interface CapabilityComponentLifecycleEvent {
  action: CapabilityComponentLifecycleAction
  componentId: string
  generation: number
  timestamp: string
  reason?: string
}

export interface RegisterComponentOptions {
  trusted?: boolean
  enabled?: boolean
  health?: CapabilityComponentHealth
}

export class CapabilityComponentError extends Error {
  readonly code: string
  readonly componentId?: string

  constructor(code: string, message: string, componentId?: string) {
    super(message)
    this.name = "CapabilityComponentError"
    this.code = code
    this.componentId = componentId
  }
}

function stableManifest(manifest: CapabilityComponentManifest): CapabilityComponentManifest {
  return {
    schemaVersion: CAPABILITY_COMPONENT_SCHEMA_VERSION,
    id: manifest.id,
    version: manifest.version,
    kind: manifest.kind,
    capability: manifest.capability,
    ...(manifest.replacementGroup ? { replacementGroup: manifest.replacementGroup } : {}),
    ...(manifest.dependencies?.length ? { dependencies: [...manifest.dependencies].sort() } : {}),
    source: manifest.source || "workspace",
    ...(manifest.description ? { description: manifest.description } : {}),
  }
}

function fingerprint(manifest: CapabilityComponentManifest): string {
  return createHash("sha256").update(JSON.stringify(stableManifest(manifest))).digest("hex")
}

function validateManifest(input: CapabilityComponentManifest): Readonly<CapabilityComponentManifest> {
  const id = String(input.id || "").trim()
  if (!/^[a-z0-9][a-z0-9._-]*$/u.test(id)) throw new CapabilityComponentError("invalid_manifest", `Invalid component id: ${id || "(empty)"}`, id)
  if (!String(input.version || "").trim()) throw new CapabilityComponentError("invalid_manifest", `Component ${id} must declare a version`, id)
  if (input.kind !== "required" && input.kind !== "optional") throw new CapabilityComponentError("invalid_manifest", `Component ${id} has invalid kind`, id)
  if (!String(input.capability || "").trim()) throw new CapabilityComponentError("invalid_manifest", `Component ${id} must declare a capability`, id)
  if (input.kind === "required" && !String(input.replacementGroup || "").trim()) {
    throw new CapabilityComponentError("invalid_manifest", `Required component ${id} must declare replacementGroup`, id)
  }
  const dependencies = input.dependencies || []
  if (dependencies.some((dependency) => !/^[a-z0-9][a-z0-9._-]*$/u.test(String(dependency)))) {
    throw new CapabilityComponentError("invalid_manifest", `Component ${id} has an invalid dependency`, id)
  }
  if (new Set(dependencies).size !== dependencies.length) {
    throw new CapabilityComponentError("invalid_manifest", `Component ${id} contains duplicate dependencies`, id)
  }
  if (dependencies.includes(id)) throw new CapabilityComponentError("invalid_manifest", `Component ${id} cannot depend on itself`, id)
  return Object.freeze(stableManifest({ ...input, id }))
}

function statusFor(state: Pick<CapabilityComponentState, "trusted" | "enabled" | "health">): CapabilityComponentStatus {
  if (!state.trusted) return "untrusted"
  if (!state.enabled) return "disabled"
  if (state.health !== "healthy") return "unhealthy"
  return "active"
}

/**
 * Small in-process component registry. It is deliberately not a plugin
 * loader: registration is declarative, and execution remains owned by the
 * existing ToolPool, Profile and MCP hosts.
 */
export class CapabilityComponentManager {
  readonly #components = new Map<string, CapabilityComponentState>()
  readonly #events: CapabilityComponentLifecycleEvent[] = []
  #generation = 0

  constructor(manifests: readonly CapabilityComponentManifest[] = []) {
    for (const manifest of manifests) this.register(manifest)
  }

  register(manifest: CapabilityComponentManifest, options: RegisterComponentOptions = {}): CapabilityComponentState {
    const normalized = validateManifest(manifest)
    if (this.#components.has(normalized.id)) throw new CapabilityComponentError("duplicate_component", `Component already registered: ${normalized.id}`, normalized.id)
    const trusted = options.trusted ?? normalized.source === "builtin"
    const enabled = options.enabled ?? (normalized.kind === "required" && trusted)
    const health = options.health ?? (normalized.source === "builtin" ? "healthy" : "unknown")
    if (enabled && !trusted) throw new CapabilityComponentError("untrusted_component", `Cannot enable untrusted component: ${normalized.id}`, normalized.id)
    const state = this.#publish({ manifest: normalized, trusted, enabled, health }, "registered")
    return state
  }

  list(): CapabilityComponentState[] {
    return [...this.#components.values()].sort((left, right) => left.manifest.id.localeCompare(right.manifest.id)).map((state) => this.#cloneState(state))
  }

  get(id: string): CapabilityComponentState | undefined {
    const state = this.#components.get(String(id || "").trim())
    return state ? this.#cloneState(state) : undefined
  }

  require(id: string): CapabilityComponentState {
    const state = this.get(id)
    if (!state) throw new CapabilityComponentError("unknown_component", `Unknown component: ${id || "(empty)"}`, id)
    return state
  }

  trust(id: string, trusted = true): CapabilityComponentState {
    const current = this.#requireMutable(id)
    if (!trusted && current.enabled) {
      this.#publish({ ...current, enabled: false }, "disabled", "trust revoked")
    }
    return this.#publish({ ...this.#requireMutable(id), trusted }, trusted ? "trusted" : "untrusted")
  }

  enable(id: string): CapabilityComponentState {
    const current = this.#requireMutable(id)
    if (!current.trusted) return this.#reject("untrusted_component", `Cannot enable untrusted component: ${id}`, id)
    if (current.health !== "healthy") return this.#reject("unhealthy_component", `Cannot enable unhealthy component: ${id}`, id)
    const dependencies = current.manifest.dependencies || []
    const missing = dependencies.filter((dependency) => {
      const state = this.#components.get(dependency)
      return !state || !state.enabled || !state.trusted || state.health !== "healthy"
    })
    if (missing.length > 0) return this.#reject("missing_dependency", `Component ${id} requires healthy dependencies: ${missing.join(", ")}`, id)
    return this.#publish({ ...current, enabled: true }, "enabled")
  }

  disable(id: string): CapabilityComponentState {
    const current = this.#requireMutable(id)
    if (current.manifest.kind === "required") return this.#reject("required_component", `Required component cannot be disabled: ${id}`, id)
    return this.#publish({ ...current, enabled: false }, "disabled")
  }

  setHealth(id: string, health: CapabilityComponentHealth): CapabilityComponentState {
    if (!["unknown", "healthy", "broken", "unavailable"].includes(health)) return this.#reject("invalid_health", `Invalid component health: ${health}`, id)
    const current = this.#requireMutable(id)
    return this.#publish({ ...current, health }, "health_changed")
  }

  uninstall(id: string): CapabilityComponentState {
    const current = this.#requireMutable(id)
    if (current.manifest.kind === "required") {
      const replacement = this.list().find((candidate) => candidate.manifest.id !== current.manifest.id
        && candidate.manifest.replacementGroup === current.manifest.replacementGroup
        && candidate.manifest.capability === current.manifest.capability
        && candidate.trusted && candidate.enabled && candidate.health === "healthy")
      if (!replacement) return this.#reject("required_component", `Required component has no healthy replacement: ${id}`, id)
    }
    this.#components.delete(current.manifest.id)
    this.#record("uninstalled", current.manifest.id, current.generation)
    return current
  }

  events(): CapabilityComponentLifecycleEvent[] { return this.#events.map((event) => ({ ...event })) }

  catalog(): {
    schemaVersion: typeof CAPABILITY_COMPONENT_SCHEMA_VERSION
    generation: number
    components: CapabilityComponentState[]
    fingerprint: string
  } {
    const components = this.list()
    const payload = { schemaVersion: CAPABILITY_COMPONENT_SCHEMA_VERSION, generation: this.#generation, components }
    return { ...payload, fingerprint: createHash("sha256").update(JSON.stringify(payload)).digest("hex") }
  }

  #requireMutable(id: string): CapabilityComponentState {
    const state = this.#components.get(String(id || "").trim())
    if (!state) throw new CapabilityComponentError("unknown_component", `Unknown component: ${id || "(empty)"}`, id)
    return state
  }

  #reject(code: string, message: string, id: string): never {
    const generation = this.#generation
    this.#record("rejected", id, generation, message)
    throw new CapabilityComponentError(code, message, id)
  }

  #publish(input: Pick<CapabilityComponentState, "manifest" | "trusted" | "enabled" | "health">, action: CapabilityComponentLifecycleAction, reason?: string): CapabilityComponentState {
    const generation = ++this.#generation
    const state: CapabilityComponentState = Object.freeze({ ...input, generation, status: statusFor(input) })
    this.#components.set(input.manifest.id, state)
    this.#record(action, input.manifest.id, generation, reason)
    return this.#cloneState(state)
  }

  #record(action: CapabilityComponentLifecycleAction, componentId: string, generation: number, reason?: string): void {
    this.#events.push({ action, componentId, generation, timestamp: new Date().toISOString(), ...(reason ? { reason } : {}) })
  }

  #cloneState(state: CapabilityComponentState): CapabilityComponentState {
    return { ...state, manifest: { ...state.manifest, ...(state.manifest.dependencies ? { dependencies: [...state.manifest.dependencies] } : {}) } }
  }
}

export const REQUIRED_COMPONENT_MANIFESTS: readonly CapabilityComponentManifest[] = Object.freeze([
  { id: "bootstrap-kernel", version: "1", kind: "required", capability: "bootstrap", replacementGroup: "bootstrap", source: "builtin", description: "Minimal host lifecycle contract" },
  { id: "session-store", version: "1", kind: "required", capability: "session-store", replacementGroup: "session-store", source: "builtin" },
  { id: "model-router", version: "1", kind: "required", capability: "model-router", replacementGroup: "model-router", source: "builtin" },
  { id: "permission-evaluator", version: "1", kind: "required", capability: "permission", replacementGroup: "permission", source: "builtin" },
  { id: "security-parser", version: "1", kind: "required", capability: "security-parser", replacementGroup: "security-parser", source: "builtin" },
  { id: "tool-presentation", version: "1", kind: "required", capability: "tool-presentation", replacementGroup: "tool-presentation", source: "builtin" },
  { id: "mcp-host-integration", version: "1", kind: "required", capability: "mcp-host", replacementGroup: "mcp-host", source: "builtin" },
])

export const capabilityComponentManager = new CapabilityComponentManager(REQUIRED_COMPONENT_MANIFESTS)

export function componentManifestFingerprint(manifest: CapabilityComponentManifest): string { return fingerprint(manifest) }
