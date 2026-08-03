/**
 * 文件标签渲染回归 — 标签栏渲染不依赖 Monaco 加载
 *
 * 背景 bug1：点击资源管理器文件后，标签栏与文件代码区一直空白，
 * 直到打开会话标签才“顺带”渲染出来。根因是 _fileActivate 把
 * renderTabs() 放在 await loadMonaco() 之后 —— Monaco 慢加载或失败时，
 * 标签栏永远不会更新。修复：_fileActivate 先渲染标签栏，再等 Monaco。
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
global.loadSessions = () => {};
global.ExplorerService = { iconFor: () => '<svg></svg>', getWorkspacePath: () => "/test" };
win.ExplorerService = global.ExplorerService;
// layout-tabs 以裸 `renderTabs` 引用（bundle 中共享作用域可用；模块加载下转发到 window.renderTabs）
global.renderTabs = () => win.renderTabs?.();

describe("file tab render before Monaco", { concurrency: false }, () => {
  before(async () => {
    win.__state = { D: null, M: [], IL: false, CS: null, CT: "chat", _activePanel: "explorer", _fileTabs: [], _activeFileTab: null, _sessionTabs: [], _sessionTabLabels: {} };
    win.App = {
      Constants: { WS_KEY: "workspace_path" },
      State: {
        getWorkspacePath: () => "/test",
        getSnapshot: () => ({ activeView: { type: "chat" }, tabs: { items: [], activeId: null }, panel: { active: "explorer", width: 260 } }),
        syncTabs: (items, activeId) => {
          const st = win.__state._uiStateStore._state;
          st.tabs = { ...st.tabs, items: items.map((i) => ({ ...i })), activeId };
        },
        saveNow: async () => true,
        touchSession: () => {},
      },
      UI: {}, Chat: { clearAttachments: () => {} },
      File: {}, Session: {}, Settings: {}, Git: {},
    };
    win.__state._uiStateStore = { _state: { activeView: { type: "chat" }, tabs: { items: [], activeId: null } }, saveNow: async () => true };
    // 模块加载时引用裸 `App`，须与 window.App 保持同一对象（真实 bundle 中共享 window.App）
    global.App = win.App;

    win.document.body.innerHTML = `
      <div id="app">
        <div class="main">
          <div class="main-tabs" id="main-tabs"></div>
          <div class="mc">
            <div class="msgs" id="ms"></div>
            <div class="file-content" id="file-content" style="display:none">
              <div class="fc-toolbar"><span id="fc-status"></span></div>
              <div class="fc-editor" id="fc-editor"></div>
            </div>
            <div class="fi-area" id="fi"></div>
          </div>
        </div>
      </div>`;

    await import("../src/frontend/dashboard/dashboard-helpers.ts");
    // dashboard-helpers 替换了 win.App（facade 含 Tabs._attachStore），立即同步 global.App，
    // 使后续模块（layout-tabs 等）加载时 `App` 指向同一对象（模拟 bundle 共享 window.App）。
    global.App = win.App;
    await import(`../src/frontend/services/chat-runtime-store.ts?f2=${Date.now()}`);
    await import(`../src/frontend/services/chat-stream.ts?f2=${Date.now()}`);
    await import(`../src/frontend/services/ui-state-store.ts?f2=${Date.now()}`);
    await import(`../src/frontend/services/tab-store.ts?f2=${Date.now()}`);
    global.placeContextMenu = win.placeContextMenu;
    await import("../src/frontend/dashboard/layout-tabs.ts");
    const sessionNonce = Date.now();
    await import(`../src/frontend/dashboard/session-restore.ts?f2=${sessionNonce}`);
    await import(`../src/frontend/dashboard/session-activation.ts?f2=${sessionNonce}`);
    await import(`../src/frontend/dashboard/dashboard-sessions.ts?f2=${sessionNonce}`);
    await import("../src/frontend/dashboard/dashboard-layout.ts");
    global.App = win.App;
  });

  beforeEach(() => {
    win.App.Tabs.reset();
    win.document.getElementById("main-tabs").innerHTML = "";
    // Monaco mock：测试环境不加载真实 Monaco（避免动态 import 产生后台 rejection）
    win.__monaco = { create() {}, setValue() {}, setLang() {}, dispose() {}, tsCloseFile() {} };
  });

  it("源码断言：_fileActivate 在 await loadMonaco() 之前渲染标签栏", () => {
    const src = readFileSync(new URL("../src/frontend/dashboard/layout-tabs.ts", import.meta.url), "utf8");
    const activateStart = src.indexOf("async function _fileActivate");
    const renderBefore = src.indexOf("renderTabs", activateStart);
    const monacoAwait = src.indexOf("await loadMonaco()", activateStart);
    assert.ok(activateStart >= 0, "找到 _fileActivate");
    assert.ok(renderBefore >= 0 && renderBefore < monacoAwait,
      "renderTabs 必须位于 await loadMonaco() 之前（标签栏渲染不依赖 Monaco）");
  });

  it("openFileTab 同步渲染标签栏 + 切换到文件内容区（Monaco mock 下 DOM 集成）", () => {
    win.openFileTab("/x.ts", "hello", "ts");
    const el = win.document.getElementById("main-tabs");
    const item = el.querySelector(".tb-item");
    assert.ok(item, "标签栏应出现 tb-item");
    assert.strictEqual(item.dataset.tab, "/x.ts");
    assert.ok(item.classList.contains("active"), "新激活的文件标签应有 active class");
    const fc = win.document.getElementById("file-content");
    assert.strictEqual(fc.style.display, "", "file-content 应显示（主区切到文件代码）");
  });

  it("点会话A(请求在途)→点文件F→A响应晚到：应保持 F（统一竞态防护覆盖跨类）", async () => {
    const ts = win.App.Tabs;
    ts.openTab({ kind: "session", id: "sess-a", title: "A", sessionId: "sess-a" });
    win.openFileTab("/f.ts", "FILE", "ts");
    win.renderTabs();

    const pendings = new Map();
    const prevFetch = global.fetch;
    global.fetch = async (url, init) => {
      const body = JSON.parse(String(init?.body || "{}"));
      return new Promise((resolve) => pendings.set(body.id, resolve));
    };
    try {
      win.App.Tabs.activate("sess-a");   // 会话请求挂起
      win.App.Tabs.activate("/f.ts");    // 点文件 → 真实 _fileActivate（使在途会话请求过期）
      await new Promise((r) => setTimeout(r, 5));
      assert.strictEqual(ts.getState().activeId, "/f.ts", "点 F 后应激活 F");
      pendings.get("sess-a")({           // A 旧响应晚到 → 应被丢弃
        ok: true,
        json: async () => ({ ok: true, activeSessionId: "sess-a", messages: [{ role: "user", content: "A-MSG" }] }),
      });
      await new Promise((r) => setTimeout(r, 10));
      assert.strictEqual(ts.getState().activeId, "/f.ts", "A 旧响应不得切回 A（应保持 F）");
      const msgs = win.App.ChatState.getMessages().map((m) => m.content);
      assert.ok(!msgs.includes("A-MSG"), "A 旧响应不得覆盖消息区");
    } finally {
      global.fetch = prevFetch;
    }
  });

  it("关闭当前激活的文件标签后，下一个标签激活并加载其内容", () => {
    const setValues = [];
    win.__monaco = {
      create() {}, dispose() {}, setLang() {}, tsCloseFile() {},
      setValue(v) { setValues.push(v); },
    };
    win.openFileTab("/f1.ts", "content1", "ts");
    win.openFileTab("/f2.ts", "content2", "ts");
    win.App.Tabs.activate("/f2.ts");
    setValues.length = 0; // 清掉打开/激活过程写入的值

    // 关闭当前激活的 f2
    win.App.Tabs.close("/f2.ts");

    const state = win.App.Tabs.getState();
    assert.deepStrictEqual(state.items.map((t) => t.id), ["/f1.ts"], "f2 应从标签列表移除");
    assert.strictEqual(state.activeId, "/f1.ts", "activeId 自动切换到下一个标签 f1");
    assert.ok(setValues.includes("content1"),
      `关闭后应把编辑器内容切换到 f1（实际写入: ${JSON.stringify(setValues)}）`);
  });
});
