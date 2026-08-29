import { createHash } from "node:crypto"
import {
  CapabilityComponentError,
  type CapabilityComponentManager,
  validateCapabilityComponentManifest,
  type CapabilityComponentManifest,
  type CapabilityComponentSource,
} from "./capability-components.js"

/** Package metadata is a declaration boundary, not a plugin loader. */
export const CAPABILITY_COMPONENT_PACKAGE_SCHEMA_VERSION = 1 as const

export type CapabilityComponentPackageSourceKind = CapabilityComponentSource | "registry"
export type CapabilityComponentPackageIsolationMode = "in-process" | "worker" | "process"
export type CapabilityComponentPackagePermission = "read" | "write" | "create" | "remove"

export interface CapabilityComponentPackageSource {
  kind: CapabilityComponentPackageSourceKind
  origin?: string
  /** SHA-256 digest of the installed package or immutable source artifact. */
  digest?: string
}

export interface CapabilityComponentPackageSignature {
  /** `ed25519` is reserved for cryptographic verification; this layer only validates shape. */
  algorithm: "ed25519" | "sha256"
  value: string
  keyId?: string
}

export interface CapabilityComponentPackageCompatibility {
  /** Semver-like host range understood by the host contract. */
  host: string
  contract: string
  engine?: string
}

export interface CapabilityComponentPackagePermissions {
  /** Declarations are audited inputs; they do not grant the package access. */
  network: boolean | readonly string[]
  filesystem: readonly CapabilityComponentPackagePermission[]
  subprocess: boolean
  secrets: readonly string[]
}

export interface CapabilityComponentPackageResources {
  maxMemoryMb: number
  maxCpuMs?: number
  maxNetworkRequests?: number
  maxFileBytes?: number
}

export interface CapabilityComponentPackageIsolation {
  mode: CapabilityComponentPackageIsolationMode
  /** Relative directory below the host-managed component install root. */
  installRoot: string
  /** Relative entry path allowed by the host; never an arbitrary absolute path. */
  allowedEntry: string
}

export interface CapabilityComponentPackageManifest {
  schemaVersion: typeof CAPABILITY_COMPONENT_PACKAGE_SCHEMA_VERSION
  packageId: string
  packageVersion: string
  component: CapabilityComponentManifest
  entry?: string
  source: CapabilityComponentPackageSource
  signature?: CapabilityComponentPackageSignature
  compatibility: CapabilityComponentPackageCompatibility
  permissions: CapabilityComponentPackagePermissions
  resources: CapabilityComponentPackageResources
  isolation: CapabilityComponentPackageIsolation
}

export interface CapabilityComponentPackageCompatibilityContext {
  hostVersion: string
  contractVersion: string
  engineVersion?: string
}

export const CAPABILITY_COMPONENT_PACKAGE_RESOURCE_LIMITS = Object.freeze({
  maxMemoryMb: 4096,
  maxCpuMs: 300_000,
  maxNetworkRequests: 10_000,
  maxFileBytes: 1_073_741_824,
})

/** A machine-readable contract for package manifests; validation remains in TypeScript. */
export const CAPABILITY_COMPONENT_PACKAGE_SCHEMA = Object.freeze({
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  required: ["schemaVersion", "packageId", "packageVersion", "component", "source", "compatibility", "permissions", "resources", "isolation"],
  properties: {
    schemaVersion: { const: CAPABILITY_COMPONENT_PACKAGE_SCHEMA_VERSION },
    packageId: { type: "string", pattern: "^[a-z0-9][a-z0-9._-]*$" },
    packageVersion: { type: "string", pattern: "^[0-9]+(?:\\.[0-9]+){0,2}$" },
    entry: { type: "string" },
    source: { type: "object" },
    signature: { type: "object" },
    compatibility: { type: "object" },
    permissions: { type: "object" },
    resources: { type: "object" },
    isolation: { type: "object" },
  },
} as const)

export class CapabilityComponentPackageError extends Error {
  readonly code: string
  constructor(code: string, message: string) {
    super(message)
    this.name = "CapabilityComponentPackageError"
    this.code = code
  }
}

