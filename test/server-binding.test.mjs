import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { PassThrough } from "node:stream";
import { spawn as spawnProcess } from "node:child_process";
import { createRequire } from "node:module";

import { resolveDataLayout } from "../src/data/data-layout.ts";
import {
  createExternalServerBinding,
  createNoneServerBinding,
  createOwnedServerBinding,
  forceKillChildProcess,
  isProcessAlive,
} from "../src/electron/server-binding.ts";

const temporaryRoots = [];
const require = createRequire(import.meta.url);

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

class FakeChildProcess extends EventEmitter {
  constructor(pid = 4321) {
    super();
    this.pid = pid;
    this.stdout = new PassThrough();
    this.stderr = new PassThrough();
    this.exitCode = null;
    this.signalCode = null;
    this.stdinWrites = [];
    this.stdinEnded = false;
    this.stdin = {
      write: (value) => {
        this.stdinWrites.push(String(value));
        return true;
      },
      end: () => {
        this.stdinEnded = true;
      },
    };
  }

  exit(code = 0, signal = null) {
    this.exitCode = code;
    this.signalCode = signal;
    this.emit("exit", code, signal);
  }
}

function createFakeTimers() {
  let nextId = 1;
  const timers = new Map();
  return {
    setTimeout(callback, delay) {
      const id = nextId++;
      timers.set(id, { callback, delay });
      return id;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
    runDelay(delay) {
      const matches = [...timers.entries()].filter(([, timer]) => timer.delay === delay);
      for (const [id, timer] of matches) {
        timers.delete(id);
        timer.callback();
      }
    },
    get size() {
      return timers.size;
    },
  };
}

function makeSpec(overrides = {}) {
  const root = mkdtempSync(join(tmpdir(), "server-binding-"));
  temporaryRoots.push(root);
  const workspace = resolve(root, "workspace");
  const dataRoot = resolve(root, "data");
  const appRoot = resolve(root, "app");
  const runtimeRoot = resolve(root, "runtime");
  mkdirSync(workspace, { recursive: true });
  mkdirSync(appRoot, { recursive: true });
  mkdirSync(runtimeRoot, { recursive: true });
  const instanceId = "binding-test";
  return {
    workspace,
    dataRoot,
    instanceId,
    layout: resolveDataLayout({ dataRoot, workspace, instanceId }),
    token: "desktop-token",
    appRoot,
    runtimeRoot,
    isPackaged: false,
    env: { PRESERVED_ENV: "yes" },
    ...overrides,
  };
}

function makeHarness(options = {}) {
  const child = options.child || new FakeChildProcess();
  const timers = createFakeTimers();
  const spawns = [];
  const forceKills = [];
  const unexpectedExits = [];
  const spec = makeSpec({
    onUnexpectedExit: (event) => unexpectedExits.push(event),
    ...options.spec,
  });
  const binding = createOwnedServerBinding(spec, {
    spawn: (command, args, spawnOptions) => {
      spawns.push({ command, args, options: spawnOptions });
      return child;
    },
    forceKill: async (target) => {
      forceKills.push(target);
      target.exit(null, "SIGKILL");
    },
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
    startupTimeoutMs: 30_000,
    stopTimeoutMs: 2_000,
    forceKillGraceTimeoutMs: 500,
    writeStdout: () => {},
    writeStderr: () => {},
    ...options.deps,
  });
  return { binding, child, timers, spawns, forceKills, unexpectedExits, spec };
}

describe("server bindings", () => {
  it("treats a Windows taskkill not-found race as an already-terminated process", () => {
    const child = new FakeChildProcess(4322);
    assert.doesNotThrow(() => forceKillChildProcess(child, {
      platform: "win32",
      taskkill: () => { throw Object.assign(new Error("taskkill target not found"), { status: 128 }); },
      probe: () => { throw Object.assign(new Error("process not found"), { code: "ESRCH" }); },
    }));
  });

  it("keeps a Windows taskkill failure terminal when the target PID is alive", () => {
    const child = new FakeChildProcess(4323);
    assert.throws(() => forceKillChildProcess(child, {
      platform: "win32",
      taskkill: () => { throw Object.assign(new Error("taskkill access denied"), { status: 5 }); },
      probe: () => true,
    }), /taskkill access denied/);
  });

  it("treats only ESRCH as a missing process", () => {
    assert.equal(isProcessAlive(4324, () => { throw Object.assign(new Error("missing"), { code: "ESRCH" }); }), false);
    assert.equal(isProcessAlive(4324, () => { throw Object.assign(new Error("denied"), { code: "EPERM" }); }), true);
  });

  it("creates a none binding whose stop is a no-op and cannot start", async () => {
    const binding = createNoneServerBinding();

    assert.strictEqual(binding.kind, "none");
    assert.strictEqual(binding.state, "stopped");
    assert.strictEqual(binding.port, 0);
    assert.strictEqual(binding.process, null);
    assert.deepStrictEqual(binding.snapshot(), {
      kind: "none",
      state: "stopped",
      port: 0,
      token: "",
      origin: "",
      hasProcess: false,
    });
    await binding.stop();
    assert.strictEqual("start" in binding, false);
  });

  it("creates an external binding with a fixed endpoint and no owned process", async () => {
    const binding = createExternalServerBinding({
      port: 5173,
      token: "external-token",
      origin: "http://localhost:5173",
    });

    assert.strictEqual(binding.kind, "external");
    assert.strictEqual(binding.state, "ready");
    assert.strictEqual(binding.port, 5173);
    assert.strictEqual(binding.token, "external-token");
    assert.strictEqual(binding.origin, "http://localhost:5173");
    assert.strictEqual(binding.process, null);
    assert.strictEqual(await binding.start(), 5173);
    await binding.stop();
    assert.strictEqual(binding.state, "ready");
    assert.deepStrictEqual(binding.snapshot(), {
      kind: "external",
      state: "ready",
      port: 5173,
      token: "external-token",
      origin: "http://localhost:5173",
      hasProcess: false,
    });
  });

  it("shares concurrent starts and resolves only after SERVER_PORT readiness", async () => {
    const { binding, child, timers } = makeHarness();

    const first = binding.start();
    const second = binding.start();
    assert.strictEqual(second, first);
    assert.strictEqual(binding.state, "starting");
    assert.strictEqual(binding.process, child);
    assert.strictEqual(timers.size, 1);

    let settled = false;
    void first.then(() => { settled = true; });
    child.stdout.write("booting\nSERVER_");
    await Promise.resolve();
    assert.strictEqual(settled, false);

    child.stdout.write("PORT:43123\n");
    assert.strictEqual(await first, 43123);
    assert.strictEqual(binding.state, "ready");
    assert.strictEqual(binding.port, 43123);
    assert.strictEqual(binding.origin, "http://127.0.0.1:43123");
    assert.strictEqual(timers.size, 0);
    assert.deepStrictEqual(binding.snapshot(), {
      kind: "owned",
      state: "ready",
      port: 43123,
      token: "desktop-token",
      origin: "http://127.0.0.1:43123",
      hasProcess: true,
    });
  });

  it("shares concurrent stops and waits for child exit after graceful shutdown", async () => {
    const { binding, child, timers, forceKills } = makeHarness();
    const ready = binding.start();
    child.stdout.write("SERVER_PORT:4567\n");
    await ready;

    const first = binding.stop();
    const second = binding.stop();
    assert.strictEqual(second, first);
    assert.strictEqual(binding.state, "stopping");
    assert.strictEqual(binding.port, 0);
    assert.deepStrictEqual(child.stdinWrites, ["PI_SERVER_SHUTDOWN\n"]);
    assert.strictEqual(child.stdinEnded, true);
    assert.strictEqual(timers.size, 1);

    let stopped = false;
    void first.then(() => { stopped = true; });
    await Promise.resolve();
    assert.strictEqual(stopped, false);
    child.exit(0);
    await first;

    assert.strictEqual(binding.state, "stopped");
    assert.strictEqual(binding.process, null);
    assert.strictEqual(timers.size, 0);
    assert.deepStrictEqual(forceKills, []);
    assert.strictEqual(child.listenerCount("exit"), 0);
    assert.strictEqual(child.listenerCount("error"), 0);
    assert.strictEqual(child.stdout.listenerCount("data"), 0);
    assert.strictEqual(child.stderr.listenerCount("data"), 0);
  });

  it("uses the injected force kill when graceful shutdown times out", async () => {
    const { binding, child, timers, forceKills, unexpectedExits } = makeHarness();
    const ready = binding.start();
    child.stdout.write("SERVER_PORT:4568\n");
    await ready;

    const stopped = binding.stop();
    timers.runDelay(2_000);
    await stopped;

    assert.deepStrictEqual(forceKills, [child]);
    assert.strictEqual(binding.state, "stopped");
    assert.strictEqual(binding.process, null);
    assert.strictEqual(timers.size, 0);
    child.exit(1);
    assert.deepStrictEqual(unexpectedExits, []);
  });

  it("waits for exit after force kill and rejects after the kill grace timeout", async () => {
    const harness = makeHarness({
      deps: { forceKill: () => undefined },
    });
    const ready = harness.binding.start();
    harness.child.stdout.write("SERVER_PORT:4580\n");
    await ready;

    const stopped = harness.binding.stop();
    harness.timers.runDelay(2_000);
    await Promise.resolve();
    let settled = false;
    void stopped.finally(() => { settled = true; }).catch(() => undefined);
    await Promise.resolve();
    assert.strictEqual(settled, false);
    assert.strictEqual(harness.binding.process, harness.child);
    assert.strictEqual(harness.binding.state, "stopping");

    harness.timers.runDelay(500);
    await assert.rejects(stopped, /did not exit.*force kill/i);
    assert.strictEqual(harness.binding.process, harness.child);
    assert.notStrictEqual(harness.binding.state, "stopped");
    assert.strictEqual(harness.timers.size, 0);
  });

  it("treats a false force kill result as failure and preserves the child", async () => {
    const harness = makeHarness({
      deps: { forceKill: () => false },
    });
    const ready = harness.binding.start();
    harness.child.stdout.write("SERVER_PORT:4581\n");
    await ready;

    const stopped = harness.binding.stop();
    harness.timers.runDelay(2_000);
    await assert.rejects(stopped, /force kill.*failed/i);
    assert.strictEqual(harness.binding.process, harness.child);
    assert.notStrictEqual(harness.binding.state, "stopped");
  });

  it("rejects an exit before readiness with captured stdout and stderr", async () => {
    const { binding, child, timers, unexpectedExits } = makeHarness();
    const started = binding.start();
    child.stdout.write("partial startup output\n");
    child.stderr.write("startup failed detail\n");
    child.exit(17);

    await assert.rejects(started, (error) => {
      assert.match(error.message, /exited before ready \(17\)/);
      assert.match(error.message, /partial startup output/);
      assert.match(error.message, /startup failed detail/);
      return true;
    });
    assert.strictEqual(binding.state, "failed");
    assert.strictEqual(binding.port, 0);
    assert.strictEqual(binding.process, null);
    assert.strictEqual(timers.size, 0);
    assert.deepStrictEqual(unexpectedExits, []);
  });

  it("reports one binding-local callback for an unexpected exit after readiness", async () => {
    const { binding, child, unexpectedExits } = makeHarness();
    const started = binding.start();
    child.stdout.write("SERVER_PORT:4569\n");
    await started;

    child.exit(9, null);

    assert.strictEqual(binding.state, "failed");
    assert.strictEqual(binding.port, 0);
    assert.strictEqual(binding.process, null);
    assert.strictEqual(unexpectedExits.length, 1);
    assert.deepStrictEqual(unexpectedExits[0], { code: 9, signal: null });
  });

  it("delivers an early unexpected exit when its owning context attaches", async () => {
    const { binding, child } = makeHarness({ spec: { onUnexpectedExit: undefined } });
    const started = binding.start();
    child.stdout.write("SERVER_PORT:4568\n");
    await started;
    child.exit(9);
    const exits = [];

    binding.setUnexpectedExitHandler((event) => exits.push(event));

    assert.deepStrictEqual(exits, [{ code: 9, signal: null }]);
  });

  it("reports every ready child exit that was not requested as unexpected", async () => {
    const clean = makeHarness();
    const cleanStarted = clean.binding.start();
    clean.child.stdout.write("SERVER_PORT:4582\n");
    await cleanStarted;
    clean.child.exit(0, null);
    assert.deepStrictEqual(clean.unexpectedExits, [{ code: 0, signal: null }]);
    assert.strictEqual(clean.binding.state, "failed");

    const signaled = makeHarness();
    const signalStarted = signaled.binding.start();
    signaled.child.stdout.write("SERVER_PORT:4583\n");
    await signalStarted;
    signaled.child.exit(null, "SIGTERM");
    assert.deepStrictEqual(signaled.unexpectedExits, [{ code: null, signal: "SIGTERM" }]);
    assert.strictEqual(signaled.binding.state, "failed");
  });

  it("keeps unexpected exits in the binding policy before notifying Electron", () => {
    const electronMain = readFileSync(resolve("src/electron/electron-main.ts"), "utf8");
    const serverBinding = readFileSync(resolve("src/electron/server-binding.ts"), "utf8");
    assert.match(electronMain, /onUnexpectedExit:\s*\(\{\s*code,\s*signal,\s*error\s*\}\)/);
    assert.match(serverBinding, /if \(!wasReady \|\| wasTerminationRequested\)/);
    assert.match(serverBinding, /state = "failed";\s*notifyUnexpectedExit\(\{ code, signal \}\);/);
  });

  it("cleans startup timers and settles only once on child error", async () => {
    const { binding, child, timers, unexpectedExits } = makeHarness();
    const started = binding.start();
    child.stderr.write("spawn diagnostics\n");
    child.emit("error", new Error("spawn failed"));

    await assert.rejects(started, /spawn failed[\s\S]*spawn diagnostics/);
    assert.strictEqual(binding.state, "failed");
    assert.strictEqual(timers.size, 0);
    child.exit(1);
    timers.runDelay(30_000);
    assert.deepStrictEqual(unexpectedExits, []);
    assert.strictEqual(binding.state, "failed");
  });

  it("allows start to retry after spawn throws synchronously", async () => {
    const child = new FakeChildProcess();
    let spawnAttempts = 0;
    const { binding } = makeHarness({
      child,
      deps: {
        spawn: () => {
          spawnAttempts++;
          if (spawnAttempts === 1) throw new Error("synchronous spawn failure");
          return child;
        },
      },
    });

    await assert.rejects(binding.start(), /synchronous spawn failure/);
    assert.deepStrictEqual(binding.snapshot(), {
      kind: "owned",
      state: "failed",
      port: 0,
      token: "desktop-token",
      origin: "",
      hasProcess: false,
    });

    const retried = binding.start();
    assert.strictEqual(spawnAttempts, 2);
    assert.strictEqual(binding.state, "starting");
    child.stdout.write("SERVER_PORT:4573\n");
    assert.strictEqual(await retried, 4573);
    assert.strictEqual(binding.state, "ready");
  });

  it("rejects layout preparation errors asynchronously and allows retry", async () => {
    const harness = makeHarness();
    mkdirSync(harness.spec.dataRoot, { recursive: true });
    writeFileSync(harness.spec.layout.userRoot, "blocks-directory-creation");

    let started;
    assert.doesNotThrow(() => {
      started = harness.binding.start();
    });
    await assert.rejects(started, /EEXIST|ENOTDIR/);
    assert.deepStrictEqual(harness.binding.snapshot(), {
      kind: "owned",
      state: "failed",
      port: 0,
      token: "desktop-token",
      origin: "",
      hasProcess: false,
    });
    assert.strictEqual(harness.spawns.length, 0);

    rmSync(harness.spec.layout.userRoot, { force: true });
    const retried = harness.binding.start();
    assert.strictEqual(harness.spawns.length, 1);
    harness.child.stdout.write("SERVER_PORT:4574\n");
    assert.strictEqual(await retried, 4574);
  });

  it("keeps a timed-out startup child when force kill fails and blocks retry", async () => {
    let forceKillAttempts = 0;
    const harness = makeHarness({
      deps: {
        forceKill: (target) => {
          forceKillAttempts++;
          if (forceKillAttempts === 1) throw new Error("force kill denied");
          target.exit(null, "SIGKILL");
        },
      },
    });
    const started = harness.binding.start();
    harness.child.stderr.write("startup is stuck\n");
    harness.timers.runDelay(30_000);

    await assert.rejects(started, /startup timeout[\s\S]*force kill denied/);
    assert.strictEqual(harness.binding.state, "failed");
    assert.strictEqual(harness.binding.process, harness.child);
    assert.strictEqual(harness.spawns.length, 1);
    await assert.rejects(harness.binding.start(), /stop.*existing|existing.*stop/i);
    assert.strictEqual(harness.spawns.length, 1);

    const stopped = harness.binding.stop();
    harness.timers.runDelay(2_000);
    await stopped;
    assert.strictEqual(forceKillAttempts, 2);
    assert.strictEqual(harness.binding.process, null);
    assert.strictEqual(harness.binding.state, "stopped");
    assert.strictEqual(harness.timers.size, 0);
  });

  it("rejects startup timeout with diagnostics and ignores later terminal events", async () => {
    const { binding, child, timers, forceKills, unexpectedExits } = makeHarness();
    const started = binding.start();
    child.stdout.write("still booting\n");
    child.stderr.write("waiting for dependency\n");
    timers.runDelay(30_000);

    await assert.rejects(started, (error) => {
      assert.match(error.message, /startup timeout/);
      assert.match(error.message, /still booting/);
      assert.match(error.message, /waiting for dependency/);
      return true;
    });
    assert.deepStrictEqual(forceKills, [child]);
    assert.strictEqual(binding.state, "failed");
    assert.strictEqual(binding.process, null);
    assert.strictEqual(timers.size, 0);
    child.exit(1);
    assert.deepStrictEqual(unexpectedExits, []);
  });

  it("spawns development and packaged servers through the Electron executable", async () => {
    const development = makeHarness();
    const devStarted = development.binding.start();
    const devSpawn = development.spawns[0];
    assert.strictEqual(devSpawn.command, process.execPath);
    assert.deepStrictEqual(devSpawn.args, [
      "--import",
      "tsx",
      join(development.spec.appRoot, "src", "server", "server.ts"),
    ]);
    assert.strictEqual(devSpawn.options.cwd, development.spec.appRoot);
    development.child.stdout.write("SERVER_PORT:4570\n");
    await devStarted;

    const packagedSpec = makeSpec({ isPackaged: true });
    const packagedChild = new FakeChildProcess(4322);
    const packagedSpawns = [];
    const packaged = createOwnedServerBinding(packagedSpec, {
      spawn: (command, args, options) => {
        packagedSpawns.push({ command, args, options });
        return packagedChild;
      },
      writeStdout: () => {},
      writeStderr: () => {},
    });
    const packagedStarted = packaged.start();
    assert.strictEqual(packagedSpawns[0].command, process.execPath);
    assert.deepStrictEqual(packagedSpawns[0].args, [
      join(packagedSpec.appRoot, "dist", "server", "server.js"),
    ]);
    assert.strictEqual(packagedSpawns[0].options.cwd, packagedSpec.runtimeRoot);
    packagedChild.stdout.write("SERVER_PORT:4571\n");
    await packagedStarted;
  });

  it("passes the complete workspace layout and desktop parent environment", async () => {
    const { binding, child, spawns, spec } = makeHarness();
    const started = binding.start();
    const env = spawns[0].options.env;

    assert.strictEqual(env.PRESERVED_ENV, "yes");
    assert.strictEqual(env.PI_WORKSPACE, spec.workspace);
    assert.strictEqual(env.PI_DATA_ROOT, spec.dataRoot);
    assert.strictEqual(env.PI_INSTANCE_ID, spec.instanceId);
    assert.strictEqual(env.PI_DESKTOP_DATA, spec.dataRoot);
    assert.strictEqual(env.PI_DESKTOP_CONFIG, spec.layout.userRoot);
    assert.strictEqual(env.PI_DESKTOP_SESSIONS, spec.layout.sessionsDir);
    assert.strictEqual(env.PI_USER_CONFIG, spec.layout.userRoot);
    assert.strictEqual(env.PI_WORKSPACE_DATA, spec.layout.workspaceRoot);
    assert.strictEqual(env.PI_INSTANCE_DATA, spec.layout.instanceRoot);
    assert.strictEqual(env.MY_CODE_AGENT_DESKTOP_TOKEN, spec.token);
    assert.strictEqual(env.PI_ELECTRON_PARENTED, "1");
    assert.strictEqual(env.ELECTRON_RUN_AS_NODE, "1");
    assert.deepStrictEqual(spawns[0].options.stdio, ["pipe", "pipe", "pipe"]);
    assert.strictEqual(spawns[0].options.shell, false);

    child.stdout.write("SERVER_PORT:4572\n");
    await started;
  });

  it("uses the internal server environment policy and redacts provider diagnostics", async () => {
    const stdout = [];
    const stderr = [];
    const harness = makeHarness({
      spec: {
        token: "new-desktop-token",
        env: {
          PRESERVED_ENV: "yes",
          OPENAI_API_KEY: "provider-secret",
          MY_CODE_AGENT_DESKTOP_TOKEN: "old-desktop-token",
        },
      },
      deps: {
        writeStdout: (text) => stdout.push(text),
        writeStderr: (text) => stderr.push(text),
      },
    });
    const started = harness.binding.start();
    const env = harness.spawns[0].options.env;
    assert.equal(env.PRESERVED_ENV, "yes");
    assert.equal(env.OPENAI_API_KEY, "provider-secret");
    assert.equal(env.MY_CODE_AGENT_DESKTOP_TOKEN, "new-desktop-token");
    assert.equal(env.PI_DESKTOP_SESSIONS, harness.spec.layout.sessionsDir);
    assert.notStrictEqual(env, harness.spec.env);

    harness.child.stdout.write("provider-secret\nSERVER_PORT:4575\n");
    harness.child.stderr.write("authorization=provider-secret\n");
    assert.equal(await started, 4575);
    assert.ok(stdout.join("").includes("[redacted]"));
    assert.ok(stderr.join("").includes("[redacted]"));
    assert.ok(!stdout.join("").includes("provider-secret"));
    assert.ok(!stderr.join("").includes("provider-secret"));
  });

  it("redacts secrets from startup failures while retaining diagnostics", async () => {
    const stdout = [];
    const stderr = [];
    const harness = makeHarness({
      spec: { token: "failure-token", env: { OPENAI_API_KEY: "provider-secret" } },
      deps: {
        writeStdout: (text) => stdout.push(text),
        writeStderr: (text) => stderr.push(text),
      },
    });
    const started = harness.binding.start();
    harness.child.stdout.write("spawn provider-secret diagnostics\n");
    harness.child.stderr.write("stderr remains useful\n");
    harness.child.emit("error", new Error("spawn failed provider-secret"));

    await assert.rejects(started, (error) => {
      assert.match(error.message, /spawn failed/);
      assert.match(error.message, /stderr remains useful/);
      assert.ok(!error.message.includes("provider-secret"));
      return true;
    });
    assert.ok(!stdout.join("").includes("provider-secret"));
    assert.ok(!stderr.join("").includes("provider-secret"));
  });

  it("drives shutdown through a real Node child stdin and exit event", async () => {
    const spec = makeSpec();
    const script = [
      'process.stdin.setEncoding("utf8")',
      'let input = ""',
      'process.stdin.on("data", chunk => {',
      '  input += chunk',
      '  if (input.includes("PI_SERVER_SHUTDOWN\\n")) process.exit(0)',
      '})',
      'console.log("SERVER_PORT:4590")',
      'setTimeout(() => process.exit(91), 5000)',
    ].join(";\n");
    let realChild;
    const binding = createOwnedServerBinding(spec, {
      spawn: () => {
        realChild = spawnProcess(process.execPath, ["-e", script], {
          stdio: ["pipe", "pipe", "pipe"],
          windowsHide: true,
        });
        return realChild;
      },
      startupTimeoutMs: 5_000,
      stopTimeoutMs: 1_000,
      // Windows hosted runners can take several seconds to reap a real child
      // after taskkill; keep the test bounded without changing production policy.
      forceKillGraceTimeoutMs: 5_000,
      writeStdout: () => {},
      writeStderr: () => {},
    });

    // This integration covers a real Node child; packaged Electron executable coverage stays in Task 8.
    assert.strictEqual(await binding.start(), 4590);
    assert.strictEqual(binding.process, realChild);
    await binding.stop();
    assert.strictEqual(realChild.exitCode, 0);
    assert.strictEqual(binding.state, "stopped");
    assert.strictEqual(binding.process, null);
  });

  it("launches a packaged fixture through the actual Electron Node-mode executable", async () => {
    const electronPath = require("electron");
    assert.strictEqual(typeof electronPath, "string");
    const spec = makeSpec({ isPackaged: true });
    const serverScript = join(spec.appRoot, "dist", "server", "server.js");
    mkdirSync(resolve(serverScript, ".."), { recursive: true });
    writeFileSync(serverScript, [
      'const path = require("node:path")',
      'const fail = message => { console.error(message); process.exit(42) }',
      'if (process.env.ELECTRON_RUN_AS_NODE !== "1") fail("missing Electron Node mode")',
      'if (path.resolve(process.execPath) !== path.resolve(process.env.BINDING_EXPECTED_EXECUTABLE)) fail("wrong executable")',
      'if (path.resolve(process.cwd()) !== path.resolve(process.env.BINDING_EXPECTED_CWD)) fail("wrong cwd")',
      'if (process.env.PI_WORKSPACE !== process.env.BINDING_EXPECTED_WORKSPACE) fail("wrong workspace env")',
      'process.stdin.setEncoding("utf8")',
      'let input = ""',
      'process.stdin.on("data", chunk => {',
      '  input += chunk',
      '  if (input.includes("PI_SERVER_SHUTDOWN\\n")) process.exit(0)',
      '})',
      'console.log("SERVER_PORT:43127")',
      'setTimeout(() => process.exit(91), 5000)',
    ].join(";\n"));
    spec.env = {
      ...spec.env,
      BINDING_EXPECTED_EXECUTABLE: electronPath,
      BINDING_EXPECTED_CWD: spec.runtimeRoot,
      BINDING_EXPECTED_WORKSPACE: spec.workspace,
    };
    const binding = createOwnedServerBinding(spec, {
      executable: electronPath,
      startupTimeoutMs: 5_000,
      stopTimeoutMs: 1_000,
      // Windows hosted runners can take several seconds to reap Electron.
      forceKillGraceTimeoutMs: 5_000,
      writeStdout: () => {},
      writeStderr: () => {},
    });

    assert.strictEqual(await binding.start(), 43127);
    const child = binding.process;
    assert.strictEqual(resolve(child.spawnfile), resolve(electronPath));
    await binding.stop();
    assert.strictEqual(child.exitCode, 0);
    assert.strictEqual(binding.state, "stopped");
    assert.strictEqual(binding.process, null);
  });
});
