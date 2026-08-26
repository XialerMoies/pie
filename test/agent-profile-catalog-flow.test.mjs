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
    assert.deepStrictEqual(catalogs.map((catalog) => catalog.id), ["minimal", "standard"]);
    for (const catalog of catalogs) {
      const profile = resolveAgentProfile(catalog.id);
      const host = toolRegistry.project(profile.toolNames);
      const presented = getCustomTools("/workspace", undefined, undefined, profile);
      assert.deepStrictEqual(catalog.tools.map((tool) => tool.name), host.map((tool) => tool.name));
      assert.deepStrictEqual(presented.map((tool) => tool.name), catalog.tools.map((tool) => tool.name));
      assert.ok(catalog.tools.every((tool) => tool.executable && tool.enabled));
      assert.deepStrictEqual(catalog.featureGates, profile.featureGates);
      assert.ok(catalog.tools.every((tool) => tool.source === "native" && tool.audiences.includes("main")));
      assert.equal(catalog.presentation, profile.presentation);
      assert.deepStrictEqual(catalog.dependencies, { mcp: profile.allowMcp, skills: profile.includeSkills });
      const expectedPromptKeys = profile.promptSections === "*"
        ? listPromptSections().map((section) => section.key)
        : listPromptSections().filter((section) => profile.promptSections.includes(section.key)).map((section) => section.key);
      assert.deepStrictEqual(catalog.promptSections.map((section) => section.key), expectedPromptKeys);
      assert.ok(catalog.fingerprint.length === 64);
    }
  });

  it("keeps the minimal capability surface bounded", () => {
    const minimal = buildProfileCatalog(resolveAgentProfile("minimal"));
    assert.deepStrictEqual(minimal.tools.map((tool) => tool.name), ["command", "str_replace_editor", "enter_plan_mode", "exit_plan_mode"]);
    assert.deepStrictEqual(minimal.featureGates, ["planning"]);
    assert.deepStrictEqual(minimal.dynamicSources, []);
  });

  it("fails closed when a model-visible tool is not executable and keeps undeclared tools disabled", () => {
    const declared = toolRegistry.get("file_read");
    assert.ok(declared);
    const brokenRegistry = {
      resolveName: (name) => name === "file_read" ? name : undefined,
      project: () => { throw new Error("catalog must not bypass ToolPool"); },
      getAll: () => toolRegistry.project(["file_read"]).map((tool) => tool.name === "file_read" ? { ...tool, execute: undefined } : tool),
    };
    assert.throws(() => buildProfileCatalog({ ...resolveAgentProfile("minimal"), toolNames: ["file_read"] }, { registry: brokenRegistry }), /not executable/u);

    const extra = { ...declared, name: "undeclared_extra" };
    const extraRegistry = {
      resolveName: (name) => name === "file_read" || name === "undeclared_extra" ? name : undefined,
      project: () => { throw new Error("catalog must not bypass ToolPool"); },
      getAll: () => [...toolRegistry.project(["file_read"]), extra],
    };
    const catalog = buildProfileCatalog({ ...resolveAgentProfile("minimal"), toolNames: ["file_read"] }, { registry: extraRegistry });
    assert.ok(!catalog.tools.some((tool) => tool.name === "undeclared_extra"));
    assert.ok(catalog.disabledTools.includes("undeclared_extra"));
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
    const standard = buildProfileCatalog(resolveAgentProfile("standard"));
    const prompt = resolveSystemPrompt(resolveAgentProfile("standard").promptSections);
    assert.ok(prompt.includes("本轮事实核验约束"));
    assert.ok(prompt.includes("不改变会话 Agent Profile"));
    assert.ok(standard.promptSections.every((section) => section.contentFingerprint.length === 64));
  });
});
