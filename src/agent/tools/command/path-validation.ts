import path from "path"
import { parseShellCommand, tokensWithoutRedirects, type ShellSegment } from "./shell-parser.js"

export type PathValidationResult =
  | { allowed: true }
  | { allowed: false; reason: string; requiresConfirmation: true }

export interface PathValidationOptions {
  cwd: string
  workspaceRoot?: string
}

type PathOperation = "read" | "write" | "remove"

interface CommandPathArg {
  token: string
  operation: PathOperation
}

const WRITE_COMMANDS = new Set([
  "touch",
  "mkdir",
  "cp",
  "copy",
  "mv",
  "move",
  "rm",
  "rmdir",
  "del",
  "erase",
  "rd",
  "remove-item",
  "new-item",
  "set-content",
  "add-content",
  "out-file",
])

function normalizeForCompare(value: string): string {
  const resolved = path.resolve(value)
  const normalized = path.normalize(resolved)
  return process.platform === "win32" ? normalized.toLowerCase() : normalized
}

function isInsidePath(candidate: string, root: string): boolean {
  const child = normalizeForCompare(candidate)
  const parent = normalizeForCompare(root)
  if (child === parent) return true
  const rel = path.relative(parent, child)
  return !!rel && !rel.startsWith("..") && !path.isAbsolute(rel)
}

function isUnresolvedPathToken(token: string): boolean {
  return /[$%{}*?]/.test(token) || token.startsWith("~")
}

function operationLabel(operation: PathOperation): string {
  if (operation === "read") return "读取"
  if (operation === "remove") return "删除"
  return "写入"
}

function resolveTargetPath(token: string, cwd: string): { path?: string; uncertain?: string } {
  if (!token) return { uncertain: "缺少路径参数" }
  const lowered = token.replace(/\\/g, "/").toLowerCase()
  if (lowered === "/dev/null" || lowered === "nul") return {}
  if (isUnresolvedPathToken(token)) return { uncertain: `路径包含变量、通配符或用户目录: ${token}` }
  if (/^\/[A-Za-z0-9_.-]/.test(token)) return { path: token }
  return { path: path.resolve(cwd, token) }
}

function validateTarget(token: string | undefined, operation: PathOperation, cwd: string, workspaceRoot: string): PathValidationResult {
  const label = operationLabel(operation)
  if (!token) {
    return { allowed: false, reason: `命令包含缺少目标的${label}路径`, requiresConfirmation: true }
  }
  const resolved = resolveTargetPath(token, cwd)
  if (resolved.uncertain) {
    return { allowed: false, reason: `${label}${resolved.uncertain}`, requiresConfirmation: true }
  }
  if (!resolved.path) return { allowed: true }
  if (!isInsidePath(resolved.path, workspaceRoot)) {
    return {
      allowed: false,
      reason: `${label}路径不在 workspace 内: ${token}`,
      requiresConfirmation: true,
    }
  }
  return { allowed: true }
}

function isOptionToken(cmd: string, arg: string): boolean {
  if (arg === "-") return false
  if (arg.startsWith("-")) return true
  if (!arg.startsWith("/")) return false
  const windowsSwitchCommands = new Set(["copy", "move", "del", "erase", "rd", "rmdir"])
  return windowsSwitchCommands.has(cmd) && /^\/[a-z?]+$/i.test(arg)
}

function pathArgsOnly(cmd: string, args: string[]): string[] {
  const result: string[] = []
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (!arg) continue
    if (arg === "--") {
      result.push(...args.slice(i + 1))
      break
    }
    if (isOptionToken(cmd, arg)) continue
    result.push(arg)
  }
  return result
}

