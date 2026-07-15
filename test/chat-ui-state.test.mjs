import { describe, it, beforeEach } from "node:test";
import assert from "node:assert";
import { Window } from "happy-dom";

function setupDom() {
  const win = new Window();
  const doc = win.document;
  global.window = win;
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
    await import(`../src/frontend/dashboard/dashboard-chat.ts?t=${ts}`);
    env.win.bind();
  });

  it("消息未变化时 updateUI 不重绘消息区", () => {
    const panel = env.doc.getElementById("ms");
    env.win.updateUI();
    const firstHtml = panel.innerHTML;

    let redraws = 0;
    const original = Object.getOwnPropertyDescriptor(env.win.Element.prototype, "innerHTML");
    assert.ok(original?.set && original?.get);
    Object.defineProperty(panel, "innerHTML", {
      configurable: true,
      get() { return original.get.call(this); },
      set(value) { redraws += 1; return original.set.call(this, value); },
    });

    const input = env.doc.getElementById("ci");
    input.value = "只改变发送按钮状态";
    env.win.updateUI();

    assert.strictEqual(redraws, 0);
    assert.strictEqual(panel.innerHTML, firstHtml);

    Object.defineProperty(panel, "innerHTML", original);
  });

  it("消息变化时 updateUI 会重绘消息区", () => {
    const panel = env.doc.getElementById("ms");
    env.win.updateUI();

    let redraws = 0;
    const original = Object.getOwnPropertyDescriptor(env.win.Element.prototype, "innerHTML");
    assert.ok(original?.set && original?.get);
    Object.defineProperty(panel, "innerHTML", {
      configurable: true,
      get() { return original.get.call(this); },
      set(value) { redraws += 1; return original.set.call(this, value); },
    });

    env.win.__state.M[0].content = "hello again";
    env.win.updateUI();

    assert.strictEqual(redraws, 1);
    assert.ok(panel.innerHTML.includes("hello again"));

    Object.defineProperty(panel, "innerHTML", original);
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
      localStorage.setItem("session-tabs", JSON.stringify([newId]));
      localStorage.setItem("active-session-tab", newId);
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

    assert.strictEqual(localStorage.getItem("last-session-id"), "real-session");
    assert.ok(!fetchCalls.some(([url, method]) => String(url).includes("/api/sessions/delete") && method === "POST"));
  });
});