import { describe, it, before } from "node:test";
import assert from "node:assert";
import { Window } from "happy-dom";

const win = new Window();
const doc = win.document;
global.window = win;
global.mark = () => {};
global.logTiming = () => {};

global.document = doc;
global.self = win;
global.MouseEvent = win.MouseEvent;

doc.body.innerHTML = '<div id="main-tabs"></div><div id="sl"></div><div id="ms"></div>';

const store = {};
global.localStorage = {
  getItem: (key) => store[key] ?? null,
  setItem: (key, value) => { store[key] = value; },
  removeItem: (key) => { delete store[key]; },
};

const registeredPanes = new Map();
global.registerPane = (name, render) => {
  registeredPanes.set(name, render);
};

global.$ = (id) => doc.getElementById(id);
global.E = (value) => String(value ?? "");
global.S = (name, size = 16) => `<svg width="${size}" height="${size}" viewBox="0 0 24 24"><use href="#${name}"/></svg>`;

global.toast = () => {};
global.confirmAsync = async () => true;
global.ExplorerService = { iconFor: () => '<svg width="14" height="14"></svg>' };
win.ExplorerService = global.ExplorerService;

win.__state = {
  D: null,
  M: [],
  IL: false,
  CS: null,
  CT: "chat",
  _activePanel: "explorer",
  _fileTabs: [],
  _activeFileTab: null,
  _sessionTabs: [],
  _activeSessionTabId: null,
};

win.App = {
  Constants: { WS_KEY: "workspace_path" },
  UI: {},
  Chat: {},
  File: {},
  Session: {},
  Settings: {},
  Git: {},
  Tabs: {
    activate(id) {
      // 添加到 _sessionTabs + 激活（简化：不检查旧字段，handler 负责校验）
      if (!win.__state._sessionTabs.includes(id)) win.__state._sessionTabs.push(id);
      win.__state._activeSessionTabId = id;
      win.__state._activeFileTab = null;
      win.__state.M = [{ role: "user", content: "切换后" }];
      if (typeof win.renderTabs === 'function') win.renderTabs();
    },
    close(id) {
      const idx = win.__state._sessionTabs.indexOf(id);
      if (idx >= 0) {
        win.__state._sessionTabs.splice(idx, 1);
        if (win.__state._activeSessionTabId === id) {
          const next = win.__state._sessionTabs[Math.min(idx, win.__state._sessionTabs.length - 1)] || null;
          win.__state._activeSessionTabId = next;
        }
        if (typeof win.renderTabs === 'function') win.renderTabs();
      }
    },
    contextMenu() {},
  },
};
global.App = win.App;

const fetchCalls = [];
let sessionListState = 0;
const sessionListBefore = {
  sessions: [
    { id: "sess-a", name: "A", active: false, messageCount: 2, createdAt: "2026-07-12T10:00:00.000Z", updatedAt: "2026-07-12T10:10:00.000Z", file: "a.jsonl" },
    { id: "sess-b", name: "B", active: false, messageCount: 3, createdAt: "2026-07-12T11:00:00.000Z", updatedAt: "2026-07-12T11:15:00.000Z", file: "b.jsonl", pinned: true, branchFrom: { id: "sess-root", name: "Root" } },
    { id: "sess-error", name: "Error", active: false, messageCount: 4, createdAt: "2026-07-12T12:00:00.000Z", updatedAt: "2026-07-12T12:10:00.000Z", file: "error.jsonl", hasError: true },
    { id: "sess-empty", name: "Empty", active: false, messageCount: 0, createdAt: "2026-07-12T13:00:00.000Z", updatedAt: "2026-07-12T13:05:00.000Z", file: "empty.jsonl" },
  ],
  other: [],
  activeSessionId: "sess-a",
};
const sessionListAfter = {
  sessions: [
    { id: "sess-a", name: "A", active: false, messageCount: 2, createdAt: "2026-07-12T10:00:00.000Z", updatedAt: "2026-07-12T10:10:00.000Z", file: "a.jsonl" },
    { id: "sess-b", name: "B", active: true, messageCount: 3, createdAt: "2026-07-12T11:00:00.000Z", updatedAt: "2026-07-12T11:15:00.000Z", file: "b.jsonl", pinned: true, branchFrom: { id: "sess-root", name: "Root" } },
  ],
  other: [],
  activeSessionId: "sess-b",
};
const sessionListEmpty = {
  sessions: [],
  other: [],
  activeSessionId: null,
};
const sessionListBranch = {
  sessions: [
    { id: "branch-new", name: "B · 分支", active: true, messageCount: 2, createdAt: "2026-07-12T12:00:00.000Z", updatedAt: "2026-07-12T12:05:00.000Z", file: "branch-new.jsonl", branchFrom: { id: "sess-b", name: "B" } },
    ...sessionListAfter.sessions,
  ],
  other: [],
  activeSessionId: "branch-new",
};
const sessionListRunning = {
  sessions: [
    { id: "sess-a", name: "A", active: true, isRunning: true, messageCount: 2, createdAt: "2026-07-12T10:00:00.000Z", updatedAt: "2026-07-12T10:10:00.000Z", file: "a.jsonl" },
    { id: "sess-b", name: "B", active: false, messageCount: 3, createdAt: "2026-07-12T11:00:00.000Z", updatedAt: "2026-07-12T11:15:00.000Z", file: "b.jsonl", pinned: true, branchFrom: { id: "sess-root", name: "Root" } },
  ],
  other: [],
  activeSessionId: "sess-a",
};

