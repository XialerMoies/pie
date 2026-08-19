import { readLockedJson, updateLockedJson } from "../../data/locked-json-store.js"
import type { SkillDiagnostic, SkillSource, SkillStateRecord } from "./types.js"

interface StateDocument {
  records: Record<string, SkillStateRecord>
}

export interface SkillStateReadResult extends StateDocument {
  diagnostics: SkillDiagnostic[]
  failClosed?: true
}

const emptyDocument = (): StateDocument => ({ records: {} })

function validId(id: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id) && id !== "." && id !== ".."
}

function recordKey(source: SkillSource, id: string, workspaceKey?: string): string {
  if (source === "user") return `user:${id}`
  if (!workspaceKey || !/^[a-f0-9]{64}$/.test(workspaceKey)) throw new Error("Invalid workspace skill scope")
  return `workspace:${workspaceKey}:${id}`
}

function isRecord(value: unknown): value is SkillStateRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  return (record.trust === "trusted" || record.trust === "untrusted")
    && typeof record.enabled === "boolean"
    && typeof record.fingerprint === "string"
    && (record.confirmedAt === undefined || typeof record.confirmedAt === "string")
}

function validateDocument(value: unknown): StateDocument | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
  const records = (value as Record<string, unknown>).records
  if (!records || typeof records !== "object" || Array.isArray(records)) return undefined
  const output: Record<string, SkillStateRecord> = {}
  for (const [key, record] of Object.entries(records)) {
    const userMatch = key.match(/^user:(.+)$/)
    const workspaceMatch = key.match(/^workspace:([a-f0-9]{64}):(.+)$/)
    const id = userMatch?.[1] ?? workspaceMatch?.[2]
    if (!id || !validId(id) || !isRecord(record)) return undefined
    output[key] = {
      trust: record.trust,
      enabled: record.enabled,
      fingerprint: record.fingerprint,
      ...(record.confirmedAt ? { confirmedAt: record.confirmedAt } : {}),
    }
  }
  return { records: output }
}

export class SkillStateStore {
  constructor(private readonly filePath: string) {}

  async read(): Promise<SkillStateReadResult> {
    let raw: unknown
    try {
      raw = await readLockedJson<unknown>(this.filePath, emptyDocument)
    } catch (error: any) {
      if (!(error instanceof SyntaxError)) throw error
      return { records: {}, diagnostics: [{ code: "state_corrupt", message: "skill state JSON is malformed" }], failClosed: true }
    }
    const document = validateDocument(raw)
    if (!document) return { records: {}, diagnostics: [{ code: "state_corrupt", message: "skill state has an invalid shape" }], failClosed: true }
    return { records: document.records, diagnostics: [] }
  }

  async set(source: SkillSource, id: string, record: SkillStateRecord, workspaceKey?: string): Promise<void> {
    if (!validId(id) || !isRecord(record)) throw new Error("Invalid skill state")
    await updateLockedJson<unknown>(this.filePath, emptyDocument, (raw) => {
      const current = validateDocument(raw)
      if (!current) throw new Error("Skill state is corrupt")
      current.records[recordKey(source, id, workspaceKey)] = {
        trust: record.trust,
        enabled: record.enabled,
        fingerprint: record.fingerprint,
        ...(record.confirmedAt ? { confirmedAt: record.confirmedAt } : {}),
      }
      return current
    })
  }

  async update(
    source: SkillSource,
    id: string,
    updater: (current: SkillStateRecord | undefined) => SkillStateRecord,
    workspaceKey?: string,
  ): Promise<SkillStateRecord> {
    if (!validId(id)) throw new Error("Invalid skill state")
    let updatedRecord: SkillStateRecord | undefined
    await updateLockedJson<unknown>(this.filePath, emptyDocument, (raw) => {
      const current = validateDocument(raw)
      if (!current) throw new Error("Skill state is corrupt")
      const key = recordKey(source, id, workspaceKey)
      const next = updater(current.records[key])
      if (!isRecord(next)) throw new Error("Invalid skill state")
      updatedRecord = {
        trust: next.trust,
        enabled: next.enabled,
        fingerprint: next.fingerprint,
        ...(next.confirmedAt ? { confirmedAt: next.confirmedAt } : {}),
      }
      current.records[key] = updatedRecord
      return current
    })
    return updatedRecord!
  }

  async delete(source: SkillSource, id: string, workspaceKey?: string): Promise<void> {
    if (!validId(id)) throw new Error("Invalid skill id")
    await updateLockedJson<unknown>(this.filePath, emptyDocument, (raw) => {
      const current = validateDocument(raw)
      if (!current) throw new Error("Skill state is corrupt")
      delete current.records[recordKey(source, id, workspaceKey)]
      return current
    })
  }
}
