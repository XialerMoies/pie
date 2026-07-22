/**
 * MCP 配置加载 — 多路径发现 + 校验
 *
 * 扫描路径（优先级从高到低）：
 *   1. <project-root>/.mcp.json
 *   2. <project-root>/.vscode/mcp.json
 *   3. <global-config-dir>/mcp.json
 *
 * 所有配置合并后返回 McpConfigSource[]，
 * 同名 server 以高优先级覆盖低优先级。
 */

import { existsSync, readFileSync } from "node:fs"
import { resolve } from "node:path"
import type { McpServerConfig, McpConfigFile, McpConfigSource } from "./types"

// ─── 校验 ──────────────────────────────────────────

export interface ValidationError {
  path: string
  message: string
}

/**
 * 校验单条 McpServerConfig。
 *
 * 传输层校验规则：
 * - stdio: command 必填
 * - http/sse: url 必填且为有效 URL
 */
export function validateServerConfig(
  name: string,
  config: unknown,
): ValidationError[] {
  const errors: ValidationError[] = []

  if (!config || typeof config !== "object") {
    errors.push({ path: `servers.${name}`, message: "必须是对象" })
    return errors
  }

  const c = config as Record<string, unknown>
  const transport = typeof c.transport === "string" ? c.transport : "stdio"

  // 传输层类型
  const validTransports = ["stdio", "http", "sse"]
  if (c.transport !== undefined && !validTransports.includes(c.transport as string)) {
    errors.push({ path: `servers.${name}.transport`, message: `不支持的传输层: ${c.transport}（支持: ${validTransports.join(", ")}）` })
  }

  if (transport === "stdio") {
    // stdio: command 必填
    if (typeof c.command !== "string" || c.command.trim() === "") {
      errors.push({ path: `servers.${name}.command`, message: "stdio 模式下 command 必填且不能为空" })
    }
    if (c.args !== undefined) {
      if (!Array.isArray(c.args) || !c.args.every((a) => typeof a === "string")) {
        errors.push({ path: `servers.${name}.args`, message: "必须是字符串数组" })
      }
    }
    if (c.cwd !== undefined && typeof c.cwd !== "string") {
      errors.push({ path: `servers.${name}.cwd`, message: "必须是字符串" })
    }
  } else {
    // http/sse: url 必填且为合法 URL
    if (typeof c.url !== "string" || c.url.trim() === "") {
      errors.push({ path: `servers.${name}.url`, message: `${transport} 模式下 url 必填且不能为空` })
    } else {
      try { new URL(c.url.trim()) } catch {
        errors.push({ path: `servers.${name}.url`, message: `URL 格式无效: ${c.url}` })
      }
    }
    if (c.headers !== undefined) {
      if (typeof c.headers !== "object" || c.headers === null || Array.isArray(c.headers)) {
        errors.push({ path: `servers.${name}.headers`, message: "必须是对象" })
      } else {
        for (const [k, v] of Object.entries(c.headers as Record<string, unknown>)) {
          if (typeof v !== "string") {
            errors.push({ path: `servers.${name}.headers.${k}`, message: "值必须是字符串" })
          }
        }
      }
    }
  }

  // 通用字段
  if (c.env !== undefined) {
    if (typeof c.env !== "object" || c.env === null || Array.isArray(c.env)) {
      errors.push({ path: `servers.${name}.env`, message: "必须是对象" })
    } else {
      for (const [k, v] of Object.entries(c.env as Record<string, unknown>)) {
        if (typeof v !== "string") {
          errors.push({ path: `servers.${name}.env.${k}`, message: "值必须是字符串" })
        }
      }
    }
  }

  if (c.enabled !== undefined && typeof c.enabled !== "boolean") {
    errors.push({ path: `servers.${name}.enabled`, message: "必须是布尔值" })
  }

  return errors
}

/**
 * 校验并规范化 McpServerConfig。
 * 返回完整填充默认值的配置对象，附带校验错误。
 */
export function normalizeServerConfig(
  name: string,
  raw: unknown,
): { config: McpServerConfig | null; errors: ValidationError[] } {
  const errors = validateServerConfig(name, raw)
  if (errors.length > 0) return { config: null, errors }

  const c = raw as Record<string, unknown>
  const transport = (typeof c.transport === "string" ? c.transport : "stdio") as "stdio" | "http" | "sse"

  if (transport === "stdio") {
    const config: McpServerConfig = {
      command: (c.command as string).trim(),
      args: Array.isArray(c.args) ? (c.args as string[]) : [],
      env: c.env !== undefined ? (c.env as Record<string, string>) : undefined,
      cwd: typeof c.cwd === "string" ? c.cwd : undefined,
      transport: "stdio",
      enabled: typeof c.enabled === "boolean" ? c.enabled : true,
    }
    return { config, errors: [] }
  } else {
    const config: McpServerConfig = {
      transport: transport,
      url: (c.url as string).trim(),
      headers: c.headers !== undefined ? (c.headers as Record<string, string>) : undefined,
      env: c.env !== undefined ? (c.env as Record<string, string>) : undefined,
      enabled: typeof c.enabled === "boolean" ? c.enabled : true,
    }
    return { config, errors: [] }
  }
}

