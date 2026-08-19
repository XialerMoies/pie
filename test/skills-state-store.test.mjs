import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const { SkillStateStore } = await import("../src/agent/skills/skill-state-store.ts");

describe("skill state store", () => {
  it("uses empty fail-safe state when the file is missing", async () => {
    const root = await mkdtemp(join(tmpdir(), "skill-state-"));
    const store = new SkillStateStore(join(root, "skill-state.json"));
    assert.deepEqual(await store.read(), { records: {}, diagnostics: [] });
  });

  it("persists only valid trust state", async () => {
    const root = await mkdtemp(join(tmpdir(), "skill-state-"));
    const store = new SkillStateStore(join(root, "skill-state.json"));
    const workspaceKey = "a".repeat(64);
    await store.set("workspace", "release-check", { trust: "trusted", enabled: true, fingerprint: "abc" }, workspaceKey);
    assert.deepEqual((await store.read()).records[`workspace:${workspaceKey}:release-check`], { trust: "trusted", enabled: true, fingerprint: "abc" });
  });

  it("fails closed on malformed JSON or invalid records", async () => {
    const root = await mkdtemp(join(tmpdir(), "skill-state-"));
    const path = join(root, "skill-state.json");
    const store = new SkillStateStore(path);
    await writeFile(path, "{broken", "utf8");
    assert.equal((await store.read()).failClosed, true);
    await writeFile(path, JSON.stringify({ records: { "user:x": { trust: "trusted", enabled: "yes", fingerprint: "x" } } }), "utf8");
    const invalid = await store.read();
    assert.equal(invalid.failClosed, true);
    assert.deepEqual(invalid.records, {});
  });

  it("preserves concurrent updates", async () => {
    const root = await mkdtemp(join(tmpdir(), "skill-state-"));
    const store = new SkillStateStore(join(root, "skill-state.json"));
    await Promise.all([
      store.set("user", "one", { trust: "trusted", enabled: false, fingerprint: "one" }),
      store.set("workspace", "two", { trust: "untrusted", enabled: false, fingerprint: "two" }, "b".repeat(64)),
    ]);
    assert.deepEqual(Object.keys((await store.read()).records).sort(), ["user:one", `workspace:${"b".repeat(64)}:two`]);
  });
});
