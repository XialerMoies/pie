/**
 * App.Tabs 分发测试 — handler 优先级 / kind 分派 / 完整链路
 *
 * 覆盖：
 *   1. activate/close/contextMenu 按 kind 分派到正确 handler
 *   2. handler 不存在时回退到旧函数
 *   3. 草稿 → 真实会话 upgrade → 关闭 → 切换下一个
 */
import { describe, it, before, beforeEach } from "node:test";
import assert from "node:assert";
import { Window } from "happy-dom";

const win = new Window();
global.window = win;
global.document = win.document;
global.self = win;
global.MouseEvent = win.MouseEvent;

const storage = {};
global.localStorage = {
  getItem: (k) => storage[k] ?? null,
  setItem: (k, v) => { storage[k] = v; },
  removeItem: (k) => { delete storage[k]; },
};

describe("App.Tabs dispatch", () => {
  before(async () => {
    win.__state = {
      D: null, M: [], IL: false, CS: null, CT: "chat",
      _activePanel: "explorer",
      _fileTabs: [], _activeFileTab: null,
      _sessionTabs: [], _sessionTabLabels: {},
    };
    win.App = {
      Constants: { WS_KEY: "workspace_path" },
      UI: {}, Chat: { clearAttachments: () => {} },
      File: {}, Session: {}, Settings: {}, Git: {},
    };
    win.__state._uiStateStore = {
      _state: { activeView: { type: "chat" }, tabs: { sessions: [], files: [], labels: {} }, recent: { sessions: {} } },
      saveNow: async () => true,
    };
    global.App = win.App;
    global.$ = win.$ = (id) => win.document.getElementById(id);
    global.E = (v) => String(v ?? "");
    global.S = () => '<svg></svg>';
    global.toast = () => {};
    global.loadSessions = () => {};
    global.ExplorerService = { iconFor: () => '<svg></svg>' };
    win.ExplorerService = global.ExplorerService;
    await import("../src/frontend/services/tab-store.ts");
    await import("../src/frontend/dashboard/dashboard-helpers.ts");
    global.App = win.App;
  });

  beforeEach(() => {
    win.__tabs.reset();
    // 清除 __state.tabs 以防 re-init 读到旧数据
    delete win.__state.tabs;
    win.__state._sessionTabs = [];
    win.__state._fileTabs = [];
    win.__state._activeFileTab = null;
    win.__state._activeSessionTabId = null;
  });

  // ─── Activate dispatch ──────────────────────────────

  it("activate(file) 调用 file handler", () => {
    const ts = win.__tabs;
    ts.openTab({ kind: "file", id: "/a.ts", title: "a.ts", path: "/a.ts" });
    let called = "";
    ts.registerTabBehavior("file", {
      activate(t) { called = "file:" + t.id; },
      close() {},
    });
    win.App.Tabs.activate("/a.ts");
    assert.strictEqual(called, "file:/a.ts");
  });

  it("activate(session) 调用 session handler", () => {
    const ts = win.__tabs;
    ts.openTab({ kind: "session", id: "sess-1", title: "S1", sessionId: "sess-1" });
    let called = "";
    ts.registerTabBehavior("session", {
      activate(t) { called = "session:" + t.id; },
      close() {},
    });
    win.App.Tabs.activate("sess-1");
    assert.strictEqual(called, "session:sess-1");
  });

  it("activate(chat) 调用 chat handler", () => {
    const ts = win.__tabs;
    ts.openTab({ kind: "chat", id: "draft:1", title: "新会话", draftId: "draft:1" });
    let called = "";
    ts.registerTabBehavior("chat", {
      activate(t) { called = "chat:" + t.id; },
      close() {},
    });
    win.App.Tabs.activate("draft:1");
    assert.strictEqual(called, "chat:draft:1");
  });

  it("activate 对不存在的 id 静默不报错", () => {
    let called = "";
    win.__tabs.registerTabBehavior("file", { activate() { called = "x"; }, close() {} });
    win.App.Tabs.activate("nonexistent");
    assert.strictEqual(called, "");
  });

  // ─── Close dispatch ─────────────────────────────────

  it("close(file) 调用 file close handler", () => {
    const ts = win.__tabs;
    ts.openTab({ kind: "file", id: "/b.ts", title: "b.ts", path: "/b.ts" });
    let called = "";
    ts.registerTabBehavior("file", {
      activate() {},
      close(t) { called = "close:" + t.id; },
    });
    win.App.Tabs.close("/b.ts");
    assert.strictEqual(called, "close:/b.ts");
  });

  it("close(session) 调用 session close handler", () => {
    const ts = win.__tabs;
    ts.openTab({ kind: "session", id: "sess-2", title: "S2", sessionId: "sess-2" });
    let called = "";
    ts.registerTabBehavior("session", {
      activate() {},
      close(t) { called = "close:" + t.id; },
    });
    win.App.Tabs.close("sess-2");
    assert.strictEqual(called, "close:sess-2");
  });

  it("close(chat) 调用 chat close handler", () => {
    const ts = win.__tabs;
    ts.openTab({ kind: "chat", id: "draft:2", title: "新会话", draftId: "draft:2" });
    let called = "";
    ts.registerTabBehavior("chat", {
      activate() {},
      close(t) { called = "close:" + t.id; },
    });
    win.App.Tabs.close("draft:2");
    assert.strictEqual(called, "close:draft:2");
  });

  // ─── Context menu dispatch ──────────────────────────

  it("contextMenu(file) 调用 file contextMenu handler", () => {
    const ts = win.__tabs;
    ts.openTab({ kind: "file", id: "/menu.ts", title: "menu.ts", path: "/menu.ts" });
    let called = "";
    ts.registerTabBehavior("file", {
      activate() {},
      close() {},
      contextMenu(_e, t) { called = "menu:" + t.id; },
    });
    win.App.Tabs.contextMenu(new MouseEvent("contextmenu"), "/menu.ts");
    assert.strictEqual(called, "menu:/menu.ts");
  });

  it("contextMenu(session) 不抛错（无 contextMenu handler）", () => {
    const ts = win.__tabs;
    ts.openTab({ kind: "session", id: "sess-m", title: "M", sessionId: "sess-m" });
    ts.registerTabBehavior("session", { activate() {}, close() {} });
    assert.doesNotThrow(() => win.App.Tabs.contextMenu(new MouseEvent("contextmenu"), "sess-m"));
  });

  // ─── 无 handler 时不做降级（安全 no-op） ──────────────

  it("无 handler 时不触发旧函数 fallback（已删除）", () => {
    const ts = win.__tabs;
    ts.openTab({ kind: "file", id: "/noop.ts", title: "f.ts", path: "/noop.ts" });
    // 不注册 handler，不设旧 window 别名，不应报错
    assert.doesNotThrow(() => win.App.Tabs.activate("/noop.ts"));
  });

  // ─── 完整链路：草稿 → 升级 → 关闭 → 下一个 ──────────

  it("完整链路：chat→session upgrade + close + 下一个", () => {
    const ts = win.__tabs;

    // 打开三个 tab：draft, sess-a, sess-b
    ts.openTab({ kind: "chat", id: "draft:lifecycle", title: "草稿", draftId: "draft:lifecycle" });
    ts.openTab({ kind: "session", id: "sess-a", title: "A", sessionId: "sess-a" });
    ts.openTab({ kind: "session", id: "sess-b", title: "B", sessionId: "sess-b" });

    // 升级：chat→session
    ts.replaceTab("draft:lifecycle", { kind: "session", id: "sess-new", sessionId: "sess-new", draftId: undefined });
    ts.activateTab("sess-new");
    assert.strictEqual(ts.getTab("draft:lifecycle"), undefined, "upgrade: old id 已替换");
    assert.strictEqual(ts.getTab("sess-new")?.kind, "session", "upgrade: kind 变为 session");

    // 关闭 sess-new（直接调 TabStore.closeTab 避免 mock handler 不关 tab）
    ts.activateTab("sess-new");
    ts.closeTab("sess-new");

    // 验证顺序：sess-a, sess-b（closeTab 移除了位置 0，sess-a 移到位置 0）
    assert.strictEqual(ts.getState().items.length, 2, "close: 剩下 2 tab");
    assert.strictEqual(ts.getState().items[0].id, "sess-a");
    assert.strictEqual(ts.getState().items[1].id, "sess-b");
  });

  it("真实链路：commitSessionTab 升级 + App.Tabs.close 关闭", async () => {
    // 需要 dashboard-sessions 模块提供 commitSessionTab 和真实 handler
    await import("../src/frontend/dashboard/dashboard-sessions.ts?t=" + Date.now());

    const ts = win.__tabs;
    const beforeLen = ts.getTabs().length;

    // 准备：创建草稿 tab（模拟 newSession 行为）
    const draftId = "draft:e2e-" + Date.now().toString(36);
    ts.openTab({ kind: "chat", id: draftId, title: "新会话", draftId });
    ts.activateTab(draftId);

    // commitSessionTab 升级（chat→session）
    const sessionId = "sess-e2e-" + Date.now().toString(36);
    win.commitSessionTab(draftId, sessionId, "e2e测试");

    // 验证升级结果
    assert.strictEqual(ts.getTab(draftId), undefined, "e2e: draft 已替换");
    const upgraded = ts.getTab(sessionId);
    assert.ok(upgraded, "e2e: session tab 存在");
    assert.strictEqual(upgraded?.kind, "session", "e2e: kind = session");
    assert.strictEqual(ts.getState().activeId, sessionId, "e2e: session 已激活");

    // App.Tabs.close 关闭（走真实 _sessionClose handler）
    win.App.Tabs.close(sessionId);

    // 验证关闭结果
    assert.strictEqual(ts.getTab(sessionId), undefined, "e2e: session tab 已关闭");
    assert.strictEqual(ts.getTabs().length, beforeLen + 0, "e2e: 总 tab 数回退到升级前");
  });

  // ─── handler 优先于 fallback ─────────────────────────

  it("handler 存在时 handler 优先，不走 fallback", () => {
    const ts = win.__tabs;
    ts.openTab({ kind: "file", id: "/prio.ts", title: "prio.ts", path: "/prio.ts" });
    let handlerCalled = false;
    let fallbackCalled = false;
    ts.registerTabBehavior("file", {
      activate() { handlerCalled = true; },
      close() {},
    });
    win.switchTab = () => { fallbackCalled = true; };
    win.App.Tabs.activate("/prio.ts");
    assert.strictEqual(handlerCalled, true, "handler 被调用");
    assert.strictEqual(fallbackCalled, false, "fallback 未被调用");
  });
});
