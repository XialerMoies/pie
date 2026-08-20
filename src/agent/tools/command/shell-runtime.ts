import { existsSync } from "node:fs"

function stripOuterQuotes(value: string): string {
  const trimmed = value.trim()
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1)
  }
  return trimmed
}

export function resolveBashExecutable(environment: NodeJS.ProcessEnv = process.env): string | undefined {
  const configured = stripOuterQuotes(environment.MY_CODE_AGENT_BASH_PATH ?? "")
  if (configured) return existsSync(configured) ? configured : undefined
  if (process.platform !== "win32") return environment.SHELL || "bash"

  const candidates = [
    "C:\\Program Files\\Git\\bin\\bash.exe",
    "C:\\Program Files\\Git\\usr\\bin\\bash.exe",
    "C:\\Program Files (x86)\\Git\\bin\\bash.exe",
    "C:\\Program Files (x86)\\Git\\usr\\bin\\bash.exe",
  ]
  return candidates.find((candidate) => existsSync(candidate))
}
