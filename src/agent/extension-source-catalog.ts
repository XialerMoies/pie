import { createHash } from "node:crypto"
import { readFile } from "node:fs/promises"
import { dirname, isAbsolute, relative, resolve, sep } from "node:path"
import {
  componentPackageManifestFingerprint,
  normalizeCapabilityComponentPackageManifest,
  type CapabilityComponentPackageCompatibilityContext,
  type CapabilityComponentPackageManifest,
} from "./component-package.js"
import { ExtensionSourceError, type ExtensionSourceRecord } from "./extension-source-store.js"

export const EXTENSION_SOURCE_INDEX_SCHEMA_VERSION = 1 as const

export interface ExtensionSourceIndexVersion {
  version: string
  manifestPath: string
  manifestDigest: string
  manifestFingerprint: string
}

export interface ExtensionSourceIndexPackage {
  packageId: string
  displayName?: string
  publisher?: string
  versions: ExtensionSourceIndexVersion[]
}

export interface ExtensionSourceIndex {
  schemaVersion: typeof EXTENSION_SOURCE_INDEX_SCHEMA_VERSION
  sourceId: string
  packages: ExtensionSourceIndexPackage[]
}

export interface ExtensionSourceCatalogPackageVersion {
  sourceId: string
  packageId: string
  displayName: string
  publisher?: string
  version: string
  manifestPath: string
  manifestDigest: string
  manifestFingerprint: string
  manifest: Readonly<CapabilityComponentPackageManifest>
}

const ID_PATTERN = /^[a-z0-9][a-z0-9._-]*$/u
const VERSION_PATTERN = /^\d+(?:\.\d+){0,2}$/u
const SHA256_PATTERN = /^[a-f\d]{64}$/iu

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ExtensionSourceError("invalid_source_index", `${label} must be an object`)
  return value as Record<string, unknown>
}

function text(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new ExtensionSourceError("invalid_source_index", `${label} must be a non-empty string`)
  return value.trim()
}

function safeRelativePath(value: unknown, label: string): string {
  const path = text(value, label).replaceAll("\\", "/").replace(/^\.\/+/u, "")
  if (!path || path.startsWith("/") || /^[a-z]:/iu.test(path) || path.split("/").some((part) => !part || part === "." || part === "..")) {
    throw new ExtensionSourceError("unsafe_manifest_path", `${label} must be a safe relative path`)
  }
  return path
}

function pathInside(root: string, candidate: string): boolean {
  const difference = relative(root, candidate)
  return difference === "" || (!difference.startsWith(`..${sep}`) && difference !== ".." && !isAbsolute(difference))
}

function sha256(raw: string): string {
  return createHash("sha256").update(raw).digest("hex")
}

function normalizeIndex(input: unknown, source: ExtensionSourceRecord): ExtensionSourceIndex {
  const index = object(input, "extension source index")
  if (index.schemaVersion !== EXTENSION_SOURCE_INDEX_SCHEMA_VERSION) throw new ExtensionSourceError("unsupported_source_index", `Unsupported extension source index schemaVersion: ${String(index.schemaVersion)}`)
  if (text(index.sourceId, "sourceId") !== source.id) throw new ExtensionSourceError("source_id_mismatch", `Extension source index belongs to ${String(index.sourceId)}, not ${source.id}`)
  if (!Array.isArray(index.packages)) throw new ExtensionSourceError("invalid_source_index", "packages must be an array")
  const packageIds = new Set<string>()
  const packages = index.packages.map((entry, packageIndex) => {
    const packageEntry = object(entry, `packages[${packageIndex}]`)
    const packageId = text(packageEntry.packageId, `packages[${packageIndex}].packageId`)
    if (!ID_PATTERN.test(packageId) || packageIds.has(packageId)) throw new ExtensionSourceError("invalid_source_index", `packages[${packageIndex}].packageId must be unique and stable`)
    packageIds.add(packageId)
    const displayName = packageEntry.displayName === undefined ? undefined : text(packageEntry.displayName, `packages[${packageIndex}].displayName`)
    const publisher = packageEntry.publisher === undefined ? undefined : text(packageEntry.publisher, `packages[${packageIndex}].publisher`)
    if (!Array.isArray(packageEntry.versions) || packageEntry.versions.length === 0) throw new ExtensionSourceError("invalid_source_index", `packages[${packageIndex}].versions must be a non-empty array`)
    const versions = new Set<string>()
    const normalizedVersions = packageEntry.versions.map((value, versionIndex) => {
      const entry = object(value, `packages[${packageIndex}].versions[${versionIndex}]`)
      const version = text(entry.version, `packages[${packageIndex}].versions[${versionIndex}].version`)
      if (!VERSION_PATTERN.test(version) || versions.has(version)) throw new ExtensionSourceError("invalid_source_index", `packages[${packageIndex}].versions[${versionIndex}].version must be unique and exact`)
      versions.add(version)
      const manifestPath = safeRelativePath(entry.manifestPath, `packages[${packageIndex}].versions[${versionIndex}].manifestPath`)
      const manifestDigest = text(entry.manifestDigest, `packages[${packageIndex}].versions[${versionIndex}].manifestDigest`).toLowerCase()
      const manifestFingerprint = text(entry.manifestFingerprint, `packages[${packageIndex}].versions[${versionIndex}].manifestFingerprint`).toLowerCase()
      if (!SHA256_PATTERN.test(manifestDigest) || !SHA256_PATTERN.test(manifestFingerprint)) throw new ExtensionSourceError("invalid_source_index", "Manifest digest and fingerprint must be SHA-256 hex values")
      return { version, manifestPath, manifestDigest, manifestFingerprint }
    })
    return { packageId, ...(displayName ? { displayName } : {}), ...(publisher ? { publisher } : {}), versions: normalizedVersions }
  })
  return { schemaVersion: EXTENSION_SOURCE_INDEX_SCHEMA_VERSION, sourceId: source.id, packages }
}

