import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { once } from "node:events";

import {
  previewLegacySessions,
  migrateLegacySessions,
} from "../src/server/routes/session-dir.ts";
import { canonicalWorkspacePath, resolveDataLayout } from "../src/data/data-layout.ts";
import { readUserSettings } from "../src/data/user-settings.ts";
import { resolveStartupPaths } from "../src/server/startup-paths.ts";
import {
  DESKTOP_IPC_INVOKE_CHANNELS,
  registerDesktopIpcHandlers,
  TrustedDesktopRoots,
} from "../src/electron/desktop-ipc.ts";
import {
  LEGACY_LAUNCH_HANDOFF_ERROR,
  drainSecondLaunchRequests,
  parseDesktopLaunchRequest,
  createLegacyLaunchWaiterRegistry,
} from "../src/electron/desktop-launch.ts";

function fixture(name) {
  const root = mkdtempSync(join(tmpdir(), `multi-instance-launch-${name}-`));
  const dataRoot = join(root, "data");
  const workspace = join(root, "workspace");
  mkdirSync(workspace, { recursive: true });
  return { root, dataRoot, workspace };
}

function writeSession(file, id, workspace, content) {
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, `${JSON.stringify({ type: "session", id, workspace })}\n${content}\n`);
}

class IpcMainMock {
  handles = new Map();
  listeners = new Map();
  handle(channel, handler) { this.handles.set(channel, handler); }
  on(channel, handler) { this.listeners.set(channel, handler); }
  invoke(channel, ...args) { return this.handles.get(channel)({}, ...args); }
}

class ChildProcessMock {
  listeners = new Map();
  exitCode = null;
  once(event, listener) {
    this.listeners.set(event, listener);
    return this;
  }
  emit(event, ...args) {
    const listener = this.listeners.get(event);
    if (listener) listener(...args);
  }
  unref() {}
}

function startServer({ workspace, dataRoot, instanceId, token }) {
  return new Promise((resolveServer, rejectServer) => {
    const childNodeOptions = `${(process.env.NODE_OPTIONS || "").replace(/--max-old-space-size=\d+/gu, "").trim()} --max-old-space-size=512`.trim();
    const child = spawn(process.execPath, [
      "--import", "tsx", resolve("src/server/server.ts"),
      "--workspace", workspace,
      "--data-root", dataRoot,
      "--instance-id", instanceId,
    ], {
      cwd: process.cwd(),
      env: { ...process.env, NODE_OPTIONS: childNodeOptions, PI_DEV_PORT: "0", MY_CODE_AGENT_DESKTOP_TOKEN: token },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timer;
    const settle = (callback) => {
      if (settled) return false;
      settled = true;
      clearTimeout(timer);
      callback();
      return true;
    };
    const rejectStartup = (error, kill = true) => {
      if (!settle(() => rejectServer(error))) return;
      if (kill && child.exitCode === null) child.kill();
    };
    timer = setTimeout(() => {
      rejectStartup(new Error(`server startup timed out\n${stdout}\n${stderr}`));
    }, 30_000);
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
      const match = stdout.match(/SERVER_PORT:(\d+)/);
      if (!match) return;
      settle(() => resolveServer({ child, port: Number(match[1]), token }));
    });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.once("error", (error) => rejectStartup(error));
    child.once("exit", (code, signal) => {
      if (!settled) {
        rejectStartup(new Error(`server exited before ready (${code ?? "unknown"}, ${signal ?? "unknown"})\n${stdout}\n${stderr}`), false);
      }
    });
  });
}

async function stopServer(server) {
  if (!server?.child || server.child.exitCode !== null) return;
  server.child.stdin?.write("PI_SERVER_SHUTDOWN\n");
  server.child.stdin?.end();
  await Promise.race([
    new Promise((resolveExit) => server.child.once("exit", resolveExit)),
    new Promise((resolveWait) => setTimeout(resolveWait, 5_000)),
  ]);
  if (server.child.exitCode === null) {
    server.child.kill();
    await Promise.race([
      once(server.child, "exit"),
      new Promise((resolveWait) => setTimeout(resolveWait, 5_000)),
    ]);
  }
}

async function waitFor(predicate, message, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 25));
  }
  assert.fail(message);
}

