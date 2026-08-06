import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { getLocalApiBaseUrl } from "../src/agent/tools/local-api.ts";
import { AppEventHub } from "../src/server/app-events.ts";
import * as securityModule from "../src/server/security.ts";

const roots = [];
const children = new Set();

function fixture(name) {
  const root = mkdtempSync(join(tmpdir(), `${name}-`));
  roots.push(root);
  return root;
}

function delay(ms) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

function makeResponse() {
  return {
    destroyed: false,
    writableEnded: false,
    writes: [],
    endCalls: 0,
    write(chunk) { this.writes.push(String(chunk)); },
    end() { this.endCalls += 1; this.writableEnded = true; },
  };
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
    const timer = setTimeout(() => {
      rejectServer(new Error(`server startup timed out\n${stdout}\n${stderr}`));
    }, 30_000);

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
      const match = stdout.match(/SERVER_PORT:(\d+)/);
      if (!match) return;
      clearTimeout(timer);
      resolveServer({ child, port: Number(match[1]), stdout: () => stdout, stderr: () => stderr });
    });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.once("error", (error) => {
      clearTimeout(timer);
      rejectServer(error);
    });
    child.once("exit", (code) => {
      children.delete(child);
      if (!/SERVER_PORT:\d+/.test(stdout)) {
        clearTimeout(timer);
        rejectServer(new Error(`server exited before ready (${code})\n${stdout}\n${stderr}`));
      }
    });
  });
}

async function stopServer(running) {
  if (!running || running.child.exitCode !== null || running.child.signalCode !== null) return;
  const exited = new Promise((resolveExit) => running.child.once("exit", resolveExit));
  running.child.stdin.write("PI_SERVER_SHUTDOWN\n");
  running.child.stdin.end();
  await Promise.race([
    exited,
    delay(10_000).then(() => {
      running.child.kill();
      throw new Error(`server shutdown timed out\n${running.stdout()}\n${running.stderr()}`);
    }),
  ]);
}

function api(port, token, pathname, signal) {
  return fetch(`http://127.0.0.1:${port}${pathname}`, {
    headers: { "X-My-Code-Agent-Token": token },
    signal,
  });
}

afterEach(async () => {
  for (const child of [...children]) {
    try { child.kill(); } catch {}
  }
  children.clear();
  while (roots.length) rmSync(roots.pop(), { recursive: true, force: true });
});

describe("multi-instance server security", () => {
  it("generates a distinct desktop token for each instance", () => {
    const first = securityModule.createDesktopSecurityConfig("");
    const second = securityModule.createDesktopSecurityConfig("");

    assert.ok(first.token.length >= 32);
    assert.ok(second.token.length >= 32);
    assert.notStrictEqual(first.token, second.token);
  });

  it("lets Electron inject a fixed token only in test mode", () => {
    const source = readFileSync(resolve("src/electron/electron-main.ts"), "utf8");

    assert.match(source, /NODE_ENV === "test"[\s\S]*MY_CODE_AGENT_DESKTOP_TOKEN/);
    assert.match(source, /createDesktopSessionToken\(\)/);
    assert.doesNotMatch(
      source,
      /process\.env\.MY_CODE_AGENT_DESKTOP_TOKEN\s*\|\|\s*randomBytes/,
    );
  });

  it("requires the active child SERVER_PORT for local tool API calls", () => {
    const previousServerPort = process.env.SERVER_PORT;
    const previousDevPort = process.env.PI_DEV_PORT;
    try {
      process.env.SERVER_PORT = "43123";
      process.env.PI_DEV_PORT = "5173";
      assert.strictEqual(getLocalApiBaseUrl(), "http://127.0.0.1:43123");

      delete process.env.SERVER_PORT;
      assert.throws(() => getLocalApiBaseUrl(), /SERVER_PORT/);
    } finally {
      if (previousServerPort === undefined) delete process.env.SERVER_PORT;
      else process.env.SERVER_PORT = previousServerPort;
      if (previousDevPort === undefined) delete process.env.PI_DEV_PORT;
      else process.env.PI_DEV_PORT = previousDevPort;
    }
  });

  it("closes only clients owned by the selected AppEventHub", () => {
    const firstHub = new AppEventHub();
    const secondHub = new AppEventHub();
    const firstClient = makeResponse();
    const secondClient = makeResponse();
    firstHub.addClient(firstClient);
    secondHub.addClient(secondClient);

    assert.strictEqual(typeof firstHub.closeAll, "function");
    firstHub.closeAll();

    assert.strictEqual(firstClient.endCalls, 1);
    assert.strictEqual(secondClient.endCalls, 0);
    assert.deepStrictEqual(firstHub.clientsSnapshot(), []);
    assert.deepStrictEqual(secondHub.clientsSnapshot(), [secondClient]);
  });

  it("removes dead instance state without touching user or workspace data", async () => {
    const dataRoot = fixture("instance-cleanup");
    const staleRoot = join(dataRoot, "instances", "stale-instance");
    const activeRoot = join(dataRoot, "instances", "active-instance");
    const userFile = join(dataRoot, "user", "settings.json");
    const sessionFile = join(dataRoot, "workspaces", "workspace-key", "sessions", "session.jsonl");
    for (const directory of [staleRoot, activeRoot, join(dataRoot, "user"), join(dataRoot, "workspaces", "workspace-key", "sessions")]) {
      mkdirSync(directory, { recursive: true });
    }
    writeFileSync(join(staleRoot, "port.json"), JSON.stringify({
      version: 1,
      instanceId: "stale-instance",
      pid: 2147483647,
      port: 41000,
      workspace: resolve(dataRoot, "stale-workspace"),
      startedAt: Date.now() - 60_000,
    }));
    writeFileSync(join(activeRoot, "keep.txt"), "active");
    writeFileSync(userFile, "{}");
    writeFileSync(sessionFile, "session");

    assert.strictEqual(typeof securityModule.cleanupStaleInstanceDirectories, "function");
    const removed = await securityModule.cleanupStaleInstanceDirectories(dataRoot, "active-instance");

    assert.deepStrictEqual(removed, [staleRoot]);
    assert.strictEqual(existsSync(staleRoot), false);
    assert.strictEqual(readFileSync(join(activeRoot, "keep.txt"), "utf8"), "active");
    assert.strictEqual(readFileSync(userFile, "utf8"), "{}");
    assert.strictEqual(readFileSync(sessionFile, "utf8"), "session");
  });

  it("keeps ports, tokens, streams, metadata, and shutdown isolated", { timeout: 90_000 }, async () => {
    const dataRoot = fixture("multi-instance-security");
    const workspaceA = join(dataRoot, "workspace-a");
    const workspaceB = join(dataRoot, "workspace-b");
    mkdirSync(workspaceA, { recursive: true });
    mkdirSync(workspaceB, { recursive: true });
    const tokenA = "instance-a-token";
    const tokenB = "instance-b-token";
    let instanceA;
    let instanceB;
    const controllers = [];

    try {
      [instanceA, instanceB] = await Promise.all([
        startServer({ workspace: workspaceA, dataRoot, instanceId: "instance-a", token: tokenA }),
        startServer({ workspace: workspaceB, dataRoot, instanceId: "instance-b", token: tokenB }),
      ]);
      assert.notStrictEqual(instanceA.port, instanceB.port);

      const wrongToken = await api(instanceB.port, tokenA, "/api/dashboard");
      assert.strictEqual(wrongToken.status, 403);

      for (const [running, token, pathname] of [
        [instanceA, tokenA, "/api/events"],
        [instanceA, tokenA, "/api/chat/stream"],
        [instanceB, tokenB, "/api/events"],
        [instanceB, tokenB, "/api/chat/stream"],
      ]) {
        const controller = new AbortController();
        controllers.push(controller);
        const response = await api(running.port, token, pathname, controller.signal);
        assert.strictEqual(response.status, 200, `${pathname} should open on ${running.port}`);
      }

      const metadataAPath = join(dataRoot, "instances", "instance-a", "port.json");
      const metadataBPath = join(dataRoot, "instances", "instance-b", "port.json");
      assert.strictEqual(existsSync(metadataAPath), true);
      assert.strictEqual(existsSync(metadataBPath), true);
      const metadataA = readFileSync(metadataAPath, "utf8");
      const metadataB = readFileSync(metadataBPath, "utf8");
      assert.doesNotMatch(metadataA, /instance-a-token/);
      assert.doesNotMatch(metadataB, /instance-b-token/);
      assert.strictEqual(JSON.parse(metadataA).port, instanceA.port);
      assert.strictEqual(JSON.parse(metadataB).port, instanceB.port);

      await stopServer(instanceA);
      instanceA = null;

      const stillRunning = await api(instanceB.port, tokenB, "/api/dashboard");
      assert.strictEqual(stillRunning.status, 200);
      assert.strictEqual(existsSync(metadataBPath), true);
      assert.strictEqual(existsSync(join(dataRoot, "instances", "instance-a")), false);
    } finally {
      for (const controller of controllers) controller.abort();
      await stopServer(instanceA).catch(() => {});
      await stopServer(instanceB).catch(() => {});
    }
  });
});
