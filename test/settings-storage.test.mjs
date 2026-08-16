import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";

import {
  readDataRootPointer,
  writeDataRootPointer,
} from "../src/data/data-root-config.ts";
import { canonicalWorkspacePath } from "../src/data/data-layout.ts";
import { recordOpenedWorkspace } from "../src/data/user-settings.ts";
import { handleSettings } from "../src/server/routes/settings.ts";
import { previewLegacySessions, workspaceDataPaths } from "../src/server/routes/session-dir.ts";

const roots = [];

afterEach(() => {
  while (roots.length) rmSync(roots.pop(), { recursive: true, force: true });
});

function makeRoot() {
  const root = mkdtempSync(resolve(tmpdir(), "my-code-agent-settings-"));
  roots.push(root);
  return root;
}

async function callSettings(method, url, body, paths, options = {}) {
  const rawBody = options.rawBody ?? (body === undefined ? "" : JSON.stringify(body));
  const request = {
    method,
    url,
    headers: { "content-type": "application/json" },
    on(event, callback) {
      if (event === "data" && rawBody) callback(Buffer.from(rawBody));
      if (event === "end") callback();
      return request;
    },
  };
  const response = {
    status: 0,
    body: "",
    writeHead(status) {
      response.status = status;
      return response;
    },
    end(value) {
      response.body += value ? String(value) : "";
      return response;
    },
  };
  const context = {
    runtime: {
      session: {},
      modelRegistry: {},
      currentWorkspace: paths.STARTUP?.workspace,
      syncModelProviders: async () => 0,
      runWithStableSession: async (operation) => operation(),
      ...options.runtime,
    },
    paths,
  };
  await handleSettings(request, response, context);
  return { status: response.status, body: response.body ? JSON.parse(response.body) : null };
}