describe("multi-instance launch and migration UX", () => {
  it("preserves instance-id when parsing a second-instance request", () => {
    const request = parseDesktopLaunchRequest(
      ["app.exe", "--workspace", "workspace-a", "--data-root", "data", "--instance-id", "legacy-1"],
      "E:/launch-directory",
    );

    assert.deepStrictEqual(request, {
      workspace: resolve("E:/launch-directory/workspace-a"),
      dataRoot: resolve("E:/launch-directory/data"),
      instanceId: "legacy-1",
    });
  });

  it("keeps a legacy launch promise pending after child spawn", async () => {
    const child = new ChildProcessMock();
    const registry = createLegacyLaunchWaiterRegistry({ timeoutMs: 1_000 });
    const launch = registry.register("legacy-spawn", child);
    child.emit("spawn");

    const result = await Promise.race([
      launch.then(() => "resolved", () => "rejected"),
      new Promise((resolveWait) => setTimeout(() => resolveWait("pending"), 10)),
    ]);

    assert.strictEqual(result, "pending");
    assert.strictEqual(registry.size(), 1);
    registry.reject("legacy-spawn", new Error(LEGACY_LAUNCH_HANDOFF_ERROR));
    await assert.rejects(launch, new RegExp(LEGACY_LAUNCH_HANDOFF_ERROR));
  });

  it("rejects only the waiter matching a second-instance request", async () => {
    const first = new ChildProcessMock();
    const second = new ChildProcessMock();
    const registry = createLegacyLaunchWaiterRegistry({ timeoutMs: 1_000 });
    const firstLaunch = registry.register("legacy-a", first);
    const secondLaunch = registry.register("legacy-b", second);
    const rejected = [];

    drainSecondLaunchRequests([
      { instanceId: "legacy-a" },
    ], {
      rejectWaiter: (instanceId) => registry.reject(instanceId, new Error(LEGACY_LAUNCH_HANDOFF_ERROR)),
      focus: () => rejected.push("focus"),
      showErrorBox: () => rejected.push("modal"),
    });

    await assert.rejects(firstLaunch, new RegExp(LEGACY_LAUNCH_HANDOFF_ERROR));
    assert.strictEqual(registry.size(), 1);
    assert.deepStrictEqual(rejected, []);
    registry.reject("legacy-b", new Error("cleanup"));
    await assert.rejects(secondLaunch, /cleanup/);
  });

  it("cleans a waiter on child error, early exit, and timeout", async () => {
    const registry = createLegacyLaunchWaiterRegistry({ timeoutMs: 5 });
    const erroredChild = new ChildProcessMock();
    const exitedChild = new ChildProcessMock();
    const timedOutChild = new ChildProcessMock();
    const errored = registry.register("legacy-error", erroredChild);
    const exited = registry.register("legacy-exit", exitedChild);
    const timedOut = registry.register("legacy-timeout", timedOutChild);

    erroredChild.emit("error", new Error("spawn failed"));
    exitedChild.emit("exit", 1, null);

    await assert.rejects(errored, /spawn failed/);
    await assert.rejects(exited, /exited before handoff/);
    await assert.rejects(timedOut, /timed out/);
    assert.strictEqual(registry.size(), 0);
  });

  it("coalesces 32 external queued requests into one notice", () => {
    let focusCalls = 0;
    let modalCalls = 0;
    drainSecondLaunchRequests(Array.from({ length: 32 }, (_, index) => ({
      workspace: `workspace-${index}`,
    })), {
      rejectWaiter: () => false,
      focus: () => { focusCalls++; },
      showErrorBox: () => { modalCalls++; },
    });

    assert.strictEqual(focusCalls, 1);
    assert.strictEqual(modalCalls, 1);
  });

  it("previews matching legacy sessions with bytes and reports collisions without writing", () => {
    const f = fixture("preview");
    try {
      const legacyDir = join(f.dataRoot, "pi", "sessions", "by-project", basename(f.workspace));
      const matching = join(legacyDir, "matching.jsonl");
      const collisionA = join(f.dataRoot, "pi", "sessions", "by-project", "one", "same.jsonl");
      const collisionB = join(f.dataRoot, "pi", "sessions", "by-project", "two", "same.jsonl");
      const caseCollisionA = join(f.dataRoot, "pi", "sessions", "by-project", "three", "Case.jsonl");
      const caseCollisionB = join(f.dataRoot, "pi", "sessions", "by-project", "four", "case.jsonl");
      writeSession(matching, "matching", f.workspace, "match");
      writeSession(collisionA, "same-a", f.workspace, "a");
      writeSession(collisionB, "same-b", f.workspace, "b");
      writeSession(caseCollisionA, "case-a", f.workspace, "a");
      writeSession(caseCollisionB, "case-b", f.workspace, "b");

      const preview = previewLegacySessions(f.dataRoot, f.workspace);
      const caseInsensitiveDestinations = process.platform === "win32" || process.platform === "darwin";

      assert.strictEqual(preview.fileCount, caseInsensitiveDestinations ? 1 : 3);
      assert.ok(preview.bytes >= statSync(matching).size);
      if (caseInsensitiveDestinations) assert.strictEqual(preview.bytes, statSync(matching).size);
      assert.ok(preview.files.some((file) => basename(file.source) === "matching.jsonl"));
      assert.ok(preview.conflicts.some((conflict) => conflict.includes("same.jsonl")));
      assert.strictEqual(
        preview.conflicts.some((conflict) => conflict.toLowerCase().includes("case.jsonl")),
        caseInsensitiveDestinations,
      );
      assert.match(preview.previewId, /^[a-f0-9]{64}$/);
      assert.strictEqual(existsSync(preview.destination), false);
      assert.strictEqual(existsSync(matching), true);
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  });

  it("confirm migration copies the previewed files and never deletes legacy sources", () => {
    const f = fixture("confirm");
    try {
      const source = join(f.dataRoot, "pi", "sessions", "by-project", basename(f.workspace), "one.jsonl");
      writeSession(source, "one", f.workspace, "payload");
      const before = previewLegacySessions(f.dataRoot, f.workspace);
      const result = migrateLegacySessions(f.dataRoot, f.workspace);

      assert.strictEqual(result.copied.length, before.fileCount);
      assert.strictEqual(existsSync(source), true);
      assert.strictEqual(existsSync(join(before.destination, "one.jsonl")), true);
      assert.deepStrictEqual(previewLegacySessions(f.dataRoot, f.workspace).conflicts, []);
      assert.strictEqual(previewLegacySessions(f.dataRoot, f.workspace).fileCount, 0);
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  });

  it("uses an exclusive destination create so a migration race cannot overwrite data", () => {
    const source = readFileSync(resolve("src/server/routes/session-dir.ts"), "utf8");
    assert.match(source, /copyFileSync\(source, destination, fsConstants\.COPYFILE_EXCL\)/);
  });

  it("launches an empty window without opening a folder dialog", async () => {
    const f = fixture("ipc");
    try {
      const ipcMain = new IpcMainMock();
      const calls = [];
      const roots = new TrustedDesktopRoots();
      const context = {
        id: "sender",
        window: {
          webContents: { id: 1 },
          minimize() {},
          isMaximized: () => false,
          maximize() {},
          unmaximize() {},
          close() {},
        },
        token: "token",
        trustedRoots: roots,
        server: { kind: "none", port: 0, origin: "" },
      };
      registerDesktopIpcHandlers({
        ipcMain,
        resolveContext: () => context,
        createEmptyWindow: () => { calls.push("empty-window"); return { ok: true, instanceId: "empty-1" }; },
        openWorkspaceFolder: async () => { calls.push("dialog"); return null; },
        retryWorkspace: async () => { calls.push("retry"); },
        selectFolder: async () => { calls.push("dialog"); return f.workspace; },
        selectFile: async () => { calls.push("dialog"); return null; },
        showItemInFolder: () => {},
        trashItem: async () => {},
        spawnTerminal: () => true,
      });

      assert.ok(DESKTOP_IPC_INVOKE_CHANNELS.includes("window-new"));
      assert.ok(!DESKTOP_IPC_INVOKE_CHANNELS.includes("launch-project-instance"));
      assert.deepStrictEqual(await ipcMain.invoke("window-new"), { ok: true, instanceId: "empty-1" });
      assert.deepStrictEqual(calls, ["empty-window"]);
      assert.deepStrictEqual(roots.listRoots(), []);
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  });

  it("starts two isolated server instances and preserves each requested workspace", async () => {
    const f = fixture("servers");
    const workspaceB = join(f.root, "workspace-b");
    mkdirSync(workspaceB, { recursive: true });
    let first;
    let second;
    try {
      const starts = await Promise.allSettled([
        startServer({ workspace: f.workspace, dataRoot: f.dataRoot, instanceId: "launch-a", token: "launch-token-a" }),
        startServer({ workspace: workspaceB, dataRoot: f.dataRoot, instanceId: "launch-b", token: "launch-token-b" }),
      ]);
      first = starts[0].status === "fulfilled" ? starts[0].value : undefined;
      second = starts[1].status === "fulfilled" ? starts[1].value : undefined;
      for (const result of starts) {
        if (result.status === "rejected") throw result.reason;
      }
      assert.notStrictEqual(first.port, second.port);
      const [firstResponse, secondResponse] = await Promise.all([
        fetch(`http://127.0.0.1:${first.port}/api/bootstrap`, { headers: { "X-My-Code-Agent-Token": first.token } }),
        fetch(`http://127.0.0.1:${second.port}/api/bootstrap`, { headers: { "X-My-Code-Agent-Token": second.token } }),
      ]);
      const [firstBody, secondBody] = await Promise.all([firstResponse.json(), secondResponse.json()]);
      assert.strictEqual(firstBody.startup.workspace, resolve(f.workspace).toLowerCase());
      assert.strictEqual(secondBody.startup.workspace, resolve(workspaceB).toLowerCase());
      assert.notStrictEqual(firstBody.startup.instanceRoot, secondBody.startup.instanceRoot);
      assert.strictEqual(firstBody.startup.dataRoot, secondBody.startup.dataRoot);

      await stopServer(first);
      first = await startServer({
        workspace: f.workspace,
        dataRoot: f.dataRoot,
        instanceId: "launch-a-restart",
        token: "launch-token-a-restart",
      });
      const restartedResponse = await fetch(`http://127.0.0.1:${first.port}/api/bootstrap`, {
        headers: { "X-My-Code-Agent-Token": first.token },
      });
      const restartedBody = await restartedResponse.json();
      assert.strictEqual(restartedBody.startup.workspace, firstBody.startup.workspace);
      assert.strictEqual(restartedBody.startup.dataRoot, firstBody.startup.dataRoot);
      assert.notStrictEqual(restartedBody.startup.instanceRoot, firstBody.startup.instanceRoot);
    } finally {
      await Promise.all([stopServer(first), stopServer(second)]);
      rmSync(f.root, { recursive: true, force: true });
    }
  });

  it("records a successful real startup workspace without replacing it for an empty window", async () => {
    const f = fixture("startup-workspace-history");
    const realInstanceId = "history-real";
    const emptyInstanceId = "history-empty";
    const settingsFile = resolveDataLayout({
      dataRoot: f.dataRoot,
      workspace: f.workspace,
      instanceId: realInstanceId,
    }).settingsFile;
    const emptyWorkspace = resolve(f.dataRoot, "instances", emptyInstanceId, "empty-workspace");
    mkdirSync(emptyWorkspace, { recursive: true });
    let running;
    try {
      running = await startServer({
        workspace: f.workspace,
        dataRoot: f.dataRoot,
        instanceId: realInstanceId,
        token: "history-real-token",
      });
      await waitFor(
        () => readUserSettings(settingsFile).startup?.lastWorkspace === canonicalWorkspacePath(f.workspace),
        "successful startup workspace was not recorded",
      );
      await stopServer(running);
      const restarted = resolveStartupPaths({
        appRoot: f.root,
        argv: ["--data-root", f.dataRoot, "--instance-id", "restart-new"],
        env: {},
      });
      assert.strictEqual(restarted.workspace, canonicalWorkspacePath(f.workspace));

      running = await startServer({
        workspace: emptyWorkspace,
        dataRoot: f.dataRoot,
        instanceId: emptyInstanceId,
        token: "history-empty-token",
      });
      await new Promise((resolveWait) => setTimeout(resolveWait, 100));
      assert.deepStrictEqual(readUserSettings(settingsFile).startup, {
        lastWorkspace: canonicalWorkspacePath(f.workspace),
        recentWorkspaces: [canonicalWorkspacePath(f.workspace)],
      });
    } finally {
      await stopServer(running);
      rmSync(f.root, { recursive: true, force: true });
    }
  });

  it("exposes the new-instance capability and settings status fields", () => {
    const preload = readFileSync(resolve("src/electron/preload.ts"), "utf8");
    const declarations = readFileSync(resolve("src/frontend/dashboard.d.ts"), "utf8");
    const storageSettings = readFileSync(resolve("src/frontend/dashboard/settings-storage.ts"), "utf8");
    const electronMain = readFileSync(resolve("src/electron/electron-main.ts"), "utf8");
    const launchBridge = readFileSync(resolve("src/electron/desktop-launch.ts"), "utf8");
    const sessionRoutes = readFileSync(resolve("src/server/routes/sessions.ts"), "utf8");

    assert.match(preload, /newWindow:\s*\(\)\s*=>\s*ipcRenderer\.invoke\("window-new"\)/);
    assert.doesNotMatch(preload, /launchProjectInstance/);
    assert.doesNotMatch(declarations, /launchProjectInstance/);
    assert.match(declarations, /instanceId/);
    assert.match(storageSettings, /workspaceLock/);
    assert.match(storageSettings, /migration/);
    assert.match(electronMain, /new WindowManager\(/);
    assert.match(electronMain, /windowManager\.createEmptyWindow\(\)/);
    assert.match(electronMain, /windowManager\.createInitialWindow\(/);
    assert.match(electronMain, /windowManager\.openWorkspace\(/);
    assert.match(electronMain, /windowManager\.disposeAll\(\)/);
    assert.doesNotMatch(electronMain, /function launchWindowForWorkspace\(|function launchEmptyWindow\(/);
    assert.doesNotMatch(electronMain, /detached:\s*true/);
    assert.match(electronMain, /PI_DEV_PORT/);
    assert.match(electronMain, /MY_CODE_AGENT_DESKTOP_TOKEN/);
    assert.match(launchBridge, /child\.once\("error"/);
    assert.doesNotMatch(electronMain, /child\.once\("spawn"/);
    assert.doesNotMatch(sessionRoutes, /migrateLegacySessions/, "session listing must not bypass explicit migration confirmation");
  });
});
