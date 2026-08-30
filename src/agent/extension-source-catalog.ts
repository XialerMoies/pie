import { createHash, createPublicKey, verify } from "node:crypto"
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
  signature?: ExtensionSourceIndexSignature
}

export interface ExtensionSourceIndexSignature {
  algorithm: "ed25519"
  keyId: string
  value: string
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
const BASE64_PATTERN = /^(?:[A-Za-z\d+/]{4})*(?:[A-Za-z\d+/]{2}==|[A-Za-z\d+/]{3}=)?$/u

export interface ExtensionSourceCatalogOptions {
  fetch?: typeof globalThis.fetch
  timeoutMs?: number
  maxIndexBytes?: number
}

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

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`
  const record = value as Record<string, unknown>
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(",")}}`
}

/** Canonical bytes signed by an HTTPS source: the complete index except signature. */
export function extensionSourceIndexSigningPayload(input: unknown): Buffer {
  const index = object(input, "extension source index")
  const { signature: _signature, ...unsigned } = index
  return Buffer.from(stableJson(unsigned), "utf8")
}

function normalizeSignature(value: unknown): ExtensionSourceIndexSignature {
  const signature = object(value, "signature")
  if (signature.algorithm !== "ed25519") throw new ExtensionSourceError("invalid_source_signature", "Source index signature.algorithm must be ed25519")
  const keyId = text(signature.keyId, "signature.keyId")
  const encoded = text(signature.value, "signature.value")
  if (!ID_PATTERN.test(keyId) || !BASE64_PATTERN.test(encoded) || Buffer.from(encoded, "base64").length !== 64) {
    throw new ExtensionSourceError("invalid_source_signature", "Source index signature must contain a stable keyId and Ed25519 base64 value")
  }
  return { algorithm: "ed25519", keyId, value: encoded }
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
  const signature = index.signature === undefined ? undefined : normalizeSignature(index.signature)
  if (source.kind === "https") {
    if (!signature) throw new ExtensionSourceError("missing_source_signature", `Remote source ${source.id} must sign its index`)
    if (signature.keyId !== source.keyId) throw new ExtensionSourceError("source_key_mismatch", `Source index keyId does not match ${source.id}`)
  }
  return { schemaVersion: EXTENSION_SOURCE_INDEX_SCHEMA_VERSION, sourceId: source.id, packages, ...(signature ? { signature } : {}) }
}

/** Reads declarative local source indexes. It never imports package entries. */
export class ExtensionSourceCatalog {
  readonly #compatibility: CapabilityComponentPackageCompatibilityContext
  readonly #fetch: typeof globalThis.fetch
  readonly #timeoutMs: number
  readonly #maxIndexBytes: number

  constructor(compatibility: CapabilityComponentPackageCompatibilityContext, options: ExtensionSourceCatalogOptions = {}) {
    this.#compatibility = compatibility
    this.#fetch = options.fetch || globalThis.fetch
    this.#timeoutMs = options.timeoutMs ?? 10_000
    this.#maxIndexBytes = options.maxIndexBytes ?? 1_048_576
  }

