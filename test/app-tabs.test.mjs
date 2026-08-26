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

async function loadDashboardSessions() {
  const nonce = Date.now() + Math.random();
  await import(`../src/frontend/dashboard/session-restore.ts?t=${nonce}`);
  await import(`../src/frontend/dashboard/session-activation.ts?t=${nonce}`);
  await import(`../src/frontend/dashboard/session-list-panel.ts?t=${nonce}`);
  await import(`../src/frontend/dashboard/dashboard-sessions.ts?t=${nonce}`);
}

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

let legacyState;

describe("App.Tabs dispatch", { concurrency: false }, () => {
  before(async () => {
    legacyState = {
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
          const state = legacyState._uiStateStore._state;
          state.tabs = { ...state.tabs, items: items.map((item) => ({ ...item })), activeId };
        },
      },
      UI: {}, Chat: { clearAttachments: () => {} },
      File: {}, Session: {
        getTabLabel: (id) => legacyState._sessionTabLabels[id] || "新会话",
      }, Settings: {}, Git: {},
    };
    legacyState._uiStateStore = {
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
    await import("../src/frontend/dashboard/dashboard-layout.ts");
    global.App = win.App;
  });

  beforeEach(() => {
    win.App.Tabs.reset();
    win.document.querySelectorAll(".ctx-menu, #toast-el").forEach((el) => el.remove());
    // 清除 __state.tabs 以防 re-init 读到旧数据
    delete legacyState.tabs;
    legacyState._sessionTabs = [];
    legacyState._fileTabs = [];
    legacyState._activeFileTab = null;
    legacyState._activeSessionTabId = null;
    win.App.Session.getTabLabel = (id) => legacyState._sessionTabLabels[id] || "新会话";
  });

  it("getD waits for a transient bootstrap failure before fetching dashboard", async () => {
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

      assert.strictEqual(calls[0][0], "/api/bootstrap");
      assert.strictEqual(calls[0][1].credentials, "include");
      assert.strictEqual(calls[0][1].headers["X-My-Code-Agent-Token"], "desktop-token");
      assert.strictEqual(calls[1][0], "/api/bootstrap");
      assert.strictEqual(calls[1][1].credentials, "include");
      assert.strictEqual(calls[1][1].headers["X-My-Code-Agent-Token"], "desktop-token");
      assert.strictEqual(calls[2][0], "/api/dashboard");
      assert.strictEqual(calls[2][1].credentials, "include");
      assert.strictEqual(win.App.ChatState.getDashboard().modelId, "bootstrapped-model");

      await win.getD();
      assert.strictEqual(calls[3][0], "/api/dashboard");
      assert.strictEqual(calls.length, 4, "successful bootstrap should remain cached");
    } finally {
      globalThis.fetch = previousFetch;
      global.fetch = previousFetch;
      win.fetch = previousWindowFetch;
      win.electronAPI = previousElectronApi;
      win.App.Chat.updateModelName = previousUpdateModelName;
    }
  });

  it("状态栏通知不拦截标签栏点击且会自动清除", () => {
    const css = readFileSync(new URL("../src/frontend/dashboard.css", import.meta.url), "utf8");
    const statusNoticeCss = cssBlocks(css, ".status-notice");
    assertCssDecl(statusNoticeCss, "overflow", "hidden");
    assertCssDecl(statusNoticeCss, "padding", "0 16px 0 9px");

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
      win.document.body.innerHTML = '<span id="status-notice" class="status-notice" data-active="false"></span>';
      win.App.StatusBar = {
        setNotice(message, type, durationMs = 3200) {
          const notice = win.document.getElementById("status-notice");
          notice.textContent = message;
          notice.dataset.kind = type;
          notice.dataset.active = "true";
          setTimeout(() => {
            notice.textContent = "";
            notice.dataset.active = "false";
          }, durationMs);
        },
      };
      win.toast("已开启新会话", "success");
      const notice = win.document.getElementById("status-notice");
      assert.ok(notice, "status notice should exist");
      assert.strictEqual(notice.textContent, "已开启新会话");
      assert.strictEqual(notice.dataset.kind, "success");
      assert.strictEqual(notice.dataset.active, "true");

      runTimer(3200);
      assert.strictEqual(notice.textContent, "");
      assert.strictEqual(notice.dataset.active, "false");
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

  it("无界前端移除非必要的竖向外框并保留标签分隔线", () => {
    const css = readFileSync(new URL("../src/frontend/dashboard.css", import.meta.url), "utf8");
    assert.match(css, /\.sbar\{[^}]*border-right:0/);
    assert.match(css, /\.status-problems\{[^}]*border-right:0/);
    assert.match(css, /\.tb-more\{[^}]*border-left:0/);
    assert.match(css, /\.main\{[^}]*border:1px solid var\(--bd\)/);
    assert.doesNotMatch(css, /\.main\{[^}]*border-left:1px solid var\(--bd\)/);
    assert.match(css, /\.tb-item\{[^}]*border-right:1px solid var\(--bd\)/);
  });

  it("功能面板标题下不显示横向分隔线", () => {
    const css = readFileSync(new URL("../src/frontend/dashboard.css", import.meta.url), "utf8");
    assert.match(css, /\.panel-content \.sg-t\{[^}]*border-bottom:0/);
    assert.match(css, /\.mcp-tabs\{[^}]*border-bottom:0/);
  });

  it("顶部栏和底部栏只在编辑器主区保留横向分隔线", () => {
    const css = readFileSync(new URL("../src/frontend/dashboard.css", import.meta.url), "utf8");
    assert.match(css, /\.topbar\{[^}]*border-bottom:0/);
    assert.match(css, /\.statusbar\{[^}]*border-top:0/);
    assert.match(css, /\.main\{[^}]*border:1px solid var\(--bd\)/);
  });

  it("功能栏与主区相连的分隔线端点使用圆角", () => {
    const css = readFileSync(new URL("../src/frontend/dashboard.css", import.meta.url), "utf8");
    assert.match(css, /\.main\{[^}]*border-radius:4px 0 0 4px/);
  });

  it("token usage rail keeps percent text compact and clipped", () => {
    const css = readFileSync(new URL("../src/frontend/dashboard.css", import.meta.url), "utf8");
    const tokenCode = readFileSync(new URL("../src/frontend/chat/chat-token.ts", import.meta.url), "utf8");
    const layoutCode = readFileSync(new URL("../src/frontend/dashboard/dashboard-layout.ts", import.meta.url), "utf8");

    assert.match(tokenCode, /function\s+formatPercent\(/);
    assert.match(tokenCode, /function\s+contextUsageSourceLabel\(/);
    assert.match(tokenCode, /source\s*===\s*'exact'[\s\S]*?'精确'/);
    assert.match(tokenCode, /source\s*===\s*'mixed'[\s\S]*?'含估算'/);
    assert.match(tokenCode, /source\s*===\s*'estimated'[\s\S]*?'估算'/);
    assert.match(tokenCode, /累计计费用量/);
    assert.match(layoutCode, /id="tr-source"/);
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
    const sourceCss = cssBlocks(css, ".tr-source");
    assertCssDecl(sourceCss, "white-space", "nowrap");
  });

  it("token usage rail keeps a fixed height when the composer grows", () => {
    const css = readFileSync(new URL("../src/frontend/dashboard.css", import.meta.url), "utf8");
    const tokenCode = readFileSync(new URL("../src/frontend/chat/chat-token.ts", import.meta.url), "utf8");
    const railCss = cssBlocks(css, ".tr-rail");

    assertCssDecl(railCss, "height", "78px");
    assertCssDecl(railCss, "min-height", "78px");
    assert.match(tokenCode, /rail\.style\.height\s*=\s*''/);
    assert.doesNotMatch(tokenCode, /rail\.style\.height\s*=\s*fiBox\.offsetHeight/);
  });

  it("token usage rail follows the composer bottom edge", () => {
    const tokenCode = readFileSync(new URL("../src/frontend/chat/chat-token.ts", import.meta.url), "utf8");

    assert.match(tokenCode, /const\s+railTop\s*=\s*top\s*\+\s*fiBox\.offsetHeight\s*-\s*rail\.offsetHeight/);
    assert.match(tokenCode, /rail\.style\.top\s*=\s*railTop\s*\+\s*'px'/);
    assert.doesNotMatch(tokenCode, /rail\.style\.top\s*=\s*top\s*\+\s*'px'/);
  });

  it("usage tabs keep persistent views inside a stable panel", () => {
    const css = readFileSync(new URL("../src/frontend/dashboard.css", import.meta.url), "utf8");
    const tokenCode = readFileSync(new URL("../src/frontend/chat/chat-token.ts", import.meta.url), "utf8");
    const panelCss = cssBlocks(css, ".usage-panel");
    const bodyCss = cssBlocks(css, ".usage-body");

    assertCssDecl(panelCss, "height", "min(620px,80vh)");
    assertCssDecl(panelCss, "overflow", "hidden");
    assertCssDecl(bodyCss, "overflow-y", "auto");
    assert.match(tokenCode, /usage-view-current/);
    assert.match(tokenCode, /usage-view-summary/);
    assert.match(tokenCode, /currentView\.hidden\s*=\s*_usageTab\s*!==\s*'current'/);
    assert.match(tokenCode, /summaryView\.hidden\s*=\s*_usageTab\s*!==\s*'summary'/);
    assert.doesNotMatch(tokenCode, /const body = document\.getElementById\('usage-body'\)[\s\S]*?body\.innerHTML\s*=/);
  });

  it("更多菜单中的会话标签使用实时标题", () => {
    const ts = win.App.Tabs;
    ts.openTab({ kind: "session", id: "sess-real-title", title: "新会话", sessionId: "sess-real-title" });
    win.App.Session.getTabLabel = (id) => id === "sess-real-title" ? "真实会话标题" : "新会话";

    win.tabMoreMenu(new MouseEvent("click", { clientX: 12, clientY: 12 }));

    const labels = [...win.document.querySelectorAll(".ctx-tab-label")].map((el) => el.textContent);
    assert.deepStrictEqual(labels, ["真实会话标题"]);
  });

  it("更多标签菜单限制宽度并保留关闭按钮", () => {
    const css = readFileSync(new URL("../src/frontend/dashboard.css", import.meta.url), "utf8");
    assert.match(css, /\.ctx-tabs-menu\{[^}]*width:min\(360px,calc\(100vw - 16px\)\)/);
    assert.match(css, /\.ctx-tabs-menu \.ctx-tab-close\{opacity:1\}/);

    const ts = win.App.Tabs;
    ts.openTab({ kind: "session", id: "sess-long-title", title: "新会话", sessionId: "sess-long-title" });
    win.App.Session.getTabLabel = () => "运行 git log --oneline -5 查看最近的提交然后继续执行状态检查并生成总结";
    win.tabMoreMenu(new MouseEvent("click", { clientX: 999, clientY: 12 }));

    const menu = win.document.querySelector(".ctx-tabs-menu");
    assert.ok(menu, "使用专用的标签更多菜单容器");
    assert.ok(menu.querySelector(".ctx-tab-label"), "长标题仍保留在菜单中");
    assert.ok(menu.querySelector(".ctx-tab-close"), "关闭按钮仍位于菜单内部");
  });

  // ─── Activate dispatch ──────────────────────────────

  it("activate(file) 调用 file handler", () => {
    const ts = win.App.Tabs;
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
    const ts = win.App.Tabs;
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
    const ts = win.App.Tabs;
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
    win.App.Tabs.registerTabBehavior("file", { activate() { called = "x"; }, close() {} });
    win.App.Tabs.activate("nonexistent");
    assert.strictEqual(called, "");
  });

  // ─── Close dispatch ─────────────────────────────────

  it("close(file) 调用 file close handler", () => {
    const ts = win.App.Tabs;
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
    const ts = win.App.Tabs;
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
    const ts = win.App.Tabs;
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
    const ts = win.App.Tabs;
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
    const ts = win.App.Tabs;
    ts.openTab({ kind: "session", id: "sess-m", title: "M", sessionId: "sess-m" });
    ts.registerTabBehavior("session", { activate() {}, close() {} });
    assert.doesNotThrow(() => win.App.Tabs.contextMenu(new MouseEvent("contextmenu"), "sess-m"));
  });

  // ─── reset 不清除行为注册（workspace 切换回归） ──────────

  it("reset 后 file 行为仍保留——标签仍可 activate/close", () => {
    const ts = win.App.Tabs;
    const calls = [];
    ts.registerTabBehavior("file", {
      activate(t) { calls.push("a:" + t.id); },
      close(t) { calls.push("c:" + t.id); },
    });
    // 模拟 workspace 切换：reset 清空标签状态
    ts.reset();
    ts.openTab({ kind: "file", id: "/post-reset.ts", title: "post.ts", path: "/post-reset.ts" });
    win.App.Tabs.activate("/post-reset.ts");
    win.App.Tabs.close("/post-reset.ts");
    assert.deepStrictEqual(calls, ["a:/post-reset.ts", "c:/post-reset.ts"],
      "reset 不能清空行为注册，否则 workspace 切换后标签无法切换/关闭");
  });

  // ─── 关闭最后一个会话标签 → 自动激活下一个文件标签 ────────

  it("关闭最后一个会话标签时，自动激活下一个文件标签（加载其内容）", async () => {
    await loadDashboardSessions();
    const ts = win.App.Tabs;
    const activated = [];
    ts.registerTabBehavior("file", {
      activate(t) { activated.push(t.id); },
      close() {},
    });
    // 文件标签 + 会话标签（commitSessionTab 把 draft 升级为 session，并注册 session id）
    ts.openTab({ kind: "file", id: "/only-file.ts", title: "only-file.ts", path: "/only-file.ts" });
    const draftId = "draft:last-sess-" + Date.now().toString(36);
    ts.openTab({ kind: "chat", id: draftId, title: "新会话", draftId });
    ts.activateTab(draftId);
    win.App.Session.commitSessionTab(draftId, "sess-last", "最后一个会话");

    win.App.Tabs.close("sess-last");

    assert.deepStrictEqual(activated, ["/only-file.ts"],
      "关闭最后一个会话标签后应激活下一个文件标签（closeTab 只改 activeId 不加载内容）");
  });

  it("删除最后一个会话（列表操作）→ 自动激活下一个文件标签", async () => {
    await loadDashboardSessions();
    const ts = win.App.Tabs;
    const activated = [];
    ts.registerTabBehavior("file", {
      activate(t) { activated.push(t.id); },
      close() {},
    });
    ts.openTab({ kind: "file", id: "/del-file.ts", title: "del-file.ts", path: "/del-file.ts" });
    const draftId = "draft:del-" + Date.now().toString(36);
    ts.openTab({ kind: "chat", id: draftId, title: "新会话", draftId });
    ts.activateTab(draftId);
    win.App.Session.commitSessionTab(draftId, "sess-del", "待删除");

    const prevConfirm = global.confirmAsync;
    const prevFetch = global.fetch;
    global.confirmAsync = async () => true;
    global.fetch = async () => ({ ok: true, json: async () => ({ ok: true }) });
    try {
      await win.App.Session.deleteSession("sess-del");
    } finally {
      global.confirmAsync = prevConfirm;
      global.fetch = prevFetch;
    }
    // deleteSession 的 fetch.then 是 fire-and-forget，等它跑完
    await new Promise((r) => setTimeout(r, 20));

    assert.deepStrictEqual(activated, ["/del-file.ts"],
      "删除最后一个会话后应激活下一个文件标签（列表删除路径）");
  });

  it("会话↔会话切换：激活 B 后 activeId 与消息都切到 B", async () => {
    await loadDashboardSessions();
    const ts = win.App.Tabs;
    const mk = (draft, sess) => {
      ts.openTab({ kind: "chat", id: draft, title: "新会话", draftId: draft });
      ts.activateTab(draft);
      win.App.Session.commitSessionTab(draft, sess, sess);
    };
    mk("draft:a-" + Date.now().toString(36), "sess-a");
    mk("draft:b-" + Date.now().toString(36), "sess-b");

    const prevFetch = global.fetch;
    global.fetch = async (url, init) => {
      const body = JSON.parse(String(init?.body || "{}"));
      const id = body.id;
      return {
        ok: true,
        json: async () => ({ ok: true, activeSessionId: id, messages: [{ role: "user", content: "msg-" + id }] }),
      };
    };
    try {
      win.App.Tabs.activate("sess-b");
      await new Promise((r) => setTimeout(r, 20));
    } finally {
      global.fetch = prevFetch;
    }

    assert.strictEqual(ts.getState().activeId, "sess-b",
      `激活会话 B 后 activeId 应为 sess-b（实际 ${ts.getState().activeId}）`);
    const msgs = win.App.ChatState.getMessages().map((m) => m.content);
    assert.ok(msgs.includes("msg-sess-b"), `消息应切到 B（实际 ${JSON.stringify(msgs)}）`);
  });

  it("关闭会话 B 时 B 的旧激活请求晚到应丢弃，不能重开 B 或覆盖 A 内容", async () => {
    await loadDashboardSessions();
    const ts = win.App.Tabs;
    const mk = (draft, sess) => {
      ts.openTab({ kind: "chat", id: draft, title: "新会话", draftId: draft });
      ts.activateTab(draft);
      win.App.Session.commitSessionTab(draft, sess, sess);
    };
    mk("draft:a-" + Date.now().toString(36), "sess-a");
    mk("draft:b-" + Date.now().toString(36), "sess-b");

    // 可控 fetch：按请求 id 挂起，逐个放行
    const pendings = new Map();
    const prevFetch = global.fetch;
    global.fetch = async (url, init) => {
      const body = JSON.parse(String(init?.body || "{}"));
      return new Promise((resolve) => pendings.set(body.id, resolve));
    };
    const resolveOne = (id) => {
      pendings.get(id)({
        ok: true,
        json: async () => ({ ok: true, activeSessionId: id, messages: [{ role: "user", content: "msg-" + id }] }),
      });
      pendings.delete(id);
    };
    try {
      // 点 B → B 请求挂起；立即关 B → A 激活 + A 请求挂起
      win.App.Tabs.activate("sess-b");
      win.App.Tabs.close("sess-b");
      // A 响应先到 → A 生效
      resolveOne("sess-a");
      await new Promise((r) => setTimeout(r, 10));
      assert.strictEqual(ts.getState().activeId, "sess-a", "A 应生效");
      assert.ok(!ts.getTab("sess-b"), "B 标签应已关闭");
      // B 旧响应晚到 → 必须丢弃：不得重开 B / 不得覆盖 A 内容 / 不得改 activeId
      resolveOne("sess-b");
      await new Promise((r) => setTimeout(r, 10));
      assert.ok(!ts.getTab("sess-b"), "B 旧响应不得重新打开 B 标签");
      assert.strictEqual(ts.getState().activeId, "sess-a", "activeId 应保持 A");
      const msgs = win.App.ChatState.getMessages().map((m) => m.content);
      assert.deepStrictEqual(msgs, ["msg-sess-a"], "内容应保持 A（B 旧响应被丢弃）");
    } finally {
      global.fetch = prevFetch;
    }
  });

  it("关闭会话的 next-active 规则：右邻优先 / 无右邻选左 / 无左邻选右", async () => {
    await loadDashboardSessions();
    const ts = win.App.Tabs;
    const mk = (draft, sess) => {
      ts.openTab({ kind: "chat", id: draft, title: "新会话", draftId: draft });
      ts.activateTab(draft);
      win.App.Session.commitSessionTab(draft, sess, sess);
    };

    const prevFetch = global.fetch;
    global.fetch = async (url, init) => {
      const body = JSON.parse(String(init?.body || "{}"));
      return { ok: true, json: async () => ({ ok: true, activeSessionId: body.id, messages: [{ role: "user", content: "msg-" + body.id }] }) };
    };

    const closeAndGetActive = async (closeId) => {
      win.App.Tabs.close(closeId);
      await new Promise((r) => setTimeout(r, 20));
      return ts.getState().activeId;
    };

    try {
      // 场景1：左侧有、右侧有 → 关闭中间的 → 选右侧
      ts.reset();
      mk("draft:r1-" + Date.now().toString(36), "sa"); mk("draft:r2-" + Date.now().toString(36), "sb"); mk("draft:r3-" + Date.now().toString(36), "sc");
      ts.activateTab("sb");
      assert.strictEqual(await closeAndGetActive("sb"), "sc", "[A,B,C] 关 B → 右邻 C");

      // 场景2：左侧有、右侧无 → 关闭最右 → 选左侧
      ts.reset();
      mk("draft:r4-" + Date.now().toString(36), "sa2"); mk("draft:r5-" + Date.now().toString(36), "sb2");
      ts.activateTab("sb2");
      assert.strictEqual(await closeAndGetActive("sb2"), "sa2", "[A,B] 关 B（最右）→ 左邻 A");

      // 场景3：左侧无、右侧有 → 关闭最左 → 选右侧
      ts.reset();
      mk("draft:r6-" + Date.now().toString(36), "sa3"); mk("draft:r7-" + Date.now().toString(36), "sb3");
      ts.activateTab("sa3");
      assert.strictEqual(await closeAndGetActive("sa3"), "sb3", "[A,B] 关 A（最左）→ 右邻 B");

      // 场景5：关闭后唯一剩下的标签是文件 → 加载文件内容（非会话也不丢）
      ts.reset();
      ts.openTab({ kind: "file", id: "/only.ts", title: "only.ts", path: "/only.ts", content: "only" });
      ts.openTab({ kind: "session", id: "sa5", title: "A", sessionId: "sa5" });
      ts.activateTab("sa5");
      assert.strictEqual(await closeAndGetActive("sa5"), "/only.ts",
        "[文件, sess-a] 关 sess-a → 唯一剩余文件 /only.ts");

      // 场景4（混合）：[sess-a, sess-b, /f1.ts] 关 sess-b → 右邻是文件 /f1.ts，应选它
      ts.reset();
      ts.openTab({ kind: "session", id: "sa4", title: "A", sessionId: "sa4" });
      ts.openTab({ kind: "session", id: "sb4", title: "B", sessionId: "sb4" });
      ts.openTab({ kind: "file", id: "/f1.ts", title: "f1.ts", path: "/f1.ts", content: "f1" });
      ts.activateTab("sb4");
      assert.strictEqual(await closeAndGetActive("sb4"), "/f1.ts",
        "[sess-a, sess-b, /f1.ts] 关 sess-b → 右邻文件 /f1.ts（不是左侧会话）");
    } finally {
      global.fetch = prevFetch;
    }
  });

  it("列表路径(switchSession 兜底)快速点 A→B：B 生效，A 旧响应被丢弃", async () => {
    await loadDashboardSessions();
    const ts = win.App.Tabs;
    const pendings = new Map();
    const prevFetch = global.fetch;
    global.fetch = async (url, init) => {
      const body = JSON.parse(String(init?.body || "{}"));
      return new Promise((resolve) => pendings.set(body.id, resolve));
    };
    const resolveOne = (id) => {
      pendings.get(id)({ ok: true, json: async () => ({ ok: true, activeSessionId: id, messages: [{ role: "user", content: "msg-" + id }] }) });
      pendings.delete(id);
    };
    try {
    win.App.SessionActivation.switchSession("sess-a");
    win.App.SessionActivation.switchSession("sess-b");
      resolveOne("sess-a"); // A 旧响应先到 → 应被 B 取代而丢弃
      await new Promise((r) => setTimeout(r, 10));
      assert.ok(!win.App.ChatState.getMessages().some((m) => m.content === "msg-sess-a"),
        "A 旧响应被丢弃（B 已取代）");
      resolveOne("sess-b");
      await new Promise((r) => setTimeout(r, 10));
      assert.strictEqual(ts.getState().activeId, "sess-b", "B（最新）生效");
      assert.ok(ts.getTab("sess-b"), "B 标签创建");
      assert.ok(win.App.ChatState.getMessages().some((m) => m.content === "msg-sess-b"), "B 内容加载");
    } finally {
      global.fetch = prevFetch;
    }
  });

  it("用户已交互时启动恢复不覆盖当前激活标签（hydrate/文件 fetch 晚到竞态）", async () => {
    await loadDashboardSessions();
    const ts = win.App.Tabs;
    ts.openTab({ kind: "session", id: "sess-a", title: "A", sessionId: "sess-a" });
    ts.openTab({ kind: "session", id: "sess-b", title: "B", sessionId: "sess-b" });
    ts.activateTab("sess-b");
    assert.strictEqual(win.App.SessionRestore.hasUserInteracted(), false, "初始未交互");

    const prevFetch = global.fetch;
    // mock 回显请求的 id（用于检测恢复是否会重新激活 sess-a）
    global.fetch = async (url, init) => {
      const body = JSON.parse(String(init?.body || "{}"));
      return { ok: true, json: async () => ({ ok: true, activeSessionId: body.id, messages: [] }) };
    };
    try {
      win.App.Tabs.activate("sess-b"); // 用户点 B → 标记交互
      await new Promise((r) => setTimeout(r, 10));
      assert.strictEqual(win.App.SessionRestore.hasUserInteracted(), true, "激活后已交互");
    } finally {
      global.fetch = prevFetch;
    }

    // 模拟启动恢复晚到：持久化 activeView 是"另一个"会话 sess-a，
    // restoreFileTabs → restoreActiveTab 若无视交互会把 activeId 快照回 sess-a
    const realGetSnapshot = win.App.State.getSnapshot;
    win.App.State.getSnapshot = () => ({ ...realGetSnapshot(), activeView: { type: "session", id: "sess-a" } });
    try {
      win.restoreFileTabs();
      await new Promise((r) => setTimeout(r, 10)); // 等恢复触发的 fetch 落地
      assert.strictEqual(ts.getState().activeId, "sess-b",
        "用户已交互时恢复不得把 activeId 覆盖回持久化的会话 sess-a");
    } finally {
      win.App.State.getSnapshot = realGetSnapshot;
    }
  });

  // ─── 无 handler 时不做降级（安全 no-op） ──────────────

  it("无 handler 时不触发旧函数 fallback（已删除）", () => {
    const ts = win.App.Tabs;
    ts.openTab({ kind: "file", id: "/noop.ts", title: "f.ts", path: "/noop.ts" });
    // 不注册 handler，不设旧 window 别名，不应报错
    assert.doesNotThrow(() => win.App.Tabs.activate("/noop.ts"));
  });

  // ─── 完整链路：草稿 → 升级 → 关闭 → 下一个 ──────────

  it("完整链路：chat→session upgrade + close + 下一个", () => {
    const ts = win.App.Tabs;

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
    await loadDashboardSessions();

    const ts = win.App.Tabs;
    const beforeLen = ts.getTabs().length;

    // 准备：创建草稿 tab（模拟 newSession 行为）
    const draftId = "draft:e2e-" + Date.now().toString(36);
    ts.openTab({ kind: "chat", id: draftId, title: "新会话", draftId });
    ts.activateTab(draftId);

    // commitSessionTab 升级（chat→session）
    const sessionId = "sess-e2e-" + Date.now().toString(36);
    win.App.Session.commitSessionTab(draftId, sessionId, "e2e测试");

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
    const ts = win.App.Tabs;
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