function commandPathArgs(tokens: string[]): CommandPathArg[] {
  const cmd = tokens[0]?.toLowerCase()
  const args = tokens.slice(1)
  if (!cmd || !WRITE_COMMANDS.has(cmd)) return []

  if (cmd === "out-file" || cmd === "set-content" || cmd === "add-content") {
    const explicitPath = args.findIndex((arg) => /^-(filepath|literalpath|path)$/i.test(arg))
    if (explicitPath !== -1 && args[explicitPath + 1]) return [{ token: args[explicitPath + 1], operation: "write" }]
    const positional = pathArgsOnly(cmd, args)
    return positional[0] ? [{ token: positional[0], operation: "write" }] : []
  }

  if (cmd === "cp" || cmd === "copy") {
    const explicitTarget = args.findIndex((arg) => arg === "-t" || arg === "--target-directory")
    if (explicitTarget !== -1 && args[explicitTarget + 1]) {
      const paths = pathArgsOnly(cmd, args.filter((_, index) => index !== explicitTarget && index !== explicitTarget + 1))
      return [
        { token: args[explicitTarget + 1], operation: "write" },
        ...paths.map((token) => ({ token, operation: "read" as const })),
      ]
    }
    const inlineTarget = args.find((arg) => arg.startsWith("--target-directory="))
    if (inlineTarget) {
      const target = inlineTarget.slice("--target-directory=".length)
      const paths = pathArgsOnly(cmd, args.filter((arg) => arg !== inlineTarget))
      return [
        { token: target, operation: "write" },
        ...paths.map((token) => ({ token, operation: "read" as const })),
      ]
    }
    const paths = pathArgsOnly(cmd, args)
    if (paths.length <= 1) return paths.map((token) => ({ token, operation: "read" }))
    return [
      ...paths.slice(0, -1).map((token) => ({ token, operation: "read" as const })),
      { token: paths[paths.length - 1], operation: "write" },
    ]
  }

  if (cmd === "mv" || cmd === "move") {
    const paths = pathArgsOnly(cmd, args)
    if (paths.length <= 1) return paths.map((token) => ({ token, operation: "remove" }))
    return [
      ...paths.slice(0, -1).map((token) => ({ token, operation: "remove" as const })),
      { token: paths[paths.length - 1], operation: "write" },
    ]
  }

  const operation: PathOperation = ["rm", "rmdir", "del", "erase", "rd", "remove-item"].includes(cmd)
    ? "remove"
    : "write"
  return pathArgsOnly(cmd, args).map((token) => ({ token, operation }))
}

function segmentChangesDirectory(segment: ShellSegment): boolean {
  const tokens = tokensWithoutRedirects(segment)
  const cmd = tokens[0]?.toLowerCase()
  return cmd === "cd" || cmd === "pushd"
}

export function validateCommandPaths(command: string, options: PathValidationOptions): PathValidationResult {
  const cwd = path.resolve(options.cwd || process.cwd())
  const workspaceRoot = path.resolve(options.workspaceRoot || cwd)

  if (!isInsidePath(cwd, workspaceRoot)) {
    return {
      allowed: false,
      reason: `工作目录不在 workspace 内: ${cwd}`,
      requiresConfirmation: true,
    }
  }

  const parsed = parseShellCommand(command)
  if (!parsed.ok) {
    return {
      allowed: false,
      reason: parsed.error ?? "命令解析失败，无法验证路径",
      requiresConfirmation: true,
    }
  }

  for (const segment of parsed.segments) {
    if (segmentChangesDirectory(segment) && segment.nextOperator) {
      return {
        allowed: false,
        reason: "命令包含 cd/pushd 后继续执行，无法静态确认后续写入路径",
        requiresConfirmation: true,
      }
    }

    for (const redirect of segment.redirects) {
      if (!redirect.isOutput || redirect.isSafeReadOnlySink) continue
      const result = validateTarget(redirect.target, "write", cwd, workspaceRoot)
      if (!result.allowed) return result
    }

    const tokens = tokensWithoutRedirects(segment)
    for (const target of commandPathArgs(tokens)) {
      const result = validateTarget(target.token, target.operation, cwd, workspaceRoot)
      if (!result.allowed) return result
    }
  }

  return { allowed: true }
}
