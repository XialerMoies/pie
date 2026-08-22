import { isCommandSafeViaFlagParsing } from "./read-only-command-validation.js"
import { parseCommandForSecurityLegacyFallback } from "./security-parser.js"
import type { SecurityParseOptions, SecurityParseResult, SecurityRedirect, SimpleCommand } from "./security-ast.js"

const READONLY_SIMPLE = new Set([
  "ls", "cat", "head", "tail", "less", "more",
  "grep", "egrep", "fgrep", "rg", "ag",
  "wc", "uniq", "cut", "tr", "od", "xxd", "hexdump", "nl",
  "which", "whereis", "type",
  "pwd", "date", "cal", "whoami", "id", "uname", "hostname", "uptime",
  "who", "w", "last",
  "echo", "printf", "printenv",
  "stat", "file", "du", "df",
  "dig", "nslookup", "ping", "traceroute", "tracepath",
  "ss", "netstat", "lsof",
  "dir", "fc", "findstr", "where",
])

function hasUnsafeOutput(redirects: readonly SecurityRedirect[]): boolean {
  return redirects.some((redirect) => redirect.isOutput && !redirect.isSafeReadOnlySink)
}

function isSimpleCommandReadOnly(command: SimpleCommand): boolean {
  if (hasUnsafeOutput(command.redirects)) return false

  const tokens = command.argv
  if (!tokens.length) return false
  const cmd = tokens[0]?.toLowerCase()
  const firstArg = tokens[1]

  if (cmd === "cd" || cmd === "pushd") return true
  if (READONLY_SIMPLE.has(cmd)) return true
  if (cmd === "env") return tokens.length === 1
  if (cmd === "command") return tokens.length >= 2 && firstArg === "-v"
  if (cmd === "node" || cmd === "node.exe") return false
  return isCommandSafeViaFlagParsing(tokens)
}

export function isCommandReadOnly(
  command: string,
  options: SecurityParseOptions & { parsed?: SecurityParseResult } = {},
): boolean {
  const trimmed = command.trim()
  if (!trimmed) return false

  const parsed = options.parsed ?? parseCommandForSecurityLegacyFallback(trimmed, options)
  if (parsed.kind !== "simple") return false
  return parsed.commands.every((command) => isSimpleCommandReadOnly(command))
}
