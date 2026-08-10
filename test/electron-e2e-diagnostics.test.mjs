import assert from "node:assert/strict";
import test from "node:test";

import * as e2eDiagnostics from "../src/electron/e2e-diagnostics.ts";

const {
  createElectronE2EDiagnostics,
  fingerprintToken,
} = e2eDiagnostics;

test("E2E diagnostics record real lifecycle times and redact server tokens", () => {
  let now = 1_000;
  const diagnostics = createElectronE2EDiagnostics({
    electronPid: 4123,
    now: () => now,
  });
  const context = {
    id: "context-a",
    instanceId: "instance-a",
    workspace: "C:\\projects\\a",
    layout: { instanceRoot: "C:\\data\\instances\\instance-a" },
    window: { webContents: { id: 17 } },
    server: {
      kind: "owned",
      process: { pid: 5101 },
      port: 43101,
      token: "raw-secret-a",
    },
  };

  diagnostics.record(context, "window-created", 950);
  now = 1_075;
  diagnostics.record(context, "shell-visible");
  now = 1_600;
  diagnostics.record(context, "server-ready");
  now = 1_700;
  diagnostics.record(context, "workbench-loaded");

  const result = diagnostics.snapshot([context]);
  assert.equal(result.electronPid, 4123);
  assert.deepEqual(result.timings, [
    { contextId: "context-a", event: "window-created", at: 950 },
    { contextId: "context-a", event: "shell-visible", at: 1_075 },
    { contextId: "context-a", event: "server-ready", at: 1_600 },
    { contextId: "context-a", event: "workbench-loaded", at: 1_700 },
  ]);
  assert.deepEqual(result.windows, [{
    contextId: "context-a",
    webContentsId: 17,
    workspace: "C:\\projects\\a",
    instanceId: "instance-a",
    instanceRoot: "C:\\data\\instances\\instance-a",
    serverKind: "owned",
    serverPid: 5101,
    port: 43101,
    tokenFingerprint: fingerprintToken("raw-secret-a"),
    loadedAt: 1_700,
  }]);
  assert.doesNotMatch(JSON.stringify(result), /raw-secret-a/);
});

test("E2E diagnostics describe an empty shell without inventing server data", () => {
  const diagnostics = createElectronE2EDiagnostics({ electronPid: 4123, now: () => 200 });
  const context = {
    id: "context-empty",
    instanceId: "instance-empty",
    workspace: null,
    layout: null,
    window: { webContents: { id: 18 } },
    server: { kind: "none", process: null, port: 0, token: "" },
  };

  diagnostics.record(context, "window-created", 100);
  const result = diagnostics.snapshot([context]);

  assert.deepEqual(result.windows[0], {
    contextId: "context-empty",
    webContentsId: 18,
    workspace: null,
    instanceId: "instance-empty",
    instanceRoot: null,
    serverKind: "none",
    serverPid: null,
    port: 0,
    tokenFingerprint: "",
    loadedAt: null,
  });
});

test("E2E reopen errors expose workspace locks without leaking paths or tokens", () => {
  assert.equal(typeof e2eDiagnostics.sanitizeE2EReopenError, "function");
  const diagnostic = e2eDiagnostics.sanitizeE2EReopenError(Object.assign(
    new Error("Workspace E:\\private\\project is already open; token=raw-secret"),
    { code: "WORKSPACE_LOCKED" },
  ));

  assert.deepEqual(diagnostic, {
    code: "workspace_locked",
    message: "Workspace is locked",
  });
  assert.doesNotMatch(JSON.stringify(diagnostic), /private|raw-secret|token/i);
});

test("E2E reopen errors replace arbitrary details with a stable diagnostic", () => {
  assert.equal(typeof e2eDiagnostics.sanitizeE2EReopenError, "function");
  const diagnostic = e2eDiagnostics.sanitizeE2EReopenError(Object.assign(
    new Error("Failed at E:\\private\\project with token=raw-secret"),
    { code: "E:\\private\\project" },
  ));

  assert.deepEqual(diagnostic, {
    code: "workspace_reopen_failed",
    message: "Workspace reopen failed",
  });
  assert.doesNotMatch(JSON.stringify(diagnostic), /private|raw-secret|token/i);
});