const ID_PATTERN = /^[a-z0-9][a-z0-9._-]*$/u
const VERSION_PATTERN = /^\d+(?:\.\d+){0,2}$/u
const DIGEST_PATTERN = /^[a-f\d]{64}$/iu
const RANGE_PATTERN = /^(?:\*|\d+(?:\.\d+){0,2}|[~^]\d+(?:\.\d+){0,2}|>=\s*\d+(?:\.\d+){0,2})$/u
const SECRET_PATTERN = /^[a-z0-9][a-z0-9._:-]*$/iu
const PACKAGE_SOURCE_KINDS = new Set<CapabilityComponentPackageSourceKind>(["builtin", "workspace", "user", "mcp", "registry"])
const FILESYSTEM_PERMISSIONS = new Set<CapabilityComponentPackagePermission>(["read", "write", "create", "remove"])

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new CapabilityComponentPackageError("invalid_manifest", `${label} must be an object`)
  return value as Record<string, unknown>
}

function text(value: unknown, label: string, required = true): string | undefined {
  if (value === undefined && !required) return undefined
  if (typeof value !== "string" || !value.trim()) throw new CapabilityComponentPackageError("invalid_manifest", `${label} must be a non-empty string`)
  return value.trim()
}

function exactVersion(value: unknown, label: string): string {
  const normalized = text(value, label)!
  if (!VERSION_PATTERN.test(normalized)) throw new CapabilityComponentPackageError("invalid_version", `${label} must be an exact numeric version`)
  return normalized
}

function versionRange(value: unknown, label: string): string {
  const normalized = text(value, label)!
  if (!RANGE_PATTERN.test(normalized)) throw new CapabilityComponentPackageError("invalid_compatibility", `${label} is not a supported version range`)
  return normalized
}

function normalizedRelativePath(value: unknown, label: string): string {
  const raw = text(value, label)!.replaceAll("\\", "/").replace(/^\.\/+/, "")
  if (!raw || raw === "." || raw.startsWith("/") || /^[a-z]:/iu.test(raw) || raw.split("/").some((part) => !part || part === "." || part === "..")) {
    throw new CapabilityComponentPackageError("invalid_isolation", `${label} must be a safe relative path`)
  }
  return raw
}

function stringList(value: unknown, label: string, pattern: RegExp = ID_PATTERN): string[] {
  if (!Array.isArray(value)) throw new CapabilityComponentPackageError("invalid_manifest", `${label} must be an array`)
  const result = value.map((item) => text(item, `${label} entry`)!).map((item) => item.trim())
  if (result.some((item) => !pattern.test(item))) throw new CapabilityComponentPackageError("invalid_manifest", `${label} contains an invalid entry`)
  if (new Set(result).size !== result.length) throw new CapabilityComponentPackageError("invalid_manifest", `${label} contains duplicates`)
  return result.sort((left, right) => left.localeCompare(right))
}

function boundedPositiveInteger(value: unknown, label: string, maximum: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0 || value > maximum) {
    throw new CapabilityComponentPackageError("invalid_resources", `${label} must be a positive integer no greater than ${maximum}`)
  }
  return value
}

function versionParts(version: string): [number, number, number] {
  const parts = version.split(".").map((part) => Number.parseInt(part, 10) || 0)
  return [parts[0] || 0, parts[1] || 0, parts[2] || 0]
}

function compareVersions(left: string, right: string): number {
  const a = versionParts(left); const b = versionParts(right)
  for (let index = 0; index < 3; index += 1) if (a[index] !== b[index]) return a[index] - b[index]
  return 0
}

function satisfiesVersion(version: string, range: string): boolean {
  if (range === "*") return true
  const operator = range.startsWith(">=") ? ">=" : range[0] === "^" || range[0] === "~" ? range[0] : ""
  const target = range.replace(/^(?:\^|~|>=)\s*/u, "")
  const comparison = compareVersions(version, target)
  if (operator === ">=") return comparison >= 0
  if (operator === "^") return comparison >= 0 && versionParts(version)[0] === versionParts(target)[0]
  if (operator === "~") {
    const actual = versionParts(version); const expected = versionParts(target)
    return comparison >= 0 && actual[0] === expected[0] && actual[1] === expected[1]
  }
  return comparison === 0
}

function normalizeSource(value: unknown): CapabilityComponentPackageSource {
  const source = record(value, "source")
  const kind = text(source.kind, "source.kind") as CapabilityComponentPackageSourceKind
  if (!PACKAGE_SOURCE_KINDS.has(kind)) throw new CapabilityComponentPackageError("invalid_source", `Unsupported package source: ${kind}`)
  const origin = text(source.origin, "source.origin", true)
  const digest = text(source.digest, "source.digest", false)
  if (kind !== "builtin" && !origin) throw new CapabilityComponentPackageError("invalid_source", "Non-builtin packages must declare source.origin")
  if (digest && !DIGEST_PATTERN.test(digest)) throw new CapabilityComponentPackageError("invalid_source", "source.digest must be a SHA-256 hex digest")
  if (kind !== "builtin" && !digest) throw new CapabilityComponentPackageError("invalid_source", "Non-builtin packages must declare source.digest")
  return { kind, ...(origin ? { origin } : {}), ...(digest ? { digest: digest.toLowerCase() } : {}) }
}

