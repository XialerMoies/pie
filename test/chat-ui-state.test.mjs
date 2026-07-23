import { describe, it, beforeEach } from "node:test";
import assert from "node:assert";
import { Window } from "happy-dom";

function setupDom() {
  const win = new Window();
  const doc = win.document;
  global.window = win;
global.mark = () => {};
global.logTiming = () => {};

  global.document = doc;
  global.self = win;
  global.localStorage = win.localStorage;
  global.setTimeout = setTimeout;
  global.clearTimeout = clearTimeout;
  global.setInterval = () => 0;
  global.clearInterval = () => {};
  global.requestAnimationFrame = (fn) => setTimeout(fn, 0);
  global.cancelAnimationFrame = (id) => clearTimeout(id);

  doc.body.innerHTML = [
    '<div id="ms"></div>',
    '<textarea id="ci"></textarea>',
    '<button id="cs"></button>',
    '<button id="fi-model-btn"></button>',
    '<button id="fi-mode-btn"></button>',
    '<button id="fi-file-btn"></button>',
    '<div id="fi"></div>',
    '<div id="fi-slash"></div>',
  ].join('');

  win.__state = {
    D: null,
    M: [{ role: "assistant", content: "hello" }],
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
    Chat: {
      handleSlash: () => {},
      loadModeState: () => {},
      showModePopup: () => {},
      getPendingAttachments: () => [],
      clearAttachments: () => {},
      buildInstruction: (message) => message,
    },
    File: {},
    Session: {},
    Settings: {},
    Git: {},
  };
  global.App = win.App;

  global.$ = (id) => doc.getElementById(id);
  global.S = (name, size = 16) => `<svg width="${size}" height="${size}"><use href="#${name}"/></svg>`;
  global.E = (value) => String(value ?? "");
  global.sb = () => {};
  global.toast = () => {};
  global.loadSessions = () => {};
  global.getD = async () => {};
  global.renderPanel = () => {};
  global.ExplorerService = { getWorkspacePath: () => "", _getTree: () => null };
  global.fetch = async () => ({ ok: true, json: async () => ({}) });
  win.fetch = global.fetch;
  win.msgs = () => win.__state.M.map((message) => `<div class="m"><div class="mt">${message.content}</div></div>`).join('');

  return { win, doc };
}

