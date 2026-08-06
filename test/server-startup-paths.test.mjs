import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";

import {
  resolveStartupPaths,
  startupPathsSnapshot,
} from "../src/server/startup-paths.ts";
import { handleDashboard } from "../src/server/routes/dashboard.ts";

async function readBootstrap(paths) {
  const request = { url: "/api/bootstrap", method: "GET" };
  const response = {
    status: 0,
    body: "",
    writeHead(status) { response.status = status; return response; },
    end(value) { response.body += value ? String(value) : ""; return response; },
  };
  const context = {
    runtime: { session: {} },
    paths,
  };
  await handleDashboard(request, response, context);
  return { status: response.status, body: JSON.parse(response.body) };
}

function startServerProcess(workspace, dataRoot) {
  return new Promise((resolveServer, rejectServer) => {
    const server = spawn(process.execPath, [
      "--import", "tsx", resolve("src/server/server.ts"),
      "--workspace", workspace,
      "--data-root", dataRoot,
      "--instance-id", "startup-test",
    ], {
      cwd: process.cwd(),
      env: { ...process.env, MY_CODE_AGENT_DESKTOP_TOKEN: "startup-test-token", PI_DEV_PORT: "0" },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let output = "";
    let errorOutput = "";
    const timer = setTimeout(() => {
      server.kill();
      rejectServer(new Error(`server startup timed out\n${output}\n${errorOutput}`));
    }, 30_000);
    server.stdout.on("data", (chunk) => {
      output += chunk.toString();
      const match = output.match(/SERVER_PORT:(\d+)/);
      if (!match) return;
      clearTimeout(timer);
      resolveServer({ server, port: Number(match[1]), output });
    });
    server.stderr.on("data", (chunk) => { errorOutput += chunk.toString(); });
    server.once("error", (error) => {
      clearTimeout(timer);
      rejectServer(error);
    });
  });
}

describe("server startup paths", () => {
  it("uses explicit workspace, data root, and instance id without APP_ROOT fallback", () => {
    const appRoot = resolve("E:/my-code-agent");
    const workspace = resolve("E:/projects/project-a");
    const dataRoot = resolve("D:/agent-data");

    const startup = resolveStartupPaths({
      appRoot,
      argv: ["--workspace", workspace, "--data-root", dataRoot, "--instance-id", "fixture-a"],
      env: {},
    });
    const snapshot = startupPathsSnapshot(startup);

    assert.strictEqual(snapshot.workspace, workspace.toLowerCase());
    assert.strictEqual(snapshot.dataRoot, dataRoot);
    assert.strictEqual(snapshot.instanceId, "fixture-a");
    assert.strictEqual(snapshot.workspaceRoot, startup.layout.workspaceRoot);
    assert.strictEqual(snapshot.instanceRoot, resolve(dataRoot, "instances", "fixture-a"));
    assert.notStrictEqual(snapshot.workspace, appRoot.toLowerCase());
    assert.notStrictEqual(snapshot.dataRoot, resolve(appRoot, "data"));
  });

  it("gives command-line values priority over environment values", () => {
    const startup = resolveStartupPaths({
      appRoot: resolve("E:/my-code-agent"),
      argv: ["--workspace", "E:/cli-workspace", "--data-root", "D:/cli-data", "--instance-id", "cli-id"],
      env: {
        PI_WORKSPACE: "E:/env-workspace",
        PI_DATA_ROOT: "D:/env-data",
        PI_INSTANCE_ID: "env-id",
      },
    });

    assert.strictEqual(startup.workspace, resolve("E:/cli-workspace").toLowerCase());
    assert.strictEqual(startup.layout.dataRoot, resolve("D:/cli-data"));
    assert.strictEqual(startup.instanceId, "cli-id");
  });

  it("generates a valid per-launch instance id when none is supplied", () => {
    const options = { appRoot: resolve("E:/my-code-agent"), argv: [], env: {} };
    const first = resolveStartupPaths(options);
    const second = resolveStartupPaths(options);

    assert.match(first.instanceId, /^instance-[A-Za-z0-9-]+$/);
    assert.notStrictEqual(first.instanceId, second.instanceId);
    assert.notStrictEqual(first.layout.instanceRoot, second.layout.instanceRoot);
  });

  it("rejects malformed explicit startup paths", () => {
    assert.throws(
      () => resolveStartupPaths({ appRoot: resolve("E:/my-code-agent"), argv: ["--workspace", "relative"], env: {} }),
      /workspace must be an absolute path/,
    );
    assert.throws(
      () => resolveStartupPaths({ appRoot: resolve("E:/my-code-agent"), argv: ["--data-root", "relative"], env: {} }),
      /dataRoot must be absolute/,
    );
    assert.throws(
      () => resolveStartupPaths({ appRoot: resolve("E:/my-code-agent"), argv: ["--instance-id", "../escape"], env: {} }),
      /instanceId is invalid/,
    );
  });

  it("reports the exact startup snapshot through bootstrap", async () => {
    const startup = resolveStartupPaths({
      appRoot: resolve("E:/my-code-agent"),
      argv: ["--workspace", "E:/workspace-a", "--data-root", "D:/agent-data", "--instance-id", "fixture-a"],
      env: {},
    });
    const snapshot = startupPathsSnapshot(startup);
    const response = await readBootstrap({ STARTUP: snapshot });

    assert.strictEqual(response.status, 200);
    assert.deepStrictEqual(response.body, { ok: true, startup: snapshot });
  });

  it("wires Electron and server through the explicit startup contract", () => {
    const electronSource = readFileSync(resolve("src/electron/electron-main.ts"), "utf8");
    const serverSource = readFileSync(resolve("src/server/server.ts"), "utf8");

    assert.match(electronSource, /readDataRootPointer/);
    assert.match(electronSource, /resolveStartupPaths/);
    assert.match(electronSource, /PI_WORKSPACE:\s*STARTUP\.workspace/);
    assert.match(electronSource, /PI_DATA_ROOT:\s*STARTUP\.dataRoot/);
    assert.match(electronSource, /PI_INSTANCE_ID:\s*STARTUP\.instanceId/);
    assert.match(serverSource, /resolveStartupPaths/);
    assert.match(serverSource, /cwd:\s*STARTUP\.workspace/);
    assert.doesNotMatch(serverSource, /cwd:\s*APP_ROOT/);
  });

  it("starts a real server on a loopback port with the requested snapshot", async () => {
    const root = mkdtempSync(resolve(tmpdir(), "startup-paths-test-"));
    const workspace = resolve(root, "workspace");
    const dataRoot = resolve(root, "data-root");
    mkdirSync(workspace, { recursive: true });
    let running;
    try {
      running = await startServerProcess(workspace, dataRoot);
      assert.ok(running.port > 0);
      const response = await fetch(`http://127.0.0.1:${running.port}/api/bootstrap`, {
        headers: { "X-My-Code-Agent-Token": "startup-test-token" },
      });
      assert.strictEqual(response.status, 200);
      const body = await response.json();
      assert.strictEqual(body.ok, true);
      assert.strictEqual(body.startup.workspace, resolve(workspace).toLowerCase());
      assert.strictEqual(body.startup.dataRoot, resolve(dataRoot));
      assert.strictEqual(body.startup.instanceId, "startup-test");
      assert.match(body.startup.sessionsDir, /workspaces[\\/]\w+[\\/]sessions$/);
    } finally {
      running?.server.kill();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