function normalizeSignature(value: unknown, source: CapabilityComponentPackageSource): CapabilityComponentPackageSignature | undefined {
  if (value === undefined) {
    if (source.kind !== "builtin") throw new CapabilityComponentPackageError("missing_signature", "Non-builtin packages must declare a signature")
    return undefined
  }
  const signature = record(value, "signature")
  const algorithm = text(signature.algorithm, "signature.algorithm")
  if (algorithm !== "ed25519" && algorithm !== "sha256") throw new CapabilityComponentPackageError("invalid_signature", `Unsupported signature algorithm: ${algorithm}`)
  const signatureValue = text(signature.value, "signature.value")!
  if (algorithm === "sha256" && !DIGEST_PATTERN.test(signatureValue)) throw new CapabilityComponentPackageError("invalid_signature", "sha256 signature.value must be a hex digest")
  const keyId = text(signature.keyId, "signature.keyId", false)
  if (keyId && !ID_PATTERN.test(keyId)) throw new CapabilityComponentPackageError("invalid_signature", "signature.keyId must be a stable identifier")
  return { algorithm, value: algorithm === "sha256" ? signatureValue.toLowerCase() : signatureValue, ...(keyId ? { keyId } : {}) }
}

function normalizePermissions(value: unknown): CapabilityComponentPackagePermissions {
  const permissions = record(value, "permissions")
  const network = typeof permissions.network === "boolean"
    ? permissions.network
    : stringList(permissions.network, "permissions.network", /^https?:\/\/[^\s]+$/iu)
  const filesystem = stringList(permissions.filesystem, "permissions.filesystem") as CapabilityComponentPackagePermission[]
  if (filesystem.some((permission) => !FILESYSTEM_PERMISSIONS.has(permission))) throw new CapabilityComponentPackageError("invalid_permissions", "permissions.filesystem contains an unsupported operation")
  const subprocess = permissions.subprocess
  if (typeof subprocess !== "boolean") throw new CapabilityComponentPackageError("invalid_permissions", "permissions.subprocess must be boolean")
  const secrets = stringList(permissions.secrets, "permissions.secrets", SECRET_PATTERN)
  return { network, filesystem, subprocess, secrets }
}

function normalizeResources(value: unknown): CapabilityComponentPackageResources {
  const resources = record(value, "resources")
  return {
    maxMemoryMb: boundedPositiveInteger(resources.maxMemoryMb, "resources.maxMemoryMb", CAPABILITY_COMPONENT_PACKAGE_RESOURCE_LIMITS.maxMemoryMb),
    ...(resources.maxCpuMs === undefined ? {} : { maxCpuMs: boundedPositiveInteger(resources.maxCpuMs, "resources.maxCpuMs", CAPABILITY_COMPONENT_PACKAGE_RESOURCE_LIMITS.maxCpuMs) }),
    ...(resources.maxNetworkRequests === undefined ? {} : { maxNetworkRequests: boundedPositiveInteger(resources.maxNetworkRequests, "resources.maxNetworkRequests", CAPABILITY_COMPONENT_PACKAGE_RESOURCE_LIMITS.maxNetworkRequests) }),
    ...(resources.maxFileBytes === undefined ? {} : { maxFileBytes: boundedPositiveInteger(resources.maxFileBytes, "resources.maxFileBytes", CAPABILITY_COMPONENT_PACKAGE_RESOURCE_LIMITS.maxFileBytes) }),
  }
}

function normalizeIsolation(value: unknown): CapabilityComponentPackageIsolation {
  const isolation = record(value, "isolation")
  const mode = text(isolation.mode, "isolation.mode")
  if (mode !== "in-process" && mode !== "worker" && mode !== "process") throw new CapabilityComponentPackageError("invalid_isolation", `Unsupported isolation mode: ${mode}`)
  return { mode, installRoot: normalizedRelativePath(isolation.installRoot, "isolation.installRoot"), allowedEntry: normalizedRelativePath(isolation.allowedEntry, "isolation.allowedEntry") }
}