// ─── 发现路径 ──────────────────────────────────────

export interface McpDiscoveryOptions {
  /** 项目根目录 */
  projectRoot: string
  /** 全局配置目录，默认 ~/.pi/agent/mcp.json */
  globalConfigDir?: string
}

/** 默认全局配置路径 */
export function defaultGlobalConfigPath(): string {
  const home = process.env.HOME
    || process.env.USERPROFILE
    || (process.platform === "win32" ? process.env.USERPROFILE : "/home/pi")
  return resolve(home!, ".pi", "agent", "mcp.json")
}

/**
 * 获取候选配置文件路径列表（按优先级从高到低）
 */
export function getCandidatePaths(
  projectRoot: string,
  globalConfigDir?: string,
): { path: string; priority: number; label: string }[] {
  return [
    {
      path: resolve(projectRoot, ".mcp.json"),
      priority: 0,
      label: "项目 .mcp.json",
    },
    {
      path: resolve(projectRoot, ".vscode", "mcp.json"),
      priority: 1,
      label: ".vscode/mcp.json",
    },
    {
      path: globalConfigDir
        ? resolve(globalConfigDir, "mcp.json")
        : defaultGlobalConfigPath(),
      priority: 2,
      label: "全局配置",
    },
  ]
}

// ─── 加载 ──────────────────────────────────────────

export interface McpLoadResult {
  /** 所有发现的 server 配置（同名去重，高优先级覆盖低优先级） */
  servers: McpConfigSource[]
  /** 解析过程中的错误 */
  errors: { path: string; message: string; sourceLabel: string }[]
  /** 成功加载的配置文件路径 */
  loadedPaths: string[]
}

/**
 * 从多路径加载并合并 MCP 配置。
 *
 * 同名 server（大小写不敏感）以高优先级覆盖低优先级。
 * 同优先级同名 → 后出现的覆盖先出现的。
 */
export function loadMcpConfig(options: McpDiscoveryOptions): McpLoadResult {
  const { projectRoot, globalConfigDir } = options
  const candidates = getCandidatePaths(projectRoot, globalConfigDir)

  const result: McpLoadResult = {
    servers: [],
    errors: [],
    loadedPaths: [],
  }

  // server 名（小写）→ McpConfigSource（用于去重）
  const seen = new Map<string, number>()

  for (const candidate of candidates) {
    if (!existsSync(candidate.path)) continue

    let raw: unknown
    try {
      const content = readFileSync(candidate.path, "utf-8")
      raw = JSON.parse(content)
    } catch (e) {
      result.errors.push({
        path: candidate.path,
        message: `JSON 解析失败: ${(e as Error).message}`,
        sourceLabel: candidate.label,
      })
      continue
    }

    result.loadedPaths.push(candidate.path)

    // 校验顶层结构：servers 必须是对象（不能是数组或基本类型）
    if (
      !raw || typeof raw !== "object"
      || !("servers" in (raw as Record<string, unknown>))
      || typeof (raw as Record<string, unknown>).servers !== "object"
      || (raw as Record<string, unknown>).servers === null
      || Array.isArray((raw as Record<string, unknown>).servers)
    ) {
      result.errors.push({
        path: candidate.path,
        message: '缺少顶层 "servers" 字段',
        sourceLabel: candidate.label,
      })
      continue
    }

    const file = raw as McpConfigFile

    for (const [name, serverRaw] of Object.entries(file.servers || {})) {
      const { config, errors } = normalizeServerConfig(name, serverRaw)

      if (errors.length > 0) {
        for (const err of errors) {
          result.errors.push({
            path: err.path,
            message: err.message,
            sourceLabel: candidate.label,
          })
        }
        continue
      }

      // 去重：同名（小写）以高优先级覆盖
      const key = name.toLowerCase()
      const existingIdx = seen.get(key)

      if (existingIdx !== undefined) {
        // 迭代顺序按优先级从高到低（0, 1, 2）。
        // 已有记录优先级更高时跳过不覆盖；同优先级后出现的覆盖先出现的。
        const existing = result.servers[existingIdx]
        if (candidate.priority <= existing.priority) {
          result.servers[existingIdx] = {
            name,
            config: config!,
            sourcePath: candidate.path,
            priority: candidate.priority,
          }
        }
      } else {
        seen.set(key, result.servers.length)
        result.servers.push({
          name,
          config: config!,
          sourcePath: candidate.path,
          priority: candidate.priority,
        })
      }
    }
  }

  // 按优先级排序（同优先级保留发现顺序）
  result.servers.sort((a, b) => a.priority - b.priority)

  return result
}

/**
 * 过滤出 enabled 的 server 列表。
 */
export function getEnabledServers(loadResult: McpLoadResult): McpConfigSource[] {
  return loadResult.servers.filter((s) => s.config.enabled !== false)
}
