/** Scoped long-lived memory tools. Bodies live beside skills; prompts only receive indexes. */
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { randomUUID } from "node:crypto"
import { defineAgentTool, structuredToolResult, type AgentTool, type ToolContext } from "../types.js"
import { getCurrentRuntime } from "../globals.js"
import { authorizeToolPath } from "./path-authorization.js"
import {
  migrateLegacyMemory,
  memoryIndexPath,
  memorySummary,
  readOrRebuildMemoryIndex,
  resolveMemoryRoot,
  writeMemoryIndex,
  writeMemoryPromptIndex,
  type MemoryIndex,
  type MemoryMetadata,
  type MemoryScope,
} from "../memory-store.js"

const __dirname = dirname(fileURLToPath(import.meta.url))
const APP_ROOT = resolve(__dirname, "..", "..", "..")
const LEGACY_MEMORY_DIR = resolve(APP_ROOT, "data", "pi", "memory")
const LEGACY_MARKER = ".legacy-migrated.json"

export function validMemoryName(name: string): boolean {
  return /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(name) && name.length <= 64
}

function scopeOf(value: unknown): MemoryScope {
  return value === "workspace" ? "workspace" : "user"
}

function rootFor(ctx: ToolContext | undefined, scope: MemoryScope): string {
  return resolveMemoryRoot({ scope, userMemoryRoot: ctx?.userMemoryRoot, workspaceMemoryRoot: ctx?.workspaceMemoryRoot, workspace: ctx?.workspace })
}

async function authorizeMemoryPath(ctx: ToolContext | undefined, root: string, target: string, operation: "read" | "write" | "create" | "remove", source: string): Promise<string> {
  return authorizeToolPath(ctx, root, target, operation, source)
}

function maybeMigrate(scope: MemoryScope, root: string): void {
  if (scope !== "user" || root === LEGACY_MEMORY_DIR || existsSync(join(root, LEGACY_MARKER))) return
  if (!existsSync(LEGACY_MEMORY_DIR)) return
  mkdirSync(root, { recursive: true })
  const result = migrateLegacyMemory(LEGACY_MEMORY_DIR, root)
  if (result.migrated.length || result.conflicts.length) writeFileSync(join(root, LEGACY_MARKER), JSON.stringify(result), "utf8")
}

function loadIndex(root: string, scope: MemoryScope): MemoryIndex {
  const index = readOrRebuildMemoryIndex(root, scope)
  if (index.entries.length > 0 && !existsSync(memoryIndexPath(root))) writeMemoryIndex(root, index)
  return index
}

async function persistIndex(ctx: ToolContext | undefined, root: string, index: MemoryIndex): Promise<void> {
  mkdirSync(root, { recursive: true })
  const indexPath = memoryIndexPath(root)
  await authorizeMemoryPath(ctx, root, indexPath, existsSync(indexPath) ? "write" : "create", "agent.memory.index.write")
  const promptPath = join(root, "MEMORY.md")
  await authorizeMemoryPath(ctx, root, promptPath, existsSync(promptPath) ? "write" : "create", "agent.memory.index.write")
  writeMemoryIndex(root, index)
  writeMemoryPromptIndex(root, index)
}

function metadataFor(name: string, scope: MemoryScope, content: string, previous?: MemoryMetadata, source: MemoryMetadata["source"] = "user"): MemoryMetadata {
  const now = new Date().toISOString()
  return {
    id: previous?.id || randomUUID(), name, scope,
    source,
    createdAt: previous?.createdAt || now, updatedAt: now,
    enabled: previous?.enabled ?? true, traceId: previous?.traceId || randomUUID(), summary: memorySummary(content),
  }
}

function invalidNameResult(name: string): string {
  return `无效的记忆名称"${name}"。名称只允许字母、数字、点、下划线、短横线，最长 64 字符。`
}

const scopeSchema = { type: "string", enum: ["user", "workspace"], description: "记忆作用域；默认 user。" }

export const readMemoryTool: AgentTool = defineAgentTool({
  name: "read_memory", description: "读取一条长期记忆。默认用户级；项目特定记忆使用 scope=workspace。",
  parameters: { type: "object", properties: { name: { type: "string", description: "记忆名称（不含 .md）" }, scope: scopeSchema }, required: ["name"] },
  isReadOnly: true, isConcurrencySafe: true, operations: ["read"], riskLevel: "low", needsPermission: false, workspaceBounded: false, resultFormat: "structured",
  execute: async ({ name, scope }, ctx) => {
    const n = String(name ?? "")
    if (!validMemoryName(n)) return invalidNameResult(n)
    try {
      const selectedScope = scopeOf(scope); const root = rootFor(ctx, selectedScope); maybeMigrate(selectedScope, root)
      const filePath = join(root, `${n}.md`)
      if (!existsSync(filePath)) return `未找到记忆"${n}"。用 write_memory 创建一条新的。`
      const authorizedFile = await authorizeMemoryPath(ctx, root, filePath, "read", "agent.memory.read")
      const content = readFileSync(authorizedFile, "utf8")
      return structuredToolResult(content, { name: n, scope: selectedScope, path: authorizedFile, content, operation: "read" })
    } catch (error) { return error instanceof Error ? error.message : String(error) }
  },
})

