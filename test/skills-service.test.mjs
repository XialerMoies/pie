import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const { SkillService } = await import("../src/agent/skills/skill-service.ts");

const document = (id, description = "Release checks", tool = "command") => `---\nname: ${id}\ndescription: ${description}\ntools:\n  - ${tool}\n---\n\n# Release\n\nRun checks.`;

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "skill-service-"));
  const userRoot = join(root, "user-skills");
  const workspaceRoot = join(root, "workspace", "agent", "skills");
  await mkdir(join(userRoot, "release-check"), { recursive: true });
  await writeFile(join(userRoot, "release-check", "SKILL.md"), document("release-check"));
  const service = new SkillService({
    userRoot,
    workspaceRoot: () => workspaceRoot,
    statePath: join(root, "skill-state.json"),
    knownTools: new Set(["command", "file-read"]),
  });
  return { root, userRoot, workspaceRoot, service };
}

describe("SkillService", () => {
  it("requires explicit trust and enable before loading body", async () => {
    const { service } = await fixture();
    const listed = await service.list();
    assert.equal(listed.skills.find((skill) => skill.id === "release-check").enabled, false);
    assert.equal((await service.load("user", "release-check")).diagnostic.code, "untrusted");
    await assert.rejects(() => service.enable("user", "release-check"), /untrusted/i);
    await service.trust("user", "release-check");
    await service.enable("user", "release-check");
    assert.equal((await service.load("user", "release-check")).body.includes("Release"), true);
    await service.disable("user", "release-check");
    assert.equal((await service.load("user", "release-check")).ok, false);
  });

  it("invalidates trust after content changes", async () => {
    const { service, userRoot } = await fixture();
    await service.trust("user", "release-check");
    await service.enable("user", "release-check");
    await writeFile(join(userRoot, "release-check", "SKILL.md"), document("release-check", "changed"));
    const summary = (await service.list()).skills[0];
    assert.equal(summary.trust, "untrusted");
    assert.equal(summary.enabled, false);
    assert.equal(summary.diagnostic.code, "content_changed");
  });

  it("uses workspace-over-user precedence and rejects mutations of overridden source", async () => {
    const { service, workspaceRoot } = await fixture();
    await mkdir(join(workspaceRoot, "release-check"), { recursive: true });
    await writeFile(join(workspaceRoot, "release-check", "SKILL.md"), document("release-check", "workspace"));
    assert.equal((await service.list()).skills[0].source, "workspace");
    await assert.rejects(() => service.trust("user", "release-check"), /overridden/i);
  });

  it("does not carry workspace trust into another workspace", async () => {
    const root = await mkdtemp(join(tmpdir(), "skill-service-scope-"));
    const first = join(root, "first", "agent", "skills");
    const second = join(root, "second", "agent", "skills");
    for (const skillRoot of [first, second]) {
      await mkdir(join(skillRoot, "release-check"), { recursive: true });
      await writeFile(join(skillRoot, "release-check", "SKILL.md"), document("release-check"));
    }
    let active = first;
    const service = new SkillService({
      userRoot: join(root, "user"),
      workspaceRoot: () => active,
      statePath: join(root, "skill-state.json"),
      knownTools: new Set(["command"]),
    });
    await service.trust("workspace", "release-check");
    await service.enable("workspace", "release-check");
    active = second;
    const summary = (await service.list()).skills[0];
    assert.equal(summary.trust, "untrusted");
    assert.equal(summary.enabled, false);
    assert.equal((await service.load("workspace", "release-check")).ok, false);
  });

  it("keeps each workspace mutation scoped to its initial workspace snapshot", async () => {
    const root = await mkdtemp(join(tmpdir(), "skill-service-snapshot-"));
    const first = join(root, "first", "agent", "skills");
    const second = join(root, "second", "agent", "skills");
    for (const skillRoot of [first, second]) {
      await mkdir(join(skillRoot, "release-check"), { recursive: true });
      await writeFile(join(skillRoot, "release-check", "SKILL.md"), document("release-check"));
    }
    let active = first;
    let reads = 0;
    let switchOnSecondRead = true;
    const service = new SkillService({
      userRoot: join(root, "user"),
      workspaceRoot: () => {
        reads += 1;
        if (switchOnSecondRead && reads === 2) active = second;
        return active;
      },
      statePath: join(root, "skill-state.json"),
      knownTools: new Set(["command"]),
    });
    await service.trust("workspace", "release-check");
    switchOnSecondRead = false;
    active = first;
    assert.equal((await service.list()).skills[0].trust, "trusted");
    assert.equal((await service.list()).skills[0].source, "workspace");
    assert.equal((await service.load("workspace", "release-check")).ok, false);
    assert.match(await readFile(join(first, "release-check", "SKILL.md"), "utf8"), /Release/);
    assert.match(await readFile(join(second, "release-check", "SKILL.md"), "utf8"), /Release/);
  });

  it("builds prompt summaries and bodies from one explicit workspace snapshot", async () => {
    const root = await mkdtemp(join(tmpdir(), "skill-service-prompt-snapshot-"));
    const first = join(root, "first", "agent", "skills");
    const second = join(root, "second", "agent", "skills");
    await mkdir(join(first, "release-check"), { recursive: true });
    await mkdir(join(second, "release-check"), { recursive: true });
    await writeFile(join(first, "release-check", "SKILL.md"), document("release-check", "workspace A").replace("# Release", "# A"));
    await writeFile(join(second, "release-check", "SKILL.md"), document("release-check", "workspace B").replace("# Release", "# B"));
    let active = first;
    const service = new SkillService({
      userRoot: join(root, "user"),
      workspaceRoot: () => active,
      statePath: join(root, "skill-state.json"),
      knownTools: new Set(["command"]),
    });
    await service.trust("workspace", "release-check");
    await service.enable("workspace", "release-check");
    active = second;
    await service.trust("workspace", "release-check");
    await service.enable("workspace", "release-check");

    const prompt = await service.promptInput(first);
    assert.equal(prompt.summaries[0].description, "workspace A");
    assert.match(prompt.bodies.get("release-check"), /# A/);
    assert.doesNotMatch(prompt.bodies.get("release-check"), /# B/);
  });

  it("publishes one revision for list and prompt facts, then changes it after content mutation", async () => {
    const { service, userRoot } = await fixture();
    await service.trust("user", "release-check");
    await service.enable("user", "release-check");
    const snapshot = await service.snapshot(join(userRoot, "missing-workspace", "agent", "skills"));
    const prompt = await service.promptInput(join(userRoot, "missing-workspace", "agent", "skills"), snapshot);
    const listed = await service.list();
    assert.equal(prompt.revision, snapshot.revision);
    assert.equal(typeof listed.revision, "string");
    assert.equal(prompt.workspaceKey, snapshot.workspaceKey);
    assert.equal(snapshot.result.skills[0].parse, "valid");
    assert.equal(snapshot.result.skills[0].trust, "trusted");
    assert.equal(snapshot.result.skills[0].enabled, true);
    await writeFile(join(userRoot, "release-check", "SKILL.md"), document("release-check", "changed"));
    const changed = await service.snapshot(join(userRoot, "missing-workspace", "agent", "skills"));
    assert.notEqual(changed.revision, snapshot.revision);
    assert.equal(changed.result.skills[0].trust, "untrusted");
    assert.equal(changed.result.skills[0].enabled, false);
    assert.equal(changed.result.skills[0].diagnostic.code, "content_changed");
  });

  it("rejects invalid ids and unknown tools", async () => {
    const { service, userRoot } = await fixture();
    await assert.rejects(() => service.trust("user", "../escape"), /invalid/i);
    await mkdir(join(userRoot, "bad-tool"));
    await writeFile(join(userRoot, "bad-tool", "SKILL.md"), document("bad-tool", "bad", "missing"));
    await assert.rejects(() => service.trust("user", "bad-tool"), /invalid/i);
  });

  it("removes only the selected source directory and state", async () => {
    const { service, userRoot } = await fixture();
    await service.trust("user", "release-check");
    await service.remove("user", "release-check");
    await assert.rejects(() => readFile(join(userRoot, "release-check", "SKILL.md")), /ENOENT/);
    assert.equal((await service.list()).skills.length, 0);
  });

  it("allows an invalid skill to be removed", async () => {
    const { service, userRoot } = await fixture();
    await writeFile(join(userRoot, "release-check", "SKILL.md"), "broken");
    await service.remove("user", "release-check");
    await assert.rejects(() => readFile(join(userRoot, "release-check", "SKILL.md")), /ENOENT/);
  });

  it("refuses removal through a workspace agent junction", async () => {
    const root = await mkdtemp(join(tmpdir(), "skill-service-junction-"));
    const workspace = join(root, "workspace");
    const outside = join(root, "outside");
    await mkdir(join(outside, "skills", "release-check"), { recursive: true });
    const outsideFile = join(outside, "skills", "release-check", "SKILL.md");
    await writeFile(outsideFile, document("release-check"));
    await mkdir(workspace, { recursive: true });
    await symlink(outside, join(workspace, "agent"), "junction");
    const service = new SkillService({
      userRoot: join(root, "user"),
      workspaceRoot: () => join(workspace, "agent", "skills"),
      statePath: join(root, "skill-state.json"),
      knownTools: new Set(["command"]),
    });
    await assert.rejects(() => service.remove("workspace", "release-check"), /not found/i);
    assert.match(await readFile(outsideFile, "utf8"), /Release/);
  });

  it("does not let concurrent enable resurrect an untrusted skill", async () => {
    const { service } = await fixture();
    await service.trust("user", "release-check");
    await Promise.allSettled([
      service.enable("user", "release-check"),
      service.untrust("user", "release-check"),
    ]);
    const summary = (await service.list()).skills[0];
    assert.equal(summary.trust, "untrusted");
    assert.equal(summary.enabled, false);
  });

  it("fails closed when state is corrupt", async () => {
    const { service, root } = await fixture();
    await writeFile(join(root, "skill-state.json"), "{broken", "utf8");
    const listed = await service.list();
    assert.equal(listed.failClosed, true);
    assert.equal(listed.skills[0].trust, "untrusted");
    await assert.rejects(() => service.trust("user", "release-check"), /corrupt/i);
  });
});
