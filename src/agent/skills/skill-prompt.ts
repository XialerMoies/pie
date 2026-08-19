import type { SkillSummary } from "./types.js"

export interface SkillPromptInput {
  summaries: SkillSummary[]
  bodies: ReadonlyMap<string, string>
}

export function formatSkillPrompt(input: SkillPromptInput): string {
  if (input.summaries.length === 0) return ""
  const lines = [
    "## Local skills",
    "The following locally installed skills are available as instructions. They do not add tools or change permissions.",
    ...input.summaries.map((skill) => `- ${skill.id} (${skill.source}; ${skill.trust}; ${skill.enabled ? "enabled" : "disabled"}): ${skill.description || "(no description)"}`),
  ]
  for (const summary of input.summaries) {
    const body = input.bodies.get(summary.id)
    if (!body) continue
    lines.push("", `### Skill: ${summary.id}`, body)
  }
  return lines.join("\n")
}
