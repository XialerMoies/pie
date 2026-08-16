import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { canonicalWorkspacePath } from "../src/data/data-layout.ts";
import { withFileLock } from "../src/data/file-lock.ts";
import {
  USER_PREFERENCE_KEYS,
  patchUserPreferences,
  readStartupWorkspace,
  readUserPreferences,
  readUserPreferencesStrict,
  readUserSettings,
  readUserSettingsStrict,
  recordOpenedWorkspace,
} from "../src/data/user-settings.ts";

const roots = [];

afterEach(() => {
  while (roots.length) rmSync(roots.pop(), { recursive: true, force: true });
});

function makeFixture() {
  const root = mkdtempSync(resolve(tmpdir(), "my-code-agent-user-settings-"));
  roots.push(root);
  const settingsFile = join(root, "user", "settings.json");
  const workspaceA = join(root, "workspace-a");
  const workspaceB = join(root, "workspace-b");
  mkdirSync(workspaceA, { recursive: true });
  mkdirSync(workspaceB, { recursive: true });
  return { root, settingsFile, workspaceA, workspaceB };
}

function writeSettings(settingsFile, document) {
  mkdirSync(resolve(settingsFile, ".."), { recursive: true });
  writeFileSync(settingsFile, typeof document === "string" ? document : JSON.stringify(document));
}

