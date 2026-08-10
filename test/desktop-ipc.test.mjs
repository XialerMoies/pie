import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  DESKTOP_IPC_INVOKE_CHANNELS,
  DESKTOP_IPC_SEND_CHANNELS,
  TrustedDesktopRoots,
  registerDesktopIpcHandlers,
  resolveDesktopIpcContext,
} from "../src/electron/desktop-ipc.ts";
import { resolveDataLayout } from "../src/data/data-layout.ts";
import { createNoneServerBinding } from "../src/electron/server-binding.ts";
import { WindowManager } from "../src/electron/window-manager.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const DASHBOARD_URL = "file:///application/dashboard.html";
const VITE_ORIGIN = "http://127.0.0.1:5173";
const tempDirs = [];

function makeTempDir() {
  const dir = mkdtempSync(join(ROOT, ".tmp-desktop-ipc-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length) {
    rmSync(tempDirs.pop(), { recursive: true, force: true });
  }
});

class IpcMainMock {
  handles = new Map();
  listeners = new Map();

  handle(channel, handler) {
    assert.ok(!this.handles.has(channel), `duplicate handler: ${channel}`);
    this.handles.set(channel, handler);
  }

  on(channel, handler) {
    assert.ok(!this.listeners.has(channel), `duplicate listener: ${channel}`);
    this.listeners.set(channel, handler);
  }

  async invokeWithEvent(channel, event, ...args) {
    const handler = this.handles.get(channel);
    assert.ok(handler, `missing invoke handler: ${channel}`);
    return await handler(event, ...args);
  }

  sendWithEvent(channel, event, ...args) {
    const handler = this.listeners.get(channel);
    assert.ok(handler, `missing send listener: ${channel}`);
    return handler(event, ...args);
  }
}

class ManagedIpcWindow {
  constructor(id, name, calls) {
    this.webContents = { id, getURL: () => "" };
    this.name = name;
    this.calls = calls;
    this.maximized = false;
    this.destroyed = false;
    this.listeners = new Map();
  }

  focus() { this.calls.push(`${this.name}:focus`); }
  isDestroyed() { return this.destroyed; }
  minimize() { this.calls.push(`${this.name}:minimize`); }
  isMaximized() { return this.maximized; }
  maximize() { this.maximized = true; this.calls.push(`${this.name}:maximize`); }
  unmaximize() { this.maximized = false; this.calls.push(`${this.name}:unmaximize`); }
  close() { this.calls.push(`${this.name}:close`); }
  on(event, listener) {
    const listeners = this.listeners.get(event) || [];
    listeners.push(listener);
    this.listeners.set(event, listeners);
    return this;
  }
}

function managedBinding(token, port) {
  let state = "stopped";
  let unexpectedExitHandler = null;
  return {
    kind: "owned",
    get state() { return state; },
    get port() { return state === "ready" ? port : 0; },
    token,
    get origin() { return state === "ready" ? `http://127.0.0.1:${port}` : ""; },
    process: null,
    async start() { state = "ready"; return port; },
    async stop() { state = "stopped"; },
    setUnexpectedExitHandler(handler) { unexpectedExitHandler = handler; },
    snapshot() {
      return {
        kind: "owned",
        state,
        port: this.port,
        token,
        origin: this.origin,
        hasProcess: false,
      };
    },
  };
}

function makeWindow(id, name, calls) {
  const webContents = { id, getURL: () => "" };
  let maximized = false;
  return {
    webContents,
    minimize: () => calls.push(`${name}:minimize`),
    isMaximized: () => maximized,
    maximize: () => { maximized = true; calls.push(`${name}:maximize`); },
    unmaximize: () => { maximized = false; calls.push(`${name}:unmaximize`); },
    close: () => calls.push(`${name}:close`),
  };
}

function makeContext({ id, name, token, port, root, calls, kind = "owned", workspace = root }) {
  const trustedRoots = new TrustedDesktopRoots();
  trustedRoots.addRoot(root);
  return {
    id: name,
    window: makeWindow(id, name, calls),
    workspace,
    token,
    trustedRoots,
    server: {
      kind,
      port,
      origin: port ? `http://127.0.0.1:${port}` : "",
    },
  };
}

