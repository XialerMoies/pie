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
import { readFileSync } from "node:fs";
import { Window } from "happy-dom";

const win = new Window();
global.window = win;
global.mark = () => {};
global.logTiming = () => {};

global.document = win.document;
global.self = win;
global.MouseEvent = win.MouseEvent;

function cssBlocks(css, selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const matches = [...css.matchAll(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`, "g"))].map((m) => m[1]);
  assert.ok(matches.length > 0, `${selector} rule should exist`);
  return matches.join(";");
}

function assertCssDecl(block, prop, value) {
  const escapedProp = prop.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const escapedValue = value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  assert.match(block, new RegExp(`${escapedProp}\\s*:\\s*${escapedValue}(?:;|$)`), `${prop}: ${value}`);
}

const storage = {};
global.localStorage = {
  getItem: (k) => storage[k] ?? null,
  setItem: (k, v) => { storage[k] = v; },
  removeItem: (k) => { delete storage[k]; },
};

describe("App.Tabs dispatch", { concurrency: false }, () => {
  before(async () => {
    win.__state = {
      D: null, M: [], IL: false, CS: null, CT: "chat",
      _activePanel: "explorer",
      _fileTabs: [], _activeFileTab: null,
      _sessionTabs: [], _sessionTabLabels: {},
    };
    win.App = {
      Constants: { WS_KEY: "workspace_path" },
      State: {
        getWorkspacePath: () => localStorage.getItem("workspace_path") || "",
        setWorkspacePath: (path) => localStorage.setItem("workspace_path", path),
        syncTabs: (items, activeId) => {
          const state = win.__state._uiStateStore._state;
          state.tabs = { ...state.tabs, items: items.map((item) => ({ ...item })), activeId };
        },
      },
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
    await import("../src/frontend/dashboard/dashboard-helpers.ts");
    await import(`../src/frontend/services/chat-runtime-store.ts?app-tabs=${Date.now()}`);
    await import(`../src/frontend/services/chat-stream.ts?app-tabs=${Date.now()}`);
    await import("../src/frontend/services/ui-state-store.ts");
    await import("../src/frontend/services/tab-store.ts");
    global.placeContextMenu = win.placeContextMenu;
    await import("../src/frontend/dashboard/layout-tabs.ts");
    global.App = win.App;
  });

  beforeEach(() => {
    win.__tabs.reset();
    win.document.querySelectorAll(".ctx-menu, #toast-el").forEach((el) => el.remove());
    // 清除 __state.tabs 以防 re-init 读到旧数据
    delete win.__state.tabs;
    win.__state._sessionTabs = [];
    win.__state._fileTabs = [];
    win.__state._activeFileTab = null;
    win.__state._activeSessionTabId = null;
    delete win.sessionTabLabel;
  });

  it("getD bootstraps before dashboard fetch and retries a failed bootstrap", async () => {
    const calls = [];
    const previousFetch = globalThis.fetch;
    const previousWindowFetch = win.fetch;
    const previousUpdateModelName = win.App.Chat.updateModelName;
    const previousElectronApi = win.electronAPI;
    try {
      let bootstrapCalls = 0;
      const mockFetch = async (url, init) => {
        const textUrl = String(url);
        calls.push([textUrl, init || {}]);
        if (textUrl === "/api/bootstrap") {
          bootstrapCalls += 1;
          if (bootstrapCalls === 1) throw new Error("server not ready");
          return { ok: true, json: async () => ({ ok: true }) };
        }
        if (textUrl === "/api/dashboard" && bootstrapCalls === 1) {
          throw new Error("dashboard unavailable before cookie");
        }
        return {
          ok: true,
          json: async () => textUrl.includes("/api/dashboard")
            ? { modelId: "bootstrapped-model" }
            : { ok: true },
        };
      };
      globalThis.fetch = mockFetch;
      global.fetch = mockFetch;
      win.fetch = mockFetch;
      win.electronAPI = { getDesktopSessionToken: async () => "desktop-token" };
      win.App.Chat.updateModelName = () => {};

      await win.getD();
      assert.strictEqual(win.__state.D, null);

      await win.getD();

      assert.strictEqual(calls[0][0], "/api/bootstrap");
      assert.strictEqual(calls[0][1].credentials, "include");
      assert.strictEqual(calls[0][1].headers["X-My-Code-Agent-Token"], "desktop-token");
      assert.strictEqual(calls[1][0], "/api/bootstrap");
      assert.strictEqual(calls[1][1].credentials, "include");
      assert.strictEqual(calls[1][1].headers["X-My-Code-Agent-Token"], "desktop-token");
      assert.strictEqual(calls[2][0], "/api/dashboard");
      assert.strictEqual(calls[2][1].credentials, "include");
      assert.strictEqual(win.__state.D.modelId, "bootstrapped-model");
    } finally {
      globalThis.fetch = previousFetch;
      global.fetch = previousFetch;
      win.fetch = previousWindowFetch;
      win.electronAPI = previousElectronApi;
      win.App.Chat.updateModelName = previousUpdateModelName;
    }
  });

  it("toast 不拦截标签栏点击且淡出后移除 DOM", () => {
    const css = readFileSync(new URL("../src/frontend/dashboard.css", import.meta.url), "utf8");
    const toastCss = cssBlocks(css, ".toast-el");
    assertCssDecl(toastCss, "pointer-events", "none");

    const realSetTimeout = globalThis.setTimeout;
    const realClearTimeout = globalThis.clearTimeout;
    const timers = [];
    globalThis.setTimeout = (callback, delay) => {
      const timer = { callback, delay, cancelled: false, ran: false };
      timers.push(timer);
      return timer;
    };
    globalThis.clearTimeout = (timer) => {
      if (timer) timer.cancelled = true;
    };
    const runTimer = (delay) => {
      const timer = timers.find((item) => item.delay === delay && !item.cancelled && !item.ran);
      assert.ok(timer, `timer ${delay}ms should exist`);
      timer.ran = true;
      timer.callback();
    };

    try {
      win.toast("已开启新会话", "success");
      const toast = win.document.getElementById("toast-el");
      assert.ok(toast, "toast should be created");
      assert.strictEqual(toast.textContent, "已开启新会话");
      assert.ok(toast.classList.contains("success"));
      assert.ok(!toast.classList.contains("out"));

      runTimer(3000);
      assert.ok(toast.classList.contains("out"), "toast should fade out after timeout");
      assert.strictEqual(win.document.getElementById("toast-el"), toast, "toast remains during fade transition");

      runTimer(300);
      assert.strictEqual(win.document.getElementById("toast-el"), null, "toast should be removed after fade transition");
    } finally {
      globalThis.setTimeout = realSetTimeout;
      globalThis.clearTimeout = realClearTimeout;
    }
  });

  it("标签栏保留底部细滚动条", () => {
    const css = readFileSync(new URL("../src/frontend/dashboard.css", import.meta.url), "utf8");
    const tabScrollCss = cssBlocks(css, ".tb-scroll::-webkit-scrollbar");
    assertCssDecl(tabScrollCss, "height", "3px");
    assert.doesNotMatch(css, /\.tb-scroll::-webkit-scrollbar\s*\{[^}]*height\s*:\s*0(?:;|\})/);
  });

  it("token usage rail keeps percent text compact and clipped", () => {
    const css = readFileSync(new URL("../src/frontend/dashboard.css", import.meta.url), "utf8");
    const tokenCode = readFileSync(new URL("../src/frontend/chat/chat-token.ts", import.meta.url), "utf8");

    assert.match(tokenCode, /function\s+formatPercent\(/);
    assert.match(tokenCode, /pctEl\.textContent\s*=\s*formatPercent\(pct\)/);
    assert.match(tokenCode, /crEl\.textContent\s*=\s*formatPercent\(data\.cacheHitRate\)/);
    assert.match(tokenCode, /const\s+pctDisplay\s*=\s*formatPercent\(pct\)/);
    assert.match(tokenCode, /formatPercent\(d\.cacheHitRate\)/);
    assert.doesNotMatch(tokenCode, /pct\s*\+\s*['"]%['"]/);
    assert.doesNotMatch(tokenCode, /cacheHitRate\s*\+\s*['"]%['"]/);

    const railValueCss = cssBlocks(css, ".tr-pct,.tr-cr");
    assertCssDecl(railValueCss, "width", "100%");
    assertCssDecl(railValueCss, "min-width", "0");
    assertCssDecl(railValueCss, "max-width", "100%");
    assertCssDecl(railValueCss, "overflow", "hidden");
    assertCssDecl(railValueCss, "text-overflow", "ellipsis");
    assertCssDecl(railValueCss, "white-space", "nowrap");
  });

  it("更多菜单中的会话标签使用实时标题", () => {
    const ts = win.__tabs;
    ts.openTab({ kind: "session", id: "sess-real-title", title: "新会话", sessionId: "sess-real-title" });
    win.sessionTabLabel = (id) => id === "sess-real-title" ? "真实会话标题" : "新会话";

    win.tabMoreMenu(new MouseEvent("click", { clientX: 12, clientY: 12 }));

    const labels = [...win.document.querySelectorAll(".ctx-tab-label")].map((el) => el.textContent);
    assert.deepStrictEqual(labels, ["真实会话标题"]);
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
