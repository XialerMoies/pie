import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";

import {
  readDataRootPointer,
  writeDataRootPointer,
} from "../src/data/data-root-config.ts";
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

async function callSettings(method, url, body, paths) {
  const request = {
    method,
    url,
    headers: { "content-type": "application/json" },
    on(event, callback) {
      if (event === "data" && body !== undefined) callback(Buffer.from(JSON.stringify(body)));
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
    runtime: { session: {}, modelRegistry: {}, currentWorkspace: paths.STARTUP?.workspace },
    paths,
  };
  await handleSettings(request, response, context);
  return { status: response.status, body: JSON.parse(response.body) };
}

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
