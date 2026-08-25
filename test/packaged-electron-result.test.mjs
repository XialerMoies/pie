import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import test from "node:test";

import { firstTimingAtOrAfter } from "./helpers/electron-e2e-result.mjs";
import {
  isWindowsPidRunning,
  resolveEmptyShellBudget,
  resolveWorkbenchBudget,
  terminateWindowsProcessTree,
  waitForChildTermination,
} from "./helpers/packaged-electron-process.mjs";

test("timing lookup selects the first matching event in a bounded lifecycle sequence", () => {
  const result = {
    timings: [
      { contextId: "context-b", event: "shell-visible", at: 900 },
      { contextId: "context-b", event: "workbench-loaded", at: 950 },
      { contextId: "context-b", event: "window-created", at: 1_000 },
      { contextId: "context-b", event: "shell-visible", at: 1_124 },
      { contextId: "context-b", event: "workbench-loaded", at: 2_622 },
      { contextId: "context-a", event: "shell-visible", at: 2_700 },
      { contextId: "context-b", event: "shell-visible", at: 3_879 },
      { contextId: "context-b", event: "workbench-loaded", at: 4_200 },
    ],
  };

  assert.deepEqual(firstTimingAtOrAfter(result, {
    contextId: "context-b",
    event: "shell-visible",
    at: 1_000,
  }), { contextId: "context-b", event: "shell-visible", at: 1_124 });
  assert.deepEqual(firstTimingAtOrAfter(result, {
    contextId: "context-b",
    event: "workbench-loaded",
    at: 1_000,
  }), { contextId: "context-b", event: "workbench-loaded", at: 2_622 });
});

test("packaged probe captures the real reopen outcome instead of declaring lock status", () => {
  const mainSource = readFileSync(new URL("../src/electron/electron-main.ts", import.meta.url), "utf8");
  const source = readFileSync(new URL("../src/electron/electron-packaged-e2e-probe.ts", import.meta.url), "utf8");

  assert.doesNotMatch(source, /workspaceLocked:\s*false/);
  assert.match(source, /let reopenAction:[^;]+null/);
  assert.match(source, /let reopenError:[^;]+null/);
  assert.match(source, /catch \(error\) \{[\s\S]{0,160}sanitizeE2EReopenError\(error\)/);
  assert.doesNotMatch(mainSource, /let reopenAction:[^;]+null/);
});

test("packaged E2E keeps a strict local workbench budget and a bounded CI budget", () => {
  assert.equal(resolveWorkbenchBudget({}), 3_000);
  assert.equal(resolveWorkbenchBudget({ CI: "true" }), 10_000);
  assert.equal(resolveWorkbenchBudget({ CI: "true", MY_CODE_AGENT_E2E_WORKBENCH_BUDGET_MS: "4500" }), 4_500);
  assert.throws(() => resolveWorkbenchBudget({ MY_CODE_AGENT_E2E_WORKBENCH_BUDGET_MS: "0" }), /positive/);
});

test("packaged E2E uses a strict local shell budget and a bounded CI cold-start budget", () => {
  assert.equal(resolveEmptyShellBudget({}), 300);
  assert.equal(resolveEmptyShellBudget({ CI: "true" }), 5_000);
  assert.equal(resolveEmptyShellBudget({ CI: "true", MY_CODE_AGENT_E2E_EMPTY_SHELL_BUDGET_MS: "3500" }), 3_500);
  assert.throws(() => resolveEmptyShellBudget({ MY_CODE_AGENT_E2E_EMPTY_SHELL_BUDGET_MS: "0" }), /positive/);
});

test("packaged cleanup accepts OS termination when Node misses the exit event", async () => {
  const child = Object.assign(new EventEmitter(), { pid: 42, exitCode: null, signalCode: null });
  await terminateWindowsProcessTree(child, {
    spawnSyncImpl: () => ({ status: 0, signal: null, stderr: "" }),
    isPidRunning: () => false,
    waitMs: 10,
  });
});

test("packaged cleanup probes exact Windows PIDs without a shell", () => {
  const calls = [];
  const running = isWindowsPidRunning(42, (command, args, options) => {
    calls.push({ command, args, options });
    return { status: 0, stdout: '"MyCodeAgent.exe","42","Console","1","100 K"', stderr: "" };
  });
  assert.equal(running, true);
  assert.deepEqual(calls[0].args, ["/FI", "PID eq 42", "/FO", "CSV", "/NH"]);
  assert.equal(calls[0].options.windowsHide, true);
  assert.equal(isWindowsPidRunning(42, () => ({ status: 0, stdout: '"Other.exe","420","Console","1","100 K"' })), false);
});

test("packaged cleanup reports PID and taskkill evidence when a process remains alive", async () => {
  const child = Object.assign(new EventEmitter(), { pid: 73, exitCode: null, signalCode: null });
  await assert.rejects(terminateWindowsProcessTree(child, {
    spawnSyncImpl: () => ({ status: 5, signal: null, stderr: "Access denied" }),
    isPidRunning: () => true,
    waitMs: 5,
    pollMs: 1,
  }), /PID 73.*taskkill status=5.*Access denied/);
});

test("packaged cleanup still observes a real child exit event", async () => {
  const child = Object.assign(new EventEmitter(), { pid: 91, exitCode: null, signalCode: null });
  const waiting = waitForChildTermination(child, { isPidRunning: () => true, waitMs: 20, pollMs: 1 });
  child.exitCode = 0;
  child.emit("exit", 0, null);
  await waiting;
});