function stablePackageManifest(manifest: CapabilityComponentPackageManifest): CapabilityComponentPackageManifest {
  return {
    schemaVersion: CAPABILITY_COMPONENT_PACKAGE_SCHEMA_VERSION,
    packageId: manifest.packageId,
    packageVersion: manifest.packageVersion,
    component: manifest.component,
    ...(manifest.entry ? { entry: manifest.entry } : {}),
    source: manifest.source,
    ...(manifest.signature ? { signature: manifest.signature } : {}),
    compatibility: manifest.compatibility,
    permissions: manifest.permissions,
    resources: manifest.resources,
    isolation: manifest.isolation,
  }
}

/** Normalize and validate a package without registering or enabling its component. */
export function normalizeCapabilityComponentPackageManifest(input: unknown, compatibility?: CapabilityComponentPackageCompatibilityContext): Readonly<CapabilityComponentPackageManifest> {
  const manifest = record(input, "package manifest")
  if (manifest.schemaVersion !== CAPABILITY_COMPONENT_PACKAGE_SCHEMA_VERSION) throw new CapabilityComponentPackageError("unsupported_schema", `Unsupported package schemaVersion: ${String(manifest.schemaVersion)}`)
  const packageId = text(manifest.packageId, "packageId")!
  if (!ID_PATTERN.test(packageId)) throw new CapabilityComponentPackageError("invalid_identity", "packageId must be a stable identifier")
  const packageVersion = exactVersion(manifest.packageVersion, "packageVersion")
  const source = normalizeSource(manifest.source)
  const componentInput = record(manifest.component, "component")
  const componentVersion = exactVersion(componentInput.version, "component.version")
  if (componentVersion !== packageVersion) throw new CapabilityComponentPackageError("identity_mismatch", "component.version must equal packageVersion")
  const providedBy = text(componentInput.providedBy, "component.providedBy", false)
  if (providedBy && providedBy !== packageId) throw new CapabilityComponentPackageError("identity_mismatch", "component.providedBy must equal packageId")
  const componentSource = text(componentInput.source, "component.source", false) as CapabilityComponentSource | undefined
  const expectedComponentSource: CapabilityComponentSource = source.kind === "registry" ? "user" : source.kind
  if (componentSource && !["builtin", "workspace", "user", "mcp"].includes(componentSource)) {
    throw new CapabilityComponentPackageError("identity_mismatch", "component.source is not a supported component source")
  }
  if (componentSource && componentSource !== expectedComponentSource) {
    throw new CapabilityComponentPackageError("identity_mismatch", "component.source must match source.kind")
  }
  const normalizedComponent = validateCapabilityComponentManifest({
    ...componentInput,
    version: componentVersion,
    providedBy: packageId,
    ...(componentSource ? { source: componentSource } : { source: source.kind === "registry" ? "user" : source.kind }),
  } as CapabilityComponentManifest)
  const entry = manifest.entry === undefined ? undefined : normalizedRelativePath(manifest.entry, "entry")
  const compatibilityInput = record(manifest.compatibility, "compatibility")
  const normalizedCompatibility: CapabilityComponentPackageCompatibility = {
    host: versionRange(compatibilityInput.host, "compatibility.host"),
    contract: versionRange(compatibilityInput.contract, "compatibility.contract"),
    ...(compatibilityInput.engine === undefined ? {} : { engine: versionRange(compatibilityInput.engine, "compatibility.engine") }),
  }
  const permissions = normalizePermissions(manifest.permissions)
  const resources = normalizeResources(manifest.resources)
  const isolation = normalizeIsolation(manifest.isolation)
  if (entry && entry !== isolation.allowedEntry) throw new CapabilityComponentPackageError("invalid_isolation", "entry must equal isolation.allowedEntry")
  const signature = normalizeSignature(manifest.signature, source)
  const normalized: CapabilityComponentPackageManifest = {
    schemaVersion: CAPABILITY_COMPONENT_PACKAGE_SCHEMA_VERSION,
    packageId,
    packageVersion,
    component: normalizedComponent,
    ...(entry ? { entry } : {}),
    source,
    ...(signature ? { signature } : {}),
    compatibility: normalizedCompatibility,
    permissions,
    resources,
    isolation,
  }
  const result = Object.freeze(stablePackageManifest(normalized))
  if (compatibility) assertCapabilityComponentPackageCompatible(result, compatibility)
  return result
}

export const validateCapabilityComponentPackageManifest = normalizeCapabilityComponentPackageManifest
export const parseCapabilityComponentPackageManifest = normalizeCapabilityComponentPackageManifest

