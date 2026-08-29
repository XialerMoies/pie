import { createHash } from "node:crypto"
import { readLockedJson, updateLockedJson } from "../data/locked-json-store.js"
import {
  failedReplacementChecks,
  HIGH_RISK_REPLACEMENT_GROUPS,
  CORE_REPLACEMENT_GROUPS,
  type RequiredComponentGenerationRef,
  type RequiredComponentLease,
  type RequiredComponentProviderBinding,
  type RequiredReplacementContext,
  type RequiredReplacementOptions,
  type RequiredReplacementResult,
} from "./capability-component-replacement.js"
import { assertRequiredProviderContract, type RequiredCapability } from "./capability-contracts.js"

export const CAPABILITY_COMPONENT_SCHEMA_VERSION = 1 as const
export const CAPABILITY_COMPONENT_SESSION_CUSTOM_TYPE = "my-code-agent.capability-components"

export type CapabilityComponentKind = "required" | "optional"
export type CapabilityComponentSource = "builtin" | "workspace" | "user" | "mcp"
export type CapabilityComponentHealth = "unknown" | "healthy" | "broken" | "unavailable"
export type CapabilityComponentStatus = "active" | "disabled" | "untrusted" | "unhealthy"
/** Product-facing ownership. This is deliberately separate from source/kind. */
export type CapabilityComponentProductClass = "system" | "native" | "third-party" | "mcp"
export type CapabilityComponentHostSurface = "runtime" | "desktop" | "agent" | "server" | "mcp-service"

export interface CapabilityComponentDependency {
  id: string
  /** Optional semver-like range (for example ^1.2.0, ~1.4.0 or >=2). */
  version?: string
  /** Optional dependencies do not prevent activation when absent. */
  optional?: boolean
  /** If set, the provider must expose this capability. */
  capability?: string
}

export interface RequiredComponentContract {
  version: string
  permissionBoundary: "host" | "sandboxed"
  resourceProfile: string
}

export interface CapabilityComponentManifest {
  schemaVersion?: typeof CAPABILITY_COMPONENT_SCHEMA_VERSION
  id: string
  version: string
  kind: CapabilityComponentKind
  capability: string
  replacementGroup?: string
  requiredContract?: RequiredComponentContract
  dependencies?: readonly (string | CapabilityComponentDependency)[]
  /** Parent component for host-managed child components. */
  parentId?: string
  /** Provider package that owns this component's implementation. */
  providedBy?: string
  source?: CapabilityComponentSource
  /** Explicit product classification used by the component manager UI. */
  productClass?: CapabilityComponentProductClass
  /** Explicit host/function ownership used for the second-level grouping. */
  hostSurface?: CapabilityComponentHostSurface
  /** User-facing component name. The stable id remains internal. */
  displayName?: string
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
  | "replacement_preflight"
  | "replacement_committed"
  | "replacement_rolled_back"
  | "disposed"
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
  productClass?: CapabilityComponentProductClass
  hostSurface?: CapabilityComponentHostSurface
  displayName?: string
  trusted: boolean
  enabled: boolean
  health: CapabilityComponentHealth
  description?: string
}

export interface RequiredProviderHealthResult {
  status: "healthy" | "degraded" | "broken" | "unavailable"
  reason?: string
}

export interface RequiredProviderLifecycle {
  health?: (signal: AbortSignal) => RequiredProviderHealthResult | Promise<RequiredProviderHealthResult>
  dispose?: () => void | Promise<void>
}

