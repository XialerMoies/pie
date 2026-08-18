import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { tmpdir } from "node:os";

import {
  migrateLegacySessions,
  writeWorkspaceMetadata,
  workspaceDataPaths,
} from "../src/server/routes/session-dir.ts";
import { AgentRuntime } from "../src/agent/runtime.ts";
import { handleSessions } from "../src/server/routes/sessions.ts";
import { handleUiState } from "../src/server/routes/ui-state.ts";
import { handleDashboard } from "../src/server/routes/dashboard.ts";
import { withServerGroups } from "./helpers/context.mjs";

function fixture(name) {
  const root = mkdtempSync(resolve(tmpdir(), `${name}-`));
  const dataRoot = resolve(root, "agent-data");
  const workspaceA = resolve(root, "team-a", "project");
  const workspaceB = resolve(root, "team-b", "project");
  mkdirSync(workspaceA, { recursive: true });
  mkdirSync(workspaceB, { recursive: true });
  return { root, dataRoot, workspaceA, workspaceB };
}

function response() {
  return {
    status: 0,
    body: "",
    writeHead(status) { this.status = status; return this; },
    end(value) { if (value) this.body += String(value); return this; },
  };
}

function request(method, url, body) {
  const encoded = body === undefined ? "" : JSON.stringify(body);
  return {
    method,
    url,
    headers: { host: "localhost" },
    async *[Symbol.asyncIterator]() {
      if (encoded) yield Buffer.from(encoded);
    },
  };
}

function context(dataRoot, workspace) {
  const paths = workspaceDataPaths(dataRoot, workspace);
  return withServerGroups({
    runtime: {
      currentWorkspace: workspace,
      session: {
        isStreaming: false,
        sessionManager: { getSessionId: () => "" },
      },
      getActiveSession: () => null,
    },
    chatStream: {},
    appEvents: { publish() {} },
    paths: {
      APP_ROOT: workspace,
      DATA_DIR: dataRoot,
      PI_CONFIG_DIR: resolve(dataRoot, "user"),
      SESSIONS_DIR: paths.sessionsDir,
      SETTINGS_FILE: resolve(dataRoot, "user", "settings.json"),
      STARTUP: {
        appRoot: workspace,
        workspace,
        dataRoot,
        instanceId: "layout-test",
        userRoot: resolve(dataRoot, "user"),
        workspaceRoot: paths.workspaceRoot,
        instanceRoot: resolve(dataRoot, "instances", "layout-test"),
        sessionsDir: paths.sessionsDir,
        cacheDir: resolve(dataRoot, "instances", "layout-test", "cache"),
      },
      FRONTEND_DIR: resolve(workspace, "dist"),
      FRONTEND_SRC_DIR: resolve(workspace, "src"),
      HAS_BUILT_FRONTEND: false,
    },
  });
}

function writeSession(file, id, workspace, message) {
  mkdirSync(resolve(file, ".."), { recursive: true });
  writeFileSync(file, [
    JSON.stringify({ type: "session", id, workspace, timestamp: "2026-08-06T00:00:00.000Z" }),
    JSON.stringify({ type: "message", message: { role: "user", content: [{ type: "text", text: message }] } }),
  ].join("\n") + "\n");
}

function writeUsageSession(file, id, workspace, input) {
  mkdirSync(resolve(file, ".."), { recursive: true });
  writeFileSync(file, [
    JSON.stringify({ type: "session", id, workspace, timestamp: "2026-08-06T00:00:00.000Z" }),
    JSON.stringify({
      type: "message",
      message: {
        role: "assistant",
        content: [{ type: "text", text: id }],
        usage: { input, output: 1, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } },
      },
    }),
  ].join("\n") + "\n");
}

async function listSessions(ctx, workspace) {
  const res = response();
  await handleSessions(request("GET", `/api/sessions?workspace=${encodeURIComponent(workspace)}`), res, ctx);
  return { status: res.status, body: JSON.parse(res.body) };
}

function state(workspace, sessionId) {
  return {
    schemaVersion: 2,
    workspacePath: workspace,
    activeView: { type: "session", id: sessionId },
    tabs: { sessions: [sessionId], files: [], chatOpen: true, labels: {} },
    panel: { active: "explorer", closed: false, width: 260 },
    recent: { sessions: { [sessionId]: 1 }, lastSessionId: sessionId },
  };
}

