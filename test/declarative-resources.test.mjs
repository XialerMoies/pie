import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { tmpdir } from "node:os";
import { buildDeclarativeResourceCatalog, declarativeSkillResource, declarativeSubagentResource } from "../src/agent/declarative-resources.ts";
import { handleDeclarativeResources } from "../src/server/routes/resources.ts";

describe("declarative resource catalog", () => {
  it("normalizes skills, subagents, and profiles into one metadata shape", () => {
    const catalog = buildDeclarativeResourceCatalog({
      skills: [{ id: "verify", name: "Verify", description: "facts", source: "workspace", path: "verify/SKILL.md", trust: "trusted", enabled: true, parse: "valid", declaredTools: ["file_read"], fingerprint: "a" }],
      subagents: [{ id: "reviewer", name: "Reviewer", description: "read only", prompt: "secret prompt", tools: ["search"] }],
      profiles: [{ id: "minimal", revision: 1, generation: 3, health: "ready", source: "builtin", profile: { id: "minimal", revision: 1, description: "small", toolNames: ["file_read"], presentation: "native", promptSections: [], featureGates: [], allowMcp: false, includeSkills: false }, fingerprint: "p" }],
    });
    assert.deepEqual(catalog.resources.map((item) => item.kind), ["profile", "skill", "subagent"]);
    assert.ok(catalog.resources.every((item) => item.schemaVersion === 1 && item.id && item.fingerprint));
    assert.equal("prompt" in catalog.resources.find((item) => item.kind === "subagent").declaration, false);
    assert.equal("body" in catalog.resources.find((item) => item.kind === "skill").declaration, false);
    assert.equal("path" in catalog.resources.find((item) => item.kind === "skill").declaration, false);
  });

  it("keeps trust and enablement explicit and fingerprint-stable", () => {
    const skill = { id: "x", name: "X", description: "", source: "user", path: "x/SKILL.md", trust: "untrusted", enabled: false, parse: "invalid", declaredTools: [], fingerprint: "abc" };
    const first = declarativeSkillResource(skill, 4);
    const second = declarativeSkillResource({ ...skill }, 4);
    assert.equal(first.trusted, false);
    assert.equal(first.enabled, false);
    assert.equal(first.revision, "abc");
    assert.equal(first.fingerprint, second.fingerprint);
  });

  it("does not expose subagent instructions or executable entries", () => {
    const resource = declarativeSubagentResource({ id: "r", name: "R", description: "", prompt: "do not expose", tools: ["search"] });
    assert.deepEqual(Object.keys(resource.declaration).sort(), ["description", "name", "tools"]);
    assert.equal(resource.source, "user");
  });

  it("serves a read-only route without instruction, path, or executable metadata", async () => {
    const root = mkdtempSync(join(tmpdir(), "declarative-resources-"));
    const agentsFile = join(root, "subagents.json");
    writeFileSync(agentsFile, JSON.stringify({ version: 1, agents: [{ id: "reviewer", name: "Reviewer", description: "read only", prompt: "private instructions", tools: ["search"] }] }));
    let status = 0;
    let body = "";
    try {
      const handled = await handleDeclarativeResources(
        { url: "/api/resources/catalog", method: "GET" },
        { writeHead(code) { status = code; }, end(value) { body = String(value); } },
        { groups: {
          core: { skillService: { list: async () => ({ skills: [{ id: "fact", name: "Fact", description: "facts", source: "workspace", path: "agent/skills/fact/SKILL.md", trust: "trusted", enabled: true, parse: "valid", declaredTools: ["file_read"], fingerprint: "fact-fingerprint" }] }) } },
          storage: { paths: { PI_CONFIG_DIR: root, SUBAGENTS_FILE: agentsFile } },
        } },
      );
      assert.equal(handled, true);
      assert.equal(status, 200);
      assert.equal(body.includes("private instructions"), false);
      assert.equal(body.includes("SKILL.md"), false);
      assert.equal(body.includes("prompt"), false);
      assert.equal(body.includes("execute"), false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
