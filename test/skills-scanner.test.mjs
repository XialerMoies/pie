import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, symlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const { scanSkillRoots } = await import("../src/agent/skills/skill-scanner.ts");

const doc = (name, description = "Useful skill") => `---\nname: ${name}\ndescription: ${description}\ntools:\n  - command\n---\n\n# ${name}\n\nBody`;

describe("skill root scanner", () => {
  it("scans direct child skills and reports facts", async () => {
    const user = await mkdtemp(join(tmpdir(), "skills-user-"));
    const workspace = await mkdtemp(join(tmpdir(), "skills-workspace-"));
    await mkdir(join(user, "release-check"));
    await writeFile(join(user, "release-check", "SKILL.md"), doc("release-check"));
    const result = await scanSkillRoots({ userRoot: user, workspaceRoot: workspace, knownTools: new Set(["command"]) });
    assert.equal(result.skills.length, 1);
    assert.equal(result.skills[0].source, "user");
    assert.equal(result.skills[0].id, "release-check");
    assert.equal(result.skills[0].relativePath, "release-check/SKILL.md");
    assert.equal(result.skills[0].parse, "valid");
    assert.match(result.skills[0].fingerprint, /^[a-f0-9]{64}$/);
  });

  it("does not recurse or follow symlinked skill directories", async () => {
    const user = await mkdtemp(join(tmpdir(), "skills-user-"));
    const workspace = await mkdtemp(join(tmpdir(), "skills-workspace-"));
    await mkdir(join(user, "nested", "hidden"), { recursive: true });
    await writeFile(join(user, "nested", "hidden", "SKILL.md"), doc("hidden"));
    const outside = await mkdtemp(join(tmpdir(), "skills-outside-"));
    await mkdir(join(outside, "linked"));
    await writeFile(join(outside, "linked", "SKILL.md"), doc("linked"));
    await symlink(join(outside, "linked"), join(user, "linked"), "junction");
    const result = await scanSkillRoots({ userRoot: user, workspaceRoot: workspace, knownTools: new Set(["command"]) });
    assert.deepEqual(result.skills, []);
  });

  it("rejects a workspace agent or skills junction", async () => {
    const user = await mkdtemp(join(tmpdir(), "skills-user-"));
    const workspace = await mkdtemp(join(tmpdir(), "skills-workspace-"));
    const outside = await mkdtemp(join(tmpdir(), "skills-outside-"));
    await mkdir(join(outside, "skills", "linked"), { recursive: true });
    await writeFile(join(outside, "skills", "linked", "SKILL.md"), doc("linked"));
    await symlink(outside, join(workspace, "agent"), "junction");
    const result = await scanSkillRoots({ userRoot: user, workspaceRoot: join(workspace, "agent", "skills"), knownTools: new Set(["command"]) });
    assert.deepEqual(result.skills, []);
    assert.ok(result.diagnostics.some((diagnostic) => diagnostic.code === "path_rejected"));
  });

  it("returns malformed entries as diagnostics and gives workspace precedence", async () => {
    const user = await mkdtemp(join(tmpdir(), "skills-user-"));
    const workspace = await mkdtemp(join(tmpdir(), "skills-workspace-"));
    await mkdir(join(user, "same"));
    await writeFile(join(user, "same", "SKILL.md"), doc("same", "user"));
    await mkdir(join(workspace, "same"));
    await writeFile(join(workspace, "same", "SKILL.md"), doc("same", "workspace"));
    await mkdir(join(user, "bad"));
    await writeFile(join(user, "bad", "SKILL.md"), "broken");
    const result = await scanSkillRoots({ userRoot: user, workspaceRoot: workspace, knownTools: new Set(["command"]) });
    assert.equal(result.skills.length, 2);
    assert.equal(result.skills.find((skill) => skill.id === "same").source, "workspace");
    assert.ok(result.diagnostics.some((diagnostic) => diagnostic.id === "bad"));
  });

  it("diagnoses skill directory names that settings routes cannot address", async () => {
    const user = await mkdtemp(join(tmpdir(), "skills-user-"));
    const workspace = await mkdtemp(join(tmpdir(), "skills-workspace-"));
    await mkdir(join(user, "bad id"));
    await writeFile(join(user, "bad id", "SKILL.md"), doc("bad id"));
    const result = await scanSkillRoots({ userRoot: user, workspaceRoot: workspace, knownTools: new Set(["command"]) });
    assert.deepEqual(result.skills, []);
    assert.ok(result.diagnostics.some((diagnostic) => diagnostic.id === "bad id" && diagnostic.code === "path_rejected"));
  });
});