describe("canonical workspace data layout", () => {
  it("uses different hashed roots for workspaces with the same basename", () => {
    const f = fixture("session-layout-hash");
    try {
      const a = workspaceDataPaths(f.dataRoot, f.workspaceA);
      const b = workspaceDataPaths(f.dataRoot, f.workspaceB);

      assert.strictEqual(basename(f.workspaceA), basename(f.workspaceB));
      assert.notStrictEqual(a.workspaceRoot, b.workspaceRoot);
      assert.notStrictEqual(a.sessionsDir, b.sessionsDir);
      assert.notStrictEqual(a.usageIndexFile, b.usageIndexFile);
      assert.notStrictEqual(a.uiStateFile, b.uiStateFile);
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  });

  it("lists only the active workspace sessions from its canonical directory", async () => {
    const f = fixture("session-layout-list");
    try {
      const a = workspaceDataPaths(f.dataRoot, f.workspaceA);
      const b = workspaceDataPaths(f.dataRoot, f.workspaceB);
      writeSession(resolve(a.sessionsDir, "a.jsonl"), "session-a", f.workspaceA, "A");
      writeSession(resolve(b.sessionsDir, "b.jsonl"), "session-b", f.workspaceB, "B");

      const listedA = await listSessions(context(f.dataRoot, f.workspaceA), f.workspaceA);
      const listedB = await listSessions(context(f.dataRoot, f.workspaceB), f.workspaceB);

      assert.strictEqual(listedA.status, 200);
      assert.deepStrictEqual(listedA.body.sessions.map((entry) => entry.id), ["session-a"]);
      assert.deepStrictEqual(listedB.body.sessions.map((entry) => entry.id), ["session-b"]);
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  });

  it("copies only unambiguous legacy sessions whose header matches the workspace", () => {
    const f = fixture("session-layout-migration");
    try {
      const paths = workspaceDataPaths(f.dataRoot, f.workspaceA);
      const legacyProjectDir = resolve(paths.legacySessionsRoot, "by-project", basename(f.workspaceA));
      const matching = resolve(legacyProjectDir, "matching.jsonl");
      const other = resolve(legacyProjectDir, "other.jsonl");
      const unknown = resolve(legacyProjectDir, "unknown.jsonl");
      writeSession(matching, "matching", f.workspaceA, "match");
      writeSession(other, "other", f.workspaceB, "other");
      writeFileSync(unknown, JSON.stringify({ type: "session", id: "unknown" }) + "\n");

      const result = migrateLegacySessions(f.dataRoot, f.workspaceA);

      assert.deepStrictEqual(result.copied.map((file) => basename(file)), ["matching.jsonl"]);
      assert.strictEqual(existsSync(resolve(paths.sessionsDir, "matching.jsonl")), true);
      assert.strictEqual(existsSync(resolve(paths.sessionsDir, "other.jsonl")), false);
      assert.strictEqual(existsSync(resolve(paths.sessionsDir, "unknown.jsonl")), false);
      assert.strictEqual(existsSync(matching), true, "legacy source must remain untouched");
      assert.strictEqual(existsSync(other), true, "other workspace source must remain untouched");
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  });

  it("does not auto-copy colliding legacy session filenames", () => {
    const f = fixture("session-layout-migration-collision");
    try {
      const paths = workspaceDataPaths(f.dataRoot, f.workspaceA);
      const first = resolve(paths.legacySessionsRoot, "by-project", "first", "same.jsonl");
      const second = resolve(paths.legacySessionsRoot, "by-project", "second", "same.jsonl");
      writeSession(first, "first", f.workspaceA, "first");
      writeSession(second, "second", f.workspaceA, "second");

      const result = migrateLegacySessions(f.dataRoot, f.workspaceA);

      assert.deepStrictEqual(result.copied, []);
      assert.strictEqual(existsSync(resolve(paths.sessionsDir, "same.jsonl")), false);
      assert.strictEqual(existsSync(first), true);
      assert.strictEqual(existsSync(second), true);
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  });

  it("persists UI state in each workspace root without cross-workspace leakage", async () => {
    const f = fixture("session-layout-ui-state");
    try {
      const ctxA = context(f.dataRoot, f.workspaceA);
      const ctxB = context(f.dataRoot, f.workspaceB);
      const stateA = state(f.workspaceA, "session-a");
      const stateB = state(f.workspaceB, "session-b");

      const saveA = response();
      const saveB = response();
      await handleUiState(request("PUT", "/api/ui-state", stateA), saveA, ctxA);
      await handleUiState(request("PUT", "/api/ui-state", stateB), saveB, ctxB);

      const pathsA = workspaceDataPaths(f.dataRoot, f.workspaceA);
      const pathsB = workspaceDataPaths(f.dataRoot, f.workspaceB);
      assert.strictEqual(saveA.status, 200);
      assert.strictEqual(saveB.status, 200);
      assert.deepStrictEqual(JSON.parse(readFileSync(pathsA.uiStateFile, "utf8")), stateA);
      assert.deepStrictEqual(JSON.parse(readFileSync(pathsB.uiStateFile, "utf8")), stateB);

      const getA = response();
      await handleUiState(request("GET", `/api/ui-state?workspace=${encodeURIComponent(f.workspaceA)}`), getA, ctxA);
      assert.deepStrictEqual(JSON.parse(getA.body), stateA);
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  });

  it("lets runtime resolve session files through the canonical workspace callback", () => {
    const f = fixture("session-layout-runtime");
    try {
      const canonical = workspaceDataPaths(f.dataRoot, f.workspaceA);
      const legacyDir = resolve(f.dataRoot, "legacy-sessions");
      mkdirSync(legacyDir, { recursive: true });
      writeSession(resolve(canonical.sessionsDir, "2026-08-06T000000.jsonl"), "canonical", f.workspaceA, "canonical");
      writeSession(resolve(legacyDir, "by-project", basename(f.workspaceA), "2026-08-07T000000.jsonl"), "legacy", f.workspaceA, "legacy");

      const runtime = Object.create(AgentRuntime.prototype);
      runtime.config = {
        sessionsDir: legacyDir,
        sessionsDirForWorkspace: (workspace) => workspaceDataPaths(f.dataRoot, workspace).sessionsDir,
      };

      assert.match(runtime.findLatestSessionFile(f.workspaceA), /2026-08-06T000000\.jsonl$/);
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  });

  it("keeps usage indexes isolated per canonical workspace", async () => {
    const f = fixture("session-layout-usage");
    try {
      const pathsA = workspaceDataPaths(f.dataRoot, f.workspaceA);
      const pathsB = workspaceDataPaths(f.dataRoot, f.workspaceB);
      writeUsageSession(resolve(pathsA.sessionsDir, "a.jsonl"), "usage-a", f.workspaceA, 10);
      writeUsageSession(resolve(pathsB.sessionsDir, "b.jsonl"), "usage-b", f.workspaceB, 20);

      const resA = response();
      const resB = response();
      await handleDashboard(request("GET", "/api/usage/summary"), resA, context(f.dataRoot, f.workspaceA));
      await handleDashboard(request("GET", "/api/usage/summary"), resB, context(f.dataRoot, f.workspaceB));

      assert.strictEqual(resA.status, 200);
      assert.strictEqual(resB.status, 200);
      assert.strictEqual(JSON.parse(resA.body).sessions, 1);
      assert.strictEqual(JSON.parse(resB.body).sessions, 1);
      assert.strictEqual(existsSync(pathsA.usageIndexFile), true);
      assert.strictEqual(existsSync(pathsB.usageIndexFile), true);
      assert.strictEqual(existsSync(resolve(f.dataRoot, "user", "usage-index.json")), false);
      assert.deepStrictEqual(Object.keys(JSON.parse(readFileSync(pathsA.usageIndexFile, "utf8")).sessions), ["usage-a"]);
      assert.deepStrictEqual(Object.keys(JSON.parse(readFileSync(pathsB.usageIndexFile, "utf8")).sessions), ["usage-b"]);
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  });

  it("records canonical workspace metadata beside workspace data", () => {
    const f = fixture("session-layout-metadata");
    try {
      const paths = workspaceDataPaths(f.dataRoot, f.workspaceA);
      writeWorkspaceMetadata(f.dataRoot, f.workspaceA);

      const metadata = JSON.parse(readFileSync(paths.metadataFile, "utf8"));
      assert.strictEqual(metadata.workspace, paths.workspace);
      assert.strictEqual(metadata.workspaceKey, paths.workspaceKey);
      assert.match(metadata.updatedAt, /^\d{4}-\d{2}-\d{2}T/);
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  });
});
