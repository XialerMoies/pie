/**
 * 用户可安装扩展的最小声明。
 *
 * This is intentionally independent from CapabilityComponentManifest.  The
 * latter remains an internal compatibility model for host replacement and
 * lifecycle state; an extension manifest describes only an installable
 * contribution and never carries product classification fields.
 */
import { normalizeExtensionSettingSchemas, type ExtensionSettingSchema } from "./extension-settings.js"

export const EXTENSION_MANIFEST_SCHEMA_VERSION = 1 as const

export type ExtensionContributionType =
  | "agent-tool"
  | "desktop-ui"
  | "desktop-language-service"
  | "server-route"
  | "model-adapter"

export type ExtensionPermission = "read" | "write" | "create" | "remove" | "network" | "subprocess" | "secrets"

export interface ExtensionManifestPermissions {
  readonly capabilities: readonly ExtensionPermission[]
}

export interface ExtensionManifestCompatibility {
  readonly host: string
  readonly contract: string
}

export interface ExtensionAgentConfig {
  readonly timeoutMs?: number
  readonly maxConcurrent?: number
}

export interface ExtensionManifest {
  readonly schemaVersion: typeof EXTENSION_MANIFEST_SCHEMA_VERSION
  readonly id: string
  readonly version: string
  readonly contributions: readonly ExtensionContributionType[]
  readonly permissions: ExtensionManifestPermissions
  readonly compatibility: ExtensionManifestCompatibility
  /** Human-readable title shown in extension management surfaces. */
  readonly displayName?: string
  /** Publisher/author shown to users; informational only. */
  readonly publisher?: string
  /** Safe host sprite reference, HTTPS URL, or base64 image data URI. */
  readonly icon?: string
  /** Defaults/ceilings used when the Agent invokes this contribution. */
  readonly agentConfig?: ExtensionAgentConfig
  /** Declarative non-secret settings rendered and persisted by the host. */
  readonly settings?: readonly ExtensionSettingSchema[]
  readonly entry?: string
  readonly source?: "builtin" | "workspace" | "user" | "registry"
}

const HOST_RESERVED_EXTENSION_IDS = new Set([
  "desktop.chat",
  "desktop.layout",
  "desktop.shell",
  "permission.core",
  "security.core",
])

/** A product extension may contribute features, but never replace host policy. */
export function isExtensionEligible(manifest: Pick<ExtensionManifest, "id" | "contributions" | "source">): boolean {
  if (HOST_RESERVED_EXTENSION_IDS.has(manifest.id)) return false
  const external = manifest.source !== undefined && manifest.source !== "builtin"
  if (external && manifest.contributions.some((item) => item === "server-route" || item === "model-adapter")) return false
  return true
}

export function assertExtensionEligible(manifest: Pick<ExtensionManifest, "id" | "contributions" | "source">): void {
  if (!isExtensionEligible(manifest)) throw new Error(`Extension is not eligible for this host surface: ${manifest.id}`)
}

