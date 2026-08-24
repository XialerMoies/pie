import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { agentProfileRegistry, resolveAgentProfile } from "../src/agent/agent-profile.ts";
import { buildAllProfileCatalogs, buildProfileCatalog } from "../src/agent/profile-catalog.ts";
import { listPromptSections, resolveSystemPrompt } from "../src/agent/prompts.ts";
import { getCustomTools, toolRegistry } from "../src/agent/tools/index.ts";
import { checkProfileCatalog } from "../scripts/generate-profile-catalog.mjs";

describe("AP-08 profile-generated tool and prompt catalog flow", () => {
  it("matches the real registry projection and native presentation for every ready profile", () => {
    const catalogs = buildAllProfileCatalogs();
    assert.deepStrictEqual(catalogs.map((catalog) => catalog.id), ["fact-verification", "minimal", "standard"]);
    for (const catalog of catalogs) {
      const profile = resolveAgentProfile(catalog.id);
      const host = toolRegistry.project(profile.toolNames);
      const presented = getCustomTools("/workspace", undefined, undefined, profile);
      assert.deepStrictEqual(catalog.tools.map((tool) => tool.name), host.map((tool) => tool.name));
      assert.deepStrictEqual(presented.map((tool) => tool.name), catalog.tools.map((tool) => tool.name));
      assert.ok(catalog.tools.every((tool) => tool.executable && tool.enabled));
      assert.equal(catalog.presentation, profile.presentation);
      assert.deepStrictEqual(catalog.dependencies, { mcp: profile.allowMcp, skills: profile.includeSkills });
      const expectedPromptKeys = profile.promptSections === "*"
        ? listPromptSections().map((section) => section.key)
        : listPromptSections().filter((section) => profile.promptSections.includes(section.key)).map((section) => section.key);
      assert.deepStrictEqual(catalog.promptSections.map((section) => section.key), expectedPromptKeys);
      assert.ok(catalog.fingerprint.length === 64);
    }
  });

  it("keeps minimal and fact-verification capability surfaces bounded", () => {
    const minimal = buildProfileCatalog(resolveAgentProfile("minimal"));
    const fact = buildProfileCatalog(resolveAgentProfile("fact-verification"));
    assert.deepStrictEqual(minimal.tools.map((tool) => tool.name), ["command", "str_replace_editor"]);
    assert.deepStrictEqual(fact.tools.map((tool) => tool.name), ["file_read", "explorer_list", "read_memory", "list_memory", "skill_facts"]);
    assert.deepStrictEqual(minimal.dynamicSources, []);
    assert.deepStrictEqual(fact.dynamicSources, []);
  });

  it("fails closed when a model-visible tool is not executable or an extra tool is not declared", () => {
    const declared = toolRegistry.get("file_read");
    assert.ok(declared);
    const brokenRegistry = {
      resolveName: (name) => ["file_read", "explorer_list", "skill_facts", "list_memory", "read_memory"].includes(name) ? name : undefined,
      project: () => toolRegistry.project(resolveAgentProfile("fact-verification").toolNames).map((tool) => tool.name === "file_read" ? { ...tool, execute: undefined } : tool),
      getAll: () => toolRegistry.getAll(),
    };
    assert.throws(() => buildProfileCatalog(resolveAgentProfile("fact-verification"), { registry: brokenRegistry }), /not executable/u);

    const extra = { ...declared, name: "undeclared_extra" };
    const extraRegistry = {
      resolveName: (name) => ["file_read", "explorer_list", "skill_facts", "list_memory", "read_memory"].includes(name) ? name : name === "undeclared_extra" ? "undeclared_extra" : undefined,
      project: () => [declared, extra],
      getAll: () => [declared, extra],
    };
    assert.throws(() => buildProfileCatalog(resolveAgentProfile("fact-verification"), { registry: extraRegistry }), /projection mismatch/u);
  });

  it("represents broken and unavailable profiles without standard fallback", () => {
    const broken = { id: "catalog-broken", revision: 1, generation: 9001, health: "broken", source: "workspace", error: { code: "profile_broken", message: "missing tool" } };
    const unavailable = { id: "catalog-unavailable", revision: 1, generation: 9002, health: "unavailable", source: "workspace", error: { code: "profile_unavailable", message: "not installed" } };
    const brokenCatalog = buildProfileCatalog(broken);
    const unavailableCatalog = buildProfileCatalog(unavailable);
    assert.equal(brokenCatalog.health, "broken");
    assert.equal(unavailableCatalog.health, "unavailable");
    assert.deepStrictEqual(brokenCatalog.tools, []);
    assert.deepStrictEqual(unavailableCatalog.tools, []);
    assert.ok(brokenCatalog.errors?.[0].includes("missing tool"));
    assert.ok(unavailableCatalog.errors?.[0].includes("not installed"));
  });

  it("keeps the generated artifact deterministic and exposes only selected prompt content", async () => {
    const result = await checkProfileCatalog();
    assert.equal(result.ok, true, result.reason);
    const fact = buildProfileCatalog(resolveAgentProfile("fact-verification"));
    const prompt = resolveSystemPrompt(resolveAgentProfile("fact-verification").promptSections);
    assert.ok(prompt.includes("事实核验 Profile"));
    assert.ok(!prompt.includes("你是 My Code Agent，一个基于 PI 框架"));
    assert.ok(fact.promptSections.every((section) => section.contentFingerprint.length === 64));
  });
});