function makeEvent(context, url = context.server.origin) {
  return {
    sender: context.window.webContents,
    senderFrame: { url },
  };
}

function makeContextResolver(contexts) {
  const bySender = new Map(contexts.map((context) => [context.window.webContents.id, context]));
  return (event) => resolveDesktopIpcContext(event, {
    contextForSender: (senderId) => {
      const context = bySender.get(senderId);
      if (!context) throw new Error(`Sender ${senderId} is not a managed window`);
      return context;
    },
    dashboardUrl: DASHBOARD_URL,
    viteOrigin: VITE_ORIGIN,
  });
}

function deferred() {
  let resolvePromise;
  const promise = new Promise((resolve) => {
    resolvePromise = resolve;
  });
  return { promise, resolve: resolvePromise };
}

function registerHarness({ contexts, calls, selectedFile, selectedFolder, workspaceResult }) {
  const ipcMain = new IpcMainMock();
  registerDesktopIpcHandlers({
    ipcMain,
    resolveContext: makeContextResolver(contexts),
    createEmptyWindow: () => { calls.push("new-window"); return { ok: true }; },
    openWorkspaceFolder: async (context) => {
      calls.push(`workspace:${context.id}`);
      return workspaceResult || null;
    },
    retryWorkspace: async (context) => { calls.push(`retry:${context.id}`); },
    selectFolder: async (context) => {
      calls.push(`folder:${context.id}`);
      return selectedFolder?.get(context) || null;
    },
    selectFile: async (context) => {
      calls.push(`file:${context.id}`);
      return selectedFile?.get(context) || null;
    },
    showItemInFolder: (context, filePath) => calls.push(`reveal:${context.id}:${filePath}`),
    trashItem: async (context, filePath) => { calls.push(`trash:${context.id}:${filePath}`); },
    spawnTerminal: (context) => { calls.push(`terminal:${context.id}`); return true; },
  });
  return ipcMain;
}