const ID_PATTERN = /^[a-z0-9][a-z0-9._-]*$/u
const VERSION_PATTERN = /^\d+(?:\.\d+){0,2}$/u
const RANGE_PATTERN = /^(?:\*|\d+(?:\.\d+){0,2}|[~^]\d+(?:\.\d+){0,2}|>=\s*\d+(?:\.\d+){0,2})$/u
const ICON_REFERENCE_PATTERN = /^(?:#[a-z][a-z0-9_-]*|https:\/\/[^\s]+|data:image\/(?:svg\+xml|png|jpeg|webp);base64,[a-z0-9+/=]+)$/iu
const CONTRIBUTIONS = new Set<ExtensionContributionType>([
  "agent-tool",
  "desktop-ui",
  "desktop-language-service",
  "server-route",
  "model-adapter",
])
const PERMISSIONS = new Set<ExtensionPermission>([
  "read", "write", "create", "remove", "network", "subprocess", "secrets",
])

function text(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be a non-empty string`)
  return value.trim()
}

function safeRelativePath(value: unknown, label: string): string {
  const path = text(value, label).replaceAll("\\", "/").replace(/^\.\/+/, "")
  if (!path || path.startsWith("/") || /^[a-z]:/iu.test(path) || path.split("/").some((part) => !part || part === "." || part === "..")) {
    throw new Error(`${label} must be a safe relative path`)
  }
  return path
}

function versionRange(value: unknown, label: string): string {
  const result = text(value, label)
  if (!RANGE_PATTERN.test(result)) throw new Error(`${label} must be a supported version range`)
  return result
}

/** Validate and normalize an extension without loading its entry. */
export function normalizeExtensionManifest(input: unknown): Readonly<ExtensionManifest> {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("extension manifest must be an object")
  const value = input as Record<string, unknown>
  if (value.schemaVersion !== EXTENSION_MANIFEST_SCHEMA_VERSION) throw new Error("extension manifest has an unsupported schemaVersion")
  const id = text(value.id, "id")
  if (!ID_PATTERN.test(id)) throw new Error("id must be a stable identifier")
  const version = text(value.version, "version")
  if (!VERSION_PATTERN.test(version)) throw new Error("version must be an exact numeric version")
  if (!Array.isArray(value.contributions) || value.contributions.length === 0) throw new Error("contributions must not be empty")
  const contributions = [...new Set(value.contributions.map((item) => text(item, "contribution") as ExtensionContributionType))]
  if (contributions.some((item) => !CONTRIBUTIONS.has(item))) throw new Error("contributions contains an unsupported type")
  const permissionsValue = value.permissions
  if (!permissionsValue || typeof permissionsValue !== "object" || Array.isArray(permissionsValue)) throw new Error("permissions must be an object")
  const rawPermissions = (permissionsValue as Record<string, unknown>).capabilities
  if (!Array.isArray(rawPermissions)) throw new Error("permissions.capabilities must be an array")
  const permissions = [...new Set(rawPermissions.map((item) => text(item, "permission") as ExtensionPermission))]
  if (permissions.some((item) => !PERMISSIONS.has(item))) throw new Error("permissions contains an unsupported capability")
  const compatibilityValue = value.compatibility
  if (!compatibilityValue || typeof compatibilityValue !== "object" || Array.isArray(compatibilityValue)) throw new Error("compatibility must be an object")
  const compatibility = compatibilityValue as Record<string, unknown>
  const source = value.source === undefined ? undefined : text(value.source, "source") as ExtensionManifest["source"]
  const displayName = value.displayName === undefined ? undefined : text(value.displayName, "displayName")
  const publisher = value.publisher === undefined ? undefined : text(value.publisher, "publisher")
  const icon = value.icon === undefined ? undefined : text(value.icon, "icon")
  const agentConfig = value.agentConfig === undefined ? undefined : value.agentConfig as ExtensionAgentConfig
  const settings = normalizeExtensionSettingSchemas(value.settings)
  if (icon !== undefined && (icon.length > 512 || !ICON_REFERENCE_PATTERN.test(icon))) throw new Error("icon must be a safe sprite reference, HTTPS URL, or base64 image")
  if (agentConfig !== undefined && (!agentConfig || typeof agentConfig !== "object" || Array.isArray(agentConfig))) throw new Error("agentConfig must be an object")
  if (agentConfig?.timeoutMs !== undefined && (!Number.isSafeInteger(agentConfig.timeoutMs) || agentConfig.timeoutMs < 100 || agentConfig.timeoutMs > 3_600_000)) throw new Error("agentConfig.timeoutMs must be between 100 and 3600000")
  if (agentConfig?.maxConcurrent !== undefined && (!Number.isSafeInteger(agentConfig.maxConcurrent) || agentConfig.maxConcurrent < 1 || agentConfig.maxConcurrent > 30)) throw new Error("agentConfig.maxConcurrent must be between 1 and 30")
  if (source !== undefined && !["builtin", "workspace", "user", "registry"].includes(source)) throw new Error("source is unsupported")
  const normalized = Object.freeze({
    schemaVersion: EXTENSION_MANIFEST_SCHEMA_VERSION,
    id,
    version,
    contributions: Object.freeze(contributions.sort()),
    permissions: Object.freeze({ capabilities: Object.freeze(permissions.sort()) }),
    compatibility: Object.freeze({ host: versionRange(compatibility.host, "compatibility.host"), contract: versionRange(compatibility.contract, "compatibility.contract") }),
    ...(displayName ? { displayName } : {}),
    ...(publisher ? { publisher } : {}),
    ...(icon ? { icon } : {}),
    ...(agentConfig ? { agentConfig: Object.freeze({ ...(agentConfig.timeoutMs === undefined ? {} : { timeoutMs: agentConfig.timeoutMs }), ...(agentConfig.maxConcurrent === undefined ? {} : { maxConcurrent: agentConfig.maxConcurrent }) }) } : {}),
    ...(settings.length ? { settings } : {}),
    ...(value.entry === undefined ? {} : { entry: safeRelativePath(value.entry, "entry") }),
    ...(source === undefined ? {} : { source }),
  })
  assertExtensionEligible(normalized)
  return normalized
}

export const validateExtensionManifest = normalizeExtensionManifest

/** Convert a legacy package declaration to the product-facing extension shape. */
export function extensionManifestFromPackage(input: {
  packageId: string
  packageVersion: string
  entry?: string
  source?: "builtin" | "workspace" | "user" | "registry"
  component: { id: string; version: string; capability: string; displayName?: string; publisher?: string; icon?: string; agentConfig?: ExtensionAgentConfig; settings?: readonly ExtensionSettingSchema[] }
  permissions: { filesystem: readonly string[]; network: boolean | readonly string[]; subprocess: boolean; secrets: readonly string[] }
  compatibility: { host: string; contract: string }
  displayName?: string
  publisher?: string
  icon?: string
  agentConfig?: ExtensionAgentConfig
}): Readonly<ExtensionManifest> {
  const capability = input.component.capability
  const contribution: ExtensionContributionType = capability === "desktop.ui-pane"
    ? "desktop-ui"
    : capability === "desktop.language-service"
      ? "desktop-language-service"
      : capability === "server.route"
        ? "server-route"
        : capability === "model-adapter"
          ? "model-adapter"
          : "agent-tool"
  const filesystem = input.permissions.filesystem.map((item) => item as ExtensionPermission)
  const permissions = [
    ...filesystem,
    ...(input.permissions.network ? ["network" as const] : []),
    ...(input.permissions.subprocess ? ["subprocess" as const] : []),
    ...(input.permissions.secrets.length > 0 ? ["secrets" as const] : []),
  ]
  return normalizeExtensionManifest({
    schemaVersion: EXTENSION_MANIFEST_SCHEMA_VERSION,
    id: input.packageId,
    version: input.packageVersion,
    contributions: [contribution],
    permissions: { capabilities: permissions },
    compatibility: input.compatibility,
    ...(input.component.displayName ? { displayName: input.component.displayName } : {}),
    ...(input.component.publisher ? { publisher: input.component.publisher } : {}),
    ...(input.component.icon ? { icon: input.component.icon } : {}),
    ...(input.component.agentConfig ? { agentConfig: input.component.agentConfig } : {}),
    ...(input.component.settings?.length ? { settings: input.component.settings } : {}),
    ...(input.displayName ? { displayName: input.displayName } : {}),
    ...(input.publisher ? { publisher: input.publisher } : {}),
    ...(input.icon ? { icon: input.icon } : {}),
    ...(input.agentConfig ? { agentConfig: input.agentConfig } : {}),
    ...(input.entry === undefined ? {} : { entry: input.entry }),
    ...(input.source === undefined ? {} : { source: input.source }),
  })
}
