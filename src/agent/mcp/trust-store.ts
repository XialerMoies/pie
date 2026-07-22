/**
 * 信任存储 — 记录用户确认过的 MCP server。
 *
 * 核心逻辑：
 * - server 身份由 workspacePath + commandHash(server.launch fields) 决定
 * - command hash 变化 → 视为新 server，需重新确认
 * - 存储文件：<PI_CONFIG_DIR>/mcp-trust.json
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs"
import { resolve, dirname } from "node:path"
import { createHash } from "node:crypto"
import type { McpServerConfig, TrustRecord, TrustStoreFile } from "./types"

// ─── Hash ──────────────────────────────────────────

/**
 * 生成 MCP server 启动指纹。
 *
 * stdio: hash command + args + env + cwd + transport
 * http/sse: hash url + headers(排序) + env + transport
 *
 * 任一字段变化 → hash 变化 → 需重新信任确认。
 */
export function hashServerCommand(config: McpServerConfig): string {
  const transport = config.transport || "stdio"
  const h = createHash("sha256")

  if (transport === "stdio") {
    h.update(config.command ?? "").update("\x00")
    h.update((config.args ?? []).join("\x00")).update("\x00")
    if (config.cwd) h.update(config.cwd).update("\x00")
  } else {
    // http/sse: hash url + headers
    h.update(config.url ?? "").update("\x00")
    if (config.headers) {
      for (const k of Object.keys(config.headers).sort()) {
        h.update(k).update("=").update(config.headers[k]).update("\x00")
      }
    }
  }

  // env 按 key 排序后 hash
  if (config.env) {
    for (const k of Object.keys(config.env).sort()) {
      h.update(k).update("=").update(config.env[k]).update("\x00")
    }
  }

  h.update(transport)
  return h.digest("hex")
}

// ─── 存储 ──────────────────────────────────────────

export interface TrustStoreOptions {
  /** 存储文件路径，默认 <PI_CONFIG_DIR>/mcp-trust.json */
  filePath?: string
}

/**
 * 默认存储路径：PI 配置目录下的 mcp-trust.json
 */
export function defaultTrustStorePath(): string {
  const home = process.env.HOME
    || process.env.USERPROFILE
    || (process.platform === "win32" ? process.env.USERPROFILE : "/home/pi")
  const configDir = process.env.PI_CONFIG_DIR || resolve(home!, ".pi", "agent")
  return resolve(configDir, "mcp-trust.json")
}

/**
 * 信任存储实例
 */
export class TrustStore {
  private records: TrustRecord[] = []
  private readonly filePath: string

  constructor(options?: TrustStoreOptions) {
    this.filePath = options?.filePath || defaultTrustStorePath()
    this._load()
  }

  // ─── 公开方法 ──────────────────────────────────

  /**
   * 检查 server 是否受信任。
   * workspacePath + commandHash 都匹配才算信任。
   */
  isTrusted(workspacePath: string, commandHash: string): boolean {
    return this.records.some(
      (r) => r.workspacePath === workspacePath && r.commandHash === commandHash,
    )
  }

  /**
   * 添加信任记录。
   * 相同 workspace + hash 会更新时间戳。
   */
  addTrust(
    workspacePath: string,
    commandHash: string,
    label: string,
  ): void {
    // 移除旧记录（如果存在）
    this.removeTrust(workspacePath, commandHash)
    this.records.push({
      workspacePath,
      commandHash,
      label,
      trustedAt: Date.now(),
    })
    this._save()
  }

  /**
   * 移除单条信任记录。
   */
  removeTrust(workspacePath: string, commandHash: string): void {
    const before = this.records.length
    this.records = this.records.filter(
      (r) => !(r.workspacePath === workspacePath && r.commandHash === commandHash),
    )
    if (this.records.length !== before) {
      this._save()
    }
  }

  /**
   * 清空指定 workspace 的所有信任记录。
   * 用户可用 /mcp reset-trust 恢复出厂。
   */
  clearWorkspace(workspacePath: string): void {
    const before = this.records.length
    this.records = this.records.filter(
      (r) => r.workspacePath !== workspacePath,
    )
    if (this.records.length !== before) {
      this._save()
    }
  }

  /**
   * 重置所有信任。
   */
  clearAll(): void {
    if (this.records.length === 0) return
    this.records = []
    this._save()
  }

  /** 获取所有信任记录（只读快照） */
  getAllRecords(): ReadonlyArray<TrustRecord> {
    return [...this.records]
  }

  /** 获取指定 workspace 的信任记录 */
  getWorkspaceRecords(workspacePath: string): ReadonlyArray<TrustRecord> {
    return this.records.filter((r) => r.workspacePath === workspacePath)
  }

  // ─── 私有 ────────────────────────────────────

  private _load(): void {
    try {
      if (!existsSync(this.filePath)) return
      const content = readFileSync(this.filePath, "utf-8")
      const parsed = JSON.parse(content) as TrustStoreFile
      this.records = Array.isArray(parsed.records) ? parsed.records : []
    } catch {
      // 文件损坏等情况：从空记录开始
      this.records = []
    }
  }

  private _save(): void {
    try {
      mkdirSync(dirname(this.filePath), { recursive: true })
      writeFileSync(this.filePath, JSON.stringify({ records: this.records }, null, 2), "utf-8")
    } catch {
      // 写入失败静默处理
    }
  }
}
