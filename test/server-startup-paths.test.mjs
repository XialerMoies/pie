import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";

import {
  resolveStartupPaths,
  startupPathsSnapshot,
} from "../src/server/startup-paths.ts";
import { canonicalWorkspacePath } from "../src/data/data-layout.ts";
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

function makeStartupFixture(name) {
  const root = mkdtempSync(resolve(tmpdir(), `${name}-`));
  const appRoot = resolve(root, "app-root");
  const dataRoot = resolve(root, "data-root");
  const storedWorkspace = resolve(root, "stored-workspace");
  const envWorkspace = resolve(root, "env-workspace");
  const cliWorkspace = resolve(root, "cli-workspace");
  for (const directory of [appRoot, storedWorkspace, envWorkspace, cliWorkspace]) {
    mkdirSync(directory, { recursive: true });
  }
  return { root, appRoot, dataRoot, storedWorkspace, envWorkspace, cliWorkspace };
}

function writeStartupSettings(dataRoot, document) {
  const settingsFile = join(dataRoot, "user", "settings.json");
  mkdirSync(resolve(settingsFile, ".."), { recursive: true });
  writeFileSync(settingsFile, typeof document === "string" ? document : JSON.stringify(document));
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

  it("restores the persisted last workspace from the resolved data root", () => {
    const fixture = makeStartupFixture("startup-persisted-workspace");
    try {
      writeStartupSettings(fixture.dataRoot, {
        startup: { lastWorkspace: fixture.storedWorkspace },
      });

      const startup = resolveStartupPaths({
        appRoot: fixture.appRoot,
        argv: ["--data-root", fixture.dataRoot],
        env: {},
      });

      assert.strictEqual(startup.workspace, canonicalWorkspacePath(fixture.storedWorkspace));
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("uses CLI workspace before environment and persisted workspace", () => {
    const fixture = makeStartupFixture("startup-cli-precedence");
    try {
      writeStartupSettings(fixture.dataRoot, {
        startup: { lastWorkspace: fixture.storedWorkspace },
      });

      const startup = resolveStartupPaths({
        appRoot: fixture.appRoot,
        argv: ["--workspace", fixture.cliWorkspace, "--data-root", fixture.dataRoot],
        env: { PI_WORKSPACE: fixture.envWorkspace },
      });

      assert.strictEqual(startup.workspace, canonicalWorkspacePath(fixture.cliWorkspace));
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("does not read persisted settings when CLI workspace is explicit", () => {
    const fixture = makeStartupFixture("startup-cli-skips-settings");
    try {
      mkdirSync(join(fixture.dataRoot, "user", "settings.json"), { recursive: true });

      const startup = resolveStartupPaths({
        appRoot: fixture.appRoot,
        argv: ["--workspace", fixture.cliWorkspace, "--data-root", fixture.dataRoot],
        env: {},
      });

      assert.strictEqual(startup.workspace, canonicalWorkspacePath(fixture.cliWorkspace));
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("uses environment workspace before persisted workspace", () => {
    const fixture = makeStartupFixture("startup-env-precedence");
    try {
      writeStartupSettings(fixture.dataRoot, {
        startup: { lastWorkspace: fixture.storedWorkspace },
      });

      const startup = resolveStartupPaths({
        appRoot: fixture.appRoot,
        argv: [],
        env: { PI_WORKSPACE: fixture.envWorkspace, PI_DATA_ROOT: fixture.dataRoot },
      });

      assert.strictEqual(startup.workspace, canonicalWorkspacePath(fixture.envWorkspace));
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("does not read persisted settings when environment workspace is explicit", () => {
    const fixture = makeStartupFixture("startup-env-skips-settings");
    try {
      mkdirSync(join(fixture.dataRoot, "user", "settings.json"), { recursive: true });

      const startup = resolveStartupPaths({
        appRoot: fixture.appRoot,
        argv: [],
        env: { PI_WORKSPACE: fixture.envWorkspace, PI_DATA_ROOT: fixture.dataRoot },
      });

      assert.strictEqual(startup.workspace, canonicalWorkspacePath(fixture.envWorkspace));
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("falls back to app root when the persisted workspace was deleted", () => {
    const fixture = makeStartupFixture("startup-deleted-persisted");
    try {
      writeStartupSettings(fixture.dataRoot, {
        startup: { lastWorkspace: fixture.storedWorkspace },
      });
      rmSync(fixture.storedWorkspace, { recursive: true, force: true });

      const startup = resolveStartupPaths({
        appRoot: fixture.appRoot,
        argv: ["--data-root", fixture.dataRoot],
        env: {},
      });

      assert.strictEqual(startup.workspace, canonicalWorkspacePath(fixture.appRoot));
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("falls back to app root when persisted settings are malformed", () => {
    const fixture = makeStartupFixture("startup-malformed-settings");
    try {
      writeStartupSettings(fixture.dataRoot, "{not-json");

      const startup = resolveStartupPaths({
        appRoot: fixture.appRoot,
        argv: ["--data-root", fixture.dataRoot],
        env: {},
      });

      assert.strictEqual(startup.workspace, canonicalWorkspacePath(fixture.appRoot));
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("ignores a relative persisted workspace", () => {
    const fixture = makeStartupFixture("startup-relative-persisted");
    try {
      writeStartupSettings(fixture.dataRoot, {
        startup: { lastWorkspace: "relative/workspace" },
      });

      const startup = resolveStartupPaths({
        appRoot: fixture.appRoot,
        argv: ["--data-root", fixture.dataRoot],
        env: {},
      });

      assert.strictEqual(startup.workspace, canonicalWorkspacePath(fixture.appRoot));
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
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
    const launchCoordinatorSource = readFileSync(resolve("src/electron/electron-launch-coordinator.ts"), "utf8");
    const serverSource = readFileSync(resolve("src/server/server.ts"), "utf8");

    assert.match(electronSource, /readDataRootPointer/);
    assert.match(electronSource, /resolveStartupPaths/);
    const lockIndex = electronSource.indexOf("app.requestSingleInstanceLock()");
    const userDataPathIndex = electronSource.indexOf('app.setPath("userData", DESKTOP_PATHS.electronUserData)');
    assert.ok(lockIndex >= 0, "Electron must acquire the singleton lock");
    assert.ok(userDataPathIndex >= 0, "Electron must configure its userData path");
    assert.ok(lockIndex < userDataPathIndex, "singleton lock must be acquired before userData changes");
    assert.match(
      electronSource,
      /if\s*\(!ownsSingleInstanceLock\)\s*\{\s*app\.quit\(\);\s*return;\s*\}/,
    );
    assert.match(electronSource, /app\.setPath\("cache",\s*DESKTOP_PATHS\.electronCache\)/);
    assert.doesNotMatch(
      electronSource,
      /app\.setPath\("userData",\s*path\.join\(STARTUP\.layout\.instanceRoot/,
    );
    assert.match(electronSource, /app\.requestSingleInstanceLock\(\)/);
    assert.match(electronSource, /app\.on\("second-instance"/);
    assert.match(electronSource, /from "\.\/electron-launch-coordinator\.js"/);
    assert.match(launchCoordinatorSource, /pending: DesktopLaunchRequest\[\] = \[\]/);
    assert.match(electronSource, /const windowManager = new WindowManager\(/);
    assert.match(
      electronSource,
      /if \(!request\.workspace\) \{[\s\S]{0,160}createEmptyManagedWindow\(\)/,
    );
    assert.match(
      electronSource,
      /function createEmptyManagedWindow\(\): WindowContext \{[\s\S]{0,160}windowManager\.createEmptyWindow\(\)/,
    );
    assert.match(electronSource, /windowManager\.contextForWorkspace\(request\.workspace\)/);
    assert.match(
      electronSource,
      /existing\?\.lifecycle === "active"[\s\S]{0,160}existing\.window\.focus\(\)/,
    );
    assert.match(
      electronSource,
      /const context = createEmptyManagedWindow\(\);[\s\S]{0,160}await windowManager\.openWorkspace\(context, request\.workspace\)/,
    );
    assert.match(
      electronSource,
      /validateSecondLaunchDataRoot\(DESKTOP_PATHS\.dataRoot, request\.dataRoot\)/,
    );
    assert.match(launchCoordinatorSource, /ready = false/);
    assert.match(launchCoordinatorSource, /ready = true/);
    assert.match(launchCoordinatorSource, /if \(ready\) void drain\(\)/);
    assert.match(launchCoordinatorSource, /options\.resolveWaiter\(request\.instanceId\)/);
    assert.match(launchCoordinatorSource, /rejectWaiter\(request\.instanceId, failure\)/);
    assert.match(electronSource, /PI_WORKSPACE:\s*input\.workspace/);
    assert.match(electronSource, /PI_DATA_ROOT:\s*input\.dataRoot/);
    assert.match(electronSource, /PI_INSTANCE_ID:\s*input\.instanceId/);
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
