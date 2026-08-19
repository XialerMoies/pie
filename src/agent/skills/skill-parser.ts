import type { ParsedSkill, SkillDiagnostic, SkillParseResult } from "./types.js"

function failure(code: SkillDiagnostic["code"], message: string): SkillParseResult {
  return { ok: false, diagnostic: { code, message } }
}

function unquote(value: string): string {
  const trimmed = value.trim()
  if (trimmed.length >= 2 && ((trimmed.startsWith("\"") && trimmed.endsWith("\"")) || (trimmed.startsWith("'") && trimmed.endsWith("'")))) {
    return trimmed.slice(1, -1).trim()
  }
  return trimmed
}

export function parseSkillDocument(document: string, skillId: string, knownTools: ReadonlySet<string>): SkillParseResult {
  const lines = document.replace(/^\uFEFF/, "").split(/\r?\n/)
  let start = 0
  while (start < lines.length && lines[start].trim() === "") start += 1
  if (lines[start]?.trim() !== "---") return failure("invalid_frontmatter", "frontmatter must start with ---")

  const end = lines.findIndex((line, index) => index > start && line.trim() === "---")
  if (end < 0) return failure("invalid_frontmatter", "frontmatter is not closed")

  let name: string | undefined
  let description: string | undefined
  let tools: string[] = []
  let toolsSeen = false
  const seen = new Set<string>()
  for (let index = start + 1; index < end; index += 1) {
    const line = lines[index]
    if (line.trim() === "") continue
    const item = line.match(/^\s+-\s*(.*)$/)
    if (item) {
      if (!toolsSeen || !item[1].trim()) return failure("invalid_frontmatter", "tool items must be non-empty and follow tools:")
      const tool = unquote(item[1])
      if (!tool) return failure("invalid_frontmatter", "tool items must be non-empty")
      tools.push(tool)
      continue
    }
    const field = line.match(/^([A-Za-z][A-Za-z0-9_-]*):(?:\s*)(.*)$/)
    if (!field) return failure("invalid_frontmatter", `invalid frontmatter line ${index - start}`)
    const [, key, rawValue] = field
    if (seen.has(key)) return failure("invalid_frontmatter", `duplicate field: ${key}`)
    seen.add(key)
    if (key === "name") name = unquote(rawValue)
    else if (key === "description") description = unquote(rawValue)
    else if (key === "tools") {
      if (rawValue.trim()) return failure("invalid_frontmatter", "tools must be a list")
      toolsSeen = true
    }
  }

  if (!name || !seen.has("description")) return failure("invalid_frontmatter", "name and description are required")
  if (name !== skillId) return failure("name_mismatch", `name must match skill id ${skillId}`)
  if (!description?.trim()) return failure("empty_description", "description must be non-empty")
  for (const tool of tools) {
    if (!knownTools.has(tool)) return failure("unknown_tool", `unknown tool: ${tool}`)
  }
  const body = lines.slice(end + 1).join("\n").trim()
  if (!body) return failure("empty_body", "skill body must be non-empty")
  const skill: ParsedSkill = { id: skillId, name, description, declaredTools: tools, body }
  return { ok: true, skill }
}