global.fetch = async (url, init = {}) => {
  fetchCalls.push([url, init.method || "GET", init]);
  if (String(url).includes("/api/sessions/pin")) {
    return {
      ok: true,
      json: async () => ({ ok: true, id: "sess-b", pinned: true }),
    };
  }
  if (String(url).includes("/api/sessions/branch")) {
    return {
      ok: true,
      json: async () => ({ ok: true, id: "branch-new", activeSessionId: "branch-new", messages: [
        { role: "user", content: "原问题" },
        { role: "assistant", content: "分支上下文" },
      ] }),
    };
  }
  if (String(url).includes("/api/sessions/new")) {
    return {
      ok: true,
      json: async () => ({ ok: true, id: "sess-new-empty" }),
    };
  }
  if (String(url).includes("/api/sessions/rename")) {
    return {
      ok: true,
      json: async () => ({ ok: true }),
    };
  }
  if (String(url).includes("/api/sessions/activate")) {
    const body = init.body ? JSON.parse(init.body) : {};
    const activeSessionId = body.id || "sess-b";
    return {
      ok: true,
      json: async () => ({ ok: true, activeSessionId, messages: activeSessionId === "sess-new-empty" ? [] : [
        { role: "user", content: "切换前" },
        { role: "assistant", content: "切换后" },
      ] }),
    };
  }
  if (String(url).includes("/api/sessions?")) {
    const payload = sessionListState === 0 ? sessionListBefore : sessionListState === 1 ? sessionListAfter : sessionListState === 3 ? sessionListBranch : sessionListState === 4 ? sessionListRunning : sessionListEmpty;
    sessionListState += 1;
    return {
      ok: true,
      json: async () => payload,
    };
  }
  if (String(url).includes("/api/ui-state")) {
    return { ok: true, json: async () => ({ ok: true }) };
  }
  throw new Error(`unexpected fetch: ${url}`);
};

win.fetch = global.fetch;

before(async () => {
  const ts = Date.now();
  await import(`../src/frontend/dashboard/dashboard-layout.ts?t=${ts}`);
  await import(`../src/frontend/dashboard/dashboard-sessions.ts?t=${ts}`);
  await import(`../src/frontend/pane/chat/index.ts?t=${ts}`);
  global.loadSessions = win.loadSessions;
  global.bumpSessionListSeq = win.bumpSessionListSeq;
  global.isCurrentSessionListSeq = win.isCurrentSessionListSeq;
  win.renderTabs();
}, 10000);

