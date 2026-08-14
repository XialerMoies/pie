import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

const moduleUrl = new URL("../src/electron/electron-e2e-runtime.ts", import.meta.url);
const mainUrl = new URL("../src/electron/electron-main.ts", import.meta.url);

function createContext(overrides = {}) {
  const window = overrides.window || {
    webContents: { id: 17 },
    isDestroyed: () => false,
  };
  return {
    id: "context-a",
    instanceId: "instance-a",
    workspace: "C:\\workspaces\\project-a",
    layout: {
      instanceRoot: "C:\\data\\instances\\instance-a",
      sessionsDir: "C:\\data\\workspaces\\a\\sessions",
    },
    window,
    lifecycle: "active",
    server: {
      kind: "owned",
      process: { pid: 4321 },
      port: 43123,
      token: "server-secret-a",
    },
    ...overrides,
  };
}

async function createRuntime(overrides = {}) {
  const { createElectronE2ERuntime } = await import(moduleUrl.href);
  return createElectronE2ERuntime({
    enabled: true,
    electronPid: 1234,
    resultFile: null,
    appRoot: "C:\\app",
    runtimeRoot: "C:\\runtime",
    dataRoot: "C:\\data",
    e2eDataRoot: "C:\\e2e-data",
    desktopSecurityToken: "desktop-secret",
    ensureDir: () => {},
    now: () => 1000,
    log: () => {},
    ...overrides,
  });
}