describe("preferences REST boundary", () => {
  it("GET returns empty preferences when SETTINGS_FILE is missing", async () => {
    const root = makeRoot();
    const paths = { SETTINGS_FILE: join(root, "user", "settings.json") };

    const response = await callSettings("GET", "/api/preferences", undefined, paths);

    assert.strictEqual(response.status, 200);
    assert.deepStrictEqual(response.body, { preferences: {} });
  });

  it("GET returns only validated persisted preferences", async () => {
    const root = makeRoot();
    const settingsFile = join(root, "user", "settings.json");
    mkdirSync(resolve(settingsFile, ".."), { recursive: true });
    writeFileSync(settingsFile, JSON.stringify({
      defaultModel: "kept-model",
      preferences: {
        "editor-theme": "vs-dark",
        unknown: "ignored",
        "auto-save": 42,
        "subagent-max-tasks": "31",
        "subagent-max-concurrent": "0",
      },
    }));
    const paths = { SETTINGS_FILE: settingsFile };

    const response = await callSettings("GET", "/api/preferences", undefined, paths);

    assert.strictEqual(response.status, 200);
    assert.deepStrictEqual(response.body, { preferences: { "editor-theme": "vs-dark" } });
  });

  it("PATCH merges and removes preferences without replacing other settings", async () => {
    const root = makeRoot();
    const settingsFile = join(root, "user", "settings.json");
    mkdirSync(resolve(settingsFile, ".."), { recursive: true });
    writeFileSync(settingsFile, JSON.stringify({
      defaultProvider: "kept-provider",
      defaultModel: "kept-model",
      preferences: { "editor-theme": "vs-dark", "auto-save": "1" },
    }));
    const paths = { SETTINGS_FILE: settingsFile };

    const response = await callSettings("PATCH", "/api/preferences", {
      values: { "chat-mode": "plan", "editor-theme": "vs" },
      remove: ["auto-save"],
    }, paths);

    assert.strictEqual(response.status, 200);
    assert.deepStrictEqual(response.body, {
      ok: true,
      preferences: { "editor-theme": "vs", "chat-mode": "plan" },
    });
    assert.deepStrictEqual(JSON.parse(readFileSync(settingsFile, "utf8")), {
      defaultProvider: "kept-provider",
      defaultModel: "kept-model",
      preferences: { "editor-theme": "vs", "chat-mode": "plan" },
    });
  });

  it("persists subagent limits only within the supported 1..30 range", async () => {
    const root = makeRoot();
    const settingsFile = join(root, "user", "settings.json");
    const paths = { SETTINGS_FILE: settingsFile };

    const saved = await callSettings("PATCH", "/api/preferences", {
      values: { "subagent-max-tasks": "30", "subagent-max-concurrent": "1" },
    }, paths);
    assert.strictEqual(saved.status, 200);
    assert.deepStrictEqual(saved.body.preferences, {
      "subagent-max-tasks": "30",
      "subagent-max-concurrent": "1",
    });

    for (const [key, value] of [
      ["subagent-max-tasks", "0"],
      ["subagent-max-concurrent", "31"],
      ["subagent-max-tasks", "2.5"],
    ]) {
      const response = await callSettings("PATCH", "/api/preferences", {
        values: { [key]: value },
      }, paths);
      assert.strictEqual(response.status, 400, `${key}=${value}`);
      assert.match(response.body.error, /between 1 and 30/i);
    }
  });

  it("returns 400 for invalid preference patches and malformed JSON", async () => {
    const root = makeRoot();
    const settingsFile = join(root, "settings.json");
    const paths = { SETTINGS_FILE: settingsFile };
    const invalidPatches = [
      [{ values: { unknown: "value" } }, "Unknown preference key"],
      [{ values: { "editor-theme": 42 } }, "Preference value must be a string"],
      [{ values: { "editor-theme": "x".repeat(4097) } }, "Preference value is too long"],
      [null, "Preference patch must be an object"],
      [[], "Preference patch must be an object"],
      [{ values: [] }, "Preference values must be an object"],
      [{ remove: {} }, "Preference remove must be an array"],
      [{ remove: [42] }, "Unknown preference key"],
    ];

    for (const [patch, message] of invalidPatches) {
      const response = await callSettings("PATCH", "/api/preferences", patch, paths);
      assert.strictEqual(response.status, 400, message);
      assert.strictEqual(typeof response.body.error, "string");
      assert.match(response.body.error, new RegExp(message));
    }

    const malformed = await callSettings("PATCH", "/api/preferences", undefined, paths, { rawBody: "{" });
    assert.strictEqual(malformed.status, 400);
    assert.deepStrictEqual(malformed.body, { error: "Invalid JSON" });
  });

  it("preserves preferences, model, and startup fields during concurrent writes", async () => {
    const root = makeRoot();
    const settingsFile = join(root, "settings.json");
    const workspace = join(root, "workspace");
    mkdirSync(workspace, { recursive: true });
    const model = { provider: "openai", id: "gpt-test" };
    const paths = {
      APP_ROOT: root,
      DATA_DIR: root,
      PI_CONFIG_DIR: root,
      SETTINGS_FILE: settingsFile,
      STARTUP: { workspace },
    };
    const runtime = {
      currentWorkspace: workspace,
      session: {
        model: { provider: "openai", id: "gpt-prior" },
        setModel: async () => {},
      },
      modelRegistry: { find: () => model },
    };

    const [preferences, modelResponse, startup] = await Promise.all([
      callSettings("PATCH", "/api/preferences", {
        values: { "editor-theme": "vs", "chat-mode": "plan" },
      }, paths, { runtime }),
      callSettings("POST", "/api/model/switch", {
        provider: model.provider,
        modelId: model.id,
      }, paths, { runtime }),
      recordOpenedWorkspace(settingsFile, workspace),
    ]);

    assert.strictEqual(preferences.status, 200);
    assert.strictEqual(modelResponse.status, 200);
    assert.strictEqual(startup, true);
    assert.deepStrictEqual(JSON.parse(readFileSync(settingsFile, "utf8")), {
      defaultProvider: model.provider,
      defaultModel: model.id,
      startup: {
        lastWorkspace: canonicalWorkspacePath(workspace),
        recentWorkspaces: [canonicalWorkspacePath(workspace)],
      },
      preferences: { "editor-theme": "vs", "chat-mode": "plan" },
    });
  });
});