export interface CapabilityComponentStateDocument {
  schemaVersion: typeof CAPABILITY_COMPONENT_SCHEMA_VERSION
  generation?: number
  requiredProviders?: Record<string, string>
  rollbackProviders?: Record<string, string>
  /** First-party packages available in the app distribution but explicitly uninstalled by the user. */
  uninstalledFirstPartyPackages?: string[]
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
    ...(manifest.kind === "required" ? { requiredContract: { ...(manifest.requiredContract || { version: "1", permissionBoundary: "host", resourceProfile: "default" }) } } : {}),
    ...(dependencies.length ? { dependencies } : {}),
    ...(manifest.parentId ? { parentId: manifest.parentId } : {}),
    ...(manifest.providedBy ? { providedBy: manifest.providedBy } : {}),
    source: manifest.source || "workspace",
    ...(manifest.productClass ? { productClass: manifest.productClass } : {}),
    ...(manifest.hostSurface ? { hostSurface: manifest.hostSurface } : {}),
    ...(manifest.displayName ? { displayName: manifest.displayName } : {}),
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

export function validateCapabilityComponentManifest(input: CapabilityComponentManifest): Readonly<CapabilityComponentManifest> {
  const id = String(input.id || "").trim()
  if (!/^[a-z0-9][a-z0-9._-]*$/u.test(id)) throw new CapabilityComponentError("invalid_manifest", `Invalid component id: ${id || "(empty)"}`, id)
  if (!String(input.version || "").trim()) throw new CapabilityComponentError("invalid_manifest", `Component ${id} must declare a version`, id)
  if (input.kind !== "required" && input.kind !== "optional") throw new CapabilityComponentError("invalid_manifest", `Component ${id} has invalid kind`, id)
  if (!String(input.capability || "").trim()) throw new CapabilityComponentError("invalid_manifest", `Component ${id} must declare a capability`, id)
  if (input.kind === "required" && !String(input.replacementGroup || "").trim()) {
    throw new CapabilityComponentError("invalid_manifest", `Required component ${id} must declare replacementGroup`, id)
  }
  if (input.kind === "required" && input.requiredContract) {
    if (!String(input.requiredContract.version || "").trim()
      || !["host", "sandboxed"].includes(input.requiredContract.permissionBoundary)
      || !String(input.requiredContract.resourceProfile || "").trim()) {
      throw new CapabilityComponentError("invalid_manifest", `Required component ${id} has an invalid host contract`, id)
    }
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
  const productClass = input.productClass
  if (productClass !== undefined && !["system", "native", "third-party", "mcp"].includes(productClass)) {
    throw new CapabilityComponentError("invalid_manifest", `Component ${id} has an invalid productClass`, id)
  }
  const hostSurface = input.hostSurface
  if (hostSurface !== undefined && !["runtime", "desktop", "agent", "server", "mcp-service"].includes(hostSurface)) {
    throw new CapabilityComponentError("invalid_manifest", `Component ${id} has an invalid hostSurface`, id)
  }
  const effectiveSource = input.source || "workspace"
  if (productClass === "system" && input.kind !== "required") {
    throw new CapabilityComponentError("invalid_manifest", `System component ${id} must be required`, id)
  }
  if (productClass === "system" && effectiveSource !== "builtin") {
    throw new CapabilityComponentError("invalid_manifest", `System component ${id} must come from builtin`, id)
  }
  if (input.kind === "required" && productClass && productClass !== "system") {
    throw new CapabilityComponentError("invalid_manifest", `Required component ${id} must belong to system`, id)
  }
  if (productClass === "native" && effectiveSource !== "builtin") {
    throw new CapabilityComponentError("invalid_manifest", `Native component ${id} must come from builtin`, id)
  }
  if (productClass === "third-party" && !["workspace", "user"].includes(effectiveSource)) {
    throw new CapabilityComponentError("invalid_manifest", `Third-party component ${id} must come from workspace or user`, id)
  }
  if (productClass === "mcp" && input.source !== "mcp") {
    throw new CapabilityComponentError("invalid_manifest", `MCP component ${id} must declare source=mcp`, id)
  }
  if (input.source === "mcp" && productClass && productClass !== "mcp") {
    throw new CapabilityComponentError("invalid_manifest", `MCP source component ${id} must belong to mcp`, id)
  }
  if (hostSurface === "runtime" && productClass && productClass !== "system") {
    throw new CapabilityComponentError("invalid_manifest", `Runtime component ${id} must belong to system`, id)
  }
  if (["desktop", "agent", "server"].includes(hostSurface || "") && productClass && !["native", "third-party"].includes(productClass)) {
    throw new CapabilityComponentError("invalid_manifest", `Product component ${id} must be native or third-party`, id)
  }
  if (hostSurface === "mcp-service" && productClass !== "mcp") {
    throw new CapabilityComponentError("invalid_manifest", `MCP surface component ${id} must belong to mcp`, id)
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

async function runBoundedStage<T>(label: string, timeoutMs: number, operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const boundedTimeout = Number.isFinite(timeoutMs) ? Math.max(1, Math.min(300_000, Math.floor(timeoutMs))) : 30_000
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      operation(controller.signal),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort(new Error(`${label} timed out`))
          reject(new Error(`${label} timed out after ${boundedTimeout}ms`))
        }, boundedTimeout)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

type ComponentSessionEntryLike = { type?: unknown; customType?: unknown; data?: unknown }
type ComponentSessionManagerLike = { appendCustomEntry(customType: string, data?: unknown): unknown }

function cloneRequiredRef(ref: RequiredComponentGenerationRef): RequiredComponentGenerationRef {
  return Object.freeze({ generation: ref.generation, providers: Object.freeze({ ...ref.providers }) })
}

export function readCapabilityComponentGeneration(entries: readonly ComponentSessionEntryLike[]): RequiredComponentGenerationRef | undefined {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index]
    if (entry?.type !== "custom" || entry.customType !== CAPABILITY_COMPONENT_SESSION_CUSTOM_TYPE || !entry.data || typeof entry.data !== "object") continue
    const data = entry.data as { generation?: unknown; providers?: unknown }
    if (!Number.isSafeInteger(data.generation) || Number(data.generation) < 0 || !data.providers || typeof data.providers !== "object" || Array.isArray(data.providers)) continue
    const providers: Record<string, string> = {}
    for (const [group, id] of Object.entries(data.providers as Record<string, unknown>)) {
      if (/^[a-z0-9][a-z0-9._-]*$/u.test(group) && typeof id === "string" && /^[a-z0-9][a-z0-9._-]*$/u.test(id)) providers[group] = id
    }
    if (Object.keys(providers).length !== Object.keys(data.providers as Record<string, unknown>).length) continue
    return cloneRequiredRef({ generation: Number(data.generation), providers })
  }
  return undefined
}

export function persistCapabilityComponentGeneration(manager: ComponentSessionManagerLike, ref: RequiredComponentGenerationRef): void {
  manager.appendCustomEntry(CAPABILITY_COMPONENT_SESSION_CUSTOM_TYPE, cloneRequiredRef(ref))
}

/**
 * Small in-process component registry. It is deliberately not a plugin
 * loader: registration is declarative, and execution remains owned by the
 * existing ToolPool, Profile and MCP hosts.
 */
export class CapabilityComponentManager {
  readonly #components = new Map<string, CapabilityComponentState>()
  readonly #events: CapabilityComponentLifecycleEvent[] = []
  readonly #uninstalledFirstPartyPackages = new Set<string>()
  readonly #requiredProviders = new Map<string, string>()
  readonly #rollbackProviders = new Map<string, string>()
  readonly #providerReferences = new Map<string, number>()
  readonly #requiredProviderBindings = new Map<string, unknown>()
  readonly #disposingRequiredProviders = new Set<string>()
  readonly #legacyReplacementGroups = new Set<string>()
  #generation = 0
  #replacementTail: Promise<void> = Promise.resolve()

