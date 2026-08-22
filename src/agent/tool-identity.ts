/** Canonical identity for observed legacy tool names. */
export const LEGACY_TOOL_ALIASES: Readonly<Record<string, string>> = Object.freeze({
  "file-read": "file_read",
  "explorer-list": "explorer_list",
})

export function canonicalToolName(name: string): string {
  const normalized = String(name || "").trim()
  return LEGACY_TOOL_ALIASES[normalized] || normalized
}