describe("custom subagent REST boundary", () => {
  it("lists and replaces validated custom agents", async () => {
    const root = makeRoot();
    const paths = {
      SETTINGS_FILE: join(root, "user", "settings.json"),
      SUBAGENTS_FILE: join(root, "user", "subagents.json"),
    };
    const model = { provider: "openai", id: "gpt-test" };
    const agent = {
      id: "security-reviewer",
      name: "安全审查",
      description: "检查安全边界",
      prompt: "优先检查权限与输入验证。",
      tools: ["search", "file_read"],
      model,
    };

    const empty = await callSettings("GET", "/api/subagents", undefined, paths, {
      runtime: { modelRegistry: { find: () => model } },
    });
    assert.deepStrictEqual(empty, { status: 200, body: { agents: [] } });

    const saved = await callSettings("PUT", "/api/subagents", { agents: [agent] }, paths, {
      runtime: { modelRegistry: { find: () => model } },
    });
    assert.strictEqual(saved.status, 200);
    assert.deepStrictEqual(saved.body, { ok: true, agents: [agent] });

    const loaded = await callSettings("GET", "/api/subagents", undefined, paths, {
      runtime: { modelRegistry: { find: () => model } },
    });
    assert.deepStrictEqual(loaded.body, { agents: [agent] });
  });

  it("rejects unavailable models and writable tools", async () => {
    const root = makeRoot();
    const paths = {
      SETTINGS_FILE: join(root, "user", "settings.json"),
      SUBAGENTS_FILE: join(root, "user", "subagents.json"),
    };
    const base = {
      id: "reviewer",
      name: "Reviewer",
      description: "Review code",
      prompt: "Review carefully.",
      tools: ["search"],
    };

    const unknownModel = await callSettings("PUT", "/api/subagents", {
      agents: [{ ...base, model: { provider: "missing", id: "none" } }],
    }, paths, { runtime: { modelRegistry: { find: () => undefined } } });
    assert.strictEqual(unknownModel.status, 400);
    assert.match(unknownModel.body.error, /model.*missing\/none/i);

    const writable = await callSettings("PUT", "/api/subagents", {
      agents: [{ ...base, tools: ["file_write"] }],
    }, paths);
    assert.strictEqual(writable.status, 400);
    assert.match(writable.body.error, /read-only tool/i);
  });
});

