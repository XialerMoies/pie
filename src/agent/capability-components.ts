import { createHash } from "node:crypto"
import { readLockedJson, updateLockedJson } from "../data/locked-json-store.js"

export const CAPABILITY_COMPONENT_SCHEMA_VERSION = 1 as const

export type CapabilityComponentKind = "required" | "optional"
export type CapabilityComponentSource = "builtin" | "workspace" | "user" | "mcp"
export type CapabilityComponentHealth = "unknown" | "healthy" | "broken" | "unavailable"
export type CapabilityComponentStatus = "active" | "disabled" | "untrusted" | "unhealthy"

export interface CapabilityComponentDependency {
  id: string
  /** Optional semver-like range (for example ^1.2.0, ~1.4.0 or >=2). */
  version?: string
  /** Optional dependencies do not prevent activation when absent. */
  optional?: boolean
  /** If set, the provider must expose this capability. */
  capability?: string
}

export interface CapabilityComponentManifest {
  schemaVersion?: typeof CAPABILITY_COMPONENT_SCHEMA_VERSION
  id: string
  version: string
  kind: CapabilityComponentKind
  capability: string
  replacementGroup?: string
  dependencies?: readonly (string | CapabilityComponentDependency)[]
  /** Parent component for host-managed child components. */
  parentId?: string
  /** Provider package that owns this component's implementation. */
  providedBy?: string
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

export interface SyncComponentOptions {
  version?: string
  capability?: string
  kind?: CapabilityComponentKind
  replacementGroup?: string
  source?: CapabilityComponentSource
  dependencies?: readonly (string | CapabilityComponentDependency)[]
  parentId?: string
  providedBy?: string
  trusted: boolean
  enabled: boolean
  health: CapabilityComponentHealth
  description?: string
}

export interface CapabilityComponentStateDocument {
  schemaVersion: typeof CAPABILITY_COMPONENT_SCHEMA_VERSION
  components: Array<{ manifest: CapabilityComponentManifest; trusted: boolean; enabled: boolean; health: CapabilityComponentHealth }>
}

export interface CapabilityComponentLifecycleResult {
  rootId: string
  order: string[]
  states: CapabilityComponentState[]
}

export class CapabilityComponentError extends Error {
  readonly code: string
  readonly componentId?: string
  readonly dependencyChain?: readonly string[]

