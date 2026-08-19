import { describe, it } from "node:test";
import assert from "node:assert/strict";

const { parseSkillDocument } = await import("../src/agent/skills/skill-parser.ts");

const tools = new Set(["command", "file-read"]);
const valid = "---\nname: release-check\ndescription: Run release checks\ntools:\n  - command\n  - file-read\n---\n\n# Release\n\nRun the checks.";

describe("skill document parser", () => {
  it("parses minimal frontmatter and keeps body separate", () => {
    assert.deepEqual(parseSkillDocument(valid, "release-check", tools), {
      ok: true,
      skill: {
        id: "release-check",
        name: "release-check",
        description: "Run release checks",
        declaredTools: ["command", "file-read"],
        body: "# Release\n\nRun the checks.",
      },
    });
  });

  it("rejects missing or malformed frontmatter", () => {
    for (const document of ["# no frontmatter", "---\nname: x\n---\nbody", "---\nname release\ndescription: x\n---\nbody"]) {
      const result = parseSkillDocument(document, "x", tools);
      assert.equal(result.ok, false);
      assert.equal(result.diagnostic.code, "invalid_frontmatter");
    }
  });

  it("rejects name mismatch and empty description", () => {
    const mismatch = parseSkillDocument("---\nname: other\ndescription: useful\n---\nbody", "x", tools);
    assert.equal(mismatch.ok, false);
    assert.equal(mismatch.diagnostic.code, "name_mismatch");
    const empty = parseSkillDocument("---\nname: x\ndescription:   \n---\nbody", "x", tools);
    assert.equal(empty.ok, false);
    assert.equal(empty.diagnostic.code, "empty_description");
  });

  it("rejects unknown tools, duplicate fields, and empty tool items", () => {
    const unknown = parseSkillDocument("---\nname: x\ndescription: useful\ntools:\n  - missing\n---\nbody", "x", tools);
    assert.equal(unknown.ok, false);
    assert.equal(unknown.diagnostic.code, "unknown_tool");
    const duplicate = parseSkillDocument("---\nname: x\nname: x\ndescription: useful\n---\nbody", "x", tools);
    assert.equal(duplicate.ok, false);
    assert.equal(duplicate.diagnostic.code, "invalid_frontmatter");
    const emptyItem = parseSkillDocument("---\nname: x\ndescription: useful\ntools:\n  -\n---\nbody", "x", tools);
    assert.equal(emptyItem.ok, false);
    assert.equal(emptyItem.diagnostic.code, "invalid_frontmatter");
  });

  it("rejects an empty body", () => {
    const result = parseSkillDocument("---\nname: x\ndescription: useful\n---\n\n", "x", tools);
    assert.equal(result.ok, false);
    assert.equal(result.diagnostic.code, "empty_body");
  });
});