export function assertCapabilityComponentPackageCompatible(manifest: CapabilityComponentPackageManifest, context: CapabilityComponentPackageCompatibilityContext): void {
  if (!satisfiesVersion(exactVersion(context.hostVersion, "hostVersion"), manifest.compatibility.host)) throw new CapabilityComponentPackageError("incompatible_host", `Package ${manifest.packageId} is incompatible with host ${context.hostVersion}`)
  if (!satisfiesVersion(exactVersion(context.contractVersion, "contractVersion"), manifest.compatibility.contract)) throw new CapabilityComponentPackageError("incompatible_contract", `Package ${manifest.packageId} is incompatible with contract ${context.contractVersion}`)
  if (manifest.compatibility.engine && (!context.engineVersion || !satisfiesVersion(exactVersion(context.engineVersion, "engineVersion"), manifest.compatibility.engine))) throw new CapabilityComponentPackageError("incompatible_engine", `Package ${manifest.packageId} is incompatible with engine ${context.engineVersion || "(missing)"}`)
}

export function componentPackageManifestFingerprint(manifest: CapabilityComponentPackageManifest): string {
  const normalized = normalizeCapabilityComponentPackageManifest(manifest)
  return createHash("sha256").update(JSON.stringify(normalized)).digest("hex")
}

function firstPartyPackageManifest(input: {
  packageId: string
  componentId: string
  entry: string
  description: string
  displayName?: string
  capability?: string
  network?: boolean | readonly string[]
  filesystem?: readonly CapabilityComponentPackagePermission[]
  subprocess?: boolean
  secrets?: readonly string[]
  maxMemoryMb?: number
  maxCpuMs?: number
  maxNetworkRequests?: number
  maxFileBytes?: number
  productClass?: "native" | "mcp"
  hostSurface?: "desktop" | "agent" | "server"
}): Readonly<CapabilityComponentPackageManifest> {
  return normalizeCapabilityComponentPackageManifest({
    schemaVersion: CAPABILITY_COMPONENT_PACKAGE_SCHEMA_VERSION,
    packageId: input.packageId,
    packageVersion: "1.0.0",
    component: {
      schemaVersion: 1,
      id: input.componentId,
      version: "1.0.0",
      kind: "optional",
      capability: input.capability ?? "agent-tool",
      providedBy: input.packageId,
      source: "builtin",
      productClass: input.productClass ?? "native",
      hostSurface: input.hostSurface ?? "agent",
      ...(input.displayName ? { displayName: input.displayName } : {}),
      description: input.description,
    },
    entry: input.entry,
    source: { kind: "builtin", origin: "app://my-code-agent" },
    compatibility: { host: ">=1.0.0", contract: "1", engine: ">=1.0.0" },
    permissions: {
      network: input.network ?? false,
      filesystem: input.filesystem ?? ["read"],
      subprocess: input.subprocess ?? false,
      secrets: input.secrets ?? [],
    },
    resources: {
      maxMemoryMb: input.maxMemoryMb ?? 128,
      maxCpuMs: input.maxCpuMs ?? 30_000,
      maxNetworkRequests: input.maxNetworkRequests ?? 1,
      maxFileBytes: input.maxFileBytes ?? 16_777_216,
    },
    isolation: { mode: "in-process", installRoot: `first-party/${input.componentId}`, allowedEntry: input.entry },
  })
}

/** First-party native-tool packages are registered by the tool host, not loaded here. */
export const FILE_READ_COMPONENT_PACKAGE_MANIFEST = firstPartyPackageManifest({
  packageId: "my-code-agent.tool.file-read",
  componentId: "tool.file-read",
  entry: "src/agent/tools/file-read.ts",
  description: "First-party bounded workspace file reader",
})

export const EXPLORER_LIST_COMPONENT_PACKAGE_MANIFEST = firstPartyPackageManifest({
  packageId: "my-code-agent.tool.explorer-list",
  componentId: "tool.explorer-list",
  entry: "src/agent/tools/explorer-list.ts",
  description: "First-party workspace directory explorer",
})

export const SEARCH_COMPONENT_PACKAGE_MANIFEST = firstPartyPackageManifest({
  packageId: "my-code-agent.tool.search",
  componentId: "tool.search",
  entry: "src/agent/tools/search.ts",
  description: "First-party bounded workspace search",
})