/** Reads declarative local source indexes. It never imports package entries. */
export class ExtensionSourceCatalog {
  readonly #compatibility: CapabilityComponentPackageCompatibilityContext

  constructor(compatibility: CapabilityComponentPackageCompatibilityContext) {
    this.#compatibility = compatibility
  }

  async list(source: ExtensionSourceRecord): Promise<ExtensionSourceCatalogPackageVersion[]> {
    const indexPath = resolve(source.indexPath)
    let rawIndex: string
    try {
      rawIndex = await readFile(indexPath, "utf8")
    } catch (error) {
      throw new ExtensionSourceError("source_index_unreadable", `Cannot read extension source index: ${error instanceof Error ? error.message : String(error)}`)
    }
    let index: ExtensionSourceIndex
    try {
      index = normalizeIndex(JSON.parse(rawIndex), source)
    } catch (error) {
      if (error instanceof ExtensionSourceError) throw error
      throw new ExtensionSourceError("invalid_source_index", `Extension source index is not valid JSON: ${error instanceof Error ? error.message : String(error)}`)
    }
    const root = dirname(indexPath)
    const entries: ExtensionSourceCatalogPackageVersion[] = []
    for (const packageEntry of index.packages) for (const version of packageEntry.versions) {
      const manifestPath = resolve(root, version.manifestPath)
      if (!pathInside(root, manifestPath)) throw new ExtensionSourceError("unsafe_manifest_path", `Manifest path escapes source directory: ${version.manifestPath}`)
      let rawManifest: string
      try {
        rawManifest = await readFile(manifestPath, "utf8")
      } catch (error) {
        throw new ExtensionSourceError("manifest_unreadable", `Cannot read ${version.manifestPath}: ${error instanceof Error ? error.message : String(error)}`)
      }
      if (sha256(rawManifest) !== version.manifestDigest) throw new ExtensionSourceError("manifest_digest_mismatch", `Manifest digest mismatch: ${packageEntry.packageId}@${version.version}`)
      let manifest: Readonly<CapabilityComponentPackageManifest>
      try {
        manifest = normalizeCapabilityComponentPackageManifest(JSON.parse(rawManifest), this.#compatibility)
      } catch (error) {
        throw new ExtensionSourceError("invalid_package_manifest", `Invalid manifest ${packageEntry.packageId}@${version.version}: ${error instanceof Error ? error.message : String(error)}`)
      }
      if (manifest.packageId !== packageEntry.packageId || manifest.packageVersion !== version.version) throw new ExtensionSourceError("manifest_identity_mismatch", `Manifest identity does not match index: ${packageEntry.packageId}@${version.version}`)
      if (componentPackageManifestFingerprint(manifest) !== version.manifestFingerprint) throw new ExtensionSourceError("manifest_fingerprint_mismatch", `Manifest fingerprint mismatch: ${packageEntry.packageId}@${version.version}`)
      entries.push(Object.freeze({
        sourceId: source.id,
        packageId: packageEntry.packageId,
        displayName: packageEntry.displayName || manifest.component.displayName || packageEntry.packageId,
        ...(packageEntry.publisher || manifest.component.publisher ? { publisher: packageEntry.publisher || manifest.component.publisher } : {}),
        version: version.version,
        manifestPath,
        manifestDigest: version.manifestDigest,
        manifestFingerprint: version.manifestFingerprint,
        manifest,
      }))
    }
    return entries.sort((left, right) => left.packageId.localeCompare(right.packageId) || left.version.localeCompare(right.version))
  }

  async find(source: ExtensionSourceRecord, packageId: string, version: string): Promise<ExtensionSourceCatalogPackageVersion> {
    const entry = (await this.list(source)).find((candidate) => candidate.packageId === packageId && candidate.version === version)
    if (!entry) throw new ExtensionSourceError("source_package_not_found", `Package version not found in source ${source.id}: ${packageId}@${version}`)
    return entry
  }
}
