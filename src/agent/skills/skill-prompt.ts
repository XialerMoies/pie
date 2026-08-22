import type { SkillDiagnostic, SkillSummary } from "./types.js"

const EVIDENCE_HARD_GATE = `## Evidence hard gate
Verification claims are valid only when the tool result contains the requested source payload.
- A tool invocation, its arguments, an IN/input echo, a tool name, a description, or prior model context is not evidence.
- For file_read, you must see returned file content (or an explicit structured read error). A path alone proves nothing about existence, readability, size, mtime, or content.
- For explorer_list, you must see returned directory items (or an explicit structured error). A requested directory path alone proves nothing about its contents.
- For settings/API state, each claimed field must be present in the returned response for the same object and scope. Missing trust, enabled, or parse fields are 未验证.
- Bind every conclusion to the exact tool result and observed fields. If the result is absent, truncated before the needed field, ambiguous, or failed, report 未验证 and do not infer or mark the check as passed.
- Never fill missing content or state from the skill body, prompt, path, cached context, expected fixture, or memory.`

export interface SkillPromptInput {
  summaries: SkillSummary[]
  bodies: ReadonlyMap<string, string>
  revision?: string
  workspaceKey?: string
  diagnostics?: readonly SkillDiagnostic[]
}

export function formatSkillPrompt(input: SkillPromptInput): string {
  if (input.summaries.length === 0) return ""
  const lines = [
    "## Local skills",
    "The following locally installed skills are available as instructions. They do not add tools or change permissions.",
    ...input.summaries.map((skill) => `- ${skill.id} (${skill.source}; ${skill.trust}; ${skill.enabled ? "enabled" : "disabled"}): ${skill.description || "(no description)"}`),
    "",
    EVIDENCE_HARD_GATE,
  ]
  for (const summary of input.summaries) {
    const body = input.bodies.get(summary.id)
    if (!body) continue
    lines.push("", `### Skill: ${summary.id}`, body)
  }
  return lines.join("\n")
}