export const GIT_STATUS_COMPONENT_PACKAGE_MANIFEST = firstPartyPackageManifest({
  packageId: "my-code-agent.tool.git-status",
  componentId: "tool.git-status",
  entry: "src/agent/tools/git-status.ts",
  description: "First-party read-only Git status viewer",
})

export const GIT_LOG_COMPONENT_PACKAGE_MANIFEST = firstPartyPackageManifest({
  packageId: "my-code-agent.tool.git-log",
  componentId: "tool.git-log",
  entry: "src/agent/tools/git-log.ts",
  description: "First-party read-only Git history viewer",
})

export const FILE_OUTLINE_COMPONENT_PACKAGE_MANIFEST = firstPartyPackageManifest({
  packageId: "my-code-agent.tool.file-outline",
  componentId: "tool.file-outline",
  entry: "src/agent/tools/file-outline.ts",
  description: "First-party source file outline extractor",
})

export const WEB_SEARCH_COMPONENT_PACKAGE_MANIFEST = firstPartyPackageManifest({
  packageId: "my-code-agent.tool.web-search",
  componentId: "tool.web-search",
  entry: "src/agent/tools/web-search.ts",
  description: "First-party web search capability",
  network: true,
  secrets: ["provider.apiKey"],
  maxNetworkRequests: 10,
})

export const WEB_FETCH_COMPONENT_PACKAGE_MANIFEST = firstPartyPackageManifest({
  packageId: "my-code-agent.tool.web-fetch",
  componentId: "tool.web-fetch",
  entry: "src/agent/tools/web-fetch.ts",
  description: "First-party bounded web fetch capability",
  network: true,
  maxNetworkRequests: 10,
  maxFileBytes: 524_288,
})

export const WRITE_AGENT_MD_COMPONENT_PACKAGE_MANIFEST = firstPartyPackageManifest({
  packageId: "my-code-agent.tool.write-agent-md",
  componentId: "tool.write-agent-md",
  entry: "src/agent/tools/agent-md.ts",
  description: "First-party workspace AGENT.md writer",
  filesystem: ["read", "write", "create"],
  maxFileBytes: 1_048_576,
})

export const STR_REPLACE_EDITOR_COMPONENT_PACKAGE_MANIFEST = firstPartyPackageManifest({
  packageId: "my-code-agent.tool.str-replace-editor",
  componentId: "tool.str-replace-editor",
  entry: "src/agent/tools/str-replace-editor.ts",
  description: "First-party precise workspace file editor",
  filesystem: ["read", "write"],
  maxFileBytes: 1_048_576,
})

export const FILE_WRITE_COMPONENT_PACKAGE_MANIFEST = firstPartyPackageManifest({
  packageId: "my-code-agent.tool.file-write",
  componentId: "tool.file-write",
  entry: "src/agent/tools/file-write.ts",
  description: "First-party workspace file writer",
  filesystem: ["read", "write", "create"],
  maxFileBytes: 16_777_216,
})

export const MEMORY_COMPONENT_PACKAGE_MANIFEST = firstPartyPackageManifest({
  packageId: "my-code-agent.tool.memory",
  componentId: "tool.memory",
  entry: "src/agent/tools/memory.ts",
  description: "First-party scoped memory tools",
  filesystem: ["read", "write", "create", "remove"],
  maxFileBytes: 16_777_216,
})

export const PLAN_MODE_COMPONENT_PACKAGE_MANIFEST = firstPartyPackageManifest({
  packageId: "my-code-agent.tool.plan-mode",
  componentId: "tool.plan-mode",
  entry: "src/agent/tools/plan-mode.ts",
  description: "First-party planning lifecycle tools",
  filesystem: [],
  maxFileBytes: 1,
})

export const SKILL_FACTS_COMPONENT_PACKAGE_MANIFEST = firstPartyPackageManifest({
  packageId: "my-code-agent.tool.skill-facts",
  componentId: "tool.skill-facts",
  entry: "src/agent/tools/skill-facts.ts",
  description: "First-party skill verification facts tool",
})

export const DELEGATE_TASKS_COMPONENT_PACKAGE_MANIFEST = firstPartyPackageManifest({
  packageId: "my-code-agent.tool.delegate-tasks",
  componentId: "tool.delegate-tasks",
  entry: "src/agent/tools/delegate-tasks.ts",
  description: "First-party sub-agent delegation tool",
  filesystem: ["read"],
  maxMemoryMb: 256,
  maxCpuMs: 120_000,
})