describe("session ui state", () => {
  it("无标签时主区空白，无默认 chat", () => {
    store["session-tabs"] = "[]";
    delete store["chat-tab-open"];
    win.__state._sessionTabs = [];
    win.__state._fileTabs = [];
    win.__state._activeFileTab = null;
    win.renderTabs();

    // Layer 0: 无 session/file 标签时主区空白，不自动创建 chat tab
    assert.strictEqual(doc.querySelector("#main-tabs .tb-item[data-tab='chat']"), null);
    assert.strictEqual(doc.querySelectorAll("#main-tabs .tb-item").length, 0);
  });

  it("loadSessions 不会把后端 activeSessionId 当作打开高亮", async () => {
    store["session-tabs"] = "[]";
    win.__state._sessionTabs = [];
    localStorage.setItem("workspace_path", "E:\\my-code-agent");
    await win.loadSessions();
    await new Promise((resolve) => setTimeout(resolve, 10));

    const sessionTabs = Array.from(doc.querySelectorAll("#main-tabs .session-tab")).map((node) => node.textContent || "");
    assert.strictEqual(sessionTabs.length, 0);
    // 会话标签在 #main-tabs .tb-scroll 内渲染；无 session 时没有 .session-tab
    assert.strictEqual(doc.querySelectorAll("#main-tabs .session-tab").length, 0);
    assert.ok(doc.querySelector("#main-tabs"));
    const activeItems = Array.from(doc.querySelectorAll("#sl .sess-item.active"));
    assert.strictEqual(activeItems.length, 0);
    assert.strictEqual(localStorage.getItem("last-session-id"), null);
    assert.strictEqual(doc.querySelector("#sl .thread-badge-running"), null);
	    // 非固定会话现在渲染为直接卡片（无 .session-group 包裹），仅有固定线程有 group head
	    const groupHeads = Array.from(doc.querySelectorAll("#sl .session-group-head")).map((node) => node.textContent || "");
	    assert.ok(groupHeads.some((text) => text.includes("固定线程")));
	    assert.ok(doc.querySelectorAll("#sl .sess-item").length >= 3);
    assert.strictEqual(doc.querySelector("#sl .thread-badge-pinned"), null);
    assert.strictEqual(doc.querySelector("#sl .thread-badge-error"), null);
    assert.strictEqual(doc.querySelector("#sl .thread-badge-empty"), null);
    assert.ok(doc.querySelector("#sl .sess-item")?.getAttribute("title")?.includes("当前项目"));
    assert.ok(doc.querySelector("#sl .thread-error")?.getAttribute("title")?.includes("上次执行出现错误"));
    assert.ok(doc.querySelector("#sl")?.textContent.includes("固定线程"));
    assert.ok(doc.querySelector("#sl .thread-pinned")?.getAttribute("title")?.includes("从 Root 分支"));
    assert.strictEqual(doc.querySelector("#sl-status"), null);
  });

  it("只有 agent 工作中的线程才显示运行中", async () => {
    sessionListState = 4;
    await win.loadSessions();
    await new Promise((resolve) => setTimeout(resolve, 10));

    assert.strictEqual(doc.querySelector("#sl .thread-badge-running"), null);
    assert.ok(doc.querySelector("#sl .thread-running")?.getAttribute("title")?.includes("这条线程正在当前工作区推进"));
  });

  it("会话标签页会记录多个打开的会话", async () => {
    store["session-tabs"] = "[]";
    win.__state._sessionTabs = [];
    sessionListState = 0;
    await win.loadSessions();
    await new Promise((resolve) => setTimeout(resolve, 10));

    sessionListState = 0;
    await win.App.Tabs.activate("sess-a");
    await new Promise((resolve) => setTimeout(resolve, 10));
    sessionListState = 1;
    await win.App.Tabs.activate("sess-b");
    await new Promise((resolve) => setTimeout(resolve, 10));

    const tabs = Array.from(doc.querySelectorAll("#main-tabs .session-tab")).map((node) => node.textContent || "");
    assert.ok(tabs.some((text) => text.includes("A")));
    assert.ok(tabs.some((text) => text.includes("B")));
    assert.ok(doc.querySelector("#main-tabs .session-tab.active")?.textContent.includes("B"));

    win.App.Tabs.close("sess-a");
    await new Promise((resolve) => setTimeout(resolve, 10));

    const tabsAfterClose = Array.from(doc.querySelectorAll("#main-tabs .session-tab")).map((node) => node.textContent || "");
    assert.ok(!tabsAfterClose.some((text) => text.includes("A")));
    assert.ok(tabsAfterClose.some((text) => text.includes("B")));

    win.App.Tabs.close("sess-b");
    await new Promise((resolve) => setTimeout(resolve, 10));

    assert.strictEqual(doc.querySelectorAll("#main-tabs .session-tab").length, 0);
    sessionListState = 0;
    await win.loadSessions();
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.strictEqual(doc.querySelectorAll("#main-tabs .session-tab").length, 0);
  });

  it("新会话先打开草稿标签，不立即创建服务端会话", async () => {
    store["session-tabs"] = "[]";
    store["session-tab-labels"] = "{}";
    delete store["last-session-id"];
    delete store["active-session-tab"];
    fetchCalls.length = 0;
    win.__state._sessionTabs = [];
    doc.body.insertAdjacentHTML("beforeend", '<div id="file-content"></div><div id="fi"></div><div class="mc editing"></div>');
    win.__state._fileTabs = [{ id: "src/demo.ts", label: "demo.ts", content: "", lang: "ts" }];
    win.__state._activeFileTab = "src/demo.ts";
    await win.newSession();
    await new Promise((resolve) => setTimeout(resolve, 10));

    const tab = doc.querySelector("#main-tabs .session-tab");
    assert.ok(tab?.textContent.includes("新会话"));
    assert.strictEqual(localStorage.getItem("last-session-id"), null);
    assert.ok(win.__state._sessionTabs.some(id => id.startsWith("draft:")));
    assert.ok(!fetchCalls.some(([url, method]) => String(url).includes("/api/sessions/new") && method === "POST"));
    // _activeFileTab 投影自 TabStore；验证 TabStore 已清 file active（newSession → focusChatView 调用 activateTab(null)）
    assert.strictEqual(win.__tabs?.getActiveFileTabId?.() ?? null, null);
    assert.notStrictEqual(doc.querySelector("#ms")?.style.display, "none");
    assert.strictEqual(doc.querySelector("#file-content")?.style.display, "none");

    win.__state._activeFileTab = "src/demo.ts";
    const draftId = win.__state._sessionTabs.find(id => id.startsWith("draft:"));
    await win.App.Tabs.activate(draftId);
    await new Promise((resolve) => setTimeout(resolve, 10));

    assert.strictEqual(win.__state._activeFileTab, null);
    assert.ok(doc.querySelector("#ms")?.textContent.includes("新会话"));
    doc.querySelector("#file-content")?.remove();
    doc.querySelector("#fi")?.remove();
    doc.querySelector(".mc")?.remove();
    win.__state._fileTabs = [];
  });

  it("重命名标题优先于新会话默认标题", async () => {
    store["session-tabs"] = JSON.stringify(["sess-new-empty"]);
    store["session-tab-labels"] = JSON.stringify({ "sess-new-empty": "新会话" });
    win.__state._sessionTabs = ["sess-new-empty"];
    win.renderSessionTabs("sess-new-empty");
    doc.querySelector("#sl").innerHTML = '<div class="sess-item"><span class="thread-title">新会话</span></div>';
    const button = doc.createElement("button");
    doc.querySelector("#sl .sess-item").appendChild(button);

    win.renameSession(button, "sess-new-empty");
    const input = doc.querySelector(".sess-rename-input");
    input.value = "手动标题";
    input.blur();
    await new Promise((resolve) => setTimeout(resolve, 10));

    assert.ok(doc.querySelector("#main-tabs .session-tab")?.textContent.includes("手动标题"));
  });

  it("线程操作按钮使用 SVG，取消固定传递布尔 false", async () => {
    sessionListState = 0;
    await win.loadSessions();
    await new Promise((resolve) => setTimeout(resolve, 10));

    const pinnedItem = Array.from(doc.querySelectorAll("#sl .sess-item")).find((node) => node.textContent.includes("B"));
    assert.ok(pinnedItem);
    const pinButton = pinnedItem.querySelector(".sess-pin");
    const ops = pinnedItem.querySelector(".thread-ops");

    assert.ok(pinButton?.innerHTML.includes('#ipin-off'));
    assert.ok(ops?.innerHTML.includes('#ibranch'));
    assert.ok(ops?.innerHTML.includes('#iedit'));
    assert.ok(ops?.innerHTML.includes('#itrash'));
    assert.ok(!ops?.textContent.includes('★'));
    assert.ok(!ops?.textContent.includes('☆'));
    assert.ok(!ops?.textContent.includes('⑂'));
    assert.ok(!ops?.textContent.includes('✎'));
    assert.ok(!ops?.textContent.includes('✕'));

    assert.strictEqual(pinButton?.dataset.action, "pin", "pin button data-action");
    assert.strictEqual(pinButton?.dataset.sessionId, "sess-b", "pin button data-session-id");
    assert.strictEqual(pinButton?.dataset.pinned, "true", "pin button data-pinned (当前固定)");
  });

  it("pinSession 会调用固定接口并刷新列表", async () => {
    sessionListState = 0;
    await win.pinSession("sess-b", true);
    await new Promise((resolve) => setTimeout(resolve, 10));

    assert.ok(fetchCalls.some(([url, method]) => String(url).includes("/api/sessions/pin") && method === "POST"));
    assert.ok(fetchCalls.some(([url]) => String(url).includes("/api/sessions?")));
  });

  it("pinSession 取消固定时发送布尔 false", async () => {
    fetchCalls.length = 0;
    sessionListState = 0;
    await win.pinSession("sess-b", false);
    await new Promise((resolve) => setTimeout(resolve, 10));

    const pinCall = fetchCalls.find(([url, method, init]) => String(url).includes("/api/sessions/pin") && method === "POST" && init?.body);
    assert.ok(pinCall);
    assert.strictEqual(JSON.parse(pinCall[2].body).pinned, false);
  });

  it("branchSession 会创建分支并切到新线程", async () => {
    sessionListState = 3;
    await win.branchSession("sess-b");
    await new Promise((resolve) => setTimeout(resolve, 20));

    assert.ok(fetchCalls.some(([url, method]) => String(url).includes("/api/sessions/branch") && method === "POST"));
    assert.ok(win.__state._sessionTabs.includes("branch-new"));
    assert.strictEqual(win.__state.M.length, 2);
    assert.strictEqual(win.__state.M[1].content, "分支上下文");
  });

  it("App.Tabs.activate 会添加并激活会话标签", async () => {
    sessionListState = 1;
    win.__state.M = [{ role: "user", content: "旧消息" }];
    await win.App.Tabs.activate("sess-b");
    await new Promise((resolve) => setTimeout(resolve, 20));

    assert.ok(win.__state._sessionTabs.includes("sess-b"));
    assert.strictEqual(win.__state._activeSessionTabId, "sess-b");
    assert.strictEqual(win.__state._activeFileTab, null);
    // App.Tabs.activate mock 会设置消息
    assert.strictEqual(win.__state.M.length, 1);
  });

  it("空会话时只显示新会话入口", async () => {
    sessionListState = 2;
    localStorage.setItem("last-session-id", "sess-b");

    await win.loadSessions();
    await new Promise((resolve) => setTimeout(resolve, 10));

    const panel = doc.querySelector("#sl");
    assert.ok(panel?.textContent.includes("暂无任务线程"));
    assert.ok(!panel?.textContent.includes("恢复上次会话"));
    assert.ok(panel?.textContent.includes("+ 新会话"));
  });

  it("相同会话快照刷新时不重绘列表 DOM", async () => {
    sessionListState = 0;
    await win.loadSessions();
    await new Promise((resolve) => setTimeout(resolve, 10));

    const panel = doc.querySelector("#sl");
    assert.ok(panel);
    let redraws = 0;
    const original = Object.getOwnPropertyDescriptor(win.Element.prototype, "innerHTML");
    assert.ok(original?.set && original?.get);
    Object.defineProperty(panel, "innerHTML", {
      configurable: true,
      get() { return original.get.call(this); },
      set(value) { redraws += 1; return original.set.call(this, value); },
    });

    const sameList = { ...sessionListBefore, sessions: sessionListBefore.sessions.map((session) => ({ ...session })) };
    global.fetch = async (url, init = {}) => {
      fetchCalls.push([url, init.method || "GET"]);
      if (String(url).includes("/api/sessions?")) {
        return { ok: true, json: async () => sameList };
      }
      throw new Error(`unexpected fetch: ${url}`);
    };
    win.fetch = global.fetch;

    await win.loadSessions();
    await new Promise((resolve) => setTimeout(resolve, 10));

    assert.strictEqual(redraws, 0);
    assert.strictEqual(doc.querySelector("#sl-status"), null);

    Object.defineProperty(panel, "innerHTML", original);
  });

  it("面板重挂载后即使快照相同也会重绘列表", async () => {
    sessionListState = 0;
    await win.loadSessions();
    await new Promise((resolve) => setTimeout(resolve, 10));

    const panel = doc.querySelector("#sl");
    assert.ok(panel);
    panel.innerHTML = "加载中...";
    const sameList = { ...sessionListBefore, sessions: sessionListBefore.sessions.map((session) => ({ ...session })) };
    global.fetch = async (url, init = {}) => {
      fetchCalls.push([url, init.method || "GET", init]);
      if (String(url).includes("/api/sessions?")) {
        return { ok: true, json: async () => sameList };
      }
      throw new Error(`unexpected fetch: ${url}`);
    };
    win.fetch = global.fetch;

    await win.loadSessions();
    await new Promise((resolve) => setTimeout(resolve, 10));

    assert.ok(panel.textContent.includes("固定线程"));
    assert.ok(!panel.textContent.trim().startsWith("加载中"));
  });

  it("loadSessions 网络错误时显示失败状态", async () => {
    const originalFetch = global.fetch;
    try {
      global.fetch = async (url) => {
        if (String(url).includes("/api/sessions?")) throw new Error("网络不通");
        return originalFetch(url);
      };
      win.fetch = global.fetch;

      await win.loadSessions();
      await new Promise((resolve) => setTimeout(resolve, 20));

      const panel = doc.querySelector("#sl");
      assert.ok(panel, "sl exists");
      assert.ok(!panel.classList.contains("is-loading"), "loading state cleared");
      assert.ok(panel.textContent.includes("网络错误"), "shows error message");
      assert.ok(panel.textContent.includes("重新加载"), "has retry button");
    } finally {
      global.fetch = originalFetch;
      win.fetch = originalFetch;
    }
  });

  it("聊天面板搜索不会被更慢的任务线程列表覆盖", async () => {
    const originalSl = doc.querySelector("#sl");
    const originalSlParent = originalSl?.parentNode;
    const originalSlNext = originalSl?.nextSibling;
    const originalFetch = global.fetch;
    const originalWinFetch = win.fetch;
    const chatRender = registeredPanes.get("chat");
    assert.ok(chatRender, "chat pane should be registered");
    let pane = null;

    let resolveSessions;
    const pendingSessions = new Promise((resolve) => { resolveSessions = resolve; });
    const staleSessions = {
      sessions: [
        {
          id: "stale-thread",
          name: "过时线程",
          active: false,
          messageCount: 1,
          createdAt: "2026-07-12T14:00:00.000Z",
          updatedAt: "2026-07-12T14:05:00.000Z",
          file: "stale.jsonl",
        },
      ],
      other: [],
      activeSessionId: null,
    };

    try {
      originalSl?.remove();
      pane = doc.createElement("div");
      doc.body.appendChild(pane);

      global.fetch = async (url, init = {}) => {
        const href = String(url);
        if (href.includes("/api/sessions?")) {
          return { ok: true, json: async () => pendingSessions };
        }
        if (href.includes("/api/search/conversations")) {
          return {
            ok: true,
            json: async () => ({
              results: [{
                sessionId: "match-session",
                sessionName: "命中线程",
                workspace: "E:/my-code-agent",
                file: "by-project/demo/2026-07-25.jsonl",
                matches: [{ line: 2, role: "user", text: "needle marker", length: 6 }],
              }],
              total: 1,
              truncated: false,
            }),
          };
        }
        throw new Error(`unexpected fetch: ${url}`);
      };
      win.fetch = global.fetch;

      chatRender(pane);

      const input = doc.querySelector("#chat-search-input");
      assert.ok(input, "chat search input exists");
      input.value = "needle";
      input.dispatchEvent(new win.Event("input", { bubbles: true }));
      input.dispatchEvent(new win.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 20));

      const panel = doc.querySelector("#sl");
      assert.ok(panel, "session list panel exists");
      assert.ok(!panel.classList.contains("is-loading"), "search result should clear loading state");
      assert.ok(panel.textContent.includes("命中线程"));
      assert.ok(panel.textContent.includes("needle marker"));
      assert.ok(!panel.textContent.includes("过时线程"));

      win.loadSessions();
      await new Promise((resolve) => setTimeout(resolve, 20));

      assert.ok(panel.textContent.includes("命中线程"), "active search results survive explicit loadSessions refresh");
      assert.ok(panel.textContent.includes("needle marker"), "search hit remains after explicit loadSessions refresh");
      assert.ok(!panel.textContent.includes("过时线程"), "explicit refresh does not restore stale session list");

      resolveSessions(staleSessions);
      await new Promise((resolve) => setTimeout(resolve, 20));

      assert.ok(panel.textContent.includes("命中线程"), "stale session list must not overwrite search results");
      assert.ok(panel.textContent.includes("needle marker"), "search hit remains visible");
      assert.ok(!panel.textContent.includes("过时线程"), "stale session list stays ignored");

    } finally {
      global.fetch = originalFetch;
      win.fetch = originalWinFetch;
      pane?.remove();
      if (originalSl && originalSlParent) {
        originalSlParent.insertBefore(originalSl, originalSlNext || null);
      }
    }
  });

  it("聊天面板会渲染并跳转每一条会话搜索命中", async () => {
    const originalSl = doc.querySelector("#sl");
    const originalSlParent = originalSl?.parentNode;
    const originalSlNext = originalSl?.nextSibling;
    const originalFetch = global.fetch;
    const originalWinFetch = win.fetch;
    const chatRender = registeredPanes.get("chat");
    assert.ok(chatRender, "chat pane should be registered");
    let pane = null;

    try {
      originalSl?.remove();
      pane = doc.createElement("div");
      doc.body.appendChild(pane);
      global.fetch = async (url) => {
        const href = String(url);
        if (href.includes("/api/sessions?")) {
          return { ok: true, json: async () => ({ sessions: [], other: [], activeSessionId: null }) };
        }
        if (href.includes("/api/search/conversations")) {
          return {
            ok: true,
            json: async () => ({
              results: [{
                sessionId: "multi-session",
                sessionName: "0415scf",
                workspace: "E:/my-code-agent",
                file: "by-project/demo/2026-07-25.jsonl",
                updatedAt: "2026-07-25T00:00:00.000Z",
                matches: [0, 1, 2, 3, 4].map((idx) => ({
                  line: 1,
                  role: "assistant",
                  text: `needle ${idx}`,
                  msgIndex: 0,
                  matchOrdinal: idx,
                  matchPos: [{ start: 0, end: 6 }],
                })),
              }],
              total: 5,
              truncated: false,
            }),
          };
        }
        throw new Error(`unexpected fetch: ${url}`);
      };
      win.fetch = global.fetch;

      chatRender(pane);
      const input = doc.querySelector("#chat-search-input");
      assert.ok(input, "chat search input exists");
      input.value = "needle";
      input.dispatchEvent(new win.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 20));

      const matches = Array.from(doc.querySelectorAll("#sl .cs-match"));
      assert.strictEqual(matches.length, 5, "所有返回的匹配行都应可见可点");
      assert.strictEqual(matches[4].dataset.sessionId, "multi-session", "cs-match data-session-id");
      assert.strictEqual(matches[4].dataset.msgIndex, "0", "cs-match data-msg-index");
      assert.strictEqual(matches[4].dataset.matchOrdinal, "4", "cs-match data-match-ordinal 对应第 5 处命中");
    } finally {
      global.fetch = originalFetch;
      win.fetch = originalWinFetch;
      pane?.remove();
      if (originalSl && originalSlParent) {
        originalSlParent.insertBefore(originalSl, originalSlNext || null);
      }
    }
  });

  it("openConvMatch 会立即滚动已渲染消息并高亮", async () => {
    const originalActivate = win.App.Tabs.activate;
    const originalMs = doc.querySelector("#ms");
    const originalParent = originalMs?.parentNode;
    const originalNext = originalMs?.nextSibling;
    const originalTabs = win.__tabs;
    win.__tabs = { getActiveTab: () => ({ id: "sess-a", kind: "session", title: "sess-a", order: 0 }) };
    const tabs = win.__tabs;
    const originalGetActiveTab = tabs.getActiveTab;

    try {
      win.App.Tabs.activate = () => {
        if (typeof win.emitSessionActivated === "function") win.emitSessionActivated("sess-a");
      };
      tabs.getActiveTab = () => ({ id: "sess-a", kind: "session", title: "sess-a", order: 0 });
      originalMs?.remove();
      const ms = doc.createElement("div");
      ms.id = "ms";
      ms.innerHTML = [
        '<div class="m"><div class="ml">1</div><div class="block-text">one</div></div>',
        '<div class="m"><div class="ml">2</div><div class="block-text">two</div></div>',
        '<div class="m"><div class="ml">3</div><div class="block-text">three</div></div>',
      ].join("");
      doc.body.appendChild(ms);

      const target = ms.querySelectorAll(".m")[1];
      let scrolled = 0;
      const originalScrollIntoView = target.scrollIntoView;
      Object.defineProperty(target, "scrollIntoView", {
        configurable: true,
        value: () => { scrolled += 1; },
      });

      win.openConvMatch("sess-a", 1);
      await new Promise((resolve) => setTimeout(resolve, 100));

      assert.strictEqual(scrolled, 1, "同步激活通知和立即路径应只滚动一次");
      assert.ok(target.classList.contains("msg-highlight"), "目标消息应被高亮");

      Object.defineProperty(target, "scrollIntoView", {
        configurable: true,
        value: originalScrollIntoView,
      });
    } finally {
      win.App.Tabs.activate = originalActivate;
      tabs.getActiveTab = originalGetActiveTab;
      win.__tabs = originalTabs;
      doc.querySelector("#ms")?.remove();
      if (originalMs && originalParent) {
        originalParent.insertBefore(originalMs, originalNext || null);
      }
    }
  });

  it("openConvMatch 会等待切换后的会话渲染再滚动目标消息", async () => {
    const originalActivate = win.App.Tabs.activate;
    const originalMs = doc.querySelector("#ms");
    const originalParent = originalMs?.parentNode;
    const originalNext = originalMs?.nextSibling;
    const originalTabs = win.__tabs;
    const originalScrollIntoView = win.HTMLElement.prototype.scrollIntoView;
    let activeId = "sess-old";
    let scrolledText = "";

    try {
      win.__tabs = { getActiveTab: () => ({ id: activeId, kind: "session", title: activeId, order: 0 }) };
      originalMs?.remove();
      const ms = doc.createElement("div");
      ms.id = "ms";
      ms.innerHTML = '<div class="m"><div class="block-text">old newest reply</div></div>';
      doc.body.appendChild(ms);
      Object.defineProperty(win.HTMLElement.prototype, "scrollIntoView", {
        configurable: true,
        value() { scrolledText = this.textContent || ""; },
      });
      win.App.Tabs.activate = () => {
        setTimeout(() => {
          activeId = "sess-next";
          ms.innerHTML = [
            '<div class="m"><div class="block-text">first</div></div>',
            '<div class="m"><div class="block-text">target needle reply</div></div>',
            '<div class="m"><div class="block-text">latest reply</div></div>',
          ].join("");
          // 模拟 _applySessionMessages 完成后的激活通知
          if (typeof win.emitSessionActivated === "function") win.emitSessionActivated("sess-next");
        }, 10);
      };

      win.openConvMatch("sess-next", 1, 0);
      await new Promise((resolve) => setTimeout(resolve, 120));

      assert.ok(scrolledText.includes("target needle reply") || scrolledText.includes("needle"), "应滚动到目标消息而不是最新回复");
      assert.ok(!scrolledText.includes("latest reply"), "不应停在最新回复");
    } finally {
      win.App.Tabs.activate = originalActivate;
      win.__tabs = originalTabs;
      Object.defineProperty(win.HTMLElement.prototype, "scrollIntoView", {
        configurable: true,
        value: originalScrollIntoView,
      });
      doc.querySelector("#ms")?.remove();
      if (originalMs && originalParent) {
        originalParent.insertBefore(originalMs, originalNext || null);
      }
    }
  });

  it("openConvMatch 多次调用不会残留 hook 或重复触发", async () => {
    const originalActivate = win.App.Tabs.activate;
    const originalMs = doc.querySelector("#ms");
    const originalParent = originalMs?.parentNode;
    const originalNext = originalMs?.nextSibling;
    const originalTabs = win.__tabs;
    const originalScrollIntoView = win.HTMLElement.prototype.scrollIntoView;
    const scrolled = [];
    let activeId = "";

    try {
      originalMs?.remove();
      win.App.Tabs.activate = () => {};
      win.__tabs = { getActiveTab: () => activeId ? ({ id: activeId, kind: "session", title: activeId, order: 0 }) : null };

      Object.defineProperty(win.HTMLElement.prototype, "scrollIntoView", {
        configurable: true,
        value() { scrolled.push(this.textContent || ""); },
      });

      // 连续注册两次（#ms 还不存在 -> doScroll 失败 -> 注册 hook）
      win.openConvMatch("sess-first", 0);
      win.openConvMatch("sess-second", 1);

      // 现在创建 #ms（hook 已注册，等待激活通知）
      const ms = doc.createElement("div");
      ms.id = "ms";
      ms.innerHTML = [
        '<div class="m"><div class="block-text">alpha</div></div>',
        '<div class="m"><div class="block-text">beta</div></div>',
      ].join("");
      doc.body.appendChild(ms);

      // 先激活较早点击的会话：应消费旧 hook，但保留最新 sess-second hook
  activeId = "sess-first";
      if (typeof win.emitSessionActivated === "function") win.emitSessionActivated("sess-first");
      await new Promise((resolve) => setTimeout(resolve, 80));
      assert.strictEqual(scrolled.length, 0, "较早点击先完成不应吞掉最新点击的订阅");

      // 激活第二个（最新点击）— 只有它应触发 scroll
  activeId = "sess-second";
      if (typeof win.emitSessionActivated === "function") win.emitSessionActivated("sess-second");
      await new Promise((resolve) => setTimeout(resolve, 80));

      assert.strictEqual(scrolled.length, 1, "只触发一次 scroll，非两次");
      assert.ok(scrolled[0].includes("beta"), "最新点击 sess-second 滚到 beta");
      assert.ok(!scrolled.some(t => t.includes("alpha")), "较早点击 sess-first 未滚动");

      // 激活第一个 — sess-first 的 hook 已被 latest-click 跳过且一发即焚清空
      if (typeof win.emitSessionActivated === "function") win.emitSessionActivated("sess-first");
      await new Promise((resolve) => setTimeout(resolve, 80));

      assert.strictEqual(scrolled.length, 1, "再次激活后无额外 scroll（hook 已清空）");
    } finally {
      win.App.Tabs.activate = originalActivate;
      win.__tabs = originalTabs;
      Object.defineProperty(win.HTMLElement.prototype, "scrollIntoView", {
        configurable: true,
        value: originalScrollIntoView,
      });
      doc.querySelector("#ms")?.remove();
      if (originalMs && originalParent) {
        originalParent.insertBefore(originalMs, originalNext || null);
      }
    }
  });

  it("重启后会话标题从缓存恢复", async () => {
    store["session-tabs"] = JSON.stringify(["sess-a", "sess-b"]);
    store["session-tab-labels"] = JSON.stringify({});
    store["active-session-tab"] = "sess-b";
    win.__state._sessionTabs = [];

    win.renderSessionTabs();

    const tabs = Array.from(doc.querySelectorAll("#main-tabs .session-tab")).map(node => node.textContent || "");
    assert.strictEqual(tabs.length, 2);
    assert.ok(tabs.some(t => t.includes("session-tab") || t.length > 0), "should render 2 session tabs");

    store["session-tab-labels"] = JSON.stringify({ "sess-a": "手动名称" });
    store["active-session-tab"] = "sess-a";
    win.renderSessionTabs("sess-a");

    const tabs2 = Array.from(doc.querySelectorAll("#main-tabs .session-tab")).map(node => node.textContent || "");
    assert.ok(tabs2.some(t => t.includes("手动名称")));
  });

  it("会话标签关闭按钮触发 App.Tabs.close", () => {
    store["session-tabs"] = JSON.stringify(["sess-a"]);
    store["active-session-tab"] = "sess-a";
    win.__state._sessionTabs = ["sess-a"];
    sessionListState = 0;
    win.renderSessionTabs("sess-a");

    const closeBtn = doc.querySelector("#main-tabs .session-tab .tb-close");
    assert.ok(closeBtn, "session tab should have a close button");
    // 验证委托点击：直接 dispatchEvent 模拟
    let closedId = '';
    const origClose = win.App.Tabs.close;
    win.App.Tabs.close = (id) => { closedId = id; };
    closeBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    assert.strictEqual(closedId, 'sess-a', 'close button click should trigger App.Tabs.close via delegation');
    win.App.Tabs.close = origClose;
  });

  it("关闭 tab 后会话栏高亮同步", () => {
    store["session-tabs"] = JSON.stringify(["sess-a", "sess-b"]);
    store["active-session-tab"] = "sess-b";
    store["session-tab-labels"] = JSON.stringify({});
    win.__state._sessionTabs = ["sess-a", "sess-b"];
    win.renderSessionTabs("sess-b");

    let tabs = Array.from(doc.querySelectorAll("#main-tabs .session-tab"));
    assert.strictEqual(tabs.length, 2);
    const activeIdx = tabs[0].classList.contains("active") ? 0 : 1;
    assert.strictEqual(tabs[activeIdx].dataset.tab, "sess-b");

    // 关闭 sess-a（非当前 tab），sess-b 仍存活并保持高亮
    win.App.Tabs.close("sess-a");

    tabs = Array.from(doc.querySelectorAll("#main-tabs .session-tab"));
    assert.strictEqual(tabs.length, 1);
    assert.ok(tabs[0].classList.contains("active"));
    assert.strictEqual(tabs[0].dataset.tab, "sess-b");
  });

  it("关闭中间 active session tab 切换到右侧相邻 tab", () => {
    store["session-tabs"] = JSON.stringify(["sess-a", "sess-b", "sess-c"]);
    store["active-session-tab"] = "sess-b";
    win.__state._sessionTabs = ["sess-a", "sess-b", "sess-c"];
    win.__state._activeSessionTabId = "sess-b";
    win.renderSessionTabs("sess-b");

    const tabsBefore = Array.from(doc.querySelectorAll("#main-tabs .session-tab"));
    assert.strictEqual(tabsBefore.length, 3);
    assert.ok(tabsBefore[1].classList.contains("active"));

    // 关闭中间 active tab → 应切换到右侧 c
    win.App.Tabs.close("sess-b");

    const tabsAfter = Array.from(doc.querySelectorAll("#main-tabs .session-tab"));
    assert.strictEqual(tabsAfter.length, 2);
    assert.strictEqual(tabsAfter[1].dataset.tab, "sess-c", "closing middle active → right neighbor");
    assert.ok(tabsAfter[1].classList.contains("active"), "right neighbor becomes active");
  });

  it("layout() 重建 DOM 后事件委托仍有效", () => {
    store["session-tabs"] = JSON.stringify(["sess-rebuild"]);
    win.__state._sessionTabs = ["sess-rebuild"];
    // 模拟 layout() 重建 #app → #main-tabs 被替换
    const app = win.document.getElementById('app') || (() => {
      const a = win.document.createElement('div');
      a.id = 'app';
      win.document.body.prepend(a);
      return a;
    })();
    app.innerHTML = '<div id="main-tabs"></div>';
    // 重新渲染
    win.renderTabs();
    // 验证关闭按钮仍可触发委托
    const rebuiltBtn = doc.querySelector("#main-tabs .session-tab .tb-close");
    assert.ok(rebuiltBtn, 'rebuild: close button should exist');
    let closedRebuild = '';
    const orig = win.App.Tabs.close;
    win.App.Tabs.close = (id) => { closedRebuild = id; };
    rebuiltBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    assert.strictEqual(closedRebuild, 'sess-rebuild', 'rebuild: close click should trigger via delegation');
    win.App.Tabs.close = orig;
  });
});