describe("shared user settings", () => {
  it("exports the supported preference keys", () => {
    assert.deepStrictEqual([...USER_PREFERENCE_KEYS], [
      "auto-save",
      "chat-effort",
      "chat-jump-latest-enabled",
      "chat-jump-latest-smooth",
      "chat-jump-latest-threshold",
      "chat-mode",
      "chat-timeline-enabled",
      "chat-timeline-window-size",
      "editor-font-size",
      "editor-tab-size",
      "editor-theme",
      "editor-use-tabs",
      "explorer-filter",
      "explorer-state",
      "providers_order",
      "subagent-max-concurrent",
      "subagent-max-tasks",
    ]);
  });

  it("records recent workspaces and patches preferences without losing other settings", async () => {
    const { settingsFile, workspaceA, workspaceB } = makeFixture();
    writeSettings(settingsFile, { defaultProvider: "deepseek", defaultModel: "deepseek-chat" });

    assert.strictEqual(await recordOpenedWorkspace(settingsFile, workspaceA), true);
    assert.strictEqual(await recordOpenedWorkspace(settingsFile, workspaceB), true);
    assert.strictEqual(readStartupWorkspace(settingsFile), canonicalWorkspacePath(workspaceB));
    assert.deepStrictEqual(readUserSettings(settingsFile).startup.recentWorkspaces, [
      canonicalWorkspacePath(workspaceB),
      canonicalWorkspacePath(workspaceA),
    ]);

    assert.deepStrictEqual(await patchUserPreferences(settingsFile, {
      values: { "editor-theme": "vs", "auto-save": "1" },
      remove: [],
    }), {
      "editor-theme": "vs",
      "auto-save": "1",
    });
    assert.deepStrictEqual(readUserPreferences(settingsFile), {
      "editor-theme": "vs",
      "auto-save": "1",
    });

    const stored = JSON.parse(readFileSync(settingsFile, "utf8"));
    assert.strictEqual(stored.defaultProvider, "deepseek");
    assert.strictEqual(stored.defaultModel, "deepseek-chat");
    assert.strictEqual(stored.startup.lastWorkspace, canonicalWorkspacePath(workspaceB));
  });

  it("tolerates malformed JSON and sanitizes unknown or invalid fields", () => {
    const { settingsFile, workspaceA } = makeFixture();
    writeSettings(settingsFile, "{not-json");

    assert.deepStrictEqual(readUserSettings(settingsFile), {});
    assert.strictEqual(readStartupWorkspace(settingsFile), null);
    assert.deepStrictEqual(readUserPreferences(settingsFile), {});

    writeSettings(settingsFile, {
      defaultProvider: "provider-a",
      defaultModel: 42,
      futureTopLevel: { enabled: true },
      startup: {
        lastWorkspace: workspaceA,
        recentWorkspaces: [workspaceA, workspaceA, "relative/path", 42],
        futureStartupField: true,
      },
      preferences: {
        "editor-theme": "vs",
        "future-preference": "ignored",
        "auto-save": false,
      },
    });

    assert.deepStrictEqual(readUserSettings(settingsFile), {
      defaultProvider: "provider-a",
      startup: {
        lastWorkspace: canonicalWorkspacePath(workspaceA),
        recentWorkspaces: [canonicalWorkspacePath(workspaceA)],
      },
      preferences: { "editor-theme": "vs" },
    });
  });

  it("fails closed when strict reference settings are malformed or unreadable", () => {
    const { root, settingsFile } = makeFixture();
    assert.deepStrictEqual(readUserSettingsStrict(settingsFile), {});
    writeSettings(settingsFile, "{not-json");
    assert.throws(() => readUserSettingsStrict(settingsFile), SyntaxError);

    writeSettings(settingsFile, { defaultProvider: "acme", defaultModel: 42 });
    assert.throws(() => readUserSettingsStrict(settingsFile), /defaultModel/);

    writeSettings(settingsFile, {
      preferences: { defaultProvider: 42, defaultModel: "model-a" },
    });
    assert.throws(() => readUserSettingsStrict(settingsFile), /preferences\.defaultProvider/);

    writeSettings(settingsFile, {
      preferences: { defaultProvider: "acme" },
    });
    assert.throws(() => readUserSettingsStrict(settingsFile), /preferences.*configured together/);

    writeSettings(settingsFile, {
      preferences: { defaultProvider: "acme", defaultModel: "model-a" },
    });
    assert.deepStrictEqual(readUserPreferencesStrict(settingsFile), {
      defaultProvider: "acme",
      defaultModel: "model-a",
    });

    const directory = join(root, "settings-as-directory");
    mkdirSync(directory);
    assert.throws(
      () => readUserSettingsStrict(directory),
      (error) => ["EISDIR", "EACCES", "EPERM"].includes(error?.code),
    );
  });

  it("returns only an absolute existing directory as the startup workspace", () => {
    const { root, settingsFile, workspaceA } = makeFixture();
    const filePath = join(root, "workspace-file");
    writeFileSync(filePath, "not a directory");

    for (const invalidWorkspace of ["relative/workspace", join(root, "missing"), filePath]) {
      writeSettings(settingsFile, { startup: { lastWorkspace: invalidWorkspace } });
      assert.strictEqual(readStartupWorkspace(settingsFile), null);
    }

    writeSettings(settingsFile, { startup: { lastWorkspace: workspaceA } });
    assert.strictEqual(readStartupWorkspace(settingsFile), canonicalWorkspacePath(workspaceA));
  });

  it("deduplicates recent workspaces and caps them at ten", async () => {
    const { root, settingsFile } = makeFixture();
    const workspaces = Array.from({ length: 12 }, (_, index) => join(root, `workspace-${index}`));
    for (const workspace of workspaces) {
      mkdirSync(workspace, { recursive: true });
      await recordOpenedWorkspace(settingsFile, workspace);
    }
    await recordOpenedWorkspace(settingsFile, workspaces[5]);

    const startup = readUserSettings(settingsFile).startup;
    assert.strictEqual(startup.lastWorkspace, canonicalWorkspacePath(workspaces[5]));
    assert.deepStrictEqual(startup.recentWorkspaces, [
      workspaces[5],
      ...workspaces.slice(2).reverse().filter((workspace) => workspace !== workspaces[5]),
    ].slice(0, 10).map(canonicalWorkspacePath));
  });

  it("does not record a transient workspace", async () => {
    const { root, settingsFile, workspaceA } = makeFixture();
    const transientWorkspace = join(root, "instances", "test-instance", "empty-workspace");
    mkdirSync(transientWorkspace, { recursive: true });
    await recordOpenedWorkspace(settingsFile, workspaceA);

    assert.strictEqual(await recordOpenedWorkspace(settingsFile, transientWorkspace, { transientWorkspace }), false);
    assert.strictEqual(readStartupWorkspace(settingsFile), canonicalWorkspacePath(workspaceA));
    assert.deepStrictEqual(readUserSettings(settingsFile).startup.recentWorkspaces, [
      canonicalWorkspacePath(workspaceA),
    ]);
  });

  it("does not record a missing workspace or a non-directory workspace", async () => {
    const { root, settingsFile, workspaceA } = makeFixture();
    const missingWorkspace = join(root, "missing-workspace");
    const fileWorkspace = join(root, "workspace-file");
    writeFileSync(fileWorkspace, "not a directory");
    await recordOpenedWorkspace(settingsFile, workspaceA);

    assert.strictEqual(await recordOpenedWorkspace(settingsFile, missingWorkspace), false);
    assert.strictEqual(await recordOpenedWorkspace(settingsFile, fileWorkspace), false);
    assert.deepStrictEqual(readUserSettings(settingsFile).startup, {
      lastWorkspace: canonicalWorkspacePath(workspaceA),
      recentWorkspaces: [canonicalWorkspacePath(workspaceA)],
    });
    await assert.rejects(
      recordOpenedWorkspace(settingsFile, "relative/workspace"),
      /workspace must be an absolute path/,
    );
  });

  it("does not record a workspace deleted while waiting for the settings lock", async () => {
    const { settingsFile, workspaceA, workspaceB } = makeFixture();
    await recordOpenedWorkspace(settingsFile, workspaceA);

    let releaseLock;
    let signalLockEntered;
    const lockEntered = new Promise((resolveEntered) => { signalLockEntered = resolveEntered; });
    const lockRelease = new Promise((resolveRelease) => { releaseLock = resolveRelease; });
    const lockOwner = withFileLock(`${settingsFile}.lock`, {}, async () => {
      signalLockEntered();
      await lockRelease;
    });
    await lockEntered;

    const recording = recordOpenedWorkspace(settingsFile, workspaceB).then(
      (value) => ({ value }),
      (error) => ({ error }),
    );
    try {
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
      rmSync(workspaceB, { recursive: true, force: true });
    } finally {
      releaseLock();
      await lockOwner;
    }

    const result = await recording;
    if (result.error) throw result.error;
    assert.strictEqual(result.value, false);
    assert.deepStrictEqual(readUserSettings(settingsFile).startup, {
      lastWorkspace: canonicalWorkspacePath(workspaceA),
      recentWorkspaces: [canonicalWorkspacePath(workspaceA)],
    });
  });

  it("propagates non-recoverable settings read errors", () => {
    const { root } = makeFixture();
    const settingsDirectory = join(root, "settings-directory");
    mkdirSync(settingsDirectory);

    assert.throws(
      () => readUserSettings(settingsDirectory),
      (error) => ["EISDIR", "EACCES", "EPERM"].includes(error?.code),
    );
  });

  it("merges removals and rejects an invalid patch without partial writes", async () => {
    const { settingsFile } = makeFixture();
    await patchUserPreferences(settingsFile, {
      values: { "editor-theme": "vs-dark", "auto-save": "1" },
    });

    assert.deepStrictEqual(await patchUserPreferences(settingsFile, {
      values: { "chat-mode": "plan" },
      remove: ["auto-save"],
    }), {
      "editor-theme": "vs-dark",
      "chat-mode": "plan",
    });

    const before = readFileSync(settingsFile, "utf8");
    await assert.rejects(
      patchUserPreferences(settingsFile, {
        values: { "editor-theme": "vs", "unknown-key": "value" },
      }),
      /Unknown preference key: unknown-key/,
    );
    assert.strictEqual(readFileSync(settingsFile, "utf8"), before);

    await assert.rejects(
      patchUserPreferences(settingsFile, {
        values: { "editor-theme": 42 },
      }),
      /Preference value must be a string: editor-theme/,
    );
    assert.strictEqual(readFileSync(settingsFile, "utf8"), before);

    await assert.rejects(
      patchUserPreferences(settingsFile, {
        values: { "editor-theme": "x".repeat(4097) },
      }),
      /Preference value is too long: editor-theme/,
    );
    assert.strictEqual(readFileSync(settingsFile, "utf8"), before);
  });

  it("rejects preference keys that are both set and removed", async () => {
    const { settingsFile } = makeFixture();
    await patchUserPreferences(settingsFile, { values: { "editor-theme": "vs-dark" } });
    const before = readFileSync(settingsFile, "utf8");

    await assert.rejects(
      patchUserPreferences(settingsFile, {
        values: { "editor-theme": "vs" },
        remove: ["editor-theme"],
      }),
      /Preference key cannot be both set and removed: editor-theme/,
    );
    assert.strictEqual(readFileSync(settingsFile, "utf8"), before);
  });

  it("snapshots a validated patch before waiting for the file lock", async () => {
    const { settingsFile } = makeFixture();
    await patchUserPreferences(settingsFile, { values: { "auto-save": "1" } });

    let releaseLock;
    let signalLockEntered;
    const lockEntered = new Promise((resolveEntered) => { signalLockEntered = resolveEntered; });
    const lockRelease = new Promise((resolveRelease) => { releaseLock = resolveRelease; });
    const lockOwner = withFileLock(`${settingsFile}.lock`, {}, async () => {
      signalLockEntered();
      await lockRelease;
    });
    await lockEntered;

    const patch = {
      values: { "editor-theme": "vs" },
      remove: ["auto-save"],
    };
    const update = patchUserPreferences(settingsFile, patch).then(
      (value) => ({ value }),
      (error) => ({ error }),
    );
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
    patch.values["editor-theme"] = "vs-dark";
    patch.values["unknown-key"] = "bypassed";
    patch.remove.push("editor-theme");
    releaseLock();
    await lockOwner;

    const result = await update;
    if (result.error) throw result.error;
    assert.deepStrictEqual(result.value, { "editor-theme": "vs" });
    assert.deepStrictEqual(JSON.parse(readFileSync(settingsFile, "utf8")).preferences, {
      "editor-theme": "vs",
    });
  });
});
