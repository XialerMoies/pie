import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";

import { canonicalWorkspacePath, resolveDataLayout } from "../src/data/data-layout.ts";
import { withFileLock } from "../src/data/file-lock.ts";
import { readUserSettings, recordOpenedWorkspace } from "../src/data/user-settings.ts";
import { handleChat } from "../src/server/routes/chat.ts";
import {
  WorkspaceLockConflictError,
  WorkspaceLockCoordinator,
  acquireWorkspaceLock,
} from "../src/server/workspace-lock.ts";
import { makeReq, makeRes } from "./helpers/http.mjs";

function fixture(name) {
  const root = mkdtempSync(resolve(tmpdir(), `${name}-`));
  const dataRoot = resolve(root, "data");
  const workspace = resolve(root, "workspace");
  mkdirSync(workspace, { recursive: true });
  return { root, dataRoot, workspace };
}

function waitForExit(child, timeoutMs = 10_000) {
  return new Promise((resolveExit, rejectExit) => {
    const timer = setTimeout(() => {
      child.kill();
      rejectExit(new Error("child exit timed out"));
    }, timeoutMs);
    child.once("error", (error) => {
      clearTimeout(timer);
      rejectExit(error);
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      resolveExit({ code, signal });
    });
  });
}

function startServer(workspace, dataRoot, instanceId) {
  const child = spawn(process.execPath, [
    "--import", "tsx", resolve("src/server/server.ts"),
    "--workspace", workspace,
    "--data-root", dataRoot,
    "--instance-id", instanceId,
  ], {
    cwd: process.cwd(),
    env: { ...process.env, MY_CODE_AGENT_DESKTOP_TOKEN: `token-${instanceId}`, PI_DEV_PORT: "0" },
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
  child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });

  return new Promise((resolveServer, rejectServer) => {
    const timer = setTimeout(() => {
      child.kill();
      rejectServer(new Error(`server startup timed out\n${stdout}\n${stderr}`));
    }, 30_000);
    child.stdout.on("data", () => {
      const match = stdout.match(/SERVER_PORT:(\d+)/);
      if (!match) return;
      clearTimeout(timer);
      resolveServer({ child, port: Number(match[1]), stdout: () => stdout, stderr: () => stderr });
    });
    child.once("exit", (code) => {
      if (/SERVER_PORT:\d+/.test(stdout)) return;
      clearTimeout(timer);
      rejectServer(new Error(`server exited before ready (${code})\n${stdout}\n${stderr}`));
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      rejectServer(error);
    });
  });
}

function runServerToExit(workspace, dataRoot, instanceId) {
  const child = spawn(process.execPath, [
    "--import", "tsx", resolve("src/server/server.ts"),
    "--workspace", workspace,
    "--data-root", dataRoot,
    "--instance-id", instanceId,
  ], {
    cwd: process.cwd(),
    env: { ...process.env, MY_CODE_AGENT_DESKTOP_TOKEN: `token-${instanceId}`, PI_DEV_PORT: "0" },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
  child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
  return waitForExit(child, 10_000).then((result) => ({ ...result, stdout, stderr }));
}

async function waitFor(predicate, message, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 25));
  }
  assert.fail(message);
}

function switchWorkspace(running, instanceId, workspace) {
  return fetch(`http://127.0.0.1:${running.port}/api/workspace/switch`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-My-Code-Agent-Token": `token-${instanceId}`,
    },
    body: JSON.stringify({ workspace }),
  });
}

