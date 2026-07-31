import { afterEach, describe, it } from "node:test";
import assert from "node:assert";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  DESKTOP_IPC_INVOKE_CHANNELS,
  DESKTOP_IPC_SEND_CHANNELS,
  TrustedDesktopRoots,
  registerDesktopIpcHandlers,
} from "../src/electron/desktop-ipc.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
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

  async invoke(channel, ...args) {
    return this.invokeWithEvent(channel, {}, ...args);
  }

  async invokeWithEvent(channel, event, ...args) {
    const handler = this.handles.get(channel);
    assert.ok(handler, `missing invoke handler: ${channel}`);
    return await handler(event, ...args);
  }

  send(channel, ...args) {
    return this.sendWithEvent(channel, {}, ...args);
  }

  sendWithEvent(channel, event, ...args) {
    const handler = this.listeners.get(channel);
    assert.ok(handler, `missing send listener: ${channel}`);
    return handler(event, ...args);
  }
}

describe("desktop IPC governance", () => {
  it("preload exposes openFile through the dialog-open-file channel", () => {
    const preloadSource = readFileSync(new URL("../src/electron/preload.ts", import.meta.url), "utf-8");
    const uncommentedSource = preloadSource
      .split(/\r?\n/)
      .filter((line) => !line.trimStart().startsWith("//"))
      .join("\n");

    assert.match(uncommentedSource, /openFile:\s*\(\)\s*=>\s*ipcRenderer\.invoke\("dialog-open-file"\)/);
    assert.match(uncommentedSource, /getDesktopSessionToken:\s*\(\)\s*=>\s*ipcRenderer\.invoke\("desktop-session-token"\)/);
    assert.strictEqual([...uncommentedSource.matchAll(/\bopenFile\s*:/g)].length, 1);
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

  it("trusts dialog-open-file selections as exact files instead of parent directory roots", async () => {
    const root = makeTempDir();
    const selected = join(root, "selected.txt");
    const sibling = join(root, "sibling.txt");
    writeFileSync(selected, "selected");
    writeFileSync(sibling, "sibling");

    const ipcMain = new IpcMainMock();
    const trustedRoots = new TrustedDesktopRoots();

    registerDesktopIpcHandlers({
      ipcMain,
      getMainWindow: () => null,
      createWindow: () => {},
      showOpenDialog: async () => ({ canceled: false, filePaths: [selected] }),
      showItemInFolder: () => {},
      trashItem: async () => {},
      spawnTerminal: () => true,
      getDesktopSessionToken: () => "desktop-token",
      validateSender: () => {},
      trustedRoots,
    });

    assert.strictEqual(await ipcMain.invoke("dialog-open-file"), selected);
    assert.strictEqual(trustedRoots.guardPath(selected, "reveal"), realpathSync.native(selected));
    assert.throws(() => trustedRoots.guardPath(sibling, "trash"), /outside trusted desktop roots/);
  });

  it("registers an allowlisted IPC surface with argument validation", async () => {
    const root = makeTempDir();
    const file = join(root, "file.txt");
    writeFileSync(file, "ok");

    const ipcMain = new IpcMainMock();
    const calls = [];
    const windowState = { maximized: false };
    const window = {
      minimize: () => calls.push("minimize"),
      isMaximized: () => windowState.maximized,
      maximize: () => { windowState.maximized = true; calls.push("maximize"); },
      unmaximize: () => { windowState.maximized = false; calls.push("unmaximize"); },
      close: () => calls.push("close"),
    };
    const trustedRoots = new TrustedDesktopRoots();

    registerDesktopIpcHandlers({
      ipcMain,
      getMainWindow: () => window,
      createWindow: () => calls.push("new-window"),
      showOpenDialog: async (options) => {
        calls.push(`dialog:${options.properties.join(",")}`);
        return {
          canceled: false,
          filePaths: options.properties.includes("openFile") ? [file] : [root],
        };
      },
      showItemInFolder: (filePath) => calls.push(`reveal:${filePath}`),
      trashItem: async (filePath) => { calls.push(`trash:${filePath}`); },
      spawnTerminal: () => { calls.push("terminal"); return true; },
      getDesktopSessionToken: () => "desktop-token",
      validateSender: () => {},
      trustedRoots,
    });

    assert.deepStrictEqual([...ipcMain.handles.keys()].sort(), [...DESKTOP_IPC_INVOKE_CHANNELS].sort());
    assert.deepStrictEqual([...ipcMain.listeners.keys()].sort(), [...DESKTOP_IPC_SEND_CHANNELS].sort());

    ipcMain.send("window-minimize");
    ipcMain.send("window-maximize");
    ipcMain.send("window-maximize");
    ipcMain.send("window-close");
    ipcMain.send("window-new");
    assert.deepStrictEqual(calls.slice(0, 5), ["minimize", "maximize", "unmaximize", "close", "new-window"]);
    assert.throws(() => ipcMain.send("window-new", "unexpected"), /does not accept renderer arguments/);

    assert.strictEqual(await ipcMain.invoke("dialog-open-file"), file);
    await ipcMain.invoke("show-item-in-folder", file);
    assert.ok(calls.includes(`reveal:${realpathSync.native(file)}`));

    assert.strictEqual(await ipcMain.invoke("open-folder-dialog"), root);
    assert.strictEqual(await ipcMain.invoke("trash-item", file), true);
    assert.ok(calls.includes(`trash:${realpathSync.native(file)}`));
    assert.strictEqual(await ipcMain.invoke("spawn-terminal"), true);
    assert.strictEqual(await ipcMain.invoke("desktop-session-token"), "desktop-token");

    await assert.rejects(() => ipcMain.invoke("trash-item", "relative.txt"), /expects exactly one absolute path argument/);
    await assert.rejects(() => ipcMain.invoke("dialog-open-file", "unexpected"), /does not accept renderer arguments/);
    await assert.rejects(() => ipcMain.invoke("desktop-session-token", "unexpected"), /does not accept renderer arguments/);
  });

  it("rejects untrusted IPC senders before privileged side effects", async () => {
    const root = makeTempDir();
    const file = join(root, "file.txt");
    writeFileSync(file, "ok");

    const trustedEvent = { sender: "trusted" };
    const untrustedEvent = { sender: "untrusted" };
    const calls = [];
    const ipcMain = new IpcMainMock();
    const trustedRoots = new TrustedDesktopRoots();
    trustedRoots.addRoot(root);

    registerDesktopIpcHandlers({
      ipcMain,
      getMainWindow: () => ({
        minimize: () => calls.push("minimize"),
        isMaximized: () => false,
        maximize: () => calls.push("maximize"),
        unmaximize: () => calls.push("unmaximize"),
        close: () => calls.push("close"),
      }),
      createWindow: () => calls.push("new-window"),
      showOpenDialog: async () => {
        calls.push("dialog");
        return { canceled: true, filePaths: [] };
      },
      showItemInFolder: () => calls.push("reveal"),
      trashItem: async () => { calls.push("trash"); },
      spawnTerminal: () => { calls.push("terminal"); return true; },
      getDesktopSessionToken: () => "desktop-token",
      validateSender: (event) => {
        if (event !== trustedEvent) throw new Error("untrusted IPC sender");
      },
      trustedRoots,
    });

    assert.throws(
      () => ipcMain.sendWithEvent("window-close", untrustedEvent),
      /untrusted IPC sender/,
    );
    await assert.rejects(
      () => ipcMain.invokeWithEvent("spawn-terminal", untrustedEvent),
      /untrusted IPC sender/,
    );
    await assert.rejects(
      () => ipcMain.invokeWithEvent("trash-item", untrustedEvent, file),
      /untrusted IPC sender/,
    );
    assert.deepStrictEqual(calls, []);
  });
});
