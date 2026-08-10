import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, join, resolve } from "node:path";

import { commandTool } from "../src/agent/tools/command.ts";
import { workspaceDataPaths } from "../src/server/routes/session-dir.ts";

const children = new Set();
const fixtureRoots = [];

function hasExited(child) {
  return child.exitCode !== null || child.signalCode !== null;
}

function waitForChildExit(child, timeoutMs = 10_000) {
  if (hasExited(child)) return Promise.resolve();
  return new Promise((resolveExit, rejectExit) => {
    const onExit = () => {
      clearTimeout(timer);
      resolveExit();
    };
    const timer = setTimeout(() => {
      child.removeListener("exit", onExit);
      rejectExit(new Error(`child process ${child.pid || "unknown"} did not exit within ${timeoutMs}ms`));
    }, timeoutMs);
    child.once("exit", onExit);
  });
}

async function forceStopChild(child) {
  if (hasExited(child)) return;
  const exited = waitForChildExit(child);
  child.kill();
  await exited;
}

function createFixture() {
  // The test harness redirects os.tmpdir() under APP_ROOT, which is an app-data root in dev.
  const root = mkdtempSync(join(resolve(process.cwd(), ".."), "multi-instance-e2e-"));
  const dataRoot = join(root, "agent-data");
  const workspaceA = join(root, "project-a");
  const workspaceB = join(root, "project-b");
  mkdirSync(workspaceA, { recursive: true });
  mkdirSync(workspaceB, { recursive: true });
  fixtureRoots.push(root);
  return { root, dataRoot, workspaceA, workspaceB };
}

function seedSession(dataRoot, workspace, id, message) {
  const { sessionsDir } = workspaceDataPaths(dataRoot, workspace);
  mkdirSync(sessionsDir, { recursive: true });
  const file = join(sessionsDir, `${id}.jsonl`);
  writeFileSync(file, [
    JSON.stringify({ type: "session", id, workspace, cwd: workspace, timestamp: new Date().toISOString() }),
    JSON.stringify({
      type: "message",
      message: { role: "user", content: [{ type: "text", text: message }] },
    }),
  ].join("\n") + "\n");
  return file;
}

function startServer({ workspace, dataRoot, instanceId, token }) {
  return new Promise((resolveServer, rejectServer) => {
    const workspaceArgs = workspace === undefined ? [] : ["--workspace", workspace];
    const child = spawn(process.execPath, [
      "--import", "tsx", resolve("src/server/server.ts"),
      ...workspaceArgs,
      "--data-root", dataRoot,
      "--instance-id", instanceId,
    ], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        MY_CODE_AGENT_DESKTOP_TOKEN: token,
        PI_DEV_PORT: "0",
      },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    children.add(child);

    let stdout = "";
    let stderr = "";
    let startupTimedOut = false;
    const timer = setTimeout(() => {
      startupTimedOut = true;
      const timeoutError = new Error(`server startup timed out\n${stdout}\n${stderr}`);
      void forceStopChild(child).then(
        () => rejectServer(timeoutError),
        (stopError) => rejectServer(new AggregateError([timeoutError, stopError], "server startup timed out and child termination failed")),
      );
    }, 30_000);

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
      const match = stdout.match(/SERVER_PORT:(\d+)/);
      if (!match) return;
      clearTimeout(timer);
      resolveServer({ child, port: Number(match[1]), token, stdout: () => stdout, stderr: () => stderr });
    });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.once("error", (error) => {
      clearTimeout(timer);
      rejectServer(error);
    });
    child.once("exit", (code) => {
      children.delete(child);
      if (!startupTimedOut && !/SERVER_PORT:\d+/.test(stdout)) {
        clearTimeout(timer);
        rejectServer(new Error(`server exited before ready (${code})\n${stdout}\n${stderr}`));
      }
    });
  });
}

async function stopServer(server) {
  if (!server?.child || server.child.exitCode !== null || server.child.signalCode !== null) return;
  await new Promise((resolveExit, rejectExit) => {
    const timer = setTimeout(() => {
      rejectExit(new Error(`server shutdown timed out\n${server.stdout()}\n${server.stderr()}`));
    }, 10_000);
    server.child.once("exit", () => {
      clearTimeout(timer);
      resolveExit();
    });
    server.child.stdin.write("PI_SERVER_SHUTDOWN\n");
    server.child.stdin.end();
  });
}