describe("workspace ownership lock", () => {
  it("acquires the canonical workspace and records owner metadata", async () => {
    const f = fixture("workspace-lock-owner");
    try {
      const lease = await acquireWorkspaceLock({
        dataRoot: f.dataRoot,
        workspace: f.workspace,
        instanceId: "owner-a",
        port: 4173,
      });
      const stored = JSON.parse(readFileSync(lease.lockPath, "utf8"));

      assert.strictEqual(stored.workspace, canonicalWorkspacePath(f.workspace));
      assert.strictEqual(stored.pid, process.pid);
      assert.strictEqual(stored.instanceId, "owner-a");
      assert.strictEqual(stored.port, 4173);
      assert.ok(Number.isFinite(stored.startedAt));
      await lease.release();
      assert.strictEqual(existsSync(lease.lockPath), false);
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  });

  it("rejects a second live writer with owner PID, port, and instance details", async () => {
    const f = fixture("workspace-lock-conflict");
    try {
      const first = await acquireWorkspaceLock({
        dataRoot: f.dataRoot,
        workspace: f.workspace,
        instanceId: "owner-live",
        port: 52100,
      });

      await assert.rejects(
        () => acquireWorkspaceLock({
          dataRoot: f.dataRoot,
          workspace: f.workspace,
          instanceId: "owner-second",
        }),
        (error) => {
          assert.ok(error instanceof WorkspaceLockConflictError);
          assert.strictEqual(error.code, "workspace_locked");
          assert.strictEqual(error.statusCode, 409);
          assert.strictEqual(error.owner.pid, process.pid);
          assert.strictEqual(error.owner.port, 52100);
          assert.strictEqual(error.owner.instanceId, "owner-live");
          return true;
        },
      );
      await first.release();
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  });

  it("recovers a stale lock owned by a dead process", async () => {
    const f = fixture("workspace-lock-stale");
    try {
      const layout = resolveDataLayout({ dataRoot: f.dataRoot, workspace: f.workspace, instanceId: "next" });
      mkdirSync(resolve(layout.workspaceLockFile, ".."), { recursive: true });
      writeFileSync(layout.workspaceLockFile, JSON.stringify({
        workspace: canonicalWorkspacePath(f.workspace),
        pid: 2147483647,
        instanceId: "dead-owner",
        port: 43100,
        startedAt: Date.now() - 60_000,
      }));

      const lease = await acquireWorkspaceLock({
        dataRoot: f.dataRoot,
        workspace: f.workspace,
        instanceId: "replacement",
      });
      const stored = JSON.parse(readFileSync(lease.lockPath, "utf8"));
      assert.strictEqual(stored.instanceId, "replacement");
      await lease.release();
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  });

  it("releases the initial lock when startup fails", async () => {
    const f = fixture("workspace-lock-startup-failure");
    try {
      const coordinator = new WorkspaceLockCoordinator({
        dataRoot: f.dataRoot,
        instanceId: "failed-startup",
      });
      await assert.rejects(
        () => coordinator.initialize(f.workspace, async () => {
          throw new Error("startup exploded");
        }),
        /startup exploded/,
      );
      const layout = resolveDataLayout({ dataRoot: f.dataRoot, workspace: f.workspace, instanceId: "failed-startup" });
      assert.strictEqual(existsSync(layout.workspaceLockFile), false);
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  });

  it("keeps the current lock and releases the candidate when a switch fails", async () => {
    const f = fixture("workspace-lock-switch-rollback");
    const nextWorkspace = resolve(f.root, "next-workspace");
    mkdirSync(nextWorkspace, { recursive: true });
    const coordinator = new WorkspaceLockCoordinator({ dataRoot: f.dataRoot, instanceId: "switcher" });
    try {
      await coordinator.acquireInitial(f.workspace);
      await assert.rejects(
        () => coordinator.switchTo(nextWorkspace, async () => {
          throw new Error("runtime switch failed");
        }),
        /runtime switch failed/,
      );
      assert.strictEqual(coordinator.owner?.workspace, canonicalWorkspacePath(f.workspace));

      const candidate = await acquireWorkspaceLock({
        dataRoot: f.dataRoot,
        workspace: nextWorkspace,
        instanceId: "candidate-after-failure",
      });
      await candidate.release();
    } finally {
      await coordinator.release();
      rmSync(f.root, { recursive: true, force: true });
    }
  });

  it("returns a 409 conflict with public owner details from the workspace switch API", async () => {
    const f = fixture("workspace-lock-route-conflict");
    const target = resolve(f.root, "target");
    mkdirSync(target, { recursive: true });
    const current = new WorkspaceLockCoordinator({ dataRoot: f.dataRoot, instanceId: "requester" });
    const blocker = new WorkspaceLockCoordinator({ dataRoot: f.dataRoot, instanceId: "blocker" });
    try {
      await current.acquireInitial(f.workspace);
      await blocker.acquireInitial(target);
      await blocker.updatePort(53321);
      const ctx = {
        runtime: {
          currentWorkspace: canonicalWorkspacePath(f.workspace),
          session: {},
          switchWorkspace: async () => { throw new Error("runtime must not switch on conflict"); },
        },
        chatStream: {},
        appEvents: { publish() {} },
        permissionService: { authorizeWorkspaceRoot: (workspace) => canonicalWorkspacePath(workspace) },
        workspaceLock: current,
        paths: { APP_ROOT: f.workspace },
      };
      const response = makeRes();

      await handleChat(makeReq("POST", "/api/workspace/switch", { workspace: target }), response, ctx);
      await new Promise((resolveWait) => setTimeout(resolveWait, 20));
      const body = JSON.parse(response._body);
      assert.strictEqual(response._status, 409);
      assert.strictEqual(body.code, "workspace_locked");
      assert.strictEqual(body.owner.instanceId, "blocker");
      assert.strictEqual(body.owner.port, 53321);
      assert.strictEqual(body.owner.lockId, undefined);
    } finally {
      await current.release();
      await blocker.release();
      rmSync(f.root, { recursive: true, force: true });
    }
  });

  it("does not reset chat state or prompt when the requested workspace is locked", async () => {
    const f = fixture("workspace-lock-chat-conflict");
    const target = resolve(f.root, "target");
    mkdirSync(target, { recursive: true });
    const current = new WorkspaceLockCoordinator({ dataRoot: f.dataRoot, instanceId: "chat-requester" });
    const blocker = new WorkspaceLockCoordinator({ dataRoot: f.dataRoot, instanceId: "chat-blocker" });
    try {
      await current.acquireInitial(f.workspace);
      await blocker.acquireInitial(target);
      let promptCalls = 0;
      const chatStream = {
        textBuffer: "unchanged",
        thinkingBuffer: "thinking",
        currentTextSnapshot: "snapshot",
        currentThinkingSnapshot: "thinking-snapshot",
        response: null,
        currentWorkspace: canonicalWorkspacePath(f.workspace),
        turnId: "existing-turn",
        traceSeq: 4,
        blockSeq: 3,
        blocks: [{ type: "text" }],
        textSegments: ["segment"],
        emittedTraces: new Set(["trace"]),
        eventSeq: 2,
        eventHistory: [{ id: 2, data: "existing" }],
      };
      const ctx = {
        runtime: {
          currentWorkspace: canonicalWorkspacePath(f.workspace),
          session: { prompt: async () => { promptCalls += 1; } },
          switchWorkspace: async () => { throw new Error("runtime must not switch on conflict"); },
        },
        chatStream,
        appEvents: { publish() {} },
        permissionService: { authorizeWorkspaceRoot: (workspace) => canonicalWorkspacePath(workspace) },
        workspaceLock: current,
        paths: { APP_ROOT: f.workspace },
      };
      const response = makeRes();

      await handleChat(makeReq("POST", "/api/chat", { message: "hello", workspace: target }), response, ctx);
      await new Promise((resolveWait) => setTimeout(resolveWait, 20));

      assert.strictEqual(response._status, 409);
      assert.strictEqual(JSON.parse(response._body).code, "workspace_locked");
      assert.strictEqual(promptCalls, 0);
      assert.strictEqual(chatStream.textBuffer, "unchanged");
      assert.strictEqual(chatStream.turnId, "existing-turn");
      assert.deepStrictEqual(chatStream.eventHistory, [{ id: 2, data: "existing" }]);
    } finally {
      await current.release();
      await blocker.release();
      rmSync(f.root, { recursive: true, force: true });
    }
  });

  it("records successful server workspace switches but not failed or conflicting switches", async () => {
    const f = fixture("workspace-lock-record-switch");
    const instanceId = "record-switcher";
    const target = resolve(f.root, "target");
    const lockedTarget = resolve(f.root, "locked-target");
    const missingTarget = resolve(f.root, "missing-target");
    mkdirSync(target, { recursive: true });
    mkdirSync(lockedTarget, { recursive: true });
    const blocker = new WorkspaceLockCoordinator({ dataRoot: f.dataRoot, instanceId: "record-blocker" });
    const settingsFile = resolveDataLayout({
      dataRoot: f.dataRoot,
      workspace: f.workspace,
      instanceId,
    }).settingsFile;
    let running;
    try {
      running = await startServer(f.workspace, f.dataRoot, instanceId);
      await waitFor(
        () => readUserSettings(settingsFile).startup?.lastWorkspace === canonicalWorkspacePath(f.workspace),
        "initial workspace was not recorded",
      );

      const switched = await switchWorkspace(running, instanceId, target);
      assert.strictEqual(switched.status, 200);
      await waitFor(
        () => readUserSettings(settingsFile).startup?.lastWorkspace === canonicalWorkspacePath(target),
        "successful workspace switch was not recorded",
      );

      const failed = await switchWorkspace(running, instanceId, missingTarget);
      assert.strictEqual(failed.status, 400);
      assert.strictEqual(readUserSettings(settingsFile).startup?.lastWorkspace, canonicalWorkspacePath(target));

      await blocker.acquireInitial(lockedTarget);
      const conflicted = await switchWorkspace(running, instanceId, lockedTarget);
      assert.strictEqual(conflicted.status, 409);
      assert.strictEqual(readUserSettings(settingsFile).startup?.lastWorkspace, canonicalWorkspacePath(target));
    } finally {
      try {
        if (running?.child.exitCode === null) {
          running.child.stdin.write("PI_SERVER_SHUTDOWN\n");
          running.child.stdin.end();
          await waitForExit(running.child);
        }
      } finally {
        try {
          await blocker.release();
        } finally {
          rmSync(f.root, { recursive: true, force: true });
        }
      }
    }
  });

  it("waits for a queued workspace record before graceful shutdown", async () => {
    const f = fixture("workspace-record-shutdown");
    const instanceId = "record-shutdown";
    const target = resolve(f.root, "target");
    mkdirSync(target, { recursive: true });
    const settingsFile = resolveDataLayout({
      dataRoot: f.dataRoot,
      workspace: f.workspace,
      instanceId,
    }).settingsFile;
    let releaseSettingsLock;
    const settingsLockRelease = new Promise((resolveRelease) => { releaseSettingsLock = resolveRelease; });
    let signalSettingsLock;
    const settingsLockEntered = new Promise((resolveEntered) => { signalSettingsLock = resolveEntered; });
    let running;
    let settingsLockOwner;
    try {
      running = await startServer(f.workspace, f.dataRoot, instanceId);
      await waitFor(
        () => readUserSettings(settingsFile).startup?.lastWorkspace === canonicalWorkspacePath(f.workspace),
        "initial workspace was not recorded",
      );

      settingsLockOwner = withFileLock(`${settingsFile}.lock`, { timeoutMs: 30_000 }, async () => {
        signalSettingsLock();
        await settingsLockRelease;
      });
      await settingsLockEntered;

      const switched = await switchWorkspace(running, instanceId, target);
      assert.strictEqual(switched.status, 200);
      await switched.arrayBuffer();

      const exit = waitForExit(running.child);
      running.child.stdin.write("PI_SERVER_SHUTDOWN\n");
      running.child.stdin.end();
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
      releaseSettingsLock();
      await exit;

      assert.strictEqual(readUserSettings(settingsFile).startup?.lastWorkspace, canonicalWorkspacePath(target));
    } finally {
      try {
        releaseSettingsLock?.();
        if (settingsLockOwner) await settingsLockOwner;
      } finally {
        try {
          if (running?.child.exitCode === null) running.child.kill();
        } finally {
          rmSync(f.root, { recursive: true, force: true });
        }
      }
    }
  });

  it("keeps startup and workspace switching available when recording settings fails", async () => {
    const f = fixture("workspace-recording-failure");
    const instanceId = "recording-failure";
    const target = resolve(f.root, "target");
    mkdirSync(target, { recursive: true });
    const settingsFile = resolveDataLayout({
      dataRoot: f.dataRoot,
      workspace: f.workspace,
      instanceId,
    }).settingsFile;
    mkdirSync(settingsFile, { recursive: true });
    let running;
    try {
      running = await startServer(f.workspace, f.dataRoot, instanceId);
      await waitFor(
        () => /Failed to record opened workspace/.test(running.stderr()),
        "startup recording failure was not logged",
      );
      const warningsBeforeSwitch = running.stderr().match(/Failed to record opened workspace/g)?.length ?? 0;

      const switched = await switchWorkspace(running, instanceId, target);
      assert.strictEqual(switched.status, 200);
      assert.strictEqual(canonicalWorkspacePath((await switched.json()).workspace), canonicalWorkspacePath(target));
      await waitFor(
        () => (running.stderr().match(/Failed to record opened workspace/g)?.length ?? 0) > warningsBeforeSwitch,
        "workspace switch recording failure was not logged",
      );

      const bootstrap = await fetch(`http://127.0.0.1:${running.port}/api/bootstrap`, {
        headers: { "X-My-Code-Agent-Token": `token-${instanceId}` },
      });
      assert.strictEqual(bootstrap.status, 200);
      assert.ok((await bootstrap.json()).startup);
    } finally {
      try {
        if (running?.child.exitCode === null) {
          running.child.stdin.write("PI_SERVER_SHUTDOWN\n");
          running.child.stdin.end();
          await waitForExit(running.child);
        }
      } finally {
        rmSync(f.root, { recursive: true, force: true });
      }
    }
  });

  it("writes the listening port and releases the lock on graceful shutdown", async () => {
    const f = fixture("workspace-lock-server");
    const previousWorkspace = resolve(f.root, "previous-workspace");
    mkdirSync(previousWorkspace, { recursive: true });
    let running;
    try {
      running = await startServer(f.workspace, f.dataRoot, "server-owner");
      const layout = resolveDataLayout({ dataRoot: f.dataRoot, workspace: f.workspace, instanceId: "server-owner" });
      await waitFor(
        () => readUserSettings(layout.settingsFile).startup?.lastWorkspace === canonicalWorkspacePath(f.workspace),
        "lock owner startup workspace was not recorded",
      );
      const owner = JSON.parse(readFileSync(layout.workspaceLockFile, "utf8"));
      assert.strictEqual(owner.instanceId, "server-owner");
      assert.strictEqual(owner.port, running.port);
      await recordOpenedWorkspace(layout.settingsFile, previousWorkspace);
      assert.strictEqual(
        readUserSettings(layout.settingsFile).startup?.lastWorkspace,
        canonicalWorkspacePath(previousWorkspace),
      );

      const conflict = await runServerToExit(f.workspace, f.dataRoot, "server-second");
      assert.strictEqual(conflict.code, 1);
      assert.match(conflict.stderr, /WorkspaceLockConflictError/);
      assert.match(conflict.stderr, /server-owner/);
      assert.match(conflict.stderr, new RegExp(String(running.port)));
      assert.strictEqual(
        readUserSettings(layout.settingsFile).startup?.lastWorkspace,
        canonicalWorkspacePath(previousWorkspace),
      );

      running.child.stdin.write("PI_SERVER_SHUTDOWN\n");
      running.child.stdin.end();
      await waitForExit(running.child);
      assert.strictEqual(existsSync(layout.workspaceLockFile), false);
    } finally {
      if (running?.child.exitCode === null) running.child.kill();
      rmSync(f.root, { recursive: true, force: true });
    }
  });
});