  constructor(code: string, message: string, componentId?: string, dependencyChain?: readonly string[]) {
    super(message)
    this.name = "CapabilityComponentError"
    this.code = code
    this.componentId = componentId
    this.dependencyChain = dependencyChain?.length ? Object.freeze([...dependencyChain]) : undefined
  }
}

function stableManifest(manifest: CapabilityComponentManifest): CapabilityComponentManifest {
  const dependencies = normalizeDependencies(manifest.dependencies)
  return {
    schemaVersion: CAPABILITY_COMPONENT_SCHEMA_VERSION,
    id: manifest.id,
    version: manifest.version,
    kind: manifest.kind,
    capability: manifest.capability,
    ...(manifest.replacementGroup ? { replacementGroup: manifest.replacementGroup } : {}),
    ...(dependencies.length ? { dependencies } : {}),
    ...(manifest.parentId ? { parentId: manifest.parentId } : {}),
    ...(manifest.providedBy ? { providedBy: manifest.providedBy } : {}),
    source: manifest.source || "workspace",
    ...(manifest.description ? { description: manifest.description } : {}),
  }
}

function normalizeDependencies(dependencies: CapabilityComponentManifest["dependencies"]): CapabilityComponentDependency[] {
  return (dependencies || []).map((dependency) => typeof dependency === "string" ? { id: dependency } : {
    id: dependency.id,
    ...(dependency.version ? { version: dependency.version } : {}),
    ...(dependency.optional ? { optional: true } : {}),
    ...(dependency.capability ? { capability: dependency.capability } : {}),
  }).sort((left, right) => left.id.localeCompare(right.id))
}

function effectiveDependencies(manifest: CapabilityComponentManifest): CapabilityComponentDependency[] {
  const dependencies = normalizeDependencies(manifest.dependencies)
  if (manifest.parentId && !dependencies.some((dependency) => dependency.id === manifest.parentId)) {
    dependencies.push({ id: manifest.parentId })
  }
  return dependencies.sort((left, right) => left.id.localeCompare(right.id))
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
  const dependencies = normalizeDependencies(input.dependencies)
  if (dependencies.some((dependency) => !/^[a-z0-9][a-z0-9._-]*$/u.test(String(dependency.id)))) {
    throw new CapabilityComponentError("invalid_manifest", `Component ${id} has an invalid dependency`, id)
  }
  if (dependencies.some((dependency) => dependency.version && !isVersionRange(String(dependency.version)))) {
    throw new CapabilityComponentError("invalid_manifest", `Component ${id} has an invalid dependency version range`, id)
  }
  if (new Set(dependencies.map((dependency) => dependency.id)).size !== dependencies.length) {
    throw new CapabilityComponentError("invalid_manifest", `Component ${id} contains duplicate dependencies`, id)
  }
  if (dependencies.some((dependency) => dependency.id === id)) throw new CapabilityComponentError("invalid_manifest", `Component ${id} cannot depend on itself`, id)
  const parentId = input.parentId ? String(input.parentId).trim() : undefined
  if (parentId && (!/^[a-z0-9][a-z0-9._-]*$/u.test(parentId) || parentId === id)) {
    throw new CapabilityComponentError("invalid_manifest", `Component ${id} has an invalid parentId`, id)
  }
  const providedBy = input.providedBy ? String(input.providedBy).trim() : undefined
  if (providedBy && !/^[a-z0-9][a-z0-9._-]*$/u.test(providedBy)) {
    throw new CapabilityComponentError("invalid_manifest", `Component ${id} has an invalid providedBy`, id)
  }
  return Object.freeze(stableManifest({ ...input, id, dependencies, ...(parentId ? { parentId } : {}), ...(providedBy ? { providedBy } : {}) }))
}

function isVersionRange(value: string): boolean {
  return /^(?:\*|\d+(?:\.\d+){0,2}|[~^]\d+(?:\.\d+){0,2}|>=\s*\d+(?:\.\d+){0,2})$/u.test(value.trim())
}

function versionParts(version: string): [number, number, number] {
  const match = version.trim().match(/\d+(?:\.\d+){0,2}/u)?.[0] || "0"
  const parts = match.split(".").map((part) => Number.parseInt(part, 10) || 0)
  return [parts[0] || 0, parts[1] || 0, parts[2] || 0]
}

function compareVersions(left: string, right: string): number {
  const a = versionParts(left); const b = versionParts(right)
  for (let index = 0; index < 3; index += 1) if (a[index] !== b[index]) return a[index] - b[index]
  return 0
}

function satisfiesVersion(version: string, range?: string): boolean {
  if (!range || range.trim() === "*") return true
  const value = range.trim()
  const operator = value[0] === "^" || value[0] === "~" ? value[0] : value.startsWith(">=") ? ">=" : ""
  const target = value.replace(/^(?:\^|~|>=)\s*/u, "")
  const comparison = compareVersions(version, target)
  if (operator === ">=") return comparison >= 0
  if (operator === "^") {
    const [major] = versionParts(target); return comparison >= 0 && versionParts(version)[0] === major
  }
  if (operator === "~") {
    const [major, minor] = versionParts(target); const actual = versionParts(version)
    return comparison >= 0 && actual[0] === major && actual[1] === minor
  }
  return comparison === 0
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
    this.#assertNoDependencyCycle(normalized)
    const trusted = options.trusted ?? normalized.source === "builtin"
    const enabled = options.enabled ?? (normalized.kind === "required" && trusted)
    const health = options.health ?? (normalized.source === "builtin" ? "healthy" : "unknown")
    if (enabled && !trusted) throw new CapabilityComponentError("untrusted_component", `Cannot enable untrusted component: ${normalized.id}`, normalized.id)
    if (enabled) {
      const missing = this.#dependencyFailures(normalized)
      if (missing.length > 0) throw new CapabilityComponentError("missing_dependency", `Component ${normalized.id} requires healthy dependencies: ${missing.map((dependency) => dependency.id).join(", ")}`, normalized.id, [normalized.id, ...missing.map((dependency) => dependency.id)])
    }
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
      const dependents = this.#enabledDependents(id)
      if (dependents.length > 0) return this.#rejectDependencyInUse(id, dependents)
      this.#publish({ ...current, enabled: false }, "disabled", "trust revoked")
    }
    return this.#publish({ ...this.#requireMutable(id), trusted }, trusted ? "trusted" : "untrusted")
  }

  enable(id: string): CapabilityComponentState {
    const current = this.#requireMutable(id)
    if (!current.trusted) return this.#reject("untrusted_component", `Cannot enable untrusted component: ${id}`, id)
    if (current.health !== "healthy") return this.#reject("unhealthy_component", `Cannot enable unhealthy component: ${id}`, id)
    const missing = this.#dependencyFailures(current.manifest)
    if (missing.length > 0) return this.#reject("missing_dependency", `Component ${id} requires healthy dependencies: ${missing.map((dependency) => dependency.id).join(", ")}`, id, [id, ...missing.map((dependency) => dependency.id)])
    return this.#publish({ ...current, enabled: true }, "enabled")
  }

  /** Enable a component and its required dependencies in dependency-first order. */
  enableTree(id: string): CapabilityComponentLifecycleResult {
    const order = this.#activationOrder(id)
    const states: CapabilityComponentState[] = []
    for (const componentId of order) {
      const current = this.#requireMutable(componentId)
      states.push(current.enabled ? this.#cloneState(current) : this.#publish({ ...current, enabled: true }, "enabled", `dependency tree: ${id}`))
    }
    return { rootId: id, order, states }
  }

  disable(id: string): CapabilityComponentState {
    const current = this.#requireMutable(id)
    if (current.manifest.kind === "required") return this.#reject("required_component", `Required component cannot be disabled: ${id}`, id)
    const dependents = this.#enabledDependents(id)
    if (dependents.length > 0) return this.#rejectDependencyInUse(id, dependents)
    return this.#publish({ ...current, enabled: false }, "disabled")
  }

  /** Disable enabled dependents before the requested optional component. */
  disableTree(id: string): CapabilityComponentLifecycleResult {
    const order = this.#deactivationOrder(id)
    const required = order.filter((componentId) => this.#requireMutable(componentId).manifest.kind === "required")
    if (required.length > 0) return this.#reject("required_component", `Dependency tree contains required components: ${required.join(", ")}`, id, [id, ...required])
    const states: CapabilityComponentState[] = []
    for (const componentId of order) {
      const current = this.#requireMutable(componentId)
      states.push(current.enabled ? this.#publish({ ...current, enabled: false }, "disabled", `dependency tree: ${id}`) : this.#cloneState(current))
    }
    return { rootId: id, order, states }
  }

  setHealth(id: string, health: CapabilityComponentHealth): CapabilityComponentState {
    if (!["unknown", "healthy", "broken", "unavailable"].includes(health)) return this.#reject("invalid_health", `Invalid component health: ${health}`, id)
    const current = this.#requireMutable(id)
    return this.#publish({ ...current, health }, "health_changed")
  }

  /** Reconcile a host-owned component with an external runtime status source. */
  sync(id: string, options: SyncComponentOptions): CapabilityComponentState {
    const normalizedId = String(id || "").trim()
    const existing = this.#components.get(normalizedId)
    const manifest: CapabilityComponentManifest = {
      id: normalizedId,
      version: options.version || existing?.manifest.version || "1",
      kind: options.kind || existing?.manifest.kind || "optional",
      capability: options.capability || existing?.manifest.capability || "runtime",
      ...(existing?.manifest.dependencies ? { dependencies: existing.manifest.dependencies } : {}),
      ...(options.dependencies ? { dependencies: options.dependencies } : {}),
      ...(options.parentId || existing?.manifest.parentId ? { parentId: options.parentId || existing?.manifest.parentId } : {}),
      ...(options.providedBy || existing?.manifest.providedBy ? { providedBy: options.providedBy || existing?.manifest.providedBy } : {}),
      ...(options.replacementGroup || existing?.manifest.replacementGroup ? { replacementGroup: options.replacementGroup || existing?.manifest.replacementGroup } : {}),
      source: options.source || existing?.manifest.source || "workspace",
      ...(options.description || existing?.manifest.description ? { description: options.description || existing?.manifest.description } : {}),
    }
    if (!existing) return this.register(manifest, options)
    const normalized = validateManifest(manifest)
    this.#assertNoDependencyCycle(normalized)
    const unchanged = JSON.stringify(existing.manifest) === JSON.stringify(normalized)
      && existing.trusted === options.trusted
      && existing.enabled === options.enabled
      && existing.health === options.health
    if (unchanged) return this.#cloneState(existing)
    return this.#publish({ manifest: normalized, trusted: options.trusted, enabled: options.enabled, health: options.health }, "health_changed")
  }

  /** Stable state payload for a host persistence layer. */
  persistedState(): Array<{ manifest: CapabilityComponentManifest; trusted: boolean; enabled: boolean; health: CapabilityComponentHealth }> {
    return this.list().map((state) => ({ manifest: { ...state.manifest }, trusted: state.trusted, enabled: state.enabled, health: state.health }))
  }

  async save(filePath: string): Promise<void> {
    const document: CapabilityComponentStateDocument = {
      schemaVersion: CAPABILITY_COMPONENT_SCHEMA_VERSION,
      components: this.persistedState().filter((state) => state.manifest.source !== "builtin"),
    }
    await updateLockedJson<CapabilityComponentStateDocument>(filePath, () => ({ schemaVersion: CAPABILITY_COMPONENT_SCHEMA_VERSION, components: [] }), () => document, { recoverInvalidJson: true, space: 2 })
  }

  async restore(filePath: string): Promise<void> {
    const document = await readLockedJson<CapabilityComponentStateDocument>(filePath, () => ({ schemaVersion: CAPABILITY_COMPONENT_SCHEMA_VERSION, components: [] }), { recoverInvalidJson: true })
    if (!document || document.schemaVersion !== CAPABILITY_COMPONENT_SCHEMA_VERSION || !Array.isArray(document.components)) return
    const restored: Array<{ id: string; enabled: boolean }> = []
    for (const entry of document.components) {
      try {
        const manifest = validateManifest(entry.manifest)
        if (manifest.source === "builtin") continue
        const existing = this.#components.get(manifest.id)
        if (existing) this.#publish({ manifest, trusted: entry.trusted === true, enabled: false, health: entry.health }, "health_changed", "restored")
        else this.register(manifest, { trusted: entry.trusted === true, enabled: false, health: entry.health })
        restored.push({ id: manifest.id, enabled: entry.enabled === true && entry.trusted === true })
      } catch {
        // Corrupt optional records are ignored; the host remains fail-closed.
      }
    }
    for (const entry of restored.filter((candidate) => candidate.enabled)) {
      try { this.enableTree(entry.id) } catch { /* Invalid dependency graphs remain disabled. */ }
    }
  }

  /** Agent-facing projection: active capabilities only, without management state. */
  agentProjection(): Array<{ id: string; capability: string; version: string }> {
    return this.list().filter((state) => state.status === "active" && this.#isOperational(state.manifest.id)).map((state) => ({ id: state.manifest.id, capability: state.manifest.capability, version: state.manifest.version }))
  }

  uninstall(id: string): CapabilityComponentState {
    const current = this.#requireMutable(id)
    const dependents = this.#enabledDependents(id)
    if (dependents.length > 0) return this.#rejectDependencyInUse(id, dependents)
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

  #assertNoDependencyCycle(manifest: Readonly<CapabilityComponentManifest>): void {
    const visiting = new Set<string>()
    const visit = (id: string): boolean => {
      if (visiting.has(id)) return true
      const state = id === manifest.id ? manifest : this.#components.get(id)?.manifest
      if (!state) return false
      visiting.add(id)
      for (const dependency of effectiveDependencies(state)) if (visit(dependency.id)) return true
      visiting.delete(id)
      return false
    }
    if (visit(manifest.id)) this.#reject("dependency_cycle", `Component ${manifest.id} has a dependency cycle`, manifest.id)
  }

  #activationOrder(id: string): string[] {
    this.#requireMutable(id)
    const visited = new Set<string>(); const order: string[] = []
    const visit = (componentId: string, chain: string[]): void => {
      if (visited.has(componentId)) return
      const state = this.#components.get(componentId)
      if (!state) return this.#reject("missing_dependency", `Missing component dependency: ${componentId}`, id, [...chain, componentId])
      if (!state.trusted) return this.#reject("untrusted_component", `Cannot enable untrusted component: ${componentId}`, id, [...chain, componentId])
      if (state.health !== "healthy") return this.#reject("unhealthy_component", `Cannot enable unhealthy component: ${componentId}`, id, [...chain, componentId])
      for (const dependency of effectiveDependencies(state.manifest)) {
        const provider = this.#components.get(dependency.id)
        if (dependency.optional && !provider) continue
        if (!provider || !satisfiesVersion(provider.manifest.version, dependency.version)
          || (dependency.capability && provider.manifest.capability !== dependency.capability)) {
          return this.#reject("missing_dependency", `Component ${componentId} has an incompatible dependency: ${dependency.id}`, id, [...chain, componentId, dependency.id])
        }
        visit(dependency.id, [...chain, componentId])
      }
      visited.add(componentId); order.push(componentId)
    }
    visit(id, [])
    return order
  }

  #deactivationOrder(id: string): string[] {
    this.#requireMutable(id)
    const visited = new Set<string>(); const order: string[] = []
    const visit = (componentId: string): void => {
      if (visited.has(componentId)) return
      visited.add(componentId)
      for (const dependent of this.#enabledDependents(componentId)) visit(dependent.manifest.id)
      order.push(componentId)
    }
    visit(id)
    return order
  }

  #enabledDependents(id: string): CapabilityComponentState[] {
    return this.list().filter((candidate) => candidate.enabled && effectiveDependencies(candidate.manifest).some((dependency) => dependency.id === id && !dependency.optional))
  }

  #isOperational(id: string, visiting = new Set<string>()): boolean {
    if (visiting.has(id)) return false
    const state = this.#components.get(id)
    if (!state || !state.trusted || !state.enabled || state.health !== "healthy") return false
    visiting.add(id)
    const operational = effectiveDependencies(state.manifest).every((dependency) => {
      const provider = this.#components.get(dependency.id)
      if (dependency.optional && !provider) return true
      return !!provider && satisfiesVersion(provider.manifest.version, dependency.version)
        && (!dependency.capability || provider.manifest.capability === dependency.capability)
        && this.#isOperational(dependency.id, visiting)
    })
    visiting.delete(id)
    return operational
  }

  #dependencyFailures(manifest: CapabilityComponentManifest): CapabilityComponentDependency[] {
    return effectiveDependencies(manifest).filter((dependency) => {
      const state = this.#components.get(dependency.id)
      return !dependency.optional && (!state || !this.#isOperational(dependency.id)
        || !satisfiesVersion(state.manifest.version, dependency.version)
        || (dependency.capability && state.manifest.capability !== dependency.capability))
    })
  }

  #rejectDependencyInUse(id: string, dependents: CapabilityComponentState[]): never {
    return this.#reject("dependency_in_use", `Component ${id} is required by enabled components: ${dependents.map((candidate) => candidate.manifest.id).join(", ")}`, id, [id, ...dependents.map((candidate) => candidate.manifest.id)])
  }

  #reject(code: string, message: string, id: string, dependencyChain?: readonly string[]): never {
    const generation = this.#generation
    this.#record("rejected", id, generation, message)
    throw new CapabilityComponentError(code, message, id, dependencyChain)
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
    return { ...state, manifest: { ...state.manifest, ...(state.manifest.dependencies ? { dependencies: normalizeDependencies(state.manifest.dependencies) } : {}) } }
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
