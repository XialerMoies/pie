import { readLockedJson, updateLockedJson } from "../data/locked-json-store.js"
import { dirname, join } from "node:path"
import { defaultTrustStorePath } from "./mcp/trust-store.js"
import {
  componentPackageManifestFingerprint,
  normalizeCapabilityComponentPackageManifest,
  type CapabilityComponentPackageManifest,
} from "./component-package.js"

export const EXTENSION_PACKAGE_STORE_SCHEMA_VERSION = 1 as const

export interface InstalledExtensionPackageRecord {
  schemaVersion: typeof EXTENSION_PACKAGE_STORE_SCHEMA_VERSION
  packageId: string
  packageVersion: string
  componentId: string
  fingerprint: string
  source: CapabilityComponentPackageManifest["source"]
  manifest: CapabilityComponentPackageManifest
  trusted: boolean
}

export interface ExtensionPackageUpdatePreview {
  componentId: string
  packageId: string
  fromVersion: string
  toVersion: string
  fromFingerprint: string
  toFingerprint: string
  sourceChanged: boolean
  permissionsChanged: boolean
  resourcesChanged: boolean
  entryChanged: boolean
  settingsChanged: boolean
}

interface ExtensionPackageStateDocument {
  schemaVersion: typeof EXTENSION_PACKAGE_STORE_SCHEMA_VERSION
  packages: InstalledExtensionPackageRecord[]
}

export function defaultExtensionPackageStorePath(): string {
  return join(dirname(defaultTrustStorePath()), "extension-packages.json")
}

/** Persistent package declarations; no entry point is ever imported here. */
export class ExtensionPackageStore {
  readonly #records = new Map<string, InstalledExtensionPackageRecord>()

  register(manifest: CapabilityComponentPackageManifest, trusted: boolean): InstalledExtensionPackageRecord {
    const normalized = normalizeCapabilityComponentPackageManifest(manifest)
    const record: InstalledExtensionPackageRecord = Object.freeze({
      schemaVersion: EXTENSION_PACKAGE_STORE_SCHEMA_VERSION,
      packageId: normalized.packageId,
      packageVersion: normalized.packageVersion,
      componentId: normalized.component.id,
      fingerprint: componentPackageManifestFingerprint(normalized),
      source: normalized.source,
      manifest: normalized,
      trusted: trusted === true,
    })
    this.#records.set(record.componentId, record)
    return record
  }

  setTrusted(componentId: string, trusted: boolean): InstalledExtensionPackageRecord | undefined {
    const current = this.#records.get(String(componentId || "").trim())
    if (!current) return undefined
    const updated: InstalledExtensionPackageRecord = Object.freeze({ ...current, trusted: trusted === true })
    this.#records.set(updated.componentId, updated)
    return updated
  }

  remove(componentId: string): boolean {
    return this.#records.delete(String(componentId || "").trim())
  }

  get(componentId: string): InstalledExtensionPackageRecord | undefined {
    return this.#records.get(String(componentId || "").trim())
  }

  list(): InstalledExtensionPackageRecord[] {
    return [...this.#records.values()].sort((left, right) => left.componentId.localeCompare(right.componentId))
  }

  async save(filePath = defaultExtensionPackageStorePath()): Promise<void> {
    const document: ExtensionPackageStateDocument = {
      schemaVersion: EXTENSION_PACKAGE_STORE_SCHEMA_VERSION,
      packages: this.list(),
    }
    await updateLockedJson<ExtensionPackageStateDocument>(filePath, () => ({ schemaVersion: EXTENSION_PACKAGE_STORE_SCHEMA_VERSION, packages: [] }), () => document, { recoverInvalidJson: true, space: 2 })
  }

  async restore(filePath = defaultExtensionPackageStorePath()): Promise<void> {
    const document = await readLockedJson<ExtensionPackageStateDocument>(filePath, () => ({ schemaVersion: EXTENSION_PACKAGE_STORE_SCHEMA_VERSION, packages: [] }), { recoverInvalidJson: true })
    this.#records.clear()
    if (!document || document.schemaVersion !== EXTENSION_PACKAGE_STORE_SCHEMA_VERSION || !Array.isArray(document.packages)) return
    for (const entry of document.packages) {
      try {
        const normalized = normalizeCapabilityComponentPackageManifest(entry.manifest)
        if (normalized.packageId !== entry.packageId || normalized.component.id !== entry.componentId) continue
        if (componentPackageManifestFingerprint(normalized) !== entry.fingerprint) continue
        this.register(normalized, entry.trusted === true)
      } catch {
        // Corrupt package declarations remain absent and inert.
      }
    }
  }
}

export const extensionPackageStore = new ExtensionPackageStore()

/** Product-facing, bounded diff for an explicit package update confirmation. */
export function extensionPackageUpdatePreview(
  current: InstalledExtensionPackageRecord,
  candidate: CapabilityComponentPackageManifest,
): ExtensionPackageUpdatePreview {
  const normalized = normalizeCapabilityComponentPackageManifest(candidate)
  return Object.freeze({
    componentId: current.componentId,
    packageId: current.packageId,
    fromVersion: current.packageVersion,
    toVersion: normalized.packageVersion,
    fromFingerprint: current.fingerprint,
    toFingerprint: componentPackageManifestFingerprint(normalized),
    sourceChanged: JSON.stringify(current.source) !== JSON.stringify(normalized.source),
    permissionsChanged: JSON.stringify(current.manifest.permissions) !== JSON.stringify(normalized.permissions),
    resourcesChanged: JSON.stringify(current.manifest.resources) !== JSON.stringify(normalized.resources),
    entryChanged: current.manifest.entry !== normalized.entry || JSON.stringify(current.manifest.isolation) !== JSON.stringify(normalized.isolation),
    settingsChanged: JSON.stringify(current.manifest.component.settings || []) !== JSON.stringify(normalized.component.settings || []),
  })
}