export const COMMAND_COMPONENT_PACKAGE_MANIFEST = firstPartyPackageManifest({
  packageId: "my-code-agent.tool.command",
  componentId: "tool.command",
  entry: "src/agent/tools/command.ts",
  description: "First-party governed shell command tool",
  network: true,
  filesystem: ["read", "write", "create", "remove"],
  subprocess: true,
  maxMemoryMb: 256,
  maxCpuMs: 300_000,
  maxNetworkRequests: 100,
  maxFileBytes: 1_073_741_824,
})

/** UI packages declare shipped contributions; they never load arbitrary renderer code. */
function firstPartyUiPackageManifest(input: {
  packageId: string
  componentId: string
  entry: string
  description: string
  displayName?: string
  capability: "desktop.ui-pane" | "desktop.language-service"
  productClass?: "native"
  hostSurface?: "desktop"
}): Readonly<CapabilityComponentPackageManifest> {
  return firstPartyPackageManifest({
    ...input,
    productClass: input.productClass ?? "native",
    hostSurface: input.hostSurface ?? "desktop",
    filesystem: [],
    maxMemoryMb: 64,
    maxCpuMs: 10_000,
    maxNetworkRequests: 1,
    maxFileBytes: 1,
  })
}

export const SEARCH_PANE_COMPONENT_PACKAGE_MANIFEST = firstPartyUiPackageManifest({
  packageId: "my-code-agent.ui.search-pane",
  componentId: "ui.pane.search",
  entry: "src/frontend/pane/search/index.ts",
  description: "First-party workspace search pane",
  capability: "desktop.ui-pane",
})

export const GIT_PANE_COMPONENT_PACKAGE_MANIFEST = firstPartyUiPackageManifest({
  packageId: "my-code-agent.ui.git-pane",
  componentId: "ui.pane.git",
  entry: "src/frontend/pane/git/index.ts",
  description: "First-party Git pane",
  capability: "desktop.ui-pane",
})

export const PROBLEMS_COMPONENT_PACKAGE_MANIFEST = firstPartyUiPackageManifest({
  packageId: "my-code-agent.ui.problems",
  componentId: "ui.problems",
  entry: "src/frontend/services/problems-store.ts",
  description: "First-party problems status contribution",
  capability: "desktop.ui-pane",
})

export const TYPESCRIPT_LANGUAGE_SERVICE_COMPONENT_PACKAGE_MANIFEST = firstPartyUiPackageManifest({
  packageId: "my-code-agent.language-service.typescript",
  componentId: "language-service.typescript",
  entry: "src/frontend/editor/monaco-setup.ts",
  description: "First-party TypeScript diagnostics service",
  capability: "desktop.language-service",
})

export const FIRST_PARTY_COMPONENT_PACKAGES: readonly Readonly<CapabilityComponentPackageManifest>[] = Object.freeze([
  FILE_READ_COMPONENT_PACKAGE_MANIFEST,
  EXPLORER_LIST_COMPONENT_PACKAGE_MANIFEST,
  SEARCH_COMPONENT_PACKAGE_MANIFEST,
  GIT_STATUS_COMPONENT_PACKAGE_MANIFEST,
  GIT_LOG_COMPONENT_PACKAGE_MANIFEST,
  FILE_OUTLINE_COMPONENT_PACKAGE_MANIFEST,
  WEB_SEARCH_COMPONENT_PACKAGE_MANIFEST,
  WEB_FETCH_COMPONENT_PACKAGE_MANIFEST,
  WRITE_AGENT_MD_COMPONENT_PACKAGE_MANIFEST,
  STR_REPLACE_EDITOR_COMPONENT_PACKAGE_MANIFEST,
  FILE_WRITE_COMPONENT_PACKAGE_MANIFEST,
  MEMORY_COMPONENT_PACKAGE_MANIFEST,
  PLAN_MODE_COMPONENT_PACKAGE_MANIFEST,
  SKILL_FACTS_COMPONENT_PACKAGE_MANIFEST,
  DELEGATE_TASKS_COMPONENT_PACKAGE_MANIFEST,
  COMMAND_COMPONENT_PACKAGE_MANIFEST,
  SEARCH_PANE_COMPONENT_PACKAGE_MANIFEST,
  GIT_PANE_COMPONENT_PACKAGE_MANIFEST,
  PROBLEMS_COMPONENT_PACKAGE_MANIFEST,
  TYPESCRIPT_LANGUAGE_SERVICE_COMPONENT_PACKAGE_MANIFEST,
])