  constructor(manifests: readonly CapabilityComponentManifest[] = []) {
    for (const manifest of manifests) {
      if (manifest.replacementGroup && !CORE_REPLACEMENT_GROUPS.has(manifest.replacementGroup)) this.#legacyReplacementGroups.add(manifest.replacementGroup)
    }
    for (const manifest of manifests) this.register(manifest)
  }

  register(manifest: CapabilityComponentManifest, options: RegisterComponentOptions = {}): CapabilityComponentState {
    const normalized = validateCapabilityComponentManifest(manifest)
    if (this.#components.has(normalized.id)) throw new CapabilityComponentError("duplicate_component", `Component already registered: ${normalized.id}`, normalized.id)
    this.#assertNoDependencyCycle(normalized)
    const trusted = options.trusted ?? normalized.source === "builtin"
    const replacementGroup = normalized.replacementGroup
    const enabled = options.enabled ?? (normalized.kind === "required" && trusted && !!replacementGroup && !this.#requiredProviders.has(replacementGroup))
    const health = options.health ?? (normalized.source === "builtin" ? "healthy" : "unknown")
    if (enabled && !trusted) throw new CapabilityComponentError("untrusted_component", `Cannot enable untrusted component: ${normalized.id}`, normalized.id)
    if (enabled && normalized.kind === "required" && replacementGroup && this.#requiredProviders.has(replacementGroup)) {
      throw new CapabilityComponentError("replacement_conflict", `Required provider already active for ${replacementGroup}: ${this.#requiredProviders.get(replacementGroup)}`, normalized.id)
    }
    if (enabled) {
      const missing = this.#dependencyFailures(normalized)
      if (missing.length > 0) throw new CapabilityComponentError("missing_dependency", `Component ${normalized.id} requires healthy dependencies: ${missing.map((dependency) => dependency.id).join(", ")}`, normalized.id, [normalized.id, ...missing.map((dependency) => dependency.id)])
    }
    const state = this.#publish({ manifest: normalized, trusted, enabled, health }, "registered")
    if (normalized.kind === "optional" && normalized.source === "builtin" && normalized.providedBy) {
      this.#uninstalledFirstPartyPackages.delete(normalized.providedBy)
    }
    if (enabled && normalized.kind === "required" && replacementGroup) this.#requiredProviders.set(replacementGroup, normalized.id)
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

  requiredGeneration(): RequiredComponentGenerationRef {
    return cloneRequiredRef({ generation: this.#generation, providers: Object.fromEntries([...this.#requiredProviders].sort(([left], [right]) => left.localeCompare(right))) })
  }

  /** Bind a host-owned implementation to one immutable required-provider id. */
  bindRequiredProvider<T>(id: string, implementation: T): RequiredComponentProviderBinding<T> {
    const state = this.#requireMutable(id)
    if (state.manifest.kind !== "required" || !state.manifest.replacementGroup) {
      return this.#reject("invalid_replacement", `Component is not a required provider: ${id}`, id)
    }
    if ((typeof implementation !== "object" || implementation === null) && typeof implementation !== "function") {
      return this.#reject("invalid_provider_binding", `Required provider implementation is invalid: ${id}`, id)
    }
    const contractByGroup: Partial<Record<string, RequiredCapability>> = {
      "agent-engine": "agent-engine",
      "session-store": "session-store",
      permission: "permission-evaluator",
      "security-parser": "security-parser",
      "mcp-host": "mcp-host-integration",
    }
    const capability = contractByGroup[state.manifest.replacementGroup]
    if (capability) {
      try {
        assertRequiredProviderContract(capability, implementation)
      } catch (error) {
        return this.#reject(
          "invalid_provider_binding",
          `Required provider ${id} does not satisfy ${capability}: ${error instanceof Error ? error.message : String(error)}`,
          id,
        )
      }
    }
    const existing = this.#requiredProviderBindings.get(id)
    if (existing !== undefined && existing !== implementation) {
      return this.#reject("provider_binding_conflict", `Required provider implementation is already bound: ${id}`, id)
    }
    this.#requiredProviderBindings.set(id, implementation)
    return Object.freeze({ componentId: id, replacementGroup: state.manifest.replacementGroup, implementation })
  }

  hasRequiredProviderBinding(id: string): boolean {
    return this.#requiredProviderBindings.has(String(id || "").trim())
  }

  /** Resolve a bound provider for a group, optionally pinned to a session id. */
  getRequiredProviderBinding<T = unknown>(replacementGroup: string, componentId?: string): RequiredComponentProviderBinding<T> {
    const group = String(replacementGroup || "").trim()
    const id = componentId || this.#requiredProviders.get(group)
    if (!id) throw new CapabilityComponentError("missing_required_provider", `No active required provider for: ${group}`, group)
    const state = this.#components.get(id)
    if (!state || state.manifest.kind !== "required" || state.manifest.replacementGroup !== group) {
      throw new CapabilityComponentError("invalid_required_provider", `Provider is not registered for ${group}: ${id}`, id)
    }
    const implementation = this.#requiredProviderBindings.get(id)
    if (implementation === undefined) {
      throw new CapabilityComponentError("unbound_required_provider", `Required provider has no runtime binding for ${group}: ${id}`, id, [group, id])
    }
    return Object.freeze({ componentId: id, replacementGroup: group, implementation: implementation as T })
  }

  activeRequiredProvider(replacementGroup: string): CapabilityComponentState {
    const group = String(replacementGroup || "").trim()
    const id = this.#requiredProviders.get(group)
    if (!id) throw new CapabilityComponentError("missing_required_provider", `No active required provider for: ${group}`, group)
    const state = this.require(id)
    if (!this.#isOperational(id)) throw new CapabilityComponentError("unhealthy_component", `Active required provider is unavailable for ${group}: ${id}`, id)
    return state
  }

  /** Pin the required-provider set for one session. Retired providers remain resolvable until release. */
  acquireRequiredLease(requested: RequiredComponentGenerationRef = this.requiredGeneration()): RequiredComponentLease {
    // Ignore provider ids from pre-R3 persisted sessions when their component
    // no longer exists. Core slots are merged from the current host baseline.
    const retained = Object.entries(requested.providers)
      .filter(([group, id]) => CORE_REPLACEMENT_GROUPS.has(group) || this.#components.has(id))
    const ref = cloneRequiredRef({
      generation: requested.generation,
      providers: { ...this.requiredGeneration().providers, ...Object.fromEntries(retained) },
    })
    for (const [group, id] of Object.entries(ref.providers)) {
      const state = this.#components.get(id)
      if (!state || state.manifest.kind !== "required" || state.manifest.replacementGroup !== group || !state.trusted || state.health !== "healthy"
        || this.#disposingRequiredProviders.has(id)) {
        throw new CapabilityComponentError("unavailable_component_generation", `Required provider is unavailable for ${group}: ${id}`, id, [group, id])
      }
    }
    for (const id of Object.values(ref.providers)) this.#providerReferences.set(id, (this.#providerReferences.get(id) || 0) + 1)
    let released = false
    return Object.freeze({
      ref,
      resolve: (replacementGroup: string): string => {
        const id = ref.providers[String(replacementGroup || "").trim()]
        if (!id) throw new CapabilityComponentError("missing_required_provider", `Lease has no required provider for: ${replacementGroup}`, String(replacementGroup || ""))
        return id
      },
      resolveBinding: <T = unknown>(replacementGroup: string): RequiredComponentProviderBinding<T> => {
        const group = String(replacementGroup || "").trim()
        const id = ref.providers[group]
        if (!id) throw new CapabilityComponentError("missing_required_provider", `Lease has no required provider for: ${replacementGroup}`, group)
        const implementation = this.#requiredProviderBindings.get(id)
        if (implementation === undefined) {
          throw new CapabilityComponentError("unbound_required_provider", `Required provider has no runtime binding for ${group}: ${id}`, id, [group, id])
        }
        return Object.freeze({ componentId: id, replacementGroup: group, implementation: implementation as T })
      },
      release: (): void => {
        if (released) return
        released = true
        for (const id of Object.values(ref.providers)) {
          const next = Math.max(0, (this.#providerReferences.get(id) || 0) - 1)
          if (next === 0) this.#providerReferences.delete(id)
          else this.#providerReferences.set(id, next)
        }
      },
    })
  }

  providerReferenceCount(id: string): number { return this.#providerReferences.get(String(id || "").trim()) || 0 }

  replaceRequired(currentId: string, candidateId: string, options: RequiredReplacementOptions): Promise<RequiredReplacementResult> {
    return this.#enqueueReplacement(() => this.#replaceRequired(currentId, candidateId, options))
  }

  async disposeRetiredRequired(id: string, dispose?: (state: CapabilityComponentState) => Promise<void> | void): Promise<CapabilityComponentState> {
    const state = this.#requireMutable(id)
    const group = state.manifest.replacementGroup
    if (state.manifest.kind !== "required" || !group) return this.#reject("invalid_replacement", `Component is not a required provider: ${id}`, id)
    if (this.#requiredProviders.get(group) === id || state.enabled) return this.#reject("active_required_component", `Cannot dispose active required provider: ${id}`, id)
    const references = this.providerReferenceCount(id)
    if (references > 0) return this.#reject("component_in_use", `Required provider ${id} still has ${references} session reference(s)`, id)
    if (this.#disposingRequiredProviders.has(id)) return this.#reject("component_disposing", `Required provider is already being disposed: ${id}`, id)
    const providerDispose = (this.#requiredProviderBindings.get(id) as RequiredProviderLifecycle | undefined)?.dispose
    const disposeImplementation = dispose || (providerDispose ? () => providerDispose() : undefined)
    if (!disposeImplementation) return this.#reject("dispose_unavailable", `Required provider has no dispose lifecycle: ${id}`, id)
    this.#disposingRequiredProviders.add(id)
    try {
      await disposeImplementation(this.#cloneState(state))
      this.#components.delete(id)
      this.#requiredProviderBindings.delete(id)
      if (this.#rollbackProviders.get(group) === id) this.#rollbackProviders.delete(group)
      this.#record("disposed", id, this.#generation, `replacement group: ${group}`)
      return this.#cloneState(state)
    } finally {
      this.#disposingRequiredProviders.delete(id)
    }
  }

  /** Run the provider health probe and mirror its result into component state. */
  async healthCheckRequired(id: string, options: { timeoutMs?: number } = {}): Promise<CapabilityComponentState> {
    const state = this.#requireMutable(id)
    if (state.manifest.kind !== "required") return this.#reject("invalid_replacement", `Component is not a required provider: ${id}`, id)
    const implementation = this.#requiredProviderBindings.get(id) as RequiredProviderLifecycle | undefined
    if (!implementation?.health) return this.#cloneState(state)
    try {
      const result = await runBoundedStage("required provider health check", options.timeoutMs ?? 10_000, (signal) => Promise.resolve(implementation.health!(signal)))
      const health = result.status === "healthy" ? "healthy" : result.status === "broken" ? "broken" : "unavailable"
      if (state.health === health) return this.#cloneState(state)
      return this.setHealth(id, health)
    } catch (error) {
      return this.setHealth(id, "unavailable")
    }
  }

  /** Roll a required group back to its remembered provider or builtin baseline. */
  rollbackRequired(replacementGroup: string): CapabilityComponentState {
    const group = String(replacementGroup || "").trim()
    const currentId = this.#requiredProviders.get(group)
    if (!currentId) return this.#reject("missing_required_provider", `No active required provider for: ${group}`, group)
    const current = this.#requireMutable(currentId)
    if (this.providerReferenceCount(currentId) > 0) return this.#reject("component_in_use", `Required provider ${currentId} still has session references`, currentId)
    const targetId = this.#rollbackProviders.get(group)
      || this.list().find((candidate) => candidate.manifest.kind === "required"
        && candidate.manifest.replacementGroup === group
        && candidate.manifest.source === "builtin"
        && candidate.manifest.id !== currentId
        && candidate.trusted
        && candidate.health === "healthy")?.manifest.id
    if (!targetId) return this.#reject("required_component", `Required component has no healthy rollback provider: ${group}`, currentId)
    const target = this.#requireMutable(targetId)
    if (!this.#requiredProviderBindings.has(targetId) && this.#requiredProviderBindings.has(currentId)) {
      return this.#reject("unbound_replacement", `Required rollback provider has no runtime binding: ${targetId}`, targetId)
    }
    this.#publishRequiredSwap(current, target, "replacement_rolled_back", "manual recovery")
    this.#rollbackProviders.delete(group)
    return this.#cloneState(target)
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
    const changed = this.#publish({ ...current, health }, "health_changed")
    const group = current.manifest.kind === "required" ? current.manifest.replacementGroup : undefined
    if (group && health !== "healthy" && this.#requiredProviders.get(group) === id) {
      const fallbackId = this.#rollbackProviders.get(group)
      const fallback = fallbackId ? this.#components.get(fallbackId) : undefined
      if (fallback && fallback.trusted && fallback.health === "healthy") {
        this.#publishRequiredSwap(this.#requireMutable(id), fallback, "replacement_rolled_back", `health changed to ${health}`)
      }
    }
    return changed
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
      ...(options.productClass || existing?.manifest.productClass ? { productClass: options.productClass || existing?.manifest.productClass } : {}),
      ...(options.hostSurface || existing?.manifest.hostSurface ? { hostSurface: options.hostSurface || existing?.manifest.hostSurface } : {}),
      ...(options.displayName || existing?.manifest.displayName ? { displayName: options.displayName || existing?.manifest.displayName } : {}),
      ...(options.description || existing?.manifest.description ? { description: options.description || existing?.manifest.description } : {}),
    }
    if (!existing) return this.register(manifest, options)
    const normalized = validateCapabilityComponentManifest(manifest)
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
      generation: this.#generation,
      requiredProviders: { ...this.requiredGeneration().providers },
      rollbackProviders: Object.fromEntries(this.#rollbackProviders),
      uninstalledFirstPartyPackages: [...this.#uninstalledFirstPartyPackages].sort(),
      components: this.persistedState().filter((state) => state.manifest.source !== "builtin"
        || (state.manifest.kind === "optional" && !!state.manifest.providedBy)),
    }
    await updateLockedJson<CapabilityComponentStateDocument>(filePath, () => ({ schemaVersion: CAPABILITY_COMPONENT_SCHEMA_VERSION, components: [] }), () => document, { recoverInvalidJson: true, space: 2 })
  }

  async restore(filePath: string): Promise<void> {
    const document = await readLockedJson<CapabilityComponentStateDocument>(filePath, () => ({ schemaVersion: CAPABILITY_COMPONENT_SCHEMA_VERSION, components: [] }), { recoverInvalidJson: true })
    if (!document || document.schemaVersion !== CAPABILITY_COMPONENT_SCHEMA_VERSION || !Array.isArray(document.components)) return
    if (Number.isSafeInteger(document.generation) && Number(document.generation) > this.#generation) this.#generation = Number(document.generation)
    this.#uninstalledFirstPartyPackages.clear()
    for (const packageId of document.uninstalledFirstPartyPackages || []) {
      if (typeof packageId === "string" && /^[a-z0-9][a-z0-9._-]*$/u.test(packageId)) this.#uninstalledFirstPartyPackages.add(packageId)
    }
    for (const state of this.list()) {
      if (state.manifest.kind === "optional" && state.manifest.source === "builtin" && state.manifest.providedBy
        && this.#uninstalledFirstPartyPackages.has(state.manifest.providedBy)) {
        this.#components.delete(state.manifest.id)
        this.#record("uninstalled", state.manifest.id, ++this.#generation, "restored first-party uninstall")
      }
    }
    const restored: Array<{ id: string; enabled: boolean; kind: CapabilityComponentKind }> = []
    for (const entry of document.components) {
      try {
        const manifest = validateCapabilityComponentManifest(entry.manifest)
        if (manifest.source === "builtin") {
          if (manifest.kind !== "optional" || !manifest.providedBy || this.#uninstalledFirstPartyPackages.has(manifest.providedBy)) continue
          // First-party code must still be provided by this application version.
          if (!this.#components.has(manifest.id)) continue
        }
        const existing = this.#components.get(manifest.id)
        if (existing) this.#publish({ manifest, trusted: entry.trusted === true, enabled: false, health: entry.health }, "health_changed", "restored")
        else this.register(manifest, { trusted: entry.trusted === true, enabled: false, health: entry.health })
        restored.push({ id: manifest.id, enabled: entry.enabled === true && entry.trusted === true, kind: manifest.kind })
      } catch {
        // Corrupt optional records are ignored; the host remains fail-closed.
      }
    }
    for (const [group, targetId] of Object.entries(document.requiredProviders || {})) {
      try {
        const currentId = this.#requiredProviders.get(group)
        const current = currentId ? this.#requireMutable(currentId) : undefined
        const target = this.#requireMutable(targetId)
        if (!current || current.manifest.id === target.manifest.id) continue
        if (target.manifest.kind !== "required" || target.manifest.replacementGroup !== group
          || target.manifest.capability !== current.manifest.capability || !target.trusted || target.health !== "healthy"
          || JSON.stringify(target.manifest.requiredContract) !== JSON.stringify(current.manifest.requiredContract)) continue
        if (this.#requiredProviderBindings.has(current.manifest.id) !== this.#requiredProviderBindings.has(target.manifest.id)) continue
        this.#publishRequiredSwap(current, target, "replacement_committed", "restored")
        const rollbackId = document.rollbackProviders?.[group]
        if (rollbackId && this.#components.has(rollbackId)) this.#rollbackProviders.set(group, rollbackId)
      } catch { /* Invalid required-provider records remain on the built-in provider. */ }
    }
    for (const entry of restored.filter((candidate) => candidate.enabled && candidate.kind === "optional")) {
      try { this.enableTree(entry.id) } catch { /* Invalid dependency graphs remain disabled. */ }
    }
  }

  /** Agent-facing projection: active capabilities only, without management state. */
  agentProjection(): Array<{ id: string; capability: string; version: string }> {
    return this.list().filter((state) => state.status === "active" && this.#isOperational(state.manifest.id)).map((state) => ({ id: state.manifest.id, capability: state.manifest.capability, version: state.manifest.version }))
  }

  /** Allows shipped-package seeding to preserve an explicit user uninstall. */
  isFirstPartyPackageUninstalled(packageId: string): boolean {
    return this.#uninstalledFirstPartyPackages.has(String(packageId || "").trim())
  }

  uninstall(id: string): CapabilityComponentState {
    const current = this.#requireMutable(id)
    const dependents = this.#enabledDependents(id)
    if (dependents.length > 0) return this.#rejectDependencyInUse(id, dependents)
    if (current.manifest.kind === "required") {
      const references = this.providerReferenceCount(id)
      if (references > 0) return this.#reject("component_in_use", `Required provider ${id} still has ${references} session reference(s)`, id)
      const replacement = this.list().find((candidate) => candidate.manifest.id !== current.manifest.id
        && candidate.manifest.replacementGroup === current.manifest.replacementGroup
        && candidate.manifest.capability === current.manifest.capability
        && candidate.trusted && candidate.enabled && candidate.health === "healthy")
      if (!replacement) return this.#reject("required_component", `Required component has no healthy replacement: ${id}`, id)
    }
    this.#components.delete(current.manifest.id)
    if (current.manifest.kind === "optional" && current.manifest.source === "builtin" && current.manifest.providedBy) {
      this.#uninstalledFirstPartyPackages.add(current.manifest.providedBy)
    }
    this.#requiredProviderBindings.delete(current.manifest.id)
    if (current.manifest.replacementGroup && this.#rollbackProviders.get(current.manifest.replacementGroup) === current.manifest.id) this.#rollbackProviders.delete(current.manifest.replacementGroup)
    this.#record("uninstalled", current.manifest.id, current.generation)
    return current
  }

  events(): CapabilityComponentLifecycleEvent[] { return this.#events.map((event) => ({ ...event })) }

  catalog(): {
    schemaVersion: typeof CAPABILITY_COMPONENT_SCHEMA_VERSION
    generation: number
    components: CapabilityComponentState[]
    requiredProviders: Record<string, string>
    providerReferences: Record<string, number>
    boundRequiredProviders: string[]
    uninstalledFirstPartyPackages: string[]
    fingerprint: string
  } {
    const components = this.list()
    const requiredProviders = Object.fromEntries([...this.#requiredProviders].sort(([left], [right]) => left.localeCompare(right)))
    const providerReferences = Object.fromEntries([...this.#providerReferences].sort(([left], [right]) => left.localeCompare(right)))
    const boundRequiredProviders = [...this.#requiredProviderBindings.keys()].sort()
    const uninstalledFirstPartyPackages = [...this.#uninstalledFirstPartyPackages].sort()
    const payload = { schemaVersion: CAPABILITY_COMPONENT_SCHEMA_VERSION, generation: this.#generation, components, requiredProviders, providerReferences, boundRequiredProviders, uninstalledFirstPartyPackages }
    return { ...payload, fingerprint: createHash("sha256").update(JSON.stringify(payload)).digest("hex") }
  }

  #enqueueReplacement<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#replacementTail.then(operation, operation)
    this.#replacementTail = result.then(() => undefined, () => undefined)
    return result
  }

  async #replaceRequired(currentId: string, candidateId: string, options: RequiredReplacementOptions): Promise<RequiredReplacementResult> {
    const current = this.#requireMutable(currentId)
    const candidate = this.#requireMutable(candidateId)
    const group = current.manifest.replacementGroup
    if (!group || (!CORE_REPLACEMENT_GROUPS.has(group) && !this.#legacyReplacementGroups.has(group))) {
      return this.#reject("core_replacement_only", `Only core replacement slots may be replaced: ${group}`, currentId)
    }
    if (current.manifest.kind !== "required" || candidate.manifest.kind !== "required" || !group
      || candidate.manifest.replacementGroup !== group || candidate.manifest.capability !== current.manifest.capability) {
      return this.#reject("incompatible_replacement", `Required replacement contract mismatch: ${currentId} -> ${candidateId}`, candidateId, [currentId, candidateId])
    }
    if (this.#requiredProviders.get(group) !== currentId || !current.enabled) {
      return this.#reject("stale_replacement", `Required provider is no longer active for ${group}: ${currentId}`, currentId)
    }
    if (candidate.enabled) return this.#reject("replacement_conflict", `Replacement candidate is already active: ${candidateId}`, candidateId)
    if (this.#disposingRequiredProviders.has(currentId) || this.#disposingRequiredProviders.has(candidateId)) {
      return this.#reject("component_disposing", `Required replacement provider is being disposed: ${currentId} -> ${candidateId}`, candidateId, [currentId, candidateId])
    }
    if (!candidate.trusted) return this.#reject("untrusted_component", `Cannot activate untrusted replacement: ${candidateId}`, candidateId)
    if (candidate.health !== "healthy") return this.#reject("unhealthy_component", `Cannot activate unhealthy replacement: ${candidateId}`, candidateId)
    const hasRuntimeBinding = this.#requiredProviderBindings.has(currentId)
    if (hasRuntimeBinding !== this.#requiredProviderBindings.has(candidateId)) {
      return this.#reject("unbound_replacement", `Required runtime binding mismatch: ${currentId} -> ${candidateId}`, candidateId, [currentId, candidateId])
    }
    if (hasRuntimeBinding && !options.verify) {
      return this.#reject("replacement_verification_required", `Post-switch verification is required for runtime-bound provider: ${candidateId}`, candidateId)
    }
    if (JSON.stringify(candidate.manifest.requiredContract) !== JSON.stringify(current.manifest.requiredContract)) {
      return this.#reject("incompatible_replacement", `Required host contract mismatch: ${currentId} -> ${candidateId}`, candidateId, [currentId, candidateId])
    }
    const missing = this.#dependencyFailures(candidate.manifest)
    if (missing.length > 0) return this.#reject("missing_dependency", `Replacement ${candidateId} has unavailable dependencies: ${missing.map((dependency) => dependency.id).join(", ")}`, candidateId)
    if (this.#dependsOn(candidateId, currentId)) return this.#reject("incompatible_replacement", `Replacement ${candidateId} depends on the retiring provider ${currentId}`, candidateId, [candidateId, currentId])
    const dependents = this.#enabledDependents(currentId).filter((state) => state.manifest.id !== candidateId)
    if (dependents.length > 0) return this.#rejectDependencyInUse(currentId, dependents)
    if (HIGH_RISK_REPLACEMENT_GROUPS.has(group) && options.approved !== true) {
      return this.#reject("replacement_approval_required", `User approval is required to replace ${group}`, candidateId)
    }

    const context: Omit<RequiredReplacementContext, "signal"> = { currentId, candidateId, replacementGroup: group, capability: current.manifest.capability }
    const currentGeneration = current.generation
    const candidateGeneration = candidate.generation
    this.#record("replacement_preflight", candidateId, this.#generation, `replacing ${currentId}`)
    let preflight
    try {
      preflight = await runBoundedStage("replacement preflight", options.preflightTimeoutMs ?? 30_000, (signal) => options.preflight({ ...context, signal }))
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      return this.#reject("replacement_preflight_failed", `Replacement preflight failed: ${reason}`, candidateId)
    }
    const failedChecks = failedReplacementChecks(preflight)
    if (failedChecks.length > 0) return this.#reject("replacement_preflight_failed", `Replacement preflight checks failed: ${failedChecks.join(", ")}`, candidateId)
    if (this.#requiredProviders.get(group) !== currentId
      || this.#components.get(currentId)?.generation !== currentGeneration
      || this.#components.get(candidateId)?.generation !== candidateGeneration) {
      return this.#reject("stale_replacement", `Required replacement changed during preflight: ${currentId} -> ${candidateId}`, candidateId)
    }

    try {
      await runBoundedStage("replacement state migration", options.migrationTimeoutMs ?? 30_000, (signal) => options.migrateState?.({ ...context, signal }) ?? Promise.resolve())
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      return this.#reject("replacement_migration_failed", `Replacement state migration failed: ${reason}`, candidateId)
    }

    const committedGeneration = this.#publishRequiredSwap(current, candidate, "replacement_committed")
    try {
      await options.persist?.(this.requiredGeneration())
      if (options.verify) {
        await runBoundedStage("replacement verification", options.verificationTimeoutMs ?? 30_000, (signal) => options.verify!({ ...context, signal, generation: committedGeneration }))
      }
      if (this.#requiredProviders.get(group) !== candidateId) {
        let reason = "replacement changed during verification"
        try { await options.persist?.(this.requiredGeneration()) } catch (persistError) {
          reason += `; rollback persistence failed: ${persistError instanceof Error ? persistError.message : String(persistError)}`
        }
        return { status: "rolled_back", replacementGroup: group, previousId: candidateId, activeId: this.#requiredProviders.get(group) || currentId, generation: this.#generation, preflight, reason }
      }
      return { status: "committed", replacementGroup: group, previousId: currentId, activeId: candidateId, generation: committedGeneration, preflight }
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      const rolledBackGeneration = this.#requiredProviders.get(group) === candidateId
        ? this.#publishRequiredSwap(this.#requireMutable(candidateId), this.#requireMutable(currentId), "replacement_rolled_back", reason)
        : this.#generation
      let rollbackReason = reason
      try { await options.persist?.(this.requiredGeneration()) } catch (rollbackError) {
        rollbackReason += `; rollback persistence failed: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`
      }
      return { status: "rolled_back", replacementGroup: group, previousId: candidateId, activeId: this.#requiredProviders.get(group) || currentId, generation: rolledBackGeneration, preflight, reason: rollbackReason }
    }
  }

  #publishRequiredSwap(current: CapabilityComponentState, candidate: CapabilityComponentState, action: "replacement_committed" | "replacement_rolled_back", reason?: string): number {
    const group = current.manifest.replacementGroup!
    const generation = ++this.#generation
    const retired = Object.freeze({ ...current, enabled: false, generation, status: "disabled" as const })
    const active = Object.freeze({ ...candidate, enabled: true, generation, status: "active" as const })
    this.#components.set(current.manifest.id, retired)
    this.#components.set(candidate.manifest.id, active)
    this.#requiredProviders.set(group, candidate.manifest.id)
    if (action === "replacement_committed") this.#rollbackProviders.set(group, current.manifest.id)
    else this.#rollbackProviders.delete(group)
    this.#record(action, candidate.manifest.id, generation, `${current.manifest.id} -> ${candidate.manifest.id}${reason ? `: ${reason}` : ""}`)
    return generation
  }

  #dependsOn(componentId: string, dependencyId: string, visited = new Set<string>()): boolean {
    if (visited.has(componentId)) return false
    visited.add(componentId)
    const state = this.#components.get(componentId)
    if (!state) return false
    return effectiveDependencies(state.manifest).some((dependency) => dependency.id === dependencyId || this.#dependsOn(dependency.id, dependencyId, visited))
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
    return { ...state, manifest: { ...state.manifest, ...(state.manifest.requiredContract ? { requiredContract: { ...state.manifest.requiredContract } } : {}), ...(state.manifest.dependencies ? { dependencies: normalizeDependencies(state.manifest.dependencies) } : {}) } }
  }
}

export const REQUIRED_COMPONENT_MANIFESTS: readonly CapabilityComponentManifest[] = Object.freeze([
  { id: "agent-engine", version: "1", kind: "required", capability: "agent-engine", replacementGroup: "agent-engine", source: "builtin", productClass: "system", hostSurface: "runtime", description: "Session-scoped AgentEngine factory and adapter ownership" },
  { id: "session-store", version: "1", kind: "required", capability: "session-store", replacementGroup: "session-store", source: "builtin", productClass: "system", hostSurface: "runtime" },
  { id: "model-router", version: "1", kind: "required", capability: "model-router", replacementGroup: "model-router", source: "builtin", productClass: "system", hostSurface: "runtime" },
])

export const capabilityComponentManager = new CapabilityComponentManager(REQUIRED_COMPONENT_MANIFESTS)

export function componentManifestFingerprint(manifest: CapabilityComponentManifest): string { return fingerprint(manifest) }
