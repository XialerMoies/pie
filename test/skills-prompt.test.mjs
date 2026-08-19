import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { tmpdir } from "node:os";

const { formatSkillPrompt } = await import("../src/agent/skills/skill-prompt.ts");
const { AgentRuntime } = await import("../src/agent/runtime.ts");

const summary = (id, enabled) => ({
  id,
  name: id,
  description: `${id} summary`,
  source: "user",
  path: `${id}/SKILL.md`,
  trust: enabled ? "trusted" : "untrusted",
  enabled,
  parse: "valid",
  declaredTools: ["command"],
});

describe("skill prompt", () => {
  it("keeps summaries separate from bodies and includes only supplied eligible bodies", () => {
    const prompt = formatSkillPrompt({
      summaries: [summary("disabled", false), summary("enabled", true)],
      bodies: new Map([["enabled", "# Enabled body"]]),
    });
    assert.match(prompt, /enabled summary/);
    assert.match(prompt, /# Enabled body/);
    assert.doesNotMatch(prompt, /disabled body/);
  });

  it("does not include absolute paths or raw state documents", () => {
    const prompt = formatSkillPrompt({ summaries: [summary("one", false)], bodies: new Map() });
    assert.doesNotMatch(prompt, /[A-Z]:\\|\/Users\/|skill-state\.json/);
    assert.doesNotMatch(prompt, /fingerprint|confirmedAt/);
  });

  it("binds runtime prompt assembly to the session cwd skill root", async () => {
    const cwd = join(tmpdir(), "runtime-skill-workspace");
    const roots = [];
    const runtime = Object.create(AgentRuntime.prototype);
    runtime.config = {
      skillService: {
        promptInput: async (workspaceSkillRoot) => {
          roots.push(workspaceSkillRoot);
          return { summaries: [summary("enabled", true)], bodies: new Map([["enabled", "# Bound body"]]) };
        },
      },
    };

    const prompt = await runtime._buildSystemPrompt(cwd);
    assert.deepEqual(roots, [join(cwd, "agent", "skills")]);
    assert.match(prompt, /# Bound body/);
  });
});
