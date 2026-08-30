import { isAbsolute, resolve } from "node:path"
import { dirname, join } from "node:path"
import { defaultTrustStorePath } from "./mcp/trust-store.js"
import { readLockedJson, updateLockedJson } from "../data/locked-json-store.js"

export const EXTENSION_SOURCE_STORE_SCHEMA_VERSION = 1 as const

export interface ExtensionSourceRecord {
  schemaVersion: typeof EXTENSION_SOURCE_STORE_SCHEMA_VERSION
  id: string
  displayName: string
  kind: "file" | "https"
  indexPath?: string
  indexUrl?: string
  /** Required for remote sources; PEM-encoded Ed25519 public key. */
  publicKey?: string
  keyId?: string
}

interface ExtensionSourceStateDocument {
  schemaVersion: typeof EXTENSION_SOURCE_STORE_SCHEMA_VERSION
  sources: ExtensionSourceRecord[]
}

const SOURCE_ID_PATTERN = /^[a-z0-9][a-z0-9._-]*$/u

export class ExtensionSourceError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = "ExtensionSourceError"
    this.code = code
  }
}

export function defaultExtensionSourceStorePath(): string {
  return join(dirname(defaultTrustStorePath()), "extension-sources.json")
}

export interface ExtensionSourceInput {
  id: string
  displayName?: string
  kind: "file" | "https"
  indexPath?: string
  indexUrl?: string
  publicKey?: string
  keyId?: string
}

function normalizeSource(input: ExtensionSourceInput): ExtensionSourceRecord {
  const id = String(input.id || "").trim()
  if (!SOURCE_ID_PATTERN.test(id)) throw new ExtensionSourceError("invalid_source_id", "Extension source id must be a stable identifier")
  const displayName = String(input.displayName || "").trim() || id
  if (displayName.length > 160) throw new ExtensionSourceError("invalid_source_name", "Extension source displayName must not exceed 160 characters")
  if (input.kind === "file") {
    const indexPath = String(input.indexPath || "").trim()
    if (!indexPath || !isAbsolute(indexPath)) throw new ExtensionSourceError("invalid_source_path", "Extension source indexPath must be an absolute local path")
    return Object.freeze({ schemaVersion: EXTENSION_SOURCE_STORE_SCHEMA_VERSION, id, displayName, kind: "file", indexPath: resolve(indexPath) })
  }
  if (input.kind !== "https") throw new ExtensionSourceError("unsupported_source_kind", "Extension sources must use file or HTTPS")
  let url: URL
  try { url = new URL(String(input.indexUrl || "").trim()) } catch { throw new ExtensionSourceError("invalid_source_url", "Extension source indexUrl must be a valid HTTPS URL") }
  if (url.protocol !== "https:" || url.username || url.password || url.hash) throw new ExtensionSourceError("invalid_source_url", "Extension source indexUrl must be a credential-free HTTPS URL")
  const keyId = String(input.keyId || "").trim()
  const publicKey = String(input.publicKey || "").trim()
  if (!SOURCE_ID_PATTERN.test(keyId)) throw new ExtensionSourceError("invalid_source_key", "Remote extension sources must declare a stable keyId")
  if (!publicKey.startsWith("-----BEGIN PUBLIC KEY-----") || publicKey.length > 8192) throw new ExtensionSourceError("invalid_source_key", "Remote extension sources must declare a PEM public key")
  return Object.freeze({ schemaVersion: EXTENSION_SOURCE_STORE_SCHEMA_VERSION, id, displayName, kind: "https", indexUrl: url.toString(), keyId, publicKey })
}

/** Persistent user-owned source registrations. They contain no package code. */
export class ExtensionSourceStore {
  readonly #records = new Map<string, ExtensionSourceRecord>()

  add(input: ExtensionSourceInput): ExtensionSourceRecord {
    const record = normalizeSource(input)
    if (this.#records.has(record.id)) throw new ExtensionSourceError("duplicate_source", `Extension source already exists: ${record.id}`)
    this.#records.set(record.id, record)
    return record
  }

  remove(id: string): boolean {
    return this.#records.delete(String(id || "").trim())
  }

  get(id: string): ExtensionSourceRecord | undefined {
    return this.#records.get(String(id || "").trim())
  }

  list(): ExtensionSourceRecord[] {
    return [...this.#records.values()].sort((left, right) => left.id.localeCompare(right.id))
  }

  async save(filePath = defaultExtensionSourceStorePath()): Promise<void> {
    const document: ExtensionSourceStateDocument = { schemaVersion: EXTENSION_SOURCE_STORE_SCHEMA_VERSION, sources: this.list() }
    await updateLockedJson<ExtensionSourceStateDocument>(filePath, () => ({ schemaVersion: EXTENSION_SOURCE_STORE_SCHEMA_VERSION, sources: [] }), () => document, { recoverInvalidJson: true, space: 2 })
  }

  async restore(filePath = defaultExtensionSourceStorePath()): Promise<void> {
    const document = await readLockedJson<ExtensionSourceStateDocument>(filePath, () => ({ schemaVersion: EXTENSION_SOURCE_STORE_SCHEMA_VERSION, sources: [] }), { recoverInvalidJson: true })
    this.#records.clear()
    if (!document || document.schemaVersion !== EXTENSION_SOURCE_STORE_SCHEMA_VERSION || !Array.isArray(document.sources)) return
    for (const source of document.sources) {
      try {
        const normalized = normalizeSource(source)
        if (!this.#records.has(normalized.id)) this.#records.set(normalized.id, normalized)
      } catch {
        // Corrupt source entries stay absent; nothing is fetched or loaded.
      }
    }
  }
}

export const extensionSourceStore = new ExtensionSourceStore()
