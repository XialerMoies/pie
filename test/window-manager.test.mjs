import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { resolveDataLayout } from "../src/data/data-layout.ts";
import { TrustedDesktopRoots } from "../src/electron/desktop-ipc.ts";
import { createExternalServerBinding, createNoneServerBinding } from "../src/electron/server-binding.ts";
import { WindowManager } from "../src/electron/window-manager.ts";

const tempRoots = [];

function makeTempRoot() {
  const root = mkdtempSync(join(tmpdir(), "window-manager-capabilities-"));
  tempRoots.push(root);
  return root;
}

afterEach(() => {
  while (tempRoots.length) rmSync(tempRoots.pop(), { recursive: true, force: true });
});

class FakeWindow {
  constructor(senderId) {
    this._webContents = { id: senderId };
    this.focusCalls = 0;
    this.destroyed = false;
    this.throwOnDestroyedWebContents = false;
    this.deferClosedEvent = false;
    this.listeners = new Map();
  }

  get webContents() {
    if (this.destroyed && this.throwOnDestroyedWebContents) {
      throw new Error("Object has been destroyed");
    }
    return this._webContents;
  }

  focus() {
    this.focusCalls++;
  }

  isDestroyed() {
    return this.destroyed;
  }

  on(event, listener) {
    const listeners = this.listeners.get(event) || [];
    listeners.push(listener);
    this.listeners.set(event, listeners);
    return this;
  }