  async list(source: ExtensionSourceRecord): Promise<ExtensionSourceCatalogPackageVersion[]> {
    const { rawIndex, root } = await this.#readIndex(source)
    let index: ExtensionSourceIndex
    try {
      index = normalizeIndex(JSON.parse(rawIndex), source)
    } catch (error) {
      if (error instanceof ExtensionSourceError) throw error
      throw new ExtensionSourceError("invalid_source_index", `Extension source index is not valid JSON: ${error instanceof Error ? error.message : String(error)}`)
    }
    if (source.kind === "https") this.#verifyRemoteSignature(source, JSON.parse(rawIndex), index.signature)
    const entries: ExtensionSourceCatalogPackageVersion[] = []
    for (const packageEntry of index.packages) for (const version of packageEntry.versions) {
      const { manifestPath, rawManifest } = await this.#readManifest(source, root, version.manifestPath)
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

  async #readIndex(source: ExtensionSourceRecord): Promise<{ rawIndex: string; root: string }> {
    if (source.kind === "file") {
      const indexPath = resolve(source.indexPath || "")
      try {
        return { rawIndex: await readFile(indexPath, "utf8"), root: dirname(indexPath) }
      } catch (error) {
        throw new ExtensionSourceError("source_index_unreadable", `Cannot read extension source index: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), this.#timeoutMs)
    try {
      const response = await this.#fetch(source.indexUrl!, { method: "GET", redirect: "error", credentials: "omit", signal: controller.signal })
      if (!response.ok) throw new ExtensionSourceError("source_fetch_failed", `Remote source returned HTTP ${response.status}`)
      const contentLength = Number.parseInt(response.headers.get("content-length") || "0", 10)
      if (Number.isSafeInteger(contentLength) && contentLength > this.#maxIndexBytes) throw new ExtensionSourceError("source_index_too_large", `Remote source index exceeds ${this.#maxIndexBytes} bytes`)
      const rawIndex = await response.text()
      if (Buffer.byteLength(rawIndex, "utf8") > this.#maxIndexBytes) throw new ExtensionSourceError("source_index_too_large", `Remote source index exceeds ${this.#maxIndexBytes} bytes`)
      return { rawIndex, root: new URL(".", source.indexUrl!).toString() }
    } catch (error) {
      if (error instanceof ExtensionSourceError) throw error
      if (controller.signal.aborted) throw new ExtensionSourceError("source_fetch_timeout", `Remote source did not respond within ${this.#timeoutMs}ms`)
      throw new ExtensionSourceError("source_fetch_failed", `Cannot fetch remote source: ${error instanceof Error ? error.message : String(error)}`)
    } finally {
      clearTimeout(timeout)
    }
  }

  #verifyRemoteSignature(source: ExtensionSourceRecord, rawIndex: unknown, signature: ExtensionSourceIndexSignature | undefined): void {
    if (!signature || !source.publicKey) throw new ExtensionSourceError("missing_source_signature", `Remote source ${source.id} must sign its index`)
    try {
      const publicKey = createPublicKey(source.publicKey)
      if (publicKey.asymmetricKeyType !== "ed25519") throw new ExtensionSourceError("invalid_source_key", `Remote source ${source.id} key must be Ed25519`)
      if (!verify(null, extensionSourceIndexSigningPayload(rawIndex), publicKey, Buffer.from(signature.value, "base64"))) {
        throw new ExtensionSourceError("invalid_source_signature", `Remote source ${source.id} index signature did not verify`)
      }
    } catch (error) {
      if (error instanceof ExtensionSourceError) throw error
      throw new ExtensionSourceError("invalid_source_key", `Remote source ${source.id} public key is invalid: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  async #readManifest(source: ExtensionSourceRecord, root: string, relativePath: string): Promise<{ manifestPath: string; rawManifest: string }> {
    if (source.kind === "file") {
      const manifestPath = resolve(root, relativePath)
      if (!pathInside(root, manifestPath)) throw new ExtensionSourceError("unsafe_manifest_path", `Manifest path escapes source directory: ${relativePath}`)
      try {
        return { manifestPath, rawManifest: await readFile(manifestPath, "utf8") }
      } catch (error) {
        throw new ExtensionSourceError("manifest_unreadable", `Cannot read ${relativePath}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    const manifestUrl = new URL(relativePath, root)
    const sourceUrl = new URL(source.indexUrl!)
    if (manifestUrl.origin !== sourceUrl.origin) throw new ExtensionSourceError("unsafe_manifest_path", `Manifest URL escapes source origin: ${relativePath}`)
    return { manifestPath: manifestUrl.toString(), rawManifest: await this.#fetchText(manifestUrl.toString(), "manifest") }
  }

  async #fetchText(url: string, label: string): Promise<string> {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), this.#timeoutMs)
    try {
      const response = await this.#fetch(url, { method: "GET", redirect: "error", credentials: "omit", signal: controller.signal })
      if (!response.ok) throw new ExtensionSourceError("source_fetch_failed", `Remote ${label} returned HTTP ${response.status}`)
      const contentLength = Number.parseInt(response.headers.get("content-length") || "0", 10)
      if (Number.isSafeInteger(contentLength) && contentLength > this.#maxIndexBytes) throw new ExtensionSourceError("source_index_too_large", `Remote ${label} exceeds ${this.#maxIndexBytes} bytes`)
      const text = await response.text()
      if (Buffer.byteLength(text, "utf8") > this.#maxIndexBytes) throw new ExtensionSourceError("source_index_too_large", `Remote ${label} exceeds ${this.#maxIndexBytes} bytes`)
      return text
    } catch (error) {
      if (error instanceof ExtensionSourceError) throw error
      if (controller.signal.aborted) throw new ExtensionSourceError("source_fetch_timeout", `Remote ${label} did not respond within ${this.#timeoutMs}ms`)
      throw new ExtensionSourceError("source_fetch_failed", `Cannot fetch remote ${label}: ${error instanceof Error ? error.message : String(error)}`)
    } finally {
      clearTimeout(timeout)
    }
  }
}
