import { describe, it, before } from "node:test";
import assert from "node:assert";
import { Window } from "happy-dom";

const win = new Window();
const doc = win.document;

global.window = win;
global.document = doc;
global.self = win;
global.localStorage = win.localStorage;
global.requestAnimationFrame = (callback) => { callback(0); return 0; };
global.cancelAnimationFrame = () => {};
global.$ = (id) => doc.getElementById(id);
global.E = (value) => String(value ?? "");
global.S = (name, size = 16) => `<svg width="${size}" height="${size}"><use href="#${name}"/></svg>`;
global.mark = () => {};
global.toast = () => {};
global.initResizeHandle = () => {};
global.bind = () => {};
global.setupTabDrag = () => {};
win.S = global.S;
win.requestAnimationFrame = global.requestAnimationFrame;

const calls = [];
global.renderPanel = (name) => calls.push(["panel", name]);
global.togglePanel = (name) => calls.push(["togglePanel", name]);
global.winCtrl = (action) => calls.push(["winCtrl", action]);
global.loadSessions = () => {};

win.__state = {
  D: null,
  M: [],
  IL: false,
  CS: null,
  CT: "chat",
  _activePanel: "explorer",
  _fileTabs: [],
  _activeFileTab: null,
};
win.__tabs = {
  getSessionTabIds: () => [],
  getState: () => ({ items: [], activeId: null }),
};
win.msgs = () => "";
win.ExplorerService = global.ExplorerService = {
  iconFor: () => "",
  getWorkspacePath: () => "E:/my-code-agent",
};
win.electronAPI = {
  newWindow: () => calls.push(["newWindow"]),
  openFile: async () => { calls.push(["openFile"]); return "E:/picked.ts"; },
  openFolder: async () => null,
  close: () => calls.push(["closeWindow"]),
  spawnTerminal: () => calls.push(["spawnTerminal"]),
};

win.App = {
  Constants: { WS_KEY: "workspace_path" },
  State: {
    getSnapshot: () => ({
      tabs: { chatOpen: true, items: [] },
      panel: { active: "explorer", width: 280 },
      activeView: null,
    }),
    getWorkspacePath: () => "E:/my-code-agent",
    setChatOpen: () => {},
    resetWorkspace: () => {},
  },
  UI: {},
  Chat: {},
  File: {},
  Session: { restoreSessionTabs: () => {} },
  Settings: { openSettingsModal: () => calls.push(["settings"]) },
  Tabs: {
    getState: () => {
      const st = win.__state || {};
      const items = [];
      for (const file of st._fileTabs || []) items.push({ id: file.id, kind: 'file', title: file.label, order: items.length, path: file.id });
      for (const id of st._sessionTabs || []) {
        const isDraft = id.startsWith('draft:');
        items.push({ id, kind: isDraft ? 'chat' : 'session', title: id, order: items.length, ...(isDraft ? { draftId: id } : { sessionId: id }) });
      }
      return { items, activeId: st._activeFileTab ?? st._activeSessionTabId ?? null };
    },
    getTabs: () => [],
    getActiveTab: () => null,
    getTab: () => undefined,
    getFileTabIds: () => [],
    getActiveFileTabId: () => null,
    clearActiveTab: () => {},
    activate: () => {},
    close: () => {},
    contextMenu: () => {},
  },
  Git: {},
};
global.App = win.App;

before(async () => {
  doc.body.innerHTML = '<div id="app"></div>';
  const stamp = Date.now();
  await import(`../src/frontend/services/chat-stream.ts?t=${stamp}`);
  await import(`../src/frontend/services/preferences.ts?t=${stamp}`);
  await import(`../src/frontend/dashboard/dashboard-menus.ts?t=${stamp}`);
  await import(`../src/frontend/dashboard/dashboard-layout.ts?t=${stamp}`);
});

describe("dashboard action delegation", () => {
  it("routes layout and file-menu commands without inline handlers", async () => {
    calls.length = 0;
    win.layout();
    const app = doc.getElementById("app");
    assert.ok(app);
    assert.strictEqual(app.querySelectorAll("[onclick], [onchange], [oninput]").length, 0);

    app.querySelector("[data-layout-action='panel'][data-side='search']")?.click();
    app.querySelector("[data-layout-action='window'][data-window-action='minimize']")?.click();
    app.querySelector("[data-layout-action='launch-cli']")?.click();
    app.querySelector("[data-layout-action='settings']")?.click();
    app.querySelector("[data-layout-action='file-menu']")?.click();

    const menu = doc.getElementById("file-menu");
    assert.ok(menu, "file menu should open through delegated layout action");
    assert.strictEqual(menu.querySelectorAll("[onclick], [onchange], [oninput]").length, 0);
    menu.querySelector("[data-file-action='openFile']")?.click();
    await new Promise(resolve => queueMicrotask(resolve));

    assert.ok(calls.some(call => call[0] === "togglePanel" && call[1] === "search"));
    assert.ok(calls.some(call => call[0] === "winCtrl" && call[1] === "minimize"));
    assert.ok(calls.some(call => call[0] === "spawnTerminal"));
    assert.ok(calls.some(call => call[0] === "settings"));
    assert.ok(calls.some(call => call[0] === "openFile"));
    assert.strictEqual(doc.getElementById("file-menu"), null, "file menu should close after a command");
  });
});