  close() {
    if (this.destroyed) return;
    for (const listener of this.listeners.get("close") || []) listener();
    this.destroyed = true;
    const emitClosed = () => {
      for (const listener of this.listeners.get("closed") || []) listener();
    };
    if (this.deferClosedEvent) setImmediate(emitClosed);
    else emitClosed();
  }
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function manualTimers() {
  const pending = [];
  return {
    setTimeout(callback) {
      const timer = { callback, cleared: false };
      pending.push(timer);
      return timer;
    },
    clearTimeout(timer) {
      timer.cleared = true;
    },
    runNext() {
      const timer = pending.shift();
      assert.ok(timer, "expected a pending restart timer");
      if (!timer.cleared) timer.callback();
    },
    get size() {
      return pending.filter((timer) => !timer.cleared).length;
    },
  };
}

function ownedBinding(options = {}) {
  let state = "stopped";
  let port = 0;
  let startCalls = 0;
  let stopCalls = 0;
  let unexpectedExitHandler = null;
  const start = options.start || (async () => options.port || 4100);
  const stop = options.stop || (async () => {});
  return {
    kind: "owned",
    get state() { return state; },
    get port() { return port; },
    token: options.token || "owned-token",
    get origin() { return port ? `http://127.0.0.1:${port}` : ""; },
    process: null,
    async start() {
      startCalls++;
      state = "starting";
      try {
        port = await start();
        state = "ready";
        return port;
      } catch (error) {
        state = "failed";
        throw error;
      }
    },
    async stop() {
      stopCalls++;
      state = "stopping";
      await stop();
      port = 0;
      state = "stopped";
    },
    setUnexpectedExitHandler(handler) {
      unexpectedExitHandler = handler;
    },
    unexpectedExit(event = { code: 9, signal: null }) {
      port = 0;
      state = "failed";
      unexpectedExitHandler?.(event);
    },
    snapshot() {
      return {
        kind: "owned",
        state,
        port,
        token: this.token,
        origin: this.origin,
        hasProcess: false,
      };
    },
    get startCalls() { return startCalls; },
    get stopCalls() { return stopCalls; },
  };
}

function fixture(overrides = {}) {
  const windows = [];
  const createdWindowInstanceIds = [];
  const bindings = [];
  const ready = [];
  const shell = [];
  const errors = [];
  let nextWindowId = 100;
  let nextInstanceId = 1;
  let nextToken = 1;
  const dataRoot = overrides.dataRoot || "E:\\window-manager-data";
  const manager = new WindowManager({
    dataRoot,
    createWindow: (instanceId) => {
      createdWindowInstanceIds.push(instanceId);
      const window = new FakeWindow(nextWindowId++);
      windows.push(window);
      return window;
    },
    createInstanceId: () => `instance-${nextInstanceId++}`,
    createToken: () => `token-${nextToken++}`,
    createTrustedRoots: overrides.createTrustedRoots || (() => new TrustedDesktopRoots()),
    createNoneServerBinding,
    resolveDataLayout,
    createOwnedServerBinding: (input) => {
      const binding = overrides.createOwnedServerBinding?.(input) || ownedBinding({ token: input.token });
      bindings.push({ input, binding });
      return binding;
    },
    switchExternalWorkspace: overrides.switchExternalWorkspace || (async () => {}),
    showWindowStatus: overrides.showWindowStatus || ((context, status) => {
      shell.push({ contextId: context.id, status });
    }),
    onServerReady: overrides.onServerReady || ((context) => ready.push(context.id)),
    onError: overrides.onError || ((error, context) => errors.push({ error, contextId: context.id })),
    restartDelayMs: overrides.restartDelayMs,
    maxRestartAttempts: overrides.maxRestartAttempts,
    setTimeout: overrides.setTimeout,
    clearTimeout: overrides.clearTimeout,
  });
  return { manager, windows, createdWindowInstanceIds, bindings, ready, shell, errors, dataRoot };
}

const workspaceA = "E:\\projects\\Alpha";
const workspaceB = "E:\\projects\\Beta";

describe("WindowManager", () => {
  it("creates an indexed empty context with no workspace or server", () => {
    const f = fixture();
    const context = f.manager.createEmptyWindow();

    assert.equal(context.workspace, null);
    assert.equal(context.layout, null);
    assert.equal(context.token, null);
    assert.equal(context.server.kind, "none");
    assert.equal(context.lifecycle, "active");
    assert.strictEqual(f.manager.contextForSender(context.window.webContents.id), context);
    assert.throws(() => f.manager.contextForSender(9999), /managed window/);
    assert.deepEqual(f.shell, [{ contextId: context.id, status: { state: "idle" } }]);
    assert.equal(f.bindings.length, 0);
  });

  it("shows starting before an owned server is ready and navigates only after readiness", async () => {
    const startup = deferred();
    const f = fixture({
      createOwnedServerBinding: ({ token }) => ownedBinding({ token, start: () => startup.promise }),
    });
    const context = f.manager.createEmptyWindow();

    const opening = f.manager.openWorkspace(context, workspaceA);
    await Promise.resolve();
    assert.deepEqual(f.shell.at(-1), {
      contextId: context.id,
      status: { state: "starting", workspace: workspaceA.toLowerCase() },
    });
    assert.deepEqual(f.ready, []);

    startup.resolve(4400);
    assert.equal(await opening, "bound");
    assert.deepEqual(f.ready, [context.id]);
  });

  it("binds an empty context and leaves the same workspace unchanged", async () => {
    const f = fixture();
    const context = f.manager.createEmptyWindow();

    assert.equal(await f.manager.openWorkspace(context, workspaceA), "bound");
    assert.equal(context.workspace, workspaceA.toLowerCase());
    assert.equal(context.server.kind, "owned");
    assert.equal(f.bindings.length, 1);
    assert.deepEqual(f.ready, [context.id]);

    assert.equal(await f.manager.openWorkspace(context, "e:/projects/alpha/"), "unchanged");
    assert.equal(f.bindings.length, 1);
  });

  it("focuses the existing owner and leaves the initiating empty context unbound", async () => {
    const f = fixture();
    const first = f.manager.createEmptyWindow();
    const second = f.manager.createEmptyWindow();
    await f.manager.openWorkspace(first, workspaceA);

    assert.equal(await f.manager.openWorkspace(second, workspaceA), "focused-existing");
    assert.equal(first.window.focusCalls, 1);
    assert.equal(second.workspace, null);
    assert.equal(second.server.kind, "none");
    assert.equal(f.bindings.length, 1);
  });

  it("switches a bound context from one workspace to another", async () => {
    const f = fixture();
    const context = f.manager.createEmptyWindow();
    await f.manager.openWorkspace(context, workspaceA);
    const firstBinding = context.server;

    assert.equal(await f.manager.openWorkspace(context, workspaceB), "switched");
    assert.equal(firstBinding.stopCalls, 1);
    assert.equal(context.workspace, workspaceB.toLowerCase());
    assert.equal(f.bindings.length, 2);
  });

  it("passes each context instance id to its window factory", () => {
    const f = fixture();
    const empty = f.manager.createEmptyWindow();
    const layout = resolveDataLayout({ dataRoot: f.dataRoot, workspace: workspaceA, instanceId: "initial-instance" });
    const initial = f.manager.createInitialWindow({
      instanceId: "initial-instance",
      workspace: workspaceA,
      layout,
      token: "initial-token",
      server: createExternalServerBinding({ port: 5174, token: "initial-token" }),
    });

    assert.deepEqual(f.createdWindowInstanceIds, [empty.instanceId, initial.instanceId]);
  });

  it("switches an external context through its server and keeps the binding", async () => {
    const switches = [];
    const f = fixture({
      switchExternalWorkspace: async (context, workspace) => {
        switches.push({ context, workspace });
      },
    });
    const layout = resolveDataLayout({ dataRoot: f.dataRoot, workspace: workspaceA, instanceId: "initial-instance" });
    const server = createExternalServerBinding({ port: 5174, token: "initial-token" });
    const context = f.manager.createInitialWindow({
      instanceId: "initial-instance",
      workspace: workspaceA,
      layout,
      token: "initial-token",
      server,
    });

    assert.equal(await f.manager.openWorkspace(context, workspaceB), "switched");
    assert.deepEqual(switches, [{ context, workspace: workspaceB.toLowerCase() }]);
    assert.strictEqual(context.server, server);
    assert.equal(context.server.kind, "external");
    assert.equal(context.workspace, workspaceB.toLowerCase());
    assert.notEqual(context.layout.workspaceRoot, layout.workspaceRoot);
    assert.strictEqual(f.manager.contextForWorkspace(workspaceB), context);
    assert.equal(f.manager.contextForWorkspace(workspaceA), null);
  });

  it("leaves an external context unchanged when its server switch fails", async () => {
    const f = fixture({
      switchExternalWorkspace: async () => {
        throw new Error("external switch failed");
      },
    });
    const layout = resolveDataLayout({ dataRoot: f.dataRoot, workspace: workspaceA, instanceId: "initial-instance" });
    const server = createExternalServerBinding({ port: 5174, token: "initial-token" });
    const context = f.manager.createInitialWindow({
      instanceId: "initial-instance",
      workspace: workspaceA,
      layout,
      token: "initial-token",
      server,
    });
    const oldLayout = context.layout;
    const oldRoots = context.trustedRoots;

    await assert.rejects(f.manager.openWorkspace(context, workspaceB), /external switch failed/);
    assert.strictEqual(context.server, server);
    assert.equal(context.workspace, workspaceA.toLowerCase());
    assert.strictEqual(context.layout, oldLayout);
    assert.strictEqual(context.trustedRoots, oldRoots);
    assert.strictEqual(f.manager.contextForWorkspace(workspaceA), context);
    assert.equal(f.manager.contextForWorkspace(workspaceB), null);
  });

  it("does not trust another context's workspace or instance data", async () => {
    const root = makeTempRoot();
    const dataRoot = join(root, "data");
    const projectA = join(root, "project-a");
    const projectB = join(root, "project-b");
    mkdirSync(projectA, { recursive: true });
    mkdirSync(projectB, { recursive: true });
    const f = fixture({ dataRoot });
    const contextA = f.manager.createEmptyWindow();
    const contextB = f.manager.createEmptyWindow();

    await f.manager.openWorkspace(contextA, projectA);
    await f.manager.openWorkspace(contextB, projectB);
    mkdirSync(contextA.layout.workspaceRoot, { recursive: true });
    mkdirSync(contextA.layout.instanceRoot, { recursive: true });
    mkdirSync(contextB.layout.workspaceRoot, { recursive: true });
    mkdirSync(contextB.layout.instanceRoot, { recursive: true });
    const ownWorkspaceFile = join(projectA, "own.txt");
    const otherWorkspaceFile = join(projectB, "other.txt");
    const otherInstanceFile = join(contextB.layout.instanceRoot, "port.json");
    writeFileSync(ownWorkspaceFile, "own");
    writeFileSync(otherWorkspaceFile, "other");
    writeFileSync(otherInstanceFile, "other-instance");

    assert.equal(contextA.trustedRoots.guardPath(ownWorkspaceFile, "reveal"), ownWorkspaceFile);
    assert.throws(
      () => contextA.trustedRoots.guardPath(otherWorkspaceFile, "trash"),
      /outside trusted desktop roots/,
    );
    assert.throws(
      () => contextA.trustedRoots.guardPath(otherInstanceFile, "trash"),
      /outside trusted desktop roots/,
    );
  });

  it("replaces trusted roots when switching and grants the old workspace only to its new owner", async () => {
    const root = makeTempRoot();
    const dataRoot = join(root, "data");
    const projectA = join(root, "project-a");
    const projectC = join(root, "project-c");
    mkdirSync(projectA, { recursive: true });
    mkdirSync(projectC, { recursive: true });
    const oldWorkspaceFile = join(projectA, "old.txt");
    writeFileSync(oldWorkspaceFile, "old");
    const f = fixture({ dataRoot });
    const switching = f.manager.createEmptyWindow();
    const newOwner = f.manager.createEmptyWindow();

    await f.manager.openWorkspace(switching, projectA);
    const oldRoots = switching.trustedRoots;
    assert.equal(oldRoots.guardPath(oldWorkspaceFile, "reveal"), oldWorkspaceFile);

    await f.manager.openWorkspace(switching, projectC);
    await f.manager.openWorkspace(newOwner, projectA);

    assert.notStrictEqual(switching.trustedRoots, oldRoots);
    assert.throws(
      () => switching.trustedRoots.guardPath(oldWorkspaceFile, "trash"),
      /outside trusted desktop roots/,
    );
    assert.equal(newOwner.trustedRoots.guardPath(oldWorkspaceFile, "reveal"), oldWorkspaceFile);
  });

  it("treats canonical Windows path spellings as the same workspace", async () => {
    const f = fixture();
    const first = f.manager.createEmptyWindow();
    const second = f.manager.createEmptyWindow();
    await f.manager.openWorkspace(first, "E:\\Projects\\Canonical\\.");

    assert.equal(await f.manager.openWorkspace(second, "e:/projects/canonical/"), "focused-existing");
    assert.equal(f.bindings.length, 1);
  });

  it("reserves ownership before async startup", async () => {
    const startup = deferred();
    const f = fixture({
      createOwnedServerBinding: ({ token }) => ownedBinding({ token, start: () => startup.promise }),
    });
    const first = f.manager.createEmptyWindow();
    const second = f.manager.createEmptyWindow();

    const opening = f.manager.openWorkspace(first, workspaceA);
    await Promise.resolve();
    assert.equal(await f.manager.openWorkspace(second, workspaceA), "focused-existing");
    assert.equal(f.bindings.length, 1);
    assert.equal(second.workspace, null);

    startup.resolve(4200);
    assert.equal(await opening, "bound");
  });

  it("retains a retryable empty context and releases ownership after startup failure", async () => {
    const errors = [];
    let attempts = 0;
    const f = fixture({
      createOwnedServerBinding: ({ token }) => ownedBinding({
        token,
        start: async () => {
          attempts++;
          if (attempts === 1) throw new Error("startup failed");
          return 4300;
        },
      }),
      onError: (error) => errors.push(error),
    });
    const first = f.manager.createEmptyWindow();
    const second = f.manager.createEmptyWindow();

    await assert.rejects(f.manager.openWorkspace(first, workspaceA), /startup failed/);
    assert.equal(first.lifecycle, "active");
    assert.equal(first.workspace, null);
    assert.equal(first.layout, null);
    assert.equal(first.token, null);
    assert.equal(first.server.kind, "none");
    assert.equal(errors.length, 1);

    assert.deepEqual(f.shell.at(-1), {
      contextId: first.id,
      status: {
        state: "failed",
        workspace: workspaceA.toLowerCase(),
        message: "startup failed",
      },
    });

    assert.equal(await f.manager.retryWorkspace(first), "bound");
    assert.equal(first.workspace, workspaceA.toLowerCase());
    assert.equal(attempts, 2);

    assert.equal(await f.manager.openWorkspace(second, workspaceA), "focused-existing");
  });

  it("rejects retry when the context has no failed workspace", async () => {
    const f = fixture();
    const context = f.manager.createEmptyWindow();

    await assert.rejects(f.manager.retryWorkspace(context), /no failed workspace/i);
  });

  it("quietly ignores an initial startup failure after its context starts closing", async () => {
    const stopping = deferred();
    const f = fixture();
    const instanceId = "closing-initial";
    const context = f.manager.createInitialWindow({
      instanceId,
      workspace: workspaceA,
      layout: resolveDataLayout({ dataRoot: f.dataRoot, workspace: workspaceA, instanceId }),
      token: "initial-token",
      server: ownedBinding({ token: "initial-token", stop: () => stopping.promise }),
    });
    const shellCount = f.shell.length;
    const disposal = f.manager.dispose(context);

    assert.equal(context.lifecycle, "closing");
    assert.equal(f.manager.reportWorkspaceFailure(context, new Error("late startup failure")), false);
    assert.equal(f.shell.length, shellCount);
    assert.equal(f.errors.length, 0);

    stopping.resolve();
    await disposal;
    assert.equal(context.lifecycle, "closed");
    assert.equal(f.manager.reportWorkspaceFailure(context, new Error("later startup failure")), false);
    assert.equal(f.shell.length, shellCount);
  });

  it("reports retry stop failures and keeps the failed workspace retryable", async () => {
    const stopFailure = new Error("retry termination failed");
    const f = fixture();
    const instanceId = "failed-initial";
    const context = f.manager.createInitialWindow({
      instanceId,
      workspace: workspaceA,
      layout: resolveDataLayout({ dataRoot: f.dataRoot, workspace: workspaceA, instanceId }),
      token: "initial-token",
      server: ownedBinding({ token: "initial-token", stop: async () => { throw stopFailure; } }),
    });
    assert.equal(f.manager.reportWorkspaceFailure(context, new Error("startup failed")), true);
    assert.deepEqual(f.shell.at(-1), {
      contextId: context.id,
      status: {
        state: "failed",
        workspace: workspaceA.toLowerCase(),
        message: "startup failed",
      },
    });

    await assert.rejects(f.manager.retryWorkspace(context), /retry termination failed/);

    assert.deepEqual(f.shell.at(-1), {
      contextId: context.id,
      status: {
        state: "failed",
        workspace: workspaceA.toLowerCase(),
        message: "retry termination failed",
      },
    });
    assert.deepEqual(f.errors, [{ error: stopFailure, contextId: context.id }]);
    assert.strictEqual(f.manager.contextForWorkspace(workspaceA), context);
  });

  it("waits for failed candidate cleanup before retrying", async () => {
    const cleanup = deferred();
    let attempts = 0;
    const f = fixture({
      createOwnedServerBinding: ({ token }) => {
        attempts++;
        return ownedBinding({
          token,
          ...(attempts === 1
            ? { start: async () => { throw new Error("startup failed"); }, stop: () => cleanup.promise }
            : {}),
        });
      },
    });
    const context = f.manager.createEmptyWindow();
    const opening = f.manager.openWorkspace(context, workspaceA);
    const openingFailure = assert.rejects(opening, /startup failed/);
    await new Promise((resolveImmediate) => setImmediate(resolveImmediate));

    let retrySettled = false;
    const retry = f.manager.retryWorkspace(context).then((action) => {
      retrySettled = true;
      return action;
    });
    await Promise.resolve();
    assert.equal(retrySettled, false);

    cleanup.resolve();
    await openingFailure;
    assert.equal(await retry, "bound");
    assert.equal(attempts, 2);
  });

  it("stops a started candidate before releasing ownership after ready-hook failure", async () => {
    let readyAttempts = 0;
    const f = fixture({
      onServerReady: async () => {
        readyAttempts++;
        if (readyAttempts === 1) throw new Error("renderer navigation failed");
      },
    });
    const first = f.manager.createEmptyWindow();
    const second = f.manager.createEmptyWindow();

    await assert.rejects(
      f.manager.openWorkspace(first, workspaceA),
      /renderer navigation failed/,
    );
    const candidate = f.bindings[0].binding;
    assert.equal(candidate.stopCalls, 1);
    assert.equal(candidate.state, "stopped");
    assert.equal(first.lifecycle, "active");
    assert.equal(first.workspace, null);
    assert.equal(first.server.kind, "none");

    assert.equal(await f.manager.openWorkspace(second, workspaceA), "bound");
    assert.equal(f.bindings.length, 2);
  });

  it("retains a candidate and reservation when failure cleanup cannot confirm termination", async () => {
    let stopAttempts = 0;
    let readyAttempts = 0;
    const f = fixture({
      createOwnedServerBinding: ({ token }) => ownedBinding({
        token,
        stop: async () => {
          stopAttempts++;
          if (stopAttempts === 1) throw new Error("termination not confirmed");
        },
      }),
      onServerReady: async () => {
        readyAttempts++;
        if (readyAttempts === 1) throw new Error("renderer navigation failed");
      },
    });
    const first = f.manager.createEmptyWindow();
    const second = f.manager.createEmptyWindow();
    const senderId = first.window.webContents.id;

    await assert.rejects(
      f.manager.openWorkspace(first, workspaceA),
      /candidate cleanup failed.*termination not confirmed/i,
    );
    const candidate = f.bindings[0].binding;
    assert.equal(candidate.stopCalls, 1);
    assert.equal(first.lifecycle, "closing");
    assert.equal(first.workspace, workspaceA.toLowerCase());
    assert.strictEqual(first.server, candidate);
    assert.strictEqual(f.manager.contextForWorkspace(workspaceA), first);
    assert.throws(() => f.manager.contextForSender(senderId), /managed window/);
    await assert.rejects(
      f.manager.openWorkspace(second, workspaceA),
      /termination not confirmed/,
    );
    assert.equal(f.bindings.length, 1);

    await f.manager.dispose(first);
    assert.equal(candidate.stopCalls, 2);
    assert.equal(first.lifecycle, "closed");
    assert.equal(await f.manager.openWorkspace(second, workspaceA), "bound");
  });

  it("releases ownership when binding construction fails", async () => {
    let attempts = 0;
    const f = fixture({
      createOwnedServerBinding: ({ token }) => {
        attempts++;
        if (attempts === 1) throw new Error("binding construction failed");
        return ownedBinding({ token });
      },
    });
    const first = f.manager.createEmptyWindow();
    const second = f.manager.createEmptyWindow();

    await assert.rejects(
      f.manager.openWorkspace(first, workspaceA),
      /binding construction failed/,
    );
    assert.equal(first.workspace, null);
    assert.equal(first.server.kind, "none");
    assert.equal(await f.manager.openWorkspace(second, workspaceA), "bound");
    assert.equal(attempts, 2);
  });

  it("disposes a context idempotently and stops its server once", async () => {
    const stopping = deferred();
    const f = fixture({
      createOwnedServerBinding: ({ token }) => ownedBinding({ token, stop: () => stopping.promise }),
    });
    const context = f.manager.createEmptyWindow();
    await f.manager.openWorkspace(context, workspaceA);
    const binding = context.server;

    const firstDispose = f.manager.dispose(context);
    const secondDispose = f.manager.dispose(context);
    assert.strictEqual(firstDispose, secondDispose);
    assert.equal(context.lifecycle, "closing");
    assert.equal(binding.stopCalls, 1);

    stopping.resolve();
    await firstDispose;
    assert.equal(context.lifecycle, "closed");
    assert.throws(() => f.manager.contextForSender(context.window.webContents.id), /managed window/);
    await f.manager.dispose(context);
    assert.equal(binding.stopCalls, 1);
  });

  it("closes only window B's owned server", async () => {
    const f = fixture();
    const first = f.manager.createEmptyWindow();
    const second = f.manager.createEmptyWindow();
    await f.manager.openWorkspace(first, workspaceA);
    await f.manager.openWorkspace(second, workspaceB);
    const firstBinding = first.server;
    const secondBinding = second.server;

    second.window.close();
    await new Promise((resolveImmediate) => setImmediate(resolveImmediate));

    assert.equal(first.lifecycle, "active");
    assert.equal(second.lifecycle, "closed");
    assert.equal(firstBinding.stopCalls, 0);
    assert.equal(secondBinding.stopCalls, 1);
  });

  it("disposes after Electron destroys webContents before the closed callback", async () => {
    const f = fixture();
    const context = f.manager.createEmptyWindow();
    await f.manager.openWorkspace(context, workspaceA);
    const senderId = context.window.webContents.id;
    const binding = context.server;
    context.window.throwOnDestroyedWebContents = true;

    context.window.close();
    await new Promise((resolveImmediate) => setImmediate(resolveImmediate));

    assert.equal(context.lifecycle, "closed");
    assert.equal(binding.stopCalls, 1);
    assert.throws(() => f.manager.contextForSender(senderId), /managed window/);
    assert.equal(f.errors.length, 0);
  });

  it("marks a closing window before destruction so an immediate reopen waits for disposal", async () => {
    const stopping = deferred();
    let bindingNumber = 0;
    const f = fixture({
      createOwnedServerBinding: ({ token }) => ownedBinding({
        token,
        stop: ++bindingNumber === 1 ? () => stopping.promise : undefined,
      }),
    });
    const first = f.manager.createEmptyWindow();
    await f.manager.openWorkspace(first, workspaceA);
    first.window.deferClosedEvent = true;

    first.window.close();
    const replacement = f.manager.createEmptyWindow();
    let reopened = false;
    const opening = f.manager.openWorkspace(replacement, workspaceA).then((action) => {
      reopened = true;
      return action;
    });
    await Promise.resolve();

    assert.equal(first.lifecycle, "closing");
    assert.equal(reopened, false);
    stopping.resolve();
    assert.equal(await opening, "bound");
    assert.equal(first.lifecycle, "closed");
    assert.equal(replacement.workspace, workspaceA.toLowerCase());
  });

  it("returns only crashed window B to the shell and navigates only B after restart", async () => {
    const timers = manualTimers();
    const f = fixture({
      restartDelayMs: 25,
      setTimeout: timers.setTimeout,
      clearTimeout: timers.clearTimeout,
    });
    const first = f.manager.createEmptyWindow();
    const second = f.manager.createEmptyWindow();
    await f.manager.openWorkspace(first, workspaceA);
    await f.manager.openWorkspace(second, workspaceB);
    const firstBinding = first.server;
    const secondBinding = second.server;
    f.shell.length = 0;
    f.ready.length = 0;

    secondBinding.unexpectedExit({ code: 9, signal: null });

    assert.deepEqual(f.shell, [{
      contextId: second.id,
      status: { state: "starting", workspace: workspaceB.toLowerCase() },
    }]);
    assert.equal(timers.size, 1);
    assert.equal(firstBinding.startCalls, 1);
    assert.equal(secondBinding.startCalls, 1);
    assert.deepEqual(f.ready, []);

    timers.runNext();
    await new Promise((resolveImmediate) => setImmediate(resolveImmediate));

    assert.equal(firstBinding.startCalls, 1);
    assert.equal(secondBinding.startCalls, 2);
    assert.deepEqual(f.ready, [second.id]);
    assert.equal(first.window.focusCalls, 0);
  });

  it("limits binding-local restart attempts and preserves shell retry", async () => {
    const timers = manualTimers();
    let bindingNumber = 0;
    const f = fixture({
      maxRestartAttempts: 2,
      restartDelayMs: 25,
      setTimeout: timers.setTimeout,
      clearTimeout: timers.clearTimeout,
      createOwnedServerBinding: ({ token }) => {
        bindingNumber++;
        if (bindingNumber > 1) return ownedBinding({ token });
        let attempts = 0;
        return ownedBinding({
          token,
          start: async () => {
            attempts++;
            if (attempts > 1) throw new Error(`restart ${attempts - 1} failed`);
            return 4400;
          },
        });
      },
    });
    const context = f.manager.createEmptyWindow();
    await f.manager.openWorkspace(context, workspaceA);
    const binding = context.server;

    binding.unexpectedExit({ code: 7, signal: null });
    timers.runNext();
    await new Promise((resolveImmediate) => setImmediate(resolveImmediate));
    timers.runNext();
    await new Promise((resolveImmediate) => setImmediate(resolveImmediate));

    assert.equal(binding.startCalls, 3);
    assert.equal(timers.size, 0);
    assert.deepEqual(f.shell.at(-1), {
      contextId: context.id,
      status: {
        state: "failed",
        workspace: workspaceA.toLowerCase(),
        message: "restart 2 failed",
      },
    });

    assert.equal(await f.manager.retryWorkspace(context), "bound");
    assert.equal(binding.stopCalls, 1);
    assert.equal(bindingNumber, 2);
  });

  it("finishes disposal when a close interrupts an in-flight restart", async () => {
    const timers = manualTimers();
    const restarting = deferred();
    let starts = 0;
    const f = fixture({
      restartDelayMs: 25,
      setTimeout: timers.setTimeout,
      clearTimeout: timers.clearTimeout,
      createOwnedServerBinding: ({ token }) => ownedBinding({
        token,
        start: () => ++starts === 1 ? Promise.resolve(4500) : restarting.promise,
        stop: async () => { restarting.reject(new Error("restart interrupted by close")); },
      }),
    });
    const context = f.manager.createEmptyWindow();
    await f.manager.openWorkspace(context, workspaceA);
    const binding = context.server;
    binding.unexpectedExit({ code: 8, signal: null });
    timers.runNext();
    await Promise.resolve();

    await f.manager.dispose(context);

    assert.equal(context.lifecycle, "closed");
    assert.equal(binding.stopCalls, 1);
    assert.equal(timers.size, 0);
  });

  it("replaces a stale restart timer when another crash starts a new generation", async () => {
    const timers = manualTimers();
    const f = fixture({
      restartDelayMs: 25,
      setTimeout: timers.setTimeout,
      clearTimeout: timers.clearTimeout,
    });
    const context = f.manager.createEmptyWindow();
    await f.manager.openWorkspace(context, workspaceA);
    const binding = context.server;

    binding.unexpectedExit({ code: 8, signal: null });
    binding.unexpectedExit({ code: 9, signal: null });

    assert.equal(timers.size, 1);
    await f.manager.dispose(context);
    assert.equal(timers.size, 0);
    assert.equal(context.lifecycle, "closed");
  });

  it("does not let an old recovery generation report healthy", async () => {
    const timers = manualTimers();
    const staleReady = deferred();
    let readyCalls = 0;
    const f = fixture({
      restartDelayMs: 25,
      setTimeout: timers.setTimeout,
      clearTimeout: timers.clearTimeout,
      onServerReady: () => {
        readyCalls++;
        if (readyCalls === 2) return staleReady.promise;
      },
    });
    const context = f.manager.createEmptyWindow();
    await f.manager.openWorkspace(context, workspaceA);
    const binding = context.server;

    binding.unexpectedExit({ code: 8, signal: null });
    timers.runNext();
    await new Promise((resolveImmediate) => setImmediate(resolveImmediate));
    assert.equal(context.serverRecovery.restartCount, 1);

    binding.unexpectedExit({ code: 9, signal: null });
    staleReady.resolve();
    await new Promise((resolveImmediate) => setImmediate(resolveImmediate));

    assert.equal(context.serverRecovery.health, "recovering");
    assert.equal(context.serverRecovery.restartCount, 1);
    assert.equal(timers.size, 1);
    await f.manager.dispose(context);
  });

  it("preserves one recovery budget and awaits every stale ready hook on dispose", async () => {
    const timers = manualTimers();
    const firstReady = deferred();
    const secondReady = deferred();
    let readyCalls = 0;
    const f = fixture({
      maxRestartAttempts: 2,
      restartDelayMs: 25,
      setTimeout: timers.setTimeout,
      clearTimeout: timers.clearTimeout,
      onServerReady: () => {
        readyCalls++;
        if (readyCalls === 2) return firstReady.promise;
        if (readyCalls === 3) return secondReady.promise;
      },
    });
    const context = f.manager.createEmptyWindow();
    await f.manager.openWorkspace(context, workspaceA);
    const binding = context.server;

    binding.unexpectedExit({ code: 8, signal: null });
    timers.runNext();
    await new Promise((resolveImmediate) => setImmediate(resolveImmediate));
    assert.equal(binding.startCalls, 2);
    assert.equal(readyCalls, 2);

    binding.unexpectedExit({ code: 9, signal: null });
    timers.runNext();
    await new Promise((resolveImmediate) => setImmediate(resolveImmediate));
    assert.equal(binding.startCalls, 3);
    assert.equal(readyCalls, 3);

    binding.unexpectedExit({ code: 10, signal: null });
    assert.equal(timers.size, 0);
    assert.equal(context.serverRecovery.restartCount, 2);
    assert.equal(context.serverRecovery.health, "failed");

    let disposed = false;
    const disposal = f.manager.dispose(context).then(() => { disposed = true; });
    await Promise.resolve();
    assert.equal(disposed, false);

    secondReady.resolve();
    await new Promise((resolveImmediate) => setImmediate(resolveImmediate));
    assert.equal(disposed, false);

    firstReady.resolve();
    await disposal;
    assert.equal(context.lifecycle, "closed");
    assert.equal(context.serverRecovery.health, "idle");
  });

  it("retains ownership and binding when disposal cannot confirm termination", async () => {
    let stopAttempts = 0;
    const f = fixture({
      createOwnedServerBinding: ({ token }) => ownedBinding({
        token,
        stop: async () => {
          stopAttempts++;
          if (stopAttempts === 1) throw new Error("dispose termination failed");
        },
      }),
    });
    const first = f.manager.createEmptyWindow();
    const second = f.manager.createEmptyWindow();
    await f.manager.openWorkspace(first, workspaceA);
    const binding = first.server;
    const senderId = first.window.webContents.id;

    await assert.rejects(f.manager.dispose(first), /dispose termination failed/);
    assert.equal(first.lifecycle, "closing");
    assert.strictEqual(first.server, binding);
    assert.strictEqual(f.manager.contextForWorkspace(workspaceA), first);
    assert.throws(() => f.manager.contextForSender(senderId), /managed window/);
    await assert.rejects(
      f.manager.openWorkspace(second, workspaceA),
      /termination not confirmed/,
    );
    assert.equal(f.bindings.length, 1);

    await f.manager.dispose(first);
    assert.equal(binding.stopCalls, 2);
    assert.equal(first.lifecycle, "closed");
    assert.equal(await f.manager.openWorkspace(second, workspaceA), "bound");
  });

  it("waits for an owner switching away before reclaiming its previous workspace", async () => {
    const stopping = deferred();
    let bindingNumber = 0;
    const f = fixture({
      createOwnedServerBinding: ({ token }) => {
        bindingNumber++;
        return ownedBinding({
          token,
          ...(bindingNumber === 1 ? { stop: () => stopping.promise } : {}),
        });
      },
    });
    const owner = f.manager.createEmptyWindow();
    const requester = f.manager.createEmptyWindow();
    await f.manager.openWorkspace(owner, workspaceA);

    const switching = f.manager.openWorkspace(owner, workspaceB);
    let reclaimSettled = false;
    const reclaiming = f.manager.openWorkspace(requester, workspaceA).then((action) => {
      reclaimSettled = true;
      return action;
    });
    await new Promise((resolveImmediate) => setImmediate(resolveImmediate));
    assert.equal(reclaimSettled, false);
    assert.equal(f.bindings.length, 1);

    stopping.resolve();
    assert.equal(await switching, "switched");
    assert.equal(await reclaiming, "bound");
    assert.equal(owner.workspace, workspaceB.toLowerCase());
    assert.equal(requester.workspace, workspaceA.toLowerCase());
    assert.equal(f.bindings.length, 3);
  });

  it("waits for a failed owner transition before deciding the previous workspace is unchanged", async () => {
    const stopping = deferred();
    const f = fixture({
      createOwnedServerBinding: ({ token }) => ownedBinding({ token, stop: () => stopping.promise }),
    });
    const owner = f.manager.createEmptyWindow();
    const requester = f.manager.createEmptyWindow();
    await f.manager.openWorkspace(owner, workspaceA);

    const switching = f.manager.openWorkspace(owner, workspaceB);
    const switchFailure = assert.rejects(switching, /switch stop failed/);
    let reclaimSettled = false;
    const reclaiming = f.manager.openWorkspace(requester, workspaceA).then((action) => {
      reclaimSettled = true;
      return action;
    });
    await new Promise((resolveImmediate) => setImmediate(resolveImmediate));
    assert.equal(reclaimSettled, false);

    stopping.reject(new Error("switch stop failed"));
    await switchFailure;
    assert.equal(await reclaiming, "focused-existing");
    assert.equal(owner.workspace, workspaceA.toLowerCase());
    assert.equal(owner.window.focusCalls, 1);
    assert.equal(requester.workspace, null);
    assert.equal(f.bindings.length, 1);
  });

  it("waits for a closing owner before rebinding its workspace", async () => {
    const stopping = deferred();
    let bindingNumber = 0;
    const f = fixture({
      createOwnedServerBinding: ({ token }) => {
        bindingNumber++;
        return ownedBinding({
          token,
          ...(bindingNumber === 1 ? { stop: () => stopping.promise } : {}),
        });
      },
    });
    const first = f.manager.createEmptyWindow();
    const second = f.manager.createEmptyWindow();
    await f.manager.openWorkspace(first, workspaceA);
    const disposal = f.manager.dispose(first);

    let settled = false;
    const opening = f.manager.openWorkspace(second, workspaceA).then((action) => {
      settled = true;
      return action;
    });
    await Promise.resolve();
    assert.equal(settled, false);
    assert.equal(f.bindings.length, 1);

    stopping.resolve();
    await disposal;
    assert.equal(await opening, "bound");
    assert.equal(f.bindings.length, 2);
  });

  it("creates and owns an indexed initial context from an existing binding", () => {
    const f = fixture();
    const instanceId = "initial-instance";
    const layout = resolveDataLayout({ dataRoot: f.dataRoot, workspace: workspaceA, instanceId });
    const server = createExternalServerBinding({ port: 5174, token: "initial-token" });
    const context = f.manager.createInitialWindow({
      instanceId,
      workspace: workspaceA,
      layout,
      token: "initial-token",
      server,
    });

    assert.equal(context.workspace, workspaceA.toLowerCase());
    assert.strictEqual(context.server, server);
    assert.strictEqual(f.manager.contextForSender(context.window.webContents.id), context);
    assert.strictEqual(f.manager.contextForWorkspace("e:/projects/alpha"), context);
  });

  it("waits for every owned dispose promise before completing app disposal", async () => {
    const firstStop = deferred();
    const secondStop = deferred();
    let bindingNumber = 0;
    const f = fixture({
      createOwnedServerBinding: ({ token }) => {
        const number = ++bindingNumber;
        return ownedBinding({ token, stop: () => number === 1 ? firstStop.promise : secondStop.promise });
      },
    });
    const first = f.manager.createEmptyWindow();
    const second = f.manager.createEmptyWindow();
    await f.manager.openWorkspace(first, workspaceA);
    await f.manager.openWorkspace(second, workspaceB);

    let disposed = false;
    const disposal = f.manager.disposeAll().then(() => { disposed = true; });
    await Promise.resolve();
    assert.equal(disposed, false);

    firstStop.resolve();
    await Promise.resolve();
    assert.equal(disposed, false);

    secondStop.resolve();
    await disposal;

    assert.equal(first.lifecycle, "closed");
    assert.equal(second.lifecycle, "closed");
    assert.equal(f.bindings[0].binding.stopCalls, 1);
    assert.equal(f.bindings[1].binding.stopCalls, 1);
  });
});
