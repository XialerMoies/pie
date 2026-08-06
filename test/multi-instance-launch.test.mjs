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

import {
  previewLegacySessions,
  migrateLegacySessions,
} from "../src/server/routes/session-dir.ts";
import {
  DESKTOP_IPC_INVOKE_CHANNELS,
  registerDesktopIpcHandlers,
  TrustedDesktopRoots,
} from "../src/electron/desktop-ipc.ts";

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

function startServer({ workspace, dataRoot, instanceId, token }) {
  return new Promise((resolveServer, rejectServer) => {
    const child = spawn(process.execPath, [
      "--import", "tsx", resolve("src/server/server.ts"),
      "--workspace", workspace,
      "--data-root", dataRoot,
      "--instance-id", instanceId,
    ], {
      cwd: process.cwd(),
      env: { ...process.env, PI_DEV_PORT: "0", MY_CODE_AGENT_DESKTOP_TOKEN: token },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      rejectServer(new Error(`server startup timed out\n${stdout}\n${stderr}`));
    }, 30_000);
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
      const match = stdout.match(/SERVER_PORT:(\d+)/);
      if (!match) return;
      clearTimeout(timer);
      resolveServer({ child, port: Number(match[1]), token });
    });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.once("error", (error) => {
      clearTimeout(timer);
      rejectServer(error);
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
  if (server.child.exitCode === null) server.child.kill();
}

describe("multi-instance launch and migration UX", () => {
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
      registerDesktopIpcHandlers({
        ipcMain,
        getMainWindow: () => null,
        showOpenDialog: async () => { calls.push("dialog"); return { canceled: false, filePaths: [f.workspace] }; },
        launchEmptyWindow: () => { calls.push("empty-window"); return { ok: true, instanceId: "empty-1" }; },
        showItemInFolder: () => {},
        trashItem: async () => {},
        spawnTerminal: () => true,
        getDesktopSessionToken: () => "token",
        validateSender: () => {},
        trustedRoots: roots,
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
      [first, second] = await Promise.all([
        startServer({ workspace: f.workspace, dataRoot: f.dataRoot, instanceId: "launch-a", token: "launch-token-a" }),
        startServer({ workspace: workspaceB, dataRoot: f.dataRoot, instanceId: "launch-b", token: "launch-token-b" }),
      ]);
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

  it("exposes the new-instance capability and settings status fields", () => {
    const preload = readFileSync(resolve("src/electron/preload.ts"), "utf8");
    const declarations = readFileSync(resolve("src/frontend/dashboard.d.ts"), "utf8");
    const settings = readFileSync(resolve("src/frontend/dashboard/dashboard-settings.ts"), "utf8");
    const electronMain = readFileSync(resolve("src/electron/electron-main.ts"), "utf8");
    const sessionRoutes = readFileSync(resolve("src/server/routes/sessions.ts"), "utf8");

    assert.match(preload, /newWindow:\s*\(\)\s*=>\s*ipcRenderer\.invoke\("window-new"\)/);
    assert.doesNotMatch(preload, /launchProjectInstance/);
    assert.doesNotMatch(declarations, /launchProjectInstance/);
    assert.match(declarations, /instanceId/);
    assert.match(settings, /workspaceLock/);
    assert.match(settings, /migration/);
    assert.match(electronMain, /function launchEmptyWindow\(/);
    assert.match(electronMain, /path\.join\(STARTUP\.dataRoot, "instances", instanceId, "empty-workspace"\)/);
    assert.match(electronMain, /"--workspace", path\.resolve\(workspace\)/);
    assert.match(electronMain, /"--data-root", STARTUP\.dataRoot/);
    assert.match(electronMain, /detached:\s*true/);
    assert.match(electronMain, /windowsHide:\s*false/);
    assert.match(electronMain, /"PI_DEV_PORT"/);
    assert.match(electronMain, /"MY_CODE_AGENT_DESKTOP_TOKEN"/);
    assert.match(electronMain, /child\.once\("error"/);
    assert.match(electronMain, /child\.once\("spawn"/);
    assert.doesNotMatch(sessionRoutes, /migrateLegacySessions/, "session listing must not bypass explicit migration confirmation");
  });
});
