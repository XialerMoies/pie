import { describe, it, before } from "node:test";
import assert from "node:assert";
import { Window } from "happy-dom";

const win = new Window();
const doc = win.document;
global.window = win;
global.document = doc;
global.self = win;

doc.body.innerHTML = '<div id="main-tabs"></div><div id="sl"></div><div id="ms"></div>';

const store = {};
global.localStorage = {
  getItem: (key) => store[key] ?? null,
  setItem: (key, value) => { store[key] = value; },
  removeItem: (key) => { delete store[key]; },
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
};

win.App = {
  Constants: { WS_KEY: "workspace_path" },
  UI: {},
  Chat: {},
  File: {},
  Session: {},
  Settings: {},
  Git: {},
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
  throw new Error(`unexpected fetch: ${url}`);
};

win.fetch = global.fetch;

before(async () => {
  const ts = Date.now();
  await import(`../src/frontend/dashboard/dashboard-layout.ts?t=${ts}`);
  await import(`../src/frontend/dashboard/dashboard-sessions.ts?t=${ts}`);
  win.renderTabs();
}, 10000);

describe("session ui state", () => {
  it("默认对话标签页可以关闭", () => {
    store["session-tabs"] = "[]";
    delete store["chat-tab-open"];
    win.__state._sessionTabs = [];
    win.__state._fileTabs = [];
    win.__state._activeFileTab = null;
    win.renderTabs();

    assert.ok(doc.querySelector("#main-tabs .tb-item[data-tab='chat']")?.textContent.includes("对话"));
    win.closeChatTab();

    assert.strictEqual(doc.querySelector("#main-tabs .tb-item[data-tab='chat']"), null);
    assert.strictEqual(localStorage.getItem("chat-tab-open"), "0");
  });

  it("loadSessions 不会把后端 activeSessionId 当作打开高亮", async () => {
    store["session-tabs"] = "[]";
    win.__state._sessionTabs = [];
    localStorage.setItem("workspace_path", "E:\\my-code-agent");
    await win.loadSessions();
    await new Promise((resolve) => setTimeout(resolve, 10));

    const sessionTabs = Array.from(doc.querySelectorAll("#session-tabs .session-tab.tb-item")).map((node) => node.textContent || "");
    assert.strictEqual(sessionTabs.length, 0);
    assert.ok(doc.querySelector("#main-tabs > #session-tabs"));
    assert.strictEqual(doc.querySelectorAll("body > #session-tabs").length, 0);
    const activeItems = Array.from(doc.querySelectorAll("#sl .sess-item.active"));
    assert.strictEqual(activeItems.length, 0);
    assert.strictEqual(localStorage.getItem("last-session-id"), null);
    const groupHeads = Array.from(doc.querySelectorAll("#sl .session-group-head")).map((node) => node.textContent || "");
    assert.ok(groupHeads.some((text) => text.includes("当前工作区")));
    assert.strictEqual(doc.querySelector("#sl .thread-badge-running"), null);
    assert.strictEqual(doc.querySelector("#sl .thread-badge-success"), null);
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
    await win.switchSession("sess-a");
    await new Promise((resolve) => setTimeout(resolve, 10));
    sessionListState = 1;
    await win.switchSession("sess-b");
    await new Promise((resolve) => setTimeout(resolve, 10));

    const tabs = Array.from(doc.querySelectorAll("#session-tabs .session-tab.tb-item")).map((node) => node.textContent || "");
    assert.ok(tabs.some((text) => text.includes("A")));
    assert.ok(tabs.some((text) => text.includes("B")));
    assert.ok(doc.querySelector("#session-tabs .session-tab.tb-item.active")?.textContent.includes("B"));
    const activeItems = Array.from(doc.querySelectorAll("#sl .sess-item.active"));
    assert.strictEqual(activeItems.length, 2);
    assert.ok(activeItems.some((node) => node.textContent.includes("A")));
    assert.ok(activeItems.some((node) => node.textContent.includes("B")));

    win.closeSessionTab("sess-a");
    await new Promise((resolve) => setTimeout(resolve, 10));

    const tabsAfterClose = Array.from(doc.querySelectorAll("#session-tabs .session-tab.tb-item")).map((node) => node.textContent || "");
    assert.ok(!tabsAfterClose.some((text) => text.includes("A")));
    assert.ok(tabsAfterClose.some((text) => text.includes("B")));

    win.closeSessionTab("sess-b");
    await new Promise((resolve) => setTimeout(resolve, 10));

    assert.strictEqual(doc.querySelectorAll("#session-tabs .session-tab.tb-item").length, 0);
    sessionListState = 0;
    await win.loadSessions();
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.strictEqual(doc.querySelectorAll("#session-tabs .session-tab.tb-item").length, 0);
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

    const tab = doc.querySelector("#session-tabs .session-tab.tb-item");
    assert.ok(tab?.textContent.includes("新会话"));
    assert.strictEqual(localStorage.getItem("last-session-id"), null);
    assert.ok(localStorage.getItem("active-session-tab")?.startsWith("draft:"));
    assert.ok(!fetchCalls.some(([url, method]) => String(url).includes("/api/sessions/new") && method === "POST"));
    assert.strictEqual(win.__state._activeFileTab, null);
    assert.notStrictEqual(doc.querySelector("#ms")?.style.display, "none");
    assert.strictEqual(doc.querySelector("#file-content")?.style.display, "none");

    win.__state._activeFileTab = "src/demo.ts";
    await win.switchSession(localStorage.getItem("active-session-tab"));
    await new Promise((resolve) => setTimeout(resolve, 10));

    assert.strictEqual(win.__state.M.length, 0);
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

    assert.ok(doc.querySelector("#session-tabs .session-tab.tb-item")?.textContent.includes("手动标题"));
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

    assert.ok(pinButton?.getAttribute("onclick")?.includes("pinSession('sess-b',false)"));
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
    assert.strictEqual(localStorage.getItem("last-session-id"), "branch-new");
    assert.strictEqual(win.__state.M.length, 2);
    assert.strictEqual(win.__state.M[1].content, "分支上下文");
  });

  it("switchSession 会写回 activeSessionId、消息列表和会话高亮", async () => {
    sessionListState = 1;
    win.__state.M = [{ role: "user", content: "旧消息" }];
    await win.switchSession("sess-b");
    await new Promise((resolve) => setTimeout(resolve, 20));

    assert.strictEqual(localStorage.getItem("last-session-id"), "sess-b");
    assert.strictEqual(win.__state.M.length, 2);
    assert.strictEqual(win.__state.M[1].content, "切换后");

    const activeItems = Array.from(doc.querySelectorAll("#sl .sess-item.active"));
    assert.strictEqual(activeItems.length, 1);
    assert.ok(activeItems[0].textContent.includes("B"));
    assert.ok(fetchCalls.some(([, method]) => method === "POST"));
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
});