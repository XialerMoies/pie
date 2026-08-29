import { parseShellCommand, shellDialectFromEnv, tokensWithoutRedirects, type ShellRedirect, type ShellSegment } from "./shell-parser.js"
import type { SecurityParseOptions, SecurityParseResult, SecurityRedirect, ShellDialect, SimpleCommand } from "./security-ast.js"
import { parseBashCommandWithTreeSitter } from "./tree-sitter-bash-parser.js"
import type { SecurityParserProvider } from "../../capability-contracts.js"

const MAX_SECURITY_COMMAND_LENGTH = 20_000
const MAX_SHELL_WRAPPER_DEPTH = 3
const CONTROL_CHAR_RE = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/
const UNICODE_WHITESPACE_RE = /[\u00A0\u1680\u180E\u2000-\u200B\u2028\u2029\u202F\u205F\u3000\uFEFF]/
const POSIX_SHELLS = new Set(["bash", "bash.exe", "sh", "sh.exe", "zsh", "zsh.exe"])

export function defaultShellDialect(): ShellDialect {
  return shellDialectFromEnv() ?? (process.platform === "win32" ? "cmd" : "posix-bash")
}

function envAssignment(token: string): { name: string; value: string } | null {
  const match = token.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/)
  if (!match) return null
  return { name: match[1]!, value: match[2] ?? "" }
}

function redirectFd(redirect: ShellRedirect): number | undefined {
  const match = redirect.operator.match(/^(\d+)/)
  return match ? Number(match[1]) : undefined
}

function toSecurityRedirect(redirect: ShellRedirect): SecurityRedirect {
  return {
    operator: redirect.operator,
    target: redirect.target,
    fd: redirectFd(redirect),
    isOutput: redirect.isOutput,
    isFdRedirect: redirect.isFdRedirect,
    isSafeReadOnlySink: redirect.isSafeReadOnlySink,
  }
}

function toSimpleCommand(segment: ShellSegment, dialect: ShellDialect): SimpleCommand {
  const tokens = tokensWithoutRedirects(segment)
  const envVars: SimpleCommand["envVars"] = []
  let argvStart = 0

  if (dialect === "posix-bash") {
    while (argvStart < tokens.length) {
      const assignment = envAssignment(tokens[argvStart]!)
      if (!assignment) break
      envVars.push(assignment)
      argvStart++
    }
  }

  return {
    argv: tokens.slice(argvStart),
    envVars,
    redirects: segment.redirects.map(toSecurityRedirect),
    text: segment.text,
    start: segment.start,
    end: segment.end,
    dialect,
    nextOperator: segment.nextOperator,
  }
}

function splitShortShellFlags(arg: string): string[] {
  if (!arg.startsWith("-") || arg.startsWith("--")) return [arg]
  return arg.slice(1).split("").map((flag) => `-${flag}`)
}

function extractShellWrapperCommand(argv: readonly string[]): string | undefined {
  const name = argv[0]?.toLowerCase()
  if (!name || !POSIX_SHELLS.has(name)) return undefined

  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i]
    if (!arg) continue
    if (arg === "--") continue
    if (arg === "-c") return argv[i + 1]
    if (arg.startsWith("--")) continue

    const flags = splitShortShellFlags(arg)
    if (flags.includes("-c")) return argv[i + 1]
  }

  return undefined
}

function parseWithLegacyAdapter(command: string, dialect: ShellDialect): SecurityParseResult {
  const parsed = parseShellCommand(command, { shellDialect: dialect })
  if (!parsed.ok) {
    return {
      kind: "too-complex",
      reason: parsed.error ?? "Command could not be parsed safely",
    }
  }

  const commands = parsed.segments
    .map((segment) => toSimpleCommand(segment, dialect))
    .filter((command) => command.argv.length > 0 || command.redirects.length > 0 || command.envVars.length > 0)

  return {
    kind: "simple",
    commands,
    redirects: commands.flatMap((command) => command.redirects),
    dialect,
  }
}

function parseShellWrapperIfPresent(result: SecurityParseResult, depth: number): SecurityParseResult {
  if (result.kind !== "simple") return result
  if (depth >= MAX_SHELL_WRAPPER_DEPTH) return { kind: "too-complex", reason: "Shell wrapper nesting is too deep" }
  if (result.commands.length !== 1) return result

  const [command] = result.commands
  if (!command || command.redirects.length > 0 || command.envVars.length > 0) return result

  const inner = extractShellWrapperCommand(command.argv)
  if (inner === undefined) return result
  if (!inner.trim()) return { kind: "too-complex", reason: "Shell wrapper is missing -c command content" }

  const innerResult = parseCommandForSecurityLegacyFallback(inner, { shellDialect: "posix-bash" }, depth + 1)
  if (innerResult.kind === "simple") return innerResult
  if (innerResult.kind === "too-complex") {
    return { kind: "too-complex", reason: `Shell wrapper inner command is too complex: ${innerResult.reason}` }
  }
  return { kind: "too-complex", reason: "Shell wrapper inner command could not be parsed safely" }
}

async function parseShellWrapperIfPresentAsync(result: SecurityParseResult, depth: number): Promise<SecurityParseResult> {
  if (result.kind !== "simple") return result
  if (depth >= MAX_SHELL_WRAPPER_DEPTH) return { kind: "too-complex", reason: "Shell wrapper nesting is too deep" }
  if (result.commands.length !== 1) return result

  const inner = extractShellWrapperCommand(result.commands[0]!.argv)
  if (inner === undefined) return result

  const innerResult = await parseCommandForSecurityAsync(inner, { shellDialect: "posix-bash" }, depth + 1)
  if (innerResult.kind === "simple") return innerResult
  if (innerResult.kind === "too-complex") return innerResult
  return { kind: "too-complex", reason: "Shell wrapper inner command could not be parsed safely" }
}

function precheckCommand(command: string, dialect: ShellDialect): SecurityParseResult | undefined {
  if (command === "") return { kind: "simple", commands: [], redirects: [], dialect }
  if (command.length > MAX_SECURITY_COMMAND_LENGTH) {
    return { kind: "too-complex", reason: "Command is too long to parse within the security budget" }
  }
  if (CONTROL_CHAR_RE.test(command)) {
    return { kind: "too-complex", reason: "Command contains control characters" }
  }
  if (UNICODE_WHITESPACE_RE.test(command)) {
    return { kind: "too-complex", reason: "Command contains Unicode whitespace characters" }
  }
  return undefined
}

function parseWithLegacyFacade(command: string, dialect: ShellDialect, depth: number): SecurityParseResult {
  return parseShellWrapperIfPresent(parseWithLegacyAdapter(command, dialect), depth)
}

/**
 * Synchronous parser consumers are explicit fallback paths. The async command
 * execution path below is the canonical parser and must not silently fall back
 * to this implementation when the POSIX Tree-sitter parser is unavailable.
 */
export function parseCommandForSecurityLegacyFallback(
  command: string,
  options: SecurityParseOptions = {},
  depth = 0,
): SecurityParseResult {
  const dialect = options.shellDialect ?? defaultShellDialect()
  const precheck = precheckCommand(command, dialect)
  if (precheck) return precheck
  return parseWithLegacyFacade(command, dialect, depth)
}

export function envFlagEnabled(name: string): boolean {
  const value = process.env[name]?.toLowerCase()
  return value === "1" || value === "true" || value === "yes" || value === "on"
}

function normalizedRedirectForShadow(redirect: SecurityRedirect): object {
  return {
    operator: redirect.operator,
    target: redirect.target,
    fd: redirect.fd,
    isOutput: redirect.isOutput,
    isFdRedirect: redirect.isFdRedirect,
    isSafeReadOnlySink: redirect.isSafeReadOnlySink,
  }
}