describe("data-root bootstrap pointer", () => {
  it("stores only the selected absolute directory in the bootstrap file", () => {
    const bootstrapDir = makeRoot();
    const dataRoot = makeRoot();
    const pointerFile = join(bootstrapDir, "data-root.json");

    const result = writeDataRootPointer(pointerFile, dataRoot, makeRoot());

    assert.strictEqual(result.dataRoot, resolve(dataRoot));
    assert.strictEqual(result.restartRequired, true);
    assert.strictEqual(result.moved, false);
    assert.deepStrictEqual(Object.keys(JSON.parse(readFileSync(pointerFile, "utf8"))), ["dataRoot"]);
    assert.strictEqual(statSync(pointerFile).isFile(), true);
  });

  it("accepts an existing directory and rejects a file or relative path", () => {
    const bootstrapDir = makeRoot();
    const dataRoot = makeRoot();
    const pointerFile = join(bootstrapDir, "data-root.json");
    const filePath = join(bootstrapDir, "not-a-directory");
    writeFileSync(filePath, "file");

    assert.doesNotThrow(() => writeDataRootPointer(pointerFile, dataRoot, dataRoot));
    assert.throws(() => writeDataRootPointer(pointerFile, filePath, dataRoot), /must be an existing directory/);
    assert.throws(() => writeDataRootPointer(pointerFile, "relative-data", dataRoot), /must be an absolute path/);
  });

  it("does not move or rewrite running data when the location changes", () => {
    const bootstrapDir = makeRoot();
    const currentRoot = makeRoot();
    const nextRoot = makeRoot();
    const pointerFile = join(bootstrapDir, "data-root.json");
    const sessionFile = join(currentRoot, "session.jsonl");
    const cacheFile = join(currentRoot, "cache.bin");
    writeFileSync(sessionFile, "session-data");
    writeFileSync(cacheFile, "cache-data");

    const result = writeDataRootPointer(pointerFile, nextRoot, currentRoot);

    assert.strictEqual(result.restartRequired, true);
    assert.strictEqual(result.moved, false);
    assert.strictEqual(readFileSync(sessionFile, "utf8"), "session-data");
    assert.strictEqual(readFileSync(cacheFile, "utf8"), "cache-data");
    assert.strictEqual(statSync(nextRoot).isDirectory(), true);
  });

  it("falls back when the pointer is missing or invalid", () => {
    const bootstrapDir = makeRoot();
    const pointerFile = join(bootstrapDir, "data-root.json");
    const fallback = makeRoot();

    assert.strictEqual(readDataRootPointer(pointerFile, fallback), resolve(fallback));
    writeFileSync(pointerFile, JSON.stringify({ dataRoot: "missing-root" }));
    assert.strictEqual(readDataRootPointer(pointerFile, fallback), resolve(fallback));
    writeFileSync(pointerFile, "not-json");
    assert.strictEqual(readDataRootPointer(pointerFile, fallback), resolve(fallback));
  });

  it("exposes the active location and stages a new location without moving data", async () => {
    const bootstrapDir = makeRoot();
    const currentRoot = makeRoot();
    const nextRoot = makeRoot();
    const pointerFile = join(bootstrapDir, "data-root.json");
    const sessionFile = join(currentRoot, "session.jsonl");
    writeFileSync(sessionFile, "session-data");
    const paths = {
      DATA_DIR: currentRoot,
      DATA_ROOT_POINTER_FILE: pointerFile,
    };

    const before = await callSettings("GET", "/api/storage-location", undefined, paths);
    assert.strictEqual(before.body.dataRoot, resolve(currentRoot));
    assert.strictEqual(before.body.activeDataRoot, resolve(currentRoot));
    assert.strictEqual(before.body.restartRequired, false);
    assert.strictEqual(before.body.instanceId, '');
    assert.deepStrictEqual(before.body.workspaceLock, { status: 'unlocked' });

    const saved = await callSettings("POST", "/api/storage-location", { dataRoot: nextRoot }, paths);
    assert.strictEqual(saved.status, 200);
    assert.strictEqual(saved.body.ok, true);
    assert.strictEqual(saved.body.restartRequired, true);
    assert.strictEqual(saved.body.moved, false);
    assert.strictEqual(readFileSync(sessionFile, "utf8"), "session-data");

    const after = await callSettings("GET", "/api/storage-location", undefined, paths);
    assert.strictEqual(after.body.dataRoot, resolve(nextRoot));
    assert.strictEqual(after.body.activeDataRoot, resolve(currentRoot));
    assert.strictEqual(after.body.restartRequired, true);
  });

  it('previews legacy data and requires explicit confirmation before copying', async () => {
    const dataRoot = makeRoot();
    const workspace = makeRoot();
    const legacyRoot = workspaceDataPaths(dataRoot, workspace).legacySessionsRoot;
    const source = resolve(legacyRoot, 'by-project', basename(workspace), 'legacy.jsonl');
    const paths = {
      DATA_DIR: dataRoot,
      APP_ROOT: workspace,
      STARTUP: { workspace, instanceId: 'settings-test-instance' },
    };
    mkdirSync(resolve(source, '..'), { recursive: true });
    writeFileSync(source, `${JSON.stringify({ type: 'session', id: 'legacy', workspace })}\n`);
    assert.strictEqual(previewLegacySessions(dataRoot, workspace).fileCount, 1);

    const preview = await callSettings('GET', '/api/storage-migration/preview', undefined, paths);
    assert.strictEqual(preview.status, 200);
    assert.strictEqual(preview.body.fileCount, 1);
    assert.strictEqual(preview.body.conflicts.length, 0);
    assert.match(preview.body.previewId, /^[a-f0-9]{64}$/);
    assert.strictEqual(readFileSync(source, 'utf8').length > 0, true);

    const rejected = await callSettings('POST', '/api/storage-migration/confirm', { confirm: false }, paths);
    assert.strictEqual(rejected.status, 400);
    assert.strictEqual(existsSync(source), true);

    const missingPreview = await callSettings('POST', '/api/storage-migration/confirm', { confirm: true }, paths);
    assert.strictEqual(missingPreview.status, 400);

    writeFileSync(source, `${JSON.stringify({ type: 'session', id: 'legacy', workspace })}\nchanged\n`);
    const stalePreview = await callSettings('POST', '/api/storage-migration/confirm', {
      confirm: true,
      previewId: preview.body.previewId,
    }, paths);
    assert.strictEqual(stalePreview.status, 409);
    assert.strictEqual(existsSync(join(preview.body.destination, 'legacy.jsonl')), false);

    const refreshed = await callSettings('GET', '/api/storage-migration/preview', undefined, paths);
    const confirmed = await callSettings('POST', '/api/storage-migration/confirm', {
      confirm: true,
      previewId: refreshed.body.previewId,
    }, paths);
    assert.strictEqual(confirmed.status, 200);
    assert.strictEqual(confirmed.body.ok, true);
    assert.strictEqual(confirmed.body.migration.copied.length, 1);
    assert.strictEqual(existsSync(source), true);
    assert.strictEqual(existsSync(join(confirmed.body.preview.destination, 'legacy.jsonl')), true);

    const after = await callSettings('GET', '/api/storage-migration/preview', undefined, paths);
    assert.strictEqual(after.body.fileCount, 0);
    assert.deepStrictEqual(after.body.conflicts, []);
  });
});