export function firstPartyComponentPackage(packageId: string): Readonly<CapabilityComponentPackageManifest> | undefined {
  const normalizedId = String(packageId || "").trim()
  return FIRST_PARTY_COMPONENT_PACKAGES.find((manifest) => manifest.packageId === normalizedId)
}

/** Resolve a shipped package from its stable component identity. */
export function firstPartyComponentPackageForComponent(componentId: string): Readonly<CapabilityComponentPackageManifest> | undefined {
  const normalizedId = String(componentId || "").trim()
  return FIRST_PARTY_COMPONENT_PACKAGES.find((manifest) => manifest.component.id === normalizedId)
}

/** Safe package facts for desktop catalog and recovery UI. */
export function firstPartyComponentPackageCatalog(): ReadonlyArray<Readonly<Pick<CapabilityComponentPackageManifest, "packageId" | "packageVersion" | "component">>> {
  return FIRST_PARTY_COMPONENT_PACKAGES.map((manifest) => Object.freeze({
    packageId: manifest.packageId,
    packageVersion: manifest.packageVersion,
    component: manifest.component,
  }))
}

/** Seed packages supplied by the application before persisted install state is restored. */
export function registerFirstPartyComponentPackages(manager: CapabilityComponentManager): void {
  for (const manifest of FIRST_PARTY_COMPONENT_PACKAGES) {
    if (!manager.get(manifest.component.id) && !manager.isFirstPartyPackageUninstalled(manifest.packageId)) {
      manager.register(manifest.component, { trusted: true, enabled: true, health: "healthy" })
    }
  }
}

const TOOL_COMPONENT_IDS: Readonly<Record<string, string>> = Object.freeze({
  file_read: FILE_READ_COMPONENT_PACKAGE_MANIFEST.component.id,
  explorer_list: EXPLORER_LIST_COMPONENT_PACKAGE_MANIFEST.component.id,
  search: SEARCH_COMPONENT_PACKAGE_MANIFEST.component.id,
  git_status: GIT_STATUS_COMPONENT_PACKAGE_MANIFEST.component.id,
  git_log: GIT_LOG_COMPONENT_PACKAGE_MANIFEST.component.id,
  file_outline: FILE_OUTLINE_COMPONENT_PACKAGE_MANIFEST.component.id,
  web_search: WEB_SEARCH_COMPONENT_PACKAGE_MANIFEST.component.id,
  "web-search": WEB_SEARCH_COMPONENT_PACKAGE_MANIFEST.component.id,
  web_fetch: WEB_FETCH_COMPONENT_PACKAGE_MANIFEST.component.id,
  "web-fetch": WEB_FETCH_COMPONENT_PACKAGE_MANIFEST.component.id,
  write_agent_md: WRITE_AGENT_MD_COMPONENT_PACKAGE_MANIFEST.component.id,
  str_replace_editor: STR_REPLACE_EDITOR_COMPONENT_PACKAGE_MANIFEST.component.id,
  file_write: FILE_WRITE_COMPONENT_PACKAGE_MANIFEST.component.id,
  read_memory: MEMORY_COMPONENT_PACKAGE_MANIFEST.component.id,
  write_memory: MEMORY_COMPONENT_PACKAGE_MANIFEST.component.id,
  list_memory: MEMORY_COMPONENT_PACKAGE_MANIFEST.component.id,
  delete_memory: MEMORY_COMPONENT_PACKAGE_MANIFEST.component.id,
  set_memory_enabled: MEMORY_COMPONENT_PACKAGE_MANIFEST.component.id,
  enter_plan_mode: PLAN_MODE_COMPONENT_PACKAGE_MANIFEST.component.id,
  exit_plan_mode: PLAN_MODE_COMPONENT_PACKAGE_MANIFEST.component.id,
  skill_facts: SKILL_FACTS_COMPONENT_PACKAGE_MANIFEST.component.id,
  delegate_tasks: DELEGATE_TASKS_COMPONENT_PACKAGE_MANIFEST.component.id,
  command: COMMAND_COMPONENT_PACKAGE_MANIFEST.component.id,
})

export function capabilityComponentIdForTool(name: string): string | undefined {
  return TOOL_COMPONENT_IDS[String(name || "").trim().toLowerCase().replaceAll("-", "_")]
}

export function capabilityComponentPackageForTool(name: string): Readonly<CapabilityComponentPackageManifest> | undefined {
  const componentId = capabilityComponentIdForTool(name)
  return componentId ? FIRST_PARTY_COMPONENT_PACKAGES.find((manifest) => manifest.component.id === componentId) : undefined
}