test("Electron E2E runtime owns mutable diagnostics outside electron-main", () => {
  assert.equal(existsSync(moduleUrl), true, "electron-e2e-runtime.ts should exist");

  const mainSource = readFileSync(mainUrl, "utf8");
  const runtimeSource = readFileSync(moduleUrl, "utf8");
  assert.match(runtimeSource, /export\s+function\s+createElectronE2ERuntime\s*\(/);
  assert.match(mainSource, /from "\.\/electron-e2e-runtime\.js"/);

  for (const name of [
    "e2eDiagnostics",
    "e2eRecorder",
    "e2eWindowCreatedAt",
    "e2eRecordedContexts",
    "e2eTrackedContexts",
  ]) {
    assert.doesNotMatch(mainSource, new RegExp(`(?:const|let)\\s+${name}\\b`));
  }
  for (const name of [
    "e2eFailureSnapshot",
    "e2eFailureRedactions",
    "recordE2EContext",
    "recordE2ETiming",
    "latestE2ETiming",
    "e2eStage",
    "writeE2EResult",
    "countE2EOwnedServerChildren",
  ]) {
    assert.doesNotMatch(mainSource, new RegExp(`function\\s+${name}\\s*\\(`));
  }
});

test("disabled runtime is a no-op", async () => {
  const writes = [];
  const logs = [];
  const runtime = await createRuntime({
    enabled: false,
    resultFile: "C:\\temp\\result.json",
    writeFile: (...args) => writes.push(args),
    log: (message) => logs.push(message),
  });
  const context = createContext();

  runtime.markWindowCreated(context.window, 900);
  runtime.recordContext(context);
  assert.equal(runtime.recordTiming(context, "shell-visible"), null);
  assert.equal(runtime.latestTiming(context, "window-created"), null);
  runtime.stage("disabled-stage");
  runtime.writeResult({ ok: true });

  assert.deepEqual(runtime.diagnostics, []);
  assert.deepEqual(writes, []);
  assert.deepEqual(logs, []);
  assert.deepEqual(runtime.failureSnapshot(), {
    electronPid: 1234,
    windows: [],
    timings: [],
  });
});

test("records each context once and preserves its window-created timestamp", async () => {
  let now = 1000;
  const runtime = await createRuntime({ now: () => now });
  const context = createContext();

  runtime.markWindowCreated(context.window, 750);
  runtime.recordContext(context);
  now = 2000;
  runtime.recordContext(context);

  const snapshot = runtime.failureSnapshot();
  assert.equal(snapshot.windows.length, 1);
  assert.deepEqual(snapshot.timings, [
    { contextId: "context-a", event: "window-created", at: 750 },
  ]);
});

test("records timings and returns the latest matching timing", async () => {
  let now = 1000;
  const runtime = await createRuntime({ now: () => now });
  const context = createContext();

  assert.equal(runtime.recordTiming(context, "shell-visible"), 1000);
  now = 1400;
  assert.equal(runtime.recordTiming(context, "shell-visible"), 1400);
  assert.equal(runtime.latestTiming(context, "shell-visible"), 1400);
  assert.equal(runtime.latestTiming(context, "server-ready"), null);
});

test("snapshots an explicit context set for successful results", async () => {
  const runtime = await createRuntime();
  const contextA = createContext();
  const contextB = createContext({ id: "context-b", instanceId: "instance-b" });
  runtime.recordContext(contextA);
  runtime.recordContext(contextB);

  assert.deepEqual(runtime.snapshot([contextB]).windows.map((entry) => entry.contextId), ["context-b"]);
});

test("captures diagnostics without logging and stages with logging", async () => {
  const logs = [];
  const runtime = await createRuntime({ log: (message) => logs.push(message) });

  runtime.captureDiagnostic("console detail");
  runtime.stage("window ready");

  assert.deepEqual(runtime.diagnostics, ["console detail", "window ready"]);
  assert.deepEqual(logs, ["[e2e] window ready"]);
});

test("failure snapshots omit closed and destroyed contexts", async () => {
  const runtime = await createRuntime();
  const active = createContext();
  const closed = createContext({ id: "closed", lifecycle: "closed" });
  const destroyed = createContext({
    id: "destroyed",
    window: { webContents: { id: 19 }, isDestroyed: () => true },
  });

  runtime.recordContext(active);
  runtime.recordContext(closed);
  runtime.recordContext(destroyed);

  assert.deepEqual(runtime.failureSnapshot().windows.map((entry) => entry.contextId), ["context-a"]);
});

test("failure redactions include configured and tracked roots and all tokens", async () => {
  const runtime = await createRuntime();
  runtime.recordContext(createContext());

  const redactions = runtime.failureRedactions();
  assert.deepEqual(new Set(redactions.secrets), new Set(["desktop-secret", "server-secret-a"]));
  assert.equal(redactions.roots.some((entry) => entry.value === "C:\\app" && entry.label === "<app-root>"), true);
  assert.equal(redactions.roots.some((entry) => entry.value === "C:/app" && entry.label === "<app-root>"), true);
  assert.equal(redactions.roots.some((entry) => entry.value === "C:\\workspaces\\project-a" && entry.label === "<workspace-root>"), true);
  assert.equal(JSON.stringify(redactions).includes("server-secret-a"), true);
});

test("writes formatted result JSON after ensuring the parent directory", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "electron-e2e-runtime-"));
  const resultFile = path.join(root, "nested", "result.json");
  const ensured = [];
  try {
    const runtime = await createRuntime({
      resultFile,
      ensureDir: (directory) => {
        ensured.push(directory);
        mkdirSync(directory, { recursive: true });
      },
    });
    runtime.writeResult({ ok: true, count: 2 });

    assert.deepEqual(ensured, [path.dirname(resultFile)]);
    assert.deepEqual(JSON.parse(readFileSync(resultFile, "utf8")), { ok: true, count: 2 });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("counts only active owned server child processes", async () => {
  const runtime = await createRuntime();
  runtime.recordContext(createContext());
  runtime.recordContext(createContext({ id: "external", server: { kind: "external", process: null, port: 3099, token: "external" } }));
  runtime.recordContext(createContext({ id: "none", server: { kind: "none", process: null, port: 0, token: "" } }));
  runtime.recordContext(createContext({ id: "closing", lifecycle: "closing" }));
  runtime.recordContext(createContext({ id: "no-pid", server: { kind: "owned", process: {}, port: 43124, token: "owned" } }));

  assert.equal(runtime.countOwnedServerChildren(), 1);
});
