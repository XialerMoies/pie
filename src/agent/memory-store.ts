import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { dirname, isAbsolute, join, resolve } from "node:path"
import { randomUUID } from "node:crypto"

export type MemoryScope = "user" | "workspace"

export interface ResolveMemoryRootOptions {
  scope: MemoryScope
  userMemoryRoot?: string
  workspaceMemoryRoot?: string
  workspace?: string
}

export interface MemoryMetadata {
  id: string
  name: string
  scope: MemoryScope
  source: "user" | "agent-confirmed" | "legacy"
  createdAt: string
  updatedAt: string
  enabled: boolean
  traceId: string
  summary: string
}

export interface MemoryIndex {
  schemaVersion: 1
  entries: MemoryMetadata[]
}

const INDEX_FILE = "memory-index.json"
const MEMORY_FILE = "MEMORY.md"

export function resolveMemoryRoot(options: ResolveMemoryRootOptions): string {
  const configured = options.scope === "user"
    ? options.userMemoryRoot || (process.env.PI_USER_CONFIG ? join(process.env.PI_USER_CONFIG, "memory") : join(process.cwd(), "memory"))
    : options.workspaceMemoryRoot || (options.workspace ? join(options.workspace, "agent", "memory") : "")
  if (!configured) throw new Error("workspace is required for workspace memory")
  if (!isAbsolute(configured)) throw new Error("memory root must be absolute")
  return resolve(configured)
}

export function memoryIndexPath(root: string): string {
  return join(root, INDEX_FILE)
}

export function memorySummary(content: string): string {
  const line = content.split(/\r?\n/).find((value) => value.trim())?.trim() || ""
  return line.replace(/^#+\s*/, "").slice(0, 200)
}

function validName(name: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(name)
}

function readIndexFile(root: string): MemoryIndex | undefined {
  try {
    const parsed = JSON.parse(readFileSync(memoryIndexPath(root), "utf8")) as Partial<MemoryIndex>
    if (parsed.schemaVersion !== 1 || !Array.isArray(parsed.entries)) return undefined
    return { schemaVersion: 1, entries: parsed.entries.filter(Boolean) as MemoryMetadata[] }
  } catch {
    return undefined
  }
}

export function readOrRebuildMemoryIndex(root: string, scope: MemoryScope): MemoryIndex {
  const existing = readIndexFile(root)
  if (existing) return existing
  const entries: MemoryMetadata[] = []
  if (existsSync(root)) {
    for (const file of readdirSync(root).sort()) {
      if (!file.endsWith(".md") || file === MEMORY_FILE) continue
      const name = file.slice(0, -3)
      if (!validName(name)) continue
      const content = readFileSync(join(root, file), "utf8")
      const now = new Date().toISOString()
      entries.push({
        id: randomUUID(),
        name,
        scope,
        source: "legacy",
        createdAt: now,
        updatedAt: now,
        enabled: true,
        traceId: randomUUID(),
        summary: memorySummary(content),
      })
    }
  }
  return { schemaVersion: 1, entries }
}

export function writeMemoryIndex(root: string, index: MemoryIndex): void {
  mkdirSync(root, { recursive: true })
  const temporary = `${memoryIndexPath(root)}.${process.pid}.tmp`
  writeFileSync(temporary, `${JSON.stringify({ schemaVersion: 1, entries: [...index.entries].sort((a, b) => a.name.localeCompare(b.name)) }, null, 2)}\n`, "utf8")
  renameSync(temporary, memoryIndexPath(root))
}

export function writeMemoryPromptIndex(root: string, index: MemoryIndex): void {
  mkdirSync(root, { recursive: true })
  const lines = index.entries
    .filter((entry) => entry.enabled)
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((entry) => `- [${entry.name}](${entry.name}.md) — ${entry.summary || "无摘要"}（${entry.scope}，${entry.updatedAt}）`)
  writeFileSync(join(root, MEMORY_FILE), `${lines.join("\n")}\n`, "utf8")
}

export function migrateLegacyMemory(legacyRoot: string, userRoot: string): { migrated: string[]; conflicts: string[] } {
  const migrated: string[] = []
  const conflicts: string[] = []
  if (!existsSync(legacyRoot)) return { migrated, conflicts }
  mkdirSync(userRoot, { recursive: true })
  for (const file of readdirSync(legacyRoot).sort()) {
    if (!file.endsWith(".md") || file === MEMORY_FILE) continue
    const name = file.slice(0, -3)
    if (!validName(name)) continue
    const source = join(legacyRoot, file)
    const target = join(userRoot, file)
    if (existsSync(target)) {
      conflicts.push(name)
      continue
    }
    try {
      renameSync(source, target)
    } catch {
      copyFileSync(source, target)
    }
    migrated.push(name)
  }
  return { migrated, conflicts }
}

export function writeMemoryFile(root: string, name: string, content: string): void {
  mkdirSync(dirname(join(root, `${name}.md`)), { recursive: true })
  writeFileSync(join(root, `${name}.md`), content, "utf8")
}