export const writeMemoryTool: AgentTool = defineAgentTool({
  name: "write_memory", description: "写入或更新一条长期记忆。默认用户级；项目特定内容使用 scope=workspace。只有用户明确要求或确认后才调用。",
  parameters: { type: "object", properties: { name: { type: "string", description: "记忆名称（不含 .md）" }, content: { type: "string", description: "完整 markdown 内容" }, scope: scopeSchema, source: { type: "string", enum: ["user", "agent-confirmed"], description: "记忆来源" } }, required: ["name", "content"] },
  isReadOnly: false, isDestructive: false, isConcurrencySafe: false, operations: ["read", "create", "write"], riskLevel: "medium", needsPermission: false, workspaceBounded: false, resultFormat: "structured",
  execute: async ({ name, content, scope, source }, ctx) => {
    const n = String(name ?? "")
    if (!validMemoryName(n)) return invalidNameResult(n)
    try {
      const selectedScope = scopeOf(scope); const root = rootFor(ctx, selectedScope); maybeMigrate(selectedScope, root)
      const filePath = join(root, `${n}.md`); const operation = existsSync(filePath) ? "write" : "create"
      const authorizedFile = await authorizeMemoryPath(ctx, root, filePath, operation, `agent.memory.${operation}`)
      const previous = loadIndex(root, selectedScope).entries.find((entry) => entry.name === n)
      mkdirSync(root, { recursive: true }); writeFileSync(authorizedFile, String(content), "utf8")
      const index = loadIndex(root, selectedScope)
      index.entries = [...index.entries.filter((item) => item.name !== n), metadataFor(n, selectedScope, String(content), previous, source === "agent-confirmed" ? "agent-confirmed" : "user")]
      await persistIndex(ctx, root, index)
      const runtime = getCurrentRuntime(); if (runtime) await runtime.refreshSystemPrompt()
      return structuredToolResult(`记忆"${n}"已更新。`, { name: n, scope: selectedScope, path: authorizedFile, operation, bytes: Buffer.byteLength(String(content), "utf8") })
    } catch (error) { return error instanceof Error ? error.message : String(error) }
  },
})

export const listMemoryTool: AgentTool = defineAgentTool({
  name: "list_memory", description: "列出作用域中的长期记忆摘要，不读取全部正文。",
  parameters: { type: "object", properties: { scope: scopeSchema } },
  isReadOnly: true, isConcurrencySafe: true, operations: ["read"], riskLevel: "low", needsPermission: false, workspaceBounded: false, resultFormat: "structured",
  execute: async ({ scope }, ctx) => {
    try { const selectedScope = scopeOf(scope); const root = rootFor(ctx, selectedScope); maybeMigrate(selectedScope, root); const index = loadIndex(root, selectedScope); const entries = index.entries.filter((entry) => entry.enabled); return structuredToolResult(entries.map((entry) => `${entry.name}: ${entry.summary || "无摘要"}`).join("\n") || "暂无记忆。", { scope: selectedScope, entries }) }
    catch (error) { return error instanceof Error ? error.message : String(error) }
  },
})

export const deleteMemoryTool: AgentTool = defineAgentTool({
  name: "delete_memory", description: "删除一条长期记忆正文和索引条目。此操作必须由用户明确要求。",
  parameters: { type: "object", properties: { name: { type: "string" }, scope: scopeSchema }, required: ["name"] },
  isReadOnly: false, isDestructive: true, isConcurrencySafe: false, operations: ["remove", "write"], riskLevel: "medium", needsPermission: false, workspaceBounded: false, resultFormat: "structured",
  execute: async ({ name, scope }, ctx) => {
    const n = String(name ?? ""); if (!validMemoryName(n)) return invalidNameResult(n)
    try { const selectedScope = scopeOf(scope); const root = rootFor(ctx, selectedScope); const filePath = join(root, `${n}.md`); if (!existsSync(filePath)) return `未找到记忆"${n}"。`; const authorizedFile = await authorizeMemoryPath(ctx, root, filePath, "remove", "agent.memory.delete"); unlinkSync(authorizedFile); const index = loadIndex(root, selectedScope); index.entries = index.entries.filter((entry) => entry.name !== n); await persistIndex(ctx, root, index); const runtime = getCurrentRuntime(); if (runtime) await runtime.refreshSystemPrompt(); return structuredToolResult(`记忆"${n}"已删除。`, { name: n, scope: selectedScope, operation: "delete" }) }
    catch (error) { return error instanceof Error ? error.message : String(error) }
  },
})

export const setMemoryEnabledTool: AgentTool = defineAgentTool({
  name: "set_memory_enabled", description: "启用或禁用一条长期记忆。禁用只影响索引和 prompt，不删除正文。",
  parameters: { type: "object", properties: { name: { type: "string" }, scope: scopeSchema, enabled: { type: "boolean" } }, required: ["name", "enabled"] },
  isReadOnly: false, isDestructive: false, isConcurrencySafe: false, operations: ["write"], riskLevel: "low", needsPermission: false, workspaceBounded: false, resultFormat: "structured",
  execute: async ({ name, scope, enabled }, ctx) => {
    const n = String(name ?? ""); if (!validMemoryName(n)) return invalidNameResult(n)
    try { const selectedScope = scopeOf(scope); const root = rootFor(ctx, selectedScope); const index = loadIndex(root, selectedScope); const entry = index.entries.find((item) => item.name === n); if (!entry) return `未找到记忆"${n}"。`; entry.enabled = Boolean(enabled); entry.updatedAt = new Date().toISOString(); await persistIndex(ctx, root, index); const runtime = getCurrentRuntime(); if (runtime) await runtime.refreshSystemPrompt(); return structuredToolResult(`记忆"${n}"已${entry.enabled ? "启用" : "禁用"}。`, { name: n, scope: selectedScope, enabled: entry.enabled }) }
    catch (error) { return error instanceof Error ? error.message : String(error) }
  },
})