async function api(server, pathname, options = {}) {
  const response = await fetch(`http://127.0.0.1:${server.port}${pathname}`, {
    method: options.method || "GET",
    headers: {
      "X-My-Code-Agent-Token": server.token,
      ...(options.body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const text = await response.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  return { status: response.status, body };
}

function assertSameWorkspace(actual, expected) {
  const normalize = (value) => process.platform === "win32" ? value.toLowerCase() : value;
  assert.strictEqual(normalize(actual), normalize(expected));
}

afterEach(async () => {
  await Promise.all([...children].map((child) => forceStopChild(child)));
  children.clear();
  while (fixtureRoots.length) rmSync(fixtureRoots.pop(), { recursive: true, force: true });
});

test("two independent server processes keep commands, writes, sessions, and shutdown isolated", { timeout: 90_000 }, async () => {
  const fixture = createFixture();
  const markerA = join(fixture.workspaceA, "marker.txt");
  const markerB = join(fixture.workspaceB, "marker.txt");
  writeFileSync(markerA, "project-a-before");
  writeFileSync(markerB, "project-b-before");
  seedSession(fixture.dataRoot, fixture.workspaceA, "session-a", "history-from-a");
  seedSession(fixture.dataRoot, fixture.workspaceB, "session-b", "history-from-b");

  let instanceA;
  let instanceB;
  try {
    [instanceA, instanceB] = await Promise.all([
      startServer({
        workspace: fixture.workspaceA,
        dataRoot: fixture.dataRoot,
        instanceId: "e2e-instance-a",
        token: "e2e-token-a",
      }),
      startServer({
        workspace: fixture.workspaceB,
        dataRoot: fixture.dataRoot,
        instanceId: "e2e-instance-b",
        token: "e2e-token-b",
      }),
    ]);
    assert.notStrictEqual(instanceA.port, instanceB.port);

    const readonlyCommand = process.platform === "win32" ? "cd" : "pwd";
    const [commandA, commandB] = await Promise.all([
      commandTool.execute(
        { command: readonlyCommand, readOnly: true },
        { cwd: fixture.workspaceA, workspace: fixture.workspaceA, sessionId: "e2e-a", permissionMode: "standard" },
      ),
      commandTool.execute(
        { command: readonlyCommand, readOnly: true },
        { cwd: fixture.workspaceB, workspace: fixture.workspaceB, sessionId: "e2e-b", permissionMode: "standard" },
      ),
    ]);
    assert.strictEqual(commandA.metadata.authorization.status, "allow");
    assert.strictEqual(commandB.metadata.authorization.status, "allow");
    assert.match(commandA.data.stdout.toLowerCase(), new RegExp(basename(fixture.workspaceA).toLowerCase()));
    assert.match(commandB.data.stdout.toLowerCase(), new RegExp(basename(fixture.workspaceB).toLowerCase()));

    const [ownWriteA, ownWriteB] = await Promise.all([
      api(instanceA, "/api/file/write", {
        method: "POST",
        body: { root: fixture.workspaceA, path: "marker.txt", content: "project-a-after" },
      }),
      api(instanceB, "/api/file/write", {
        method: "POST",
        body: { root: fixture.workspaceB, path: "marker.txt", content: "project-b-after" },
      }),
    ]);
    assert.strictEqual(ownWriteA.status, 200);
    assert.strictEqual(ownWriteB.status, 200);

    const [crossWriteA, crossWriteB] = await Promise.all([
      api(instanceA, "/api/file/write", {
        method: "POST",
        body: { root: fixture.workspaceB, path: "marker.txt", content: "cross-write-from-a" },
      }),
      api(instanceB, "/api/file/write", {
        method: "POST",
        body: { root: fixture.workspaceA, path: "marker.txt", content: "cross-write-from-b" },
      }),
    ]);
    const [auditA, auditB] = await Promise.all([
      api(instanceA, "/api/permissions/audit?limit=20"),
      api(instanceB, "/api/permissions/audit?limit=20"),
    ]);
    assert.strictEqual(crossWriteA.status, 403, JSON.stringify({ crossWriteA, auditA: auditA.body }, null, 2));
    assert.strictEqual(crossWriteB.status, 403, JSON.stringify({ crossWriteB, auditB: auditB.body }, null, 2));
    assert.strictEqual(readFileSync(markerA, "utf8"), "project-a-after");
    assert.strictEqual(readFileSync(markerB, "utf8"), "project-b-after");

    const [sessionsA, sessionsB, historyA, historyB] = await Promise.all([
      api(instanceA, `/api/sessions?workspace=${encodeURIComponent(fixture.workspaceA)}`),
      api(instanceB, `/api/sessions?workspace=${encodeURIComponent(fixture.workspaceB)}`),
      api(instanceA, "/api/sessions/session-a/messages"),
      api(instanceB, "/api/sessions/session-b/messages"),
    ]);
    assert.strictEqual(sessionsA.status, 200);
    assert.strictEqual(sessionsB.status, 200);
    assert.ok(sessionsA.body.sessions.some((session) => session.id === "session-a"));
    assert.ok(!sessionsA.body.sessions.some((session) => session.id === "session-b"));
    assert.ok(sessionsB.body.sessions.some((session) => session.id === "session-b"));
    assert.ok(!sessionsB.body.sessions.some((session) => session.id === "session-a"));
    assert.strictEqual(historyA.body.messages[0].content, "history-from-a");
    assert.strictEqual(historyB.body.messages[0].content, "history-from-b");

    await stopServer(instanceA);
    instanceA = null;
    const healthyB = await api(instanceB, "/api/dashboard");
    assert.strictEqual(healthyB.status, 200);
    assert.strictEqual(readFileSync(markerB, "utf8"), "project-b-after");
  } finally {
    await stopServer(instanceA).catch(() => {});
    await stopServer(instanceB).catch(() => {});
  }
});

test("independent server restarts persist workspace and preferences", { timeout: 120_000 }, async () => {
  const fixture = createFixture();
  const preferencePatch = {
    values: {
      "editor-theme": "vs",
      "explorer-filter": "0",
    },
  };
  const transientInstanceId = "transient-instance";
  const transientWorkspace = join(fixture.dataRoot, "instances", transientInstanceId, "empty-workspace");
  mkdirSync(transientWorkspace, { recursive: true });

  let restartA;
  let restartB;
  let transient;
  let restartC;
  try {
    restartA = await startServer({
      workspace: fixture.workspaceA,
      dataRoot: fixture.dataRoot,
      instanceId: "restart-a",
      token: "restart-token-a",
    });

    const switched = await api(restartA, "/api/workspace/switch", {
      method: "POST",
      body: { workspace: fixture.workspaceB },
    });
    assert.strictEqual(switched.status, 200);
    assert.strictEqual(switched.body.workspace, fixture.workspaceB);

    const patched = await api(restartA, "/api/preferences", {
      method: "PATCH",
      body: preferencePatch,
    });
    assert.strictEqual(patched.status, 200);
    assert.deepStrictEqual(patched.body.preferences, preferencePatch.values);
    await stopServer(restartA);
    restartA = null;

    restartB = await startServer({
      dataRoot: fixture.dataRoot,
      instanceId: "restart-b",
      token: "restart-token-b",
    });
    const restoredState = await api(restartB, "/api/ui-state");
    const restoredPreferences = await api(restartB, "/api/preferences");
    assert.strictEqual(restoredState.status, 200);
    assertSameWorkspace(restoredState.body.workspacePath, fixture.workspaceB);
    assert.strictEqual(restoredPreferences.status, 200);
    assert.deepStrictEqual(restoredPreferences.body.preferences, preferencePatch.values);
    await stopServer(restartB);
    restartB = null;

    transient = await startServer({
      workspace: transientWorkspace,
      dataRoot: fixture.dataRoot,
      instanceId: transientInstanceId,
      token: "transient-token",
    });
    const transientBootstrap = await api(transient, "/api/bootstrap");
    assert.strictEqual(transientBootstrap.status, 200);
    assertSameWorkspace(transientBootstrap.body.startup.workspace, transientWorkspace);
    await stopServer(transient);
    transient = null;

    restartC = await startServer({
      dataRoot: fixture.dataRoot,
      instanceId: "restart-c",
      token: "restart-token-c",
    });
    const restoredAgain = await api(restartC, "/api/ui-state");
    assert.strictEqual(restoredAgain.status, 200);
    assertSameWorkspace(restoredAgain.body.workspacePath, fixture.workspaceB);
  } finally {
    await stopServer(restartA).catch(() => {});
    await stopServer(restartB).catch(() => {});
    await stopServer(transient).catch(() => {});
    await stopServer(restartC).catch(() => {});
  }
});
