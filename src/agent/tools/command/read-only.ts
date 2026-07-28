import { isCommandSafeViaFlagParsing } from "./read-only-command-validation.js"
import { parseShellCommand, tokensWithoutRedirects, type ShellSegment } from "./shell-parser.js"

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

function segmentHasUnsafeOutput(segment: ShellSegment): boolean {
  return segment.redirects.some((redirect) => redirect.isOutput && !redirect.isSafeReadOnlySink)
}

function isSegmentReadOnly(segment: ShellSegment): boolean {
  if (segment.parseError || segment.hasNewline || segment.hasShellExpansion) return false
  if (segmentHasUnsafeOutput(segment)) return false

  const tokens = tokensWithoutRedirects(segment)
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

export function isCommandReadOnly(command: string): boolean {
  const trimmed = command.trim()
  if (!trimmed) return false

  const parsed = parseShellCommand(trimmed)
  if (!parsed.ok) return false
  return parsed.segments.every((segment) => isSegmentReadOnly(segment))
}