describe("desktop IPC governance", () => {
  it("routes every privileged operation through the sender context", async () => {
    const rootA = makeTempDir();
    const rootB = makeTempDir();
    const fileA = join(rootA, "a.txt");
    const fileB = join(rootB, "b.txt");
    writeFileSync(fileA, "a");
    writeFileSync(fileB, "b");

    const calls = [];
    const contextA = makeContext({ id: 101, name: "a", token: "token-a", port: 4101, root: rootA, calls });
    const contextB = makeContext({ id: 202, name: "b", token: "token-b", port: 4202, root: rootB, calls });
    const eventA = makeEvent(contextA);
    const eventB = makeEvent(contextB);
    const ipcMain = registerHarness({
      contexts: [contextA, contextB],
      calls,
      selectedFile: new Map([[contextA, fileA], [contextB, fileB]]),
      selectedFolder: new Map([[contextA, rootA], [contextB, rootB]]),
      workspaceResult: { ok: true, workspace: rootA, action: "binding" },
    });

    ipcMain.sendWithEvent("window-minimize", eventA);
    ipcMain.sendWithEvent("window-maximize", eventA);
    ipcMain.sendWithEvent("window-maximize", eventA);
    ipcMain.sendWithEvent("window-close", eventB);
    assert.deepStrictEqual(calls.slice(0, 4), ["a:minimize", "a:maximize", "a:unmaximize", "b:close"]);

    assert.strictEqual(await ipcMain.invokeWithEvent("desktop-session-token", eventA), "token-a");
    assert.strictEqual(await ipcMain.invokeWithEvent("desktop-session-token", eventB), "token-b");
    assert.deepStrictEqual(await ipcMain.invokeWithEvent("workspace-open-folder", eventA), {
      ok: true,
      workspace: rootA,
      action: "binding",
    });
    await ipcMain.invokeWithEvent("workspace-retry", makeEvent(contextA, DASHBOARD_URL));
    assert.strictEqual(await ipcMain.invokeWithEvent("dialog-select-folder", eventB), rootB);
    assert.strictEqual(await ipcMain.invokeWithEvent("dialog-open-file", eventA), fileA);

    await ipcMain.invokeWithEvent("show-item-in-folder", eventA, fileA);
    assert.strictEqual(await ipcMain.invokeWithEvent("trash-item", eventB, fileB), true);
    assert.strictEqual(await ipcMain.invokeWithEvent("spawn-terminal", eventB), true);
    assert.ok(calls.includes(`reveal:a:${realpathSync.native(fileA)}`));
    assert.ok(calls.includes(`trash:b:${realpathSync.native(fileB)}`));
    assert.ok(calls.includes("terminal:b"));
    assert.ok(calls.includes("retry:a"));

    await assert.rejects(
      () => ipcMain.invokeWithEvent("show-item-in-folder", eventB, fileA),
      /outside trusted desktop roots/,
    );
  });

  it("rejects unknown senders, mismatched sender identity, and cross-context origins", async () => {
    const rootA = makeTempDir();
    const rootB = makeTempDir();
    const calls = [];
    const contextA = makeContext({ id: 101, name: "a", token: "token-a", port: 4101, root: rootA, calls });
    const contextB = makeContext({ id: 202, name: "b", token: "token-b", port: 4202, root: rootB, calls });
    const ipcMain = registerHarness({ contexts: [contextA, contextB], calls });

    await assert.rejects(
      () => ipcMain.invokeWithEvent("desktop-session-token", {
        sender: { id: 999, getURL: () => contextA.server.origin },
        senderFrame: { url: contextA.server.origin },
      }),
      /managed app window/,
    );
    await assert.rejects(
      () => ipcMain.invokeWithEvent("desktop-session-token", {
        sender: { id: contextA.window.webContents.id, getURL: () => contextA.server.origin },
        senderFrame: { url: contextA.server.origin },
      }),
      /trusted app window/,
    );
    await assert.rejects(
      () => ipcMain.invokeWithEvent("desktop-session-token", makeEvent(contextA, "http://127.0.0.1:4999")),
      /trusted app origin/,
    );
    await assert.rejects(
      () => ipcMain.invokeWithEvent("desktop-session-token", makeEvent(contextA, contextB.server.origin)),
      /trusted app origin/,
    );
    await assert.rejects(
      () => ipcMain.invokeWithEvent("workspace-retry", makeEvent(contextA, contextB.server.origin)),
      /trusted app origin/,
    );
    assert.deepStrictEqual(calls, []);
  });

  it("requires a non-empty sender frame instead of falling back to the WebContents URL", async () => {
    const root = makeTempDir();
    const calls = [];
    const context = makeContext({ id: 101, name: "a", token: "token-a", port: 4101, root, calls });
    context.window.webContents.getURL = () => context.server.origin;
    const ipcMain = registerHarness({ contexts: [context], calls });

    await assert.rejects(
      () => ipcMain.invokeWithEvent("desktop-session-token", {
        sender: context.window.webContents,
        senderFrame: null,
      }),
      /trusted app origin/,
    );
    await assert.rejects(
      () => ipcMain.invokeWithEvent("desktop-session-token", {
        sender: context.window.webContents,
        senderFrame: { url: "" },
      }),
      /trusted app origin/,
    );
  });

  it("allows only the exact shell URL, owned origin, or external-context Vite origin", async () => {
    const root = makeTempDir();
    const calls = [];
    const owned = makeContext({ id: 101, name: "owned", token: "owned-token", port: 4101, root, calls });
    const external = makeContext({ id: 202, name: "external", token: "external-token", port: 4300, root, calls, kind: "external" });
    const ipcMain = registerHarness({ contexts: [owned, external], calls });

    assert.strictEqual(await ipcMain.invokeWithEvent("desktop-session-token", makeEvent(owned, DASHBOARD_URL)), "owned-token");
    assert.strictEqual(await ipcMain.invokeWithEvent("desktop-session-token", makeEvent(owned, `${owned.server.origin}/dashboard`)), "owned-token");
    assert.strictEqual(await ipcMain.invokeWithEvent("desktop-session-token", makeEvent(external, `${VITE_ORIGIN}/src/frontend.ts`)), "external-token");
    await assert.rejects(
      () => ipcMain.invokeWithEvent("desktop-session-token", makeEvent(owned, VITE_ORIGIN)),
      /trusted app origin/,
    );
    await assert.rejects(
      () => ipcMain.invokeWithEvent("desktop-session-token", makeEvent(external, external.server.origin)),
      /trusted app origin/,
    );
    await assert.rejects(
      () => ipcMain.invokeWithEvent("desktop-session-token", makeEvent(owned, `${DASHBOARD_URL}#other`)),
      /trusted app origin/,
    );
    await assert.rejects(
      () => ipcMain.invokeWithEvent("desktop-session-token", makeEvent(owned, "https://127.0.0.1:4101")),
      /trusted app origin/,
    );
    await assert.rejects(
      () => ipcMain.invokeWithEvent("desktop-session-token", makeEvent(owned, "http://user:pass@127.0.0.1:4101")),
      /trusted app origin/,
    );
  });

  it("exposes dedicated workspace and picker APIs without compatibility aliases", () => {
    const preloadSource = readFileSync(new URL("../src/electron/preload.ts", import.meta.url), "utf-8");
    const uncommentedSource = preloadSource
      .split(/\r?\n/)
      .filter((line) => !line.trimStart().startsWith("//"))
      .join("\n");

    assert.match(uncommentedSource, /openWorkspaceFolder:\s*\(\)\s*=>\s*ipcRenderer\.invoke\("workspace-open-folder"\)/);
    assert.match(uncommentedSource, /selectFolder:\s*\(\)\s*=>\s*ipcRenderer\.invoke\("dialog-select-folder"\)/);
    assert.match(uncommentedSource, /selectFile:\s*\(\)\s*=>\s*ipcRenderer\.invoke\("dialog-open-file"\)/);
    assert.doesNotMatch(uncommentedSource, /\bopenFolder\s*:/);
    assert.doesNotMatch(uncommentedSource, /\bopenFile\s*:/);
    assert.match(uncommentedSource, /getDesktopSessionToken:\s*\(\)\s*=>\s*ipcRenderer\.invoke\("desktop-session-token"\)/);
  });

  it("guards reveal/trash paths against trusted desktop roots", () => {
    const root = makeTempDir();
    const nested = join(root, "nested");
    mkdirSync(nested);
    const inside = join(nested, "inside.txt");
    writeFileSync(inside, "ok");

    const outsideRoot = makeTempDir();
    const outside = join(outsideRoot, "outside.txt");
    writeFileSync(outside, "blocked");

    const roots = new TrustedDesktopRoots();
    roots.addRoot(root);

    assert.strictEqual(roots.guardPath(inside, "reveal"), realpathSync.native(inside));
    assert.throws(() => roots.guardPath(outside, "trash"), /outside trusted desktop roots/);
    assert.throws(() => roots.guardPath("relative.txt", "reveal"), /must be absolute/);
    assert.throws(() => roots.guardPath(join(root, "missing.txt"), "reveal"), /does not exist/);
  });

  it("loads persisted workspace roots from ui-state without trusting relative paths", () => {
    const dataDir = makeTempDir();
    const workspace = makeTempDir();
    const uiStateFile = join(dataDir, "ui-state.json");
    writeFileSync(uiStateFile, JSON.stringify({
      workspaces: {
        _default: {},
        relative: {},
        [workspace]: {},
      },
    }));

    const roots = new TrustedDesktopRoots();
    assert.strictEqual(roots.addPersistedWorkspaceRoots(uiStateFile), 1);
    assert.deepStrictEqual(roots.listRoots(), [realpathSync.native(workspace)]);
  });

  it("trusts selected files exactly and selected folders only in the sender context", async () => {
    const rootA = makeTempDir();
    const rootB = makeTempDir();
    const selected = join(rootA, "selected.txt");
    const sibling = join(rootA, "sibling.txt");
    writeFileSync(selected, "selected");
    writeFileSync(sibling, "sibling");
    const calls = [];
    const contextA = makeContext({ id: 101, name: "a", token: "token-a", port: 4101, root: rootB, calls });
    const contextB = makeContext({ id: 202, name: "b", token: "token-b", port: 4202, root: rootB, calls });
    const ipcMain = registerHarness({
      contexts: [contextA, contextB],
      calls,
      selectedFile: new Map([[contextA, selected]]),
      selectedFolder: new Map([[contextA, rootA]]),
    });

    assert.strictEqual(await ipcMain.invokeWithEvent("dialog-open-file", makeEvent(contextA)), selected);
    assert.strictEqual(contextA.trustedRoots.guardPath(selected, "reveal"), realpathSync.native(selected));
    assert.throws(() => contextA.trustedRoots.guardPath(sibling, "trash"), /outside trusted desktop roots/);
    assert.throws(() => contextB.trustedRoots.guardPath(selected, "reveal"), /outside trusted desktop roots/);

    assert.strictEqual(await ipcMain.invokeWithEvent("dialog-select-folder", makeEvent(contextA)), rootA);
    assert.strictEqual(contextA.trustedRoots.guardPath(sibling, "trash"), realpathSync.native(sibling));
    assert.throws(() => contextB.trustedRoots.guardPath(sibling, "trash"), /outside trusted desktop roots/);
  });

  it("discards file and folder selections when the context root registry changes in flight", async () => {
    const originalRoot = makeTempDir();
    const selectedRoot = makeTempDir();
    const selectedFile = join(selectedRoot, "selected.txt");
    writeFileSync(selectedFile, "selected");
    const calls = [];
    const context = makeContext({
      id: 101,
      name: "a",
      token: "token-a",
      port: 4101,
      root: originalRoot,
      calls,
    });
    const fileDialog = deferred();
    const folderDialog = deferred();
    const ipcMain = registerHarness({
      contexts: [context],
      calls,
      selectedFile: new Map([[context, fileDialog.promise]]),
      selectedFolder: new Map([[context, folderDialog.promise]]),
    });

    const pendingFile = ipcMain.invokeWithEvent("dialog-open-file", makeEvent(context));
    context.trustedRoots = new TrustedDesktopRoots();
    fileDialog.resolve(selectedFile);
    assert.strictEqual(await pendingFile, null);
    assert.throws(
      () => context.trustedRoots.guardPath(selectedFile, "reveal"),
      /outside trusted desktop roots/,
    );

    const pendingFolder = ipcMain.invokeWithEvent("dialog-select-folder", makeEvent(context));
    context.trustedRoots = new TrustedDesktopRoots();
    folderDialog.resolve(selectedRoot);
    assert.strictEqual(await pendingFolder, null);
    assert.throws(
      () => context.trustedRoots.guardPath(selectedFile, "reveal"),
      /outside trusted desktop roots/,
    );
  });

  it("registers the allowlisted surface and rejects unexpected arguments", async () => {
    const root = makeTempDir();
    const file = join(root, "file.txt");
    writeFileSync(file, "ok");
    const calls = [];
    const context = makeContext({ id: 101, name: "a", token: "desktop-token", port: 4101, root, calls });
    const event = makeEvent(context);
    const ipcMain = registerHarness({
      contexts: [context],
      calls,
      selectedFile: new Map([[context, file]]),
      selectedFolder: new Map([[context, root]]),
    });

    assert.deepStrictEqual([...ipcMain.handles.keys()].sort(), [...DESKTOP_IPC_INVOKE_CHANNELS].sort());
    assert.deepStrictEqual([...ipcMain.listeners.keys()].sort(), [...DESKTOP_IPC_SEND_CHANNELS].sort());
    assert.deepStrictEqual(await ipcMain.invokeWithEvent("window-new", event), { ok: true });
    assert.ok(calls.includes("new-window"));
    assert.strictEqual(await ipcMain.invokeWithEvent("desktop-session-token", event), "desktop-token");
    await ipcMain.invokeWithEvent("workspace-retry", event);
    assert.ok(calls.includes("retry:a"));

    await assert.rejects(() => ipcMain.invokeWithEvent("window-new", event, "unexpected"), /does not accept renderer arguments/);
    await assert.rejects(() => ipcMain.invokeWithEvent("trash-item", event, "relative.txt"), /expects exactly one absolute path argument/);
    await assert.rejects(() => ipcMain.invokeWithEvent("dialog-open-file", event, "unexpected"), /does not accept renderer arguments/);
    await assert.rejects(() => ipcMain.invokeWithEvent("desktop-session-token", event, "unexpected"), /does not accept renderer arguments/);
    await assert.rejects(() => ipcMain.invokeWithEvent("workspace-retry", event, "unexpected"), /does not accept renderer arguments/);
  });

  it("composes real manager contexts without leaking roots, tokens, windows, or terminal ownership", async () => {
    const root = makeTempDir();
    const dataRoot = join(root, "data");
    const appAssets = join(root, "app-assets");
    const projectA = join(root, "project-a");
    const projectB = join(root, "project-b");
    const projectC = join(root, "project-c");
    for (const directory of [appAssets, projectA, projectB, projectC]) {
      mkdirSync(directory, { recursive: true });
    }
    const appAsset = join(appAssets, "icon.ico");
    writeFileSync(appAsset, "asset");
    const calls = [];
    const windows = [];
    let nextWindowId = 1;
    let nextInstanceId = 1;
    let nextToken = 1;
    let nextPort = 4100;
    const manager = new WindowManager({
      dataRoot,
      createWindow: () => {
        const window = new ManagedIpcWindow(nextWindowId, `window-${nextWindowId}`, calls);
        nextWindowId++;
        windows.push(window);
        return window;
      },
      createInstanceId: () => `instance-${nextInstanceId++}`,
      createToken: () => `token-${nextToken++}`,
      createTrustedRoots: () => {
        const roots = new TrustedDesktopRoots();
        roots.addRoot(appAssets);
        return roots;
      },
      createNoneServerBinding,
      resolveDataLayout,
      createOwnedServerBinding: ({ token }) => managedBinding(token, nextPort++),
      showWindowStatus: () => {},
    });
    const contextA = manager.createEmptyWindow();
    const contextB = manager.createEmptyWindow();
    const newOwnerA = manager.createEmptyWindow();
    await manager.openWorkspace(contextA, projectA);
    await manager.openWorkspace(contextB, projectB);
    for (const context of [contextA, contextB]) {
      mkdirSync(context.layout.workspaceRoot, { recursive: true });
      mkdirSync(context.layout.instanceRoot, { recursive: true });
    }
    const fileA = join(projectA, "a.txt");
    const fileB = join(projectB, "b.txt");
    const instanceB = join(contextB.layout.instanceRoot, "port.json");
    writeFileSync(fileA, "a");
    writeFileSync(fileB, "b");
    writeFileSync(instanceB, "b-instance");

    const ipcMain = new IpcMainMock();
    registerDesktopIpcHandlers({
      ipcMain,
      resolveContext: (event) => resolveDesktopIpcContext(event, {
        contextForSender: (senderId) => manager.contextForSender(senderId),
        dashboardUrl: DASHBOARD_URL,
        viteOrigin: VITE_ORIGIN,
      }),
      createEmptyWindow: () => manager.createEmptyWindow(),
      openWorkspaceFolder: async () => null,
      retryWorkspace: async (context) => { await manager.retryWorkspace(context); },
      selectFolder: async () => null,
      selectFile: async () => null,
      showItemInFolder: (context, filePath) => calls.push(`reveal:${context.id}:${filePath}`),
      trashItem: async (context, filePath) => { calls.push(`trash:${context.id}:${filePath}`); },
      spawnTerminal: (context) => { calls.push(`terminal:${context.workspace}`); return true; },
    });
    const eventA = makeEvent(contextA);
    const eventB = makeEvent(contextB);

    assert.equal(await ipcMain.invokeWithEvent("desktop-session-token", eventA), "token-1");
    assert.equal(await ipcMain.invokeWithEvent("desktop-session-token", eventB), "token-2");
    ipcMain.sendWithEvent("window-minimize", eventA);
    ipcMain.sendWithEvent("window-close", eventB);
    assert.ok(calls.includes("window-1:minimize"));
    assert.ok(calls.includes("window-2:close"));
    await assert.rejects(
      () => ipcMain.invokeWithEvent("trash-item", eventA, instanceB),
      /outside trusted desktop roots/,
    );
    await assert.rejects(
      () => ipcMain.invokeWithEvent("show-item-in-folder", eventA, fileB),
      /outside trusted desktop roots/,
    );

    await manager.openWorkspace(contextA, projectC);
    await manager.openWorkspace(newOwnerA, projectA);
    assert.equal(contextA.trustedRoots.guardPath(appAsset, "reveal"), realpathSync.native(appAsset));
    await assert.rejects(
      () => ipcMain.invokeWithEvent("show-item-in-folder", makeEvent(contextA), fileA),
      /outside trusted desktop roots/,
    );
    await ipcMain.invokeWithEvent("show-item-in-folder", makeEvent(newOwnerA), fileA);
    assert.ok(calls.includes(`reveal:${newOwnerA.id}:${realpathSync.native(fileA)}`));

    assert.equal(await ipcMain.invokeWithEvent("spawn-terminal", eventB), true);
    assert.ok(calls.includes(`terminal:${contextB.workspace}`));
  });

  it("composes context lookup, parented dialogs, and workspace action mapping in Electron main", () => {
    const electronMain = readFileSync(new URL("../src/electron/electron-main.ts", import.meta.url), "utf8");
    const desktopIpc = readFileSync(new URL("../src/electron/desktop-ipc.ts", import.meta.url), "utf8");
    const registration = electronMain.slice(
      electronMain.indexOf("registerDesktopIpcHandlers({"),
      electronMain.indexOf("const earlyServerReady"),
    );
    const terminalAdapter = electronMain.slice(
      electronMain.indexOf("function spawnCliTerminal"),
      electronMain.indexOf("function resolveDesktopContext"),
    );

    assert.match(electronMain, /resolveContext:\s*resolveDesktopContext/);
    assert.match(electronMain, /contextForSender:\s*\(senderId\)\s*=>\s*windowManager\.contextForSender\(senderId\)/);
    assert.match(electronMain, /dialog\.showOpenDialog\(context\.window as BrowserWindow,/);
    assert.match(electronMain, /windowManager\.openWorkspace\(context as unknown as WindowContext, selected\)/);
    assert.match(electronMain, /action === "bound" \? "binding" : action === "switched" \? "switching" : action/);
    assert.match(electronMain, /return \{ ok: true, workspace: selected, action: mapWorkspaceOpenAction\(action\) \}/);
    assert.match(registration, /retryWorkspace:\s*async\s*\(context\)\s*=>\s*\{\s*await windowManager\.retryWorkspace\(context as unknown as WindowContext\);\s*\}/);
    assert.doesNotMatch(electronMain, /ipcMain\.handle\(["']workspace-retry["']/);
    assert.match(desktopIpc, /handle\(["']workspace-retry["'][\s\S]*resolveContext\(event\)[\s\S]*assertNoArgs\(["']workspace-retry["']/);
    assert.doesNotMatch(electronMain, /const trustedDesktopRoots = new TrustedDesktopRoots\(\)/);
    assert.doesNotMatch(electronMain, /function addPersistedWorkspaceRoots\(\)/);
    assert.doesNotMatch(electronMain, /trustedRoots:\s*trustedDesktopRoots/);
    assert.doesNotMatch(electronMain, /roots\.addRoot\(DATA_DIR\)/);
    assert.match(desktopIpc, /workspace:\s*string \| null/);
    assert.match(terminalAdapter, /if \(!context\.workspace\) return false/);
    assert.match(terminalAdapter, /buildCliTerminalLaunch/);
    assert.match(terminalAdapter, /workspace:\s*context\.workspace/);
    assert.match(terminalAdapter, /dataRoot:\s*DATA_DIR/);
    assert.doesNotMatch(terminalAdapter, /\bnpx\b/);
    assert.doesNotMatch(terminalAdapter, /(?:^|\s)tsx(?:\s|$)/);
    assert.doesNotMatch(registration, /getMainWindow:\s*\(\)\s*=>/);
    assert.doesNotMatch(registration, /getDesktopSessionToken[:,]/);
    assert.doesNotMatch(registration, /trustedRoots:\s*trustedDesktopRoots/);
  });
});
