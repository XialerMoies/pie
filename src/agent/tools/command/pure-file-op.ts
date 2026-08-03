import type { SecurityParseResult } from "./security-ast.js"

const PURE_FILE_COMMANDS = new Set([
  "cat", "type", "head", "tail", "more", "uniq", "wc", "cut", "paste", "column", "tr",
  "file", "stat", "diff", "fc", "strings", "hexdump", "od", "base64", "nl", "grep",
  "rg", "findstr", "sort", "jq",
  "touch", "mkdir", "cp", "copy", "mv", "move", "rm", "rmdir", "del", "erase", "rd",
])

const ECHO_COMMANDS = new Set(["echo", "printf"])

function commandName(argv: readonly string[]): string {
  const raw = argv[0] || ""
  const name = raw.replace(/^.*[\\/]/, "")
  return name.toLowerCase().replace(/\.exe$/, "")
}

/**
 * Classify only statically understood, file-oriented shell commands.
 * Unknown commands and complex syntax intentionally return false.
 */
export function isPureFileOperation(parsed: SecurityParseResult): boolean {
  if (parsed.kind !== "simple" || parsed.commands.length === 0) return false
  if (parsed.commands.some((command) => command.envVars.length > 0)) return false

  return parsed.commands.every((command) => {
    const name = commandName(command.argv)
    if (ECHO_COMMANDS.has(name)) {
      return command.redirects.some((redirect) => redirect.isOutput && !redirect.isSafeReadOnlySink)
    }
    if (!PURE_FILE_COMMANDS.has(name)) return false
    return true
  })
}

/** A single static git invocation, excluding shell fan-out and redirection. */
export function isRegularGitOperation(parsed: SecurityParseResult): boolean {
  if (parsed.kind !== "simple" || parsed.commands.length !== 1) return false
  const command = parsed.commands[0]!
  if (command.nextOperator || command.redirects.length > 0) return false
  const name = commandName(command.argv)
  return name === "git"
}
