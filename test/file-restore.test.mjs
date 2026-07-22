/**
 * File tab 跨重启恢复测试
 *
 * 覆盖：
 *   1. activeView=session → 优先激活会话，忽略 stale localStorage last-active-tab
 *   2. activeView=chat → 不激活任何标签，忽略 stale last-active-tab
 *   3. openFileTab 直接调用能触发 App.Tabs.activate
 */
import { describe, it, before, beforeEach } from "node:test";
import assert from "node:assert";
import { Window } from "happy-dom";

const win = new Window();
global.window = win;
global.document = win.document;
global.self = win;
global.MouseEvent = win.MouseEvent;

const store = {};
global.localStorage = {
  getItem: (k) => store[k] ?? null,
  setItem: (k, v) => { store[k] = v; },
  removeItem: (k) => { delete store[k]; },
};

global.$ = (id) => win.document.getElementById(id);
global.E = (v) => String(v ?? "");
global.S = () => '<svg></svg>';
global.toast = () => {};

describe("File tab restore", () => {
  let activateCalls;
  let raw;

  before(async () => {
    win.__state = {
      D: null, M: [], IL: false, CS: null, CT: "chat",
      _activePanel: "explorer",
      _fileTabs: [], _activeFileTab: null,
      _sessionTabs: [], _sessionTabLabels: {},
    };
    win.__tabs = {
      getTab: () => undefined,
      openTab: (t) => { if (t.kind === 'file') { win.__state._fileTabs.push(t); } },
      replaceTab: () => {},
      getActiveFileTabId: () => null,
      activateTab: () => {},
      getTabs: () => [],
    };
    raw = {};
    win.__state._uiStateStore = raw;
    win.__uiStateStore = {
      get _state() { return raw; },
      get _hydrated() { return true; },
      saveNow: async () => true,
    };
    win.App = {
      Constants: { WS_KEY: "workspace_path" },
      UI: {}, Chat: {}, File: {}, Session: {}, Settings: {}, Git: {},
    };
    win.App.Tabs = {
      activate(id) { activateCalls.push(id); },
      close() {},
      contextMenu() {},
    };
    global.App = win.App;
    global.ExplorerService = { iconFor: () => '<svg></svg>', getWorkspacePath: () => "/test" };
    win.ExplorerService = global.ExplorerService;
    globalThis.ExplorerService = global.ExplorerService;
    global.renderTabs = () => {};
    global.fetch = async () => ({ ok: true, json: async () => ({ content: "file content" }) });
    await import("../src/frontend/dashboard/dashboard-layout.ts");
    await import("../src/frontend/dashboard/layout-tabs.ts");
  });

  beforeEach(() => {
    activateCalls = [];
    Object.keys(store).forEach(k => delete store[k]);
    Object.keys(raw).forEach(k => delete raw[k]);
    win.__state._fileTabs = [];
  });

  it("activeView=session 时优先于 stale last-active-tab", () => {
    raw.activeView = { type: "session", id: "sess-restore" };
    store["last-active-tab"] = "/stale/old.ts";

    win.restoreFileTabs();

    assert.ok(activateCalls.includes("sess-restore"), "应激活 session，而非 stale file");
    assert.ok(!activateCalls.includes("/stale/old.ts"), "stale last-active-tab 不应被使用");
  });

  it("activeView=chat 时清除激活，忽略 stale last-active-tab", () => {
    raw.activeView = { type: "chat" };
    store["last-active-tab"] = "/stale/old.ts";

    win.restoreFileTabs();

    assert.strictEqual(activateCalls.length, 0, "不应激活任何标签");
    assert.ok(!activateCalls.includes("/stale/old.ts"), "stale last-active-tab 不应被使用");
  });

  it("openFileTab 触发 App.Tabs.activate", () => {
    assert.ok(typeof win.openFileTab === 'function', "openFileTab 应在 window 上");
    win.openFileTab("/src/main.ts", "console.log('hello');", "ts");
    assert.ok(activateCalls.includes("/src/main.ts"), "openFileTab 应触发 App.Tabs.activate");
  });

  it("openFileTab 带 renderer 参数时传递给 TabStore", () => {
    win.openFileTab("/img/photo.png", "", "png", "image");

    const tabs = win.__state._fileTabs;
    assert.ok(tabs.some(function(t) { return t.id === "/img/photo.png"; }), "tab 应被打开");
    const ft = tabs.find(function(t) { return t.id === "/img/photo.png"; });
    assert.strictEqual(ft && ft.renderer, "image", "renderer 应保留为 image");
  });

});
