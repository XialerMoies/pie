/**
 * 信任存储 - 记录用户确认过的 MCP server。
 *
 * 核心逻辑：
 * - server 身份由 workspacePath + commandHash(server.launch fields) 决定
 * - command hash 变化后视为新 server，需重新确认
 * - 存储文件：<PI_USER_CONFIG>/mcp-trust.json
 */
import { createHash } from "node:crypto"
import { existsSync, readFileSync } from "node:fs"
import { resolve } from "node:path"
import { readLockedJson, updateLockedJson } from "../../data/locked-json-store.js"
import type { McpServerConfig, TrustRecord, TrustStoreFile } from "./types.js"

// --- Hash --------------------------------------------------

/**
 * 生成 MCP server 启动指纹。
 *
 * stdio: hash command + args + env + cwd + transport
 * http/sse: hash url + headers(排序) + env + transport
 *
 * 任一字段变化后 hash 变化，需重新信任确认。
 */
export function hashServerCommand(config: McpServerConfig): string {
  const transport = config.transport || "stdio"
  const h = createHash("sha256")

  if (transport === "stdio") {
    h.update(config.command ?? "").update("\x00")
    h.update((config.args ?? []).join("\x00")).update("\x00")
    if (config.cwd) h.update(config.cwd).update("\x00")
  } else {
    h.update(config.url ?? "").update("\x00")
    if (config.headers) {
      for (const key of Object.keys(config.headers).sort()) {
        h.update(key).update("=").update(config.headers[key]).update("\x00")
      }
    }
  }

  if (config.env) {
    for (const key of Object.keys(config.env).sort()) {
      h.update(key).update("=").update(config.env[key]).update("\x00")
    }
  }

  h.update(transport)
  return h.digest("hex")
}

// --- 存储 --------------------------------------------------

export interface TrustStoreOptions {
  /** 存储文件路径，默认 <PI_USER_CONFIG>/mcp-trust.json。 */
  filePath?: string
}

/** 默认存储路径：用户级 PI 配置目录下的 mcp-trust.json。 */
export function defaultTrustStorePath(): string {
  const home = process.env.HOME
    || process.env.USERPROFILE
    || (process.platform === "win32" ? process.env.USERPROFILE : "/home/pi")
  const configDir = process.env.PI_USER_CONFIG
    || process.env.PI_CONFIG_DIR
    || resolve(home!, ".pi", "agent")
  return resolve(configDir, "mcp-trust.json")
}

export class TrustStore {
  private records: TrustRecord[] = []
  private readonly filePath: string

  constructor(options?: TrustStoreOptions) {
    this.filePath = options?.filePath || defaultTrustStorePath()
    this._load()
  }

  /** 检查 server 是否受信任；workspacePath 与 commandHash 都必须匹配。 */
  isTrusted(workspacePath: string, commandHash: string): boolean {
    return this.records.some(
      (record) => record.workspacePath === workspacePath && record.commandHash === commandHash,
    )
  }

  /** 添加或刷新信任记录；相同 workspace + hash 会更新时间戳。 */
  addTrust(
    workspacePath: string,
    commandHash: string,
    label: string,
  ): Promise<void> {
    return this._update((records) => [
      ...records.filter((record) => !(record.workspacePath === workspacePath && record.commandHash === commandHash)),
      { workspacePath, commandHash, label, trustedAt: Date.now() },
    ])
  }

  removeTrust(workspacePath: string, commandHash: string): Promise<void> {
    return this._update((records) => records.filter(
      (record) => !(record.workspacePath === workspacePath && record.commandHash === commandHash),
    ))
  }

  clearWorkspace(workspacePath: string): Promise<void> {
    return this._update((records) => records.filter((record) => record.workspacePath !== workspacePath))
  }

  clearAll(): Promise<void> {
    return this._update(() => [])
  }

  /** 获取所有信任记录的只读快照。 */
  getAllRecords(): ReadonlyArray<TrustRecord> {
    return [...this.records]
  }

  /** 获取指定 workspace 的信任记录。 */
  getWorkspaceRecords(workspacePath: string): ReadonlyArray<TrustRecord> {
    return this.records.filter((record) => record.workspacePath === workspacePath)
  }

  async refresh(): Promise<void> {
    const document = await readLockedJson<TrustStoreFile>(
      this.filePath,
      () => ({ records: [] }),
      { recoverInvalidJson: true },
    )
    this.records = sanitizeTrustRecords(document)
  }

  private _load(): void {
    try {
      if (!existsSync(this.filePath)) return
      this.records = sanitizeTrustRecords(JSON.parse(readFileSync(this.filePath, "utf8")))
    } catch {
      // 文件损坏等情况：从空记录开始。
      this.records = []
    }
  }

  private async _update(updater: (records: TrustRecord[]) => TrustRecord[]): Promise<void> {
    const document = await updateLockedJson<TrustStoreFile>(
      this.filePath,
      () => ({ records: [] }),
      (current) => ({ records: updater(sanitizeTrustRecords(current)) }),
      { recoverInvalidJson: true },
    )
    this.records = sanitizeTrustRecords(document)
  }
}

function sanitizeTrustRecords(document: unknown): TrustRecord[] {
  if (!document || typeof document !== "object" || Array.isArray(document)) return []
  const records = (document as Partial<TrustStoreFile>).records
  return Array.isArray(records) ? records : []
}
