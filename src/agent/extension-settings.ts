import { readLockedJson, updateLockedJson } from "../data/locked-json-store.js"

export const EXTENSION_SETTINGS_SCHEMA_VERSION = 1 as const

export type ExtensionSettingType = "string" | "number" | "boolean" | "select"
export type ExtensionSettingValue = string | number | boolean
export type ExtensionSettingsScope = "user" | "workspace"

export interface ExtensionSettingSchema {
  id: string
  type: ExtensionSettingType
  label: string
  description?: string
  defaultValue?: ExtensionSettingValue
  choices?: readonly string[]
}

interface ExtensionSettingsDocument {
  schemaVersion: typeof EXTENSION_SETTINGS_SCHEMA_VERSION
  extensions: Record<string, Record<string, ExtensionSettingValue>>
}

const ID_PATTERN = /^[a-z0-9][a-z0-9._-]*$/u
const SECRET_NAME_PATTERN = /(?:secret|token|password|passwd|api[-_.]?key|private[-_.]?key)/iu

function asDocument(value: unknown): ExtensionSettingsDocument {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { schemaVersion: EXTENSION_SETTINGS_SCHEMA_VERSION, extensions: {} }
  }
  const document = value as Partial<ExtensionSettingsDocument>
  return {
    schemaVersion: EXTENSION_SETTINGS_SCHEMA_VERSION,
    extensions: document.extensions && typeof document.extensions === "object" && !Array.isArray(document.extensions)
      ? document.extensions
      : {},
  }
}

function text(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be a non-empty string`)
  return value.trim()
}

function normalizeValue(schema: ExtensionSettingSchema, value: unknown): ExtensionSettingValue {
  if (schema.type === "string") {
    if (typeof value !== "string") throw new Error(`Setting ${schema.id} must be a string`)
    return value
  }
  if (schema.type === "number") {
    if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`Setting ${schema.id} must be a finite number`)
    return value
  }
  if (schema.type === "boolean") {
    if (typeof value !== "boolean") throw new Error(`Setting ${schema.id} must be a boolean`)
    return value
  }
  if (typeof value !== "string" || !schema.choices?.includes(value)) {
    throw new Error(`Setting ${schema.id} must be one of its declared choices`)
  }
  return value
}

/** Validate a package-declared setting schema without registering any callback. */
export function normalizeExtensionSettingSchemas(input: unknown): readonly ExtensionSettingSchema[] {
  if (input === undefined) return Object.freeze([])
  if (!Array.isArray(input)) throw new Error("extension settings must be an array")
  const schemas = input.map((raw) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("extension setting must be an object")
    const value = raw as Record<string, unknown>
    const id = text(value.id, "setting id")
    if (!ID_PATTERN.test(id) || SECRET_NAME_PATTERN.test(id)) throw new Error(`Setting is reserved for host-owned secure storage: ${id}`)
    const type = text(value.type, "setting type") as ExtensionSettingType
    if (!(["string", "number", "boolean", "select"] as const).includes(type)) throw new Error(`Unsupported extension setting type: ${type}`)
    const label = text(value.label, "setting label")
    const description = value.description === undefined ? undefined : text(value.description, "setting description")
    const choices = value.choices === undefined ? undefined : (() => {
      if (!Array.isArray(value.choices) || value.choices.length === 0 || value.choices.some((choice) => typeof choice !== "string" || !choice.trim())) {
        throw new Error(`Setting ${id} choices must be a non-empty string array`)
      }
      const normalized = [...new Set(value.choices.map((choice) => choice.trim()))].sort()
      if (normalized.length !== value.choices.length) throw new Error(`Setting ${id} choices contain duplicates`)
      return Object.freeze(normalized)
    })()
    if (type === "select" && !choices) throw new Error(`Select setting ${id} requires choices`)
    if (type !== "select" && choices) throw new Error(`Only select setting ${id} may declare choices`)
    const schema: ExtensionSettingSchema = { id, type, label, ...(description ? { description } : {}), ...(choices ? { choices } : {}) }
    if (value.defaultValue !== undefined) schema.defaultValue = normalizeValue(schema, value.defaultValue)
    return Object.freeze(schema)
  })
  if (new Set(schemas.map((schema) => schema.id)).size !== schemas.length) throw new Error("extension settings contain duplicate ids")
  return Object.freeze(schemas.sort((left, right) => left.id.localeCompare(right.id)))
}

function valuesFor(schemas: readonly ExtensionSettingSchema[], values: unknown): Record<string, ExtensionSettingValue> {
  if (!values || typeof values !== "object" || Array.isArray(values)) return {}
  const source = values as Record<string, unknown>
  const schemaById = new Map(schemas.map((schema) => [schema.id, schema]))
  const result: Record<string, ExtensionSettingValue> = {}
  for (const [id, value] of Object.entries(source)) {
    const schema = schemaById.get(id)
    if (!schema) continue
    try { result[id] = normalizeValue(schema, value) } catch { /* stale invalid values are ignored */ }
  }
  return result
}

export function resolveExtensionSettings(
  schemas: readonly ExtensionSettingSchema[],
  userValues: unknown,
  workspaceValues: unknown,
): Readonly<Record<string, ExtensionSettingValue>> {
  const resolved: Record<string, ExtensionSettingValue> = {}
  for (const schema of schemas) if (schema.defaultValue !== undefined) resolved[schema.id] = schema.defaultValue
  Object.assign(resolved, valuesFor(schemas, userValues), valuesFor(schemas, workspaceValues))
  return Object.freeze(resolved)
}

export async function readExtensionSettings(
  filePath: string,
  componentId: string,
  schemas: readonly ExtensionSettingSchema[],
): Promise<Readonly<Record<string, ExtensionSettingValue>>> {
  const document = asDocument(await readLockedJson<unknown>(filePath, () => ({ schemaVersion: EXTENSION_SETTINGS_SCHEMA_VERSION, extensions: {} }), { recoverInvalidJson: true }))
  return Object.freeze(valuesFor(schemas, document.extensions[componentId]))
}

export async function updateExtensionSettings(
  filePath: string,
  componentId: string,
  schemas: readonly ExtensionSettingSchema[],
  patch: unknown,
): Promise<Readonly<Record<string, ExtensionSettingValue>>> {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) throw new Error("extension settings patch must be an object")
  const schemaById = new Map(schemas.map((schema) => [schema.id, schema]))
  const updates: Record<string, ExtensionSettingValue> = {}
  for (const [id, value] of Object.entries(patch as Record<string, unknown>)) {
    const schema = schemaById.get(id)
    if (!schema) throw new Error(`Unknown extension setting: ${id}`)
    updates[id] = normalizeValue(schema, value)
  }
  const document = await updateLockedJson<ExtensionSettingsDocument>(
    filePath,
    () => ({ schemaVersion: EXTENSION_SETTINGS_SCHEMA_VERSION, extensions: {} }),
    (current) => {
      const normalized = asDocument(current)
      const previous = valuesFor(schemas, normalized.extensions[componentId])
      return {
        schemaVersion: EXTENSION_SETTINGS_SCHEMA_VERSION,
        extensions: { ...normalized.extensions, [componentId]: { ...previous, ...updates } },
      }
    },
    { recoverInvalidJson: true },
  )
  return Object.freeze(valuesFor(schemas, document.extensions[componentId]))
}