function normalizedResultForShadow(result: SecurityParseResult): object {
  if (result.kind === "simple") {
    return {
      kind: result.kind,
      dialect: result.dialect,
      commands: result.commands.map((command) => ({
        argv: command.argv,
        envVars: command.envVars,
        redirects: command.redirects.map(normalizedRedirectForShadow),
        nextOperator: command.nextOperator,
      })),
      redirects: result.redirects.map(normalizedRedirectForShadow),
    }
  }

  if (result.kind === "too-complex") {
    // Reason text and parser node types are diagnostics, not security
    // semantics. Both parsers reaching too-complex is parity.
    return { kind: result.kind }
  }

  return { kind: result.kind }
}

export function securityParseResultsDifferForShadow(left: SecurityParseResult, right: SecurityParseResult): boolean {
  return JSON.stringify(normalizedResultForShadow(left)) !== JSON.stringify(normalizedResultForShadow(right))
}

function treeSitterShadowEnabled(): boolean {
  return envFlagEnabled("MY_CODE_AGENT_TREE_SITTER_SHADOW") || envFlagEnabled("MY_CODE_AGENT_TREE_SITTER_SHADOW_ONLY")
}

function logTreeSitterShadowDiff(command: string, dialect: ShellDialect, treeSitter: SecurityParseResult, legacy: SecurityParseResult): void {
  if (!treeSitterShadowEnabled()) return
  if (!securityParseResultsDifferForShadow(treeSitter, legacy)) return

  console.debug("[command-security] Tree-sitter shadow diff", {
    command,
    dialect,
    treeSitter: normalizedResultForShadow(treeSitter),
    legacy: normalizedResultForShadow(legacy),
  })
}

export async function parseCommandForSecurityAsync(
  command: string,
  options: SecurityParseOptions = {},
  depth = 0,
): Promise<SecurityParseResult> {
  const dialect = options.shellDialect ?? defaultShellDialect()
  const precheck = precheckCommand(command, dialect)
  if (precheck) return precheck

  if (dialect === "posix-bash") {
    const parsed = await parseBashCommandWithTreeSitter(command, { shellDialect: dialect }, depth)
    if (parsed.kind !== "parse-unavailable") {
      if (treeSitterShadowEnabled()) {
        const legacy = parseWithLegacyFacade(command, dialect, depth)
        logTreeSitterShadowDiff(command, dialect, parsed, legacy)
      }
      return parsed
    }

    // A missing/unloadable POSIX parser is a security failure, not permission
    // to silently downgrade the production command path to the legacy parser.
    return {
      kind: "too-complex",
      reason: `Tree-sitter security parser unavailable; command requires confirmation: ${parsed.reason ?? "unknown parser error"}`,
    }
  }

  // cmd is intentionally supported by the legacy parser until a native
  // Windows grammar is introduced. Keep this fallback explicit and bounded.
  const result = parseWithLegacyAdapter(command, dialect)
  return parseShellWrapperIfPresentAsync(result, depth)
}

export async function parseCommandForSecurityWithTreeSitterAsync(
  command: string,
  options: SecurityParseOptions = {},
  depth = 0,
): Promise<SecurityParseResult> {
  const dialect = options.shellDialect ?? defaultShellDialect()
  const precheck = precheckCommand(command, dialect)
  if (precheck) return precheck
  if (dialect !== "posix-bash") {
    return { kind: "parse-unavailable", reason: "Tree-sitter bash parser only supports POSIX shell" }
  }
  return parseShellWrapperIfPresentAsync(
    await parseBashCommandWithTreeSitter(command, { shellDialect: dialect }, depth),
    depth,
  )
}

/** Required Component binding for the canonical command security parser. */
export const securityParserProvider: SecurityParserProvider = Object.freeze({
  kind: "security-parser" as const,
  parse: parseCommandForSecurityAsync,
  parseLegacy: parseCommandForSecurityLegacyFallback,
  parseTreeSitter: parseCommandForSecurityWithTreeSitterAsync,
  health: () => ({ status: "healthy" as const }),
  dispose: () => {},
})