describe("chat ui state", () => {
  let env;

  beforeEach(async () => {
    env = setupDom();
    const ts = Date.now() + Math.random();
    await import(`../src/frontend/chat/chat-render.ts?t=${ts}`);
    await import(`../src/frontend/dashboard/dashboard-chat.ts?t=${ts}`);
    await import(`../src/frontend/dashboard/dashboard-sessions.ts?t=${ts}`);
    env.win.bind();
  });

  it("消息未变化时 updateUI 不重绘消息区", () => {
    const panel = env.doc.getElementById("ms");
    env.win.updateUI();
    const firstHtml = panel.innerHTML;

    let replaces = 0;
    const origReplaceWith = env.win.Element.prototype.replaceWith;
    env.win.Element.prototype.replaceWith = function(...args) {
      if (this.parentNode === panel || (panel && panel.contains(this))) replaces++;
      return origReplaceWith.apply(this, args);
    };

    const input = env.doc.getElementById("ci");
    input.value = "只改变发送按钮状态";
    env.win.updateUI();

    assert.strictEqual(replaces, 0, "消息未变化时不应触发 replaceWith");
    assert.strictEqual(panel.innerHTML, firstHtml);

    env.win.Element.prototype.replaceWith = origReplaceWith;
  });

  it("消息变化时 updateUI 会重绘消息区", () => {
    const panel = env.doc.getElementById("ms");
    env.win.updateUI();

    let replaces = 0;
    const origReplaceWith = env.win.Element.prototype.replaceWith;
    env.win.Element.prototype.replaceWith = function(...args) {
      if (this.parentNode === panel || (panel && panel.contains(this))) replaces++;
      return origReplaceWith.apply(this, args);
    };

    env.win.__state.M[0].content = "hello again";
    env.win.updateUI();

    assert.ok(replaces > 0, "消息变化时应有 replaceWith 调用");
    assert.ok(panel.innerHTML.includes("hello again"));

    env.win.Element.prototype.replaceWith = origReplaceWith;
  });

  it("同长度内容替换仍触发重绘", () => {
    const panel = env.doc.getElementById("ms");
    env.win.updateUI();

    let replaces = 0;
    const origReplaceWith = env.win.Element.prototype.replaceWith;
    env.win.Element.prototype.replaceWith = function(...args) {
      if (this.parentNode === panel || (panel && panel.contains(this))) replaces++;
      return origReplaceWith.apply(this, args);
    };

    // 同长度替换：hello(5) → world(5)，content.length 不变
    env.win.__state.M[0].content = "world";
    env.win.updateUI();

    assert.ok(replaces > 0, "同长度内容替换也应触发 replaceWith");
    assert.ok(panel.innerHTML.includes("world"));

    env.win.Element.prototype.replaceWith = origReplaceWith;
  });

  it("done 使用服务端最终 blocks 覆盖 live partial blocks", () => {
    const streams = [];
    class MockEventSource {
      constructor() {
        this.onmessage = null;
        this.onerror = null;
        streams.push(this);
      }
      close() {}
    }
    global.EventSource = MockEventSource;
    env.win.EventSource = MockEventSource;

    const input = env.doc.getElementById("ci");
    input.value = "检查状态";
    input.dispatchEvent(new env.win.KeyboardEvent("keydown", { key: "Enter" }));

    const stream = streams[0];
    assert.ok(stream, "应建立 SSE 连接");
    stream.onmessage({
      data: JSON.stringify({
        type: "block",
        block: { type: "text", text: "partial", blockId: "live-text", seq: 1 },
      }),
    });

    const finalBlocks = [
      { type: "text", text: "final", blockId: "final-text", seq: 1 },
      { type: "step", text: "完成", status: "success", blockId: "final-step", seq: 2 },
    ];
    stream.onmessage({
      data: JSON.stringify({ type: "done", text: "final", blocks: finalBlocks }),
    });

    const last = env.win.__state.M.at(-1);
    assert.deepStrictEqual(last.blocks, finalBlocks);
    assert.strictEqual(last.streaming, false);
  });

  it("block SSE 更新不重绘整个消息区", () => {
    let blockUpdates = 0;
    env.win.App.Chat.updateLastBlock = () => {
      blockUpdates += 1;
      return true;
    };
    const streams = [];
    class MockEventSource {
      constructor() { this.onmessage = null; this.onerror = null; streams.push(this); }
      close() {}
    }
    global.EventSource = MockEventSource;
    env.win.EventSource = MockEventSource;

    const input = env.doc.getElementById("ci");
    input.value = "流式节点";
    input.dispatchEvent(new env.win.KeyboardEvent("keydown", { key: "Enter" }));
    const stream = streams[0];
    const panel = env.doc.getElementById("ms");
    const descriptor = Object.getOwnPropertyDescriptor(env.win.Element.prototype, "innerHTML");
    let redraws = 0;
    let replaces = 0;
    Object.defineProperty(panel, "innerHTML", {
      configurable: true,
      get() { return descriptor.get.call(this); },
      set(value) { redraws += 1; return descriptor.set.call(this, value); },
    });
    stream.onmessage({
      data: JSON.stringify({ type: "block", block: { type: "tool_use", blockId: "tool-1", seq: 1 } }),
    });

    assert.strictEqual(blockUpdates, 1);
    assert.strictEqual(redraws, 0, "block 更新不能重绘整个消息区");
    Object.defineProperty(panel, "innerHTML", descriptor);
  });

  it("done SSE 不替换最后一条 assistant 消息", () => {
    const streams = [];
    class MockEventSource {
      constructor() { this.onmessage = null; this.onerror = null; streams.push(this); }
      close() {}
    }
    global.EventSource = MockEventSource;
    env.win.EventSource = MockEventSource;
    env.win.App.Chat.updateLastBlock = () => true;

    const input = env.doc.getElementById("ci");
    input.value = "流式结束";
    input.dispatchEvent(new env.win.KeyboardEvent("keydown", { key: "Enter" }));
    const stream = streams[0];
    const panel = env.doc.getElementById("ms");
    stream.onmessage({
      data: JSON.stringify({ type: "block", block: { type: "tool_use", status: "running", name: "command", toolCallId: "call1", blockId: "tool-1", seq: 1, output: "step 1\n" } }),
    });
    const assistantBefore = panel.querySelectorAll('.m')[panel.querySelectorAll('.m').length - 1];
    const descriptor = Object.getOwnPropertyDescriptor(env.win.Element.prototype, "innerHTML");
    let panelRedraws = 0;
    let messageReplaces = 0;
    const origReplaceWith = env.win.Element.prototype.replaceWith;
    Object.defineProperty(panel, "innerHTML", {
      configurable: true,
      get() { return descriptor.get.call(this); },
      set(value) { panelRedraws += 1; return descriptor.set.call(this, value); },
    });
    env.win.Element.prototype.replaceWith = function(...args) {
      if (this === assistantBefore || this.parentNode === panel) messageReplaces += 1;
      return origReplaceWith.apply(this, args);
    };

    stream.onmessage({
      data: JSON.stringify({
        type: "done",
        text: "",
        blocks: [
          { type: "tool_use", status: "success", name: "command", toolCallId: "call1", blockId: "tool-1", seq: 1, output: "step 1\ndone\n" },
          { type: "tool_result", toolUseId: "call1", output: "done\n", blockId: "result-1", seq: 2 },
        ],
      }),
    });

    assert.strictEqual(panelRedraws, 0, "done 不能重绘整个消息区");
    assert.strictEqual(messageReplaces, 0, "done 不能替换最后一条 assistant 消息");
    assert.strictEqual(panel.querySelectorAll('.m')[panel.querySelectorAll('.m').length - 1], assistantBefore);
    assert.strictEqual(assistantBefore.classList.contains('go'), false);
    assert.ok(assistantBefore.textContent.includes("done"));

    env.win.Element.prototype.replaceWith = origReplaceWith;
    Object.defineProperty(panel, "innerHTML", descriptor);
  });

  it("block 流开始后 delta 不创建重复 assistant 消息", () => {
    env.win.__state.M = [];
    env.win.App.Chat.updateLastBlock = () => true;
    const streams = [];
    class MockEventSource {
      constructor() { this.onmessage = null; this.onerror = null; streams.push(this); }
      close() {}
    }
    global.EventSource = MockEventSource;
    env.win.EventSource = MockEventSource;

    const input = env.doc.getElementById("ci");
    input.value = "你好";
    input.dispatchEvent(new env.win.KeyboardEvent("keydown", { key: "Enter" }));
    const stream = streams[0];
    stream.onmessage({ data: JSON.stringify({ type: "delta", text: "你" }) });
    stream.onmessage({ data: JSON.stringify({ type: "block", block: { type: "text", text: "你", blockId: "text-0", seq: 1 } }) });
    stream.onmessage({ data: JSON.stringify({ type: "delta", text: "好" }) });
    stream.onmessage({ data: JSON.stringify({ type: "block", block: { type: "text", text: "你好", blockId: "text-0", seq: 2 } }) });
    stream.onmessage({ data: JSON.stringify({ type: "delta", text: "！" }) });

    assert.deepStrictEqual(env.win.__state.M.map(message => message.role), ["user", "assistant"]);
    assert.strictEqual(env.win.__state.M[1].blocks.length, 1);
    assert.strictEqual(env.win.__state.M[1].blocks[0].text, "你好");
  });

  it("默认空白页发送后删除临时会话", async () => {
    env.win.__state.M = [];
    const streams = [];
    class MockEventSource {
      constructor() { this.onmessage = null; this.onerror = null; streams.push(this); }
      close() {}
    }
    global.EventSource = MockEventSource;
    env.win.EventSource = MockEventSource;

    const fetchCalls = [];
    global.fetch = async (url, init = {}) => {
      fetchCalls.push([url, init.method || "GET", init]);
      if (String(url).includes("/api/sessions/new")) return { ok: true, json: async () => ({ ok: true, id: "temp-session" }) };
      return { ok: true, json: async () => ({ ok: true }) };
    };
    env.win.fetch = global.fetch;

    const input = env.doc.getElementById("ci");
    input.value = "临时问题";
    input.dispatchEvent(new env.win.KeyboardEvent("keydown", { key: "Enter" }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.ok(fetchCalls.some(([url, method]) => String(url).includes("/api/sessions/new") && method === "POST"));
    assert.ok(fetchCalls.some(([url, method]) => String(url).includes("/api/chat") && method === "POST"));

    streams[0].onmessage({ data: JSON.stringify({ type: "done", text: "临时回答", sessionId: "temp-session" }) });
    await new Promise((resolve) => setTimeout(resolve, 0));

    const deleteCall = fetchCalls.find(([url, method]) => String(url).includes("/api/sessions/delete") && method === "POST");
    assert.ok(deleteCall);
    assert.strictEqual(JSON.parse(deleteCall[2].body).id, "temp-session");
    assert.strictEqual(localStorage.getItem("last-session-id"), null);
  });

  it("草稿标签首次发送会升级为真实会话", async () => {
    env.win.__state.M = [];
    env.win.__state._sessionTabs = ["draft:test"];
    localStorage.setItem("session-tabs", JSON.stringify(["draft:test"]));
    localStorage.setItem("active-session-tab", "draft:test");
    const streams = [];
    class MockEventSource {
      constructor() { this.onmessage = null; this.onerror = null; streams.push(this); }
      close() {}
    }
    global.EventSource = MockEventSource;
    env.win.EventSource = MockEventSource;

    let committed = null;
    env.win.commitSessionTab = (oldId, newId) => {
      committed = [oldId, newId];
      env.win.__state._sessionTabs = [newId];
    };

    const fetchCalls = [];
    global.fetch = async (url, init = {}) => {
      fetchCalls.push([url, init.method || "GET", init]);
      if (String(url).includes("/api/sessions/new")) return { ok: true, json: async () => ({ ok: true, id: "real-session" }) };
      return { ok: true, json: async () => ({ ok: true }) };
    };
    env.win.fetch = global.fetch;

    const input = env.doc.getElementById("ci");
    input.value = "持久问题";
    input.dispatchEvent(new env.win.KeyboardEvent("keydown", { key: "Enter" }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.deepStrictEqual(committed, ["draft:test", "real-session"]);
    assert.ok(fetchCalls.some(([url, method]) => String(url).includes("/api/sessions/new") && method === "POST"));
    assert.ok(fetchCalls.some(([url, method]) => String(url).includes("/api/chat") && method === "POST"));

    streams[0].onmessage({ data: JSON.stringify({ type: "done", text: "持久回答", sessionId: "real-session" }) });
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.deepStrictEqual(env.win.__state._sessionTabs, ["real-session"]);
    assert.ok(!fetchCalls.some(([url, method]) => String(url).includes("/api/sessions/delete") && method === "POST"));
  });

  it("legacy localStorage keys no longer written by session functions", () => {
    const LEGACY_KEYS = ["session-tabs", "active-session-tab", "last-session-id", "session-tab-labels"];
    for (const key of LEGACY_KEYS) localStorage.removeItem(key);

    // migrateSessionTabLabels must NOT write to localStorage
    localStorage.setItem("session-tab-labels", JSON.stringify({ "sess-old": "新会话" }));
    const before = localStorage.getItem("session-tab-labels");
    if (typeof env.win.migrateSessionTabLabels === "function") env.win.migrateSessionTabLabels();
    assert.strictEqual(localStorage.getItem("session-tab-labels"), before,
      "migrateSessionTabLabels 不能改写旧的 session-tab-labels");
    localStorage.removeItem("session-tab-labels"); // 恢复干净状态

    // setActiveSessionTabId used to write active-session-tab and last-session-id
    env.win.__state._sessionTabs = ["sess-a"];
    env.win.setActiveSessionTabId("sess-a");
    for (const key of LEGACY_KEYS) {
      assert.strictEqual(localStorage.getItem(key), null, `setActiveSessionTabId: ${key}`);
    }

    // commitSessionTab used to write session-tabs, session-tab-labels, active-session-tab, last-session-id
    env.win.__state._sessionTabs = ["draft:regression"];
    env.win.commitSessionTab("draft:regression", "sess-real", "手动标题");
    for (const key of LEGACY_KEYS) {
      assert.strictEqual(localStorage.getItem(key), null, `commitSessionTab: ${key}`);
    }
    assert.deepStrictEqual(env.win.__state._sessionTabs, ["sess-real"]);
    assert.strictEqual(env.win.__state._sessionTabLabels?.["sess-real"], "手动标题");
  });

  it("_rv 是唯一检测手段时仍触发重绘（同前缀后缀中间变化）", () => {
    const panel = env.doc.getElementById("ms");
    env.win.updateUI();

    let replaces = 0;
    const origReplaceWith = env.win.Element.prototype.replaceWith;
    env.win.Element.prototype.replaceWith = function (...args) {
      if (this.parentNode === panel || (panel && panel.contains(this))) replaces++;
      return origReplaceWith.apply(this, args);
    };

    const prefix = "A".repeat(40), suffix = "A".repeat(40);
    env.win.__state.M[0].content = prefix + "B".repeat(20) + suffix;
    env.win.__state.M[0]._rv = 1;
    env.win.updateUI();

    assert.ok(replaces > 0, "_rv bump 应触发 replaceWith");
    assert.ok(panel.innerHTML.includes("B".repeat(20)));

    env.win.Element.prototype.replaceWith = origReplaceWith;
  });

  it("resetMsgKeys 暴露在 App.Chat 上", () => {
    assert.ok(typeof App.Chat.resetMsgKeys === "function", "resetMsgKeys 应是函数");
  });

  it("空 M 时 updateUI 渲染欢迎屏", () => {
    env.win.__state.M = [];
    env.win.updateUI();
    const panel = env.doc.getElementById("ms");
    assert.ok(panel.innerHTML.includes("Pi"), "空 M 时应渲染欢迎屏");
    assert.ok(panel.innerHTML.includes("编码"), "欢迎屏应有提示文字");
  });
});