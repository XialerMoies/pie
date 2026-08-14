import { describe, it, beforeEach } from "node:test";
import assert from "node:assert";
import { readFileSync } from "node:fs";
import { Window } from "happy-dom";

function attachEventListeners(source) {
  source.addEventListener = (type, listener) => { source[`on${type}`] = listener; };
  source.removeEventListener = (type, listener) => {
    if (source[`on${type}`] === listener) source[`on${type}`] = null;
  };
}

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
    '<nav id="chat-timeline" class="chat-timeline" aria-label="会话时间线" aria-hidden="true"></nav>',
    '<button id="chat-jump-latest" aria-hidden="true" tabindex="-1"></button>',
    '<textarea id="ci"></textarea>',
    '<button id="cs"></button>',
    '<button id="chat-stop"></button>',
    '<button id="chat-note-mode"></button>',
    '<button id="fi-model-btn"></button>',
    '<button id="fi-mode-btn"></button>',
    '<button id="fi-file-btn"></button>',
    '<div id="fi"></div>',
    '<div id="fi-slash"></div>',
  ].join('');

  const testState = {
    CT: "chat",
    _activePanel: "explorer",
    _fileTabs: [],
    _activeFileTab: null,
    _sessionTabs: [],
    _activeSessionTabId: null,
  };
  const uiState = {
    workspacePath: "",
    activeView: { type: "chat" },
    tabs: { items: [], activeId: null, sessions: [], files: [], chatOpen: true, labels: {}, titleSources: {} },
    panel: { active: "explorer", closed: false, width: 260 },
    recent: { sessions: {} },
  };
  const preferences = new Map();
  const calls = [];
  const scrollState = { scrollTop: 0, scrollHeight: 0, clientHeight: 0, lastScrollTo: null };
  const messages = doc.getElementById("ms");
  Object.defineProperties(messages, {
    scrollTop: { configurable: true, get: () => scrollState.scrollTop, set: (value) => { scrollState.scrollTop = Number(value); } },
    scrollHeight: { configurable: true, get: () => scrollState.scrollHeight },
    clientHeight: { configurable: true, get: () => scrollState.clientHeight },
  });
  messages.scrollTo = (options) => {
    scrollState.lastScrollTo = options;
    scrollState.scrollTop = Number(options.top);
  };
  win.App = {
    Constants: { WS_KEY: "workspace_path" },
    State: {
      getWorkspacePath: () => win.localStorage.getItem("workspace_path") || "",
      setWorkspacePath: (path) => win.localStorage.setItem("workspace_path", path),
      hydrate: async () => uiState,
      saveNow: async () => true,
      getSnapshot: () => JSON.parse(JSON.stringify(uiState)),
      syncTabs: (items, activeId) => { uiState.tabs.items = items.map((item) => ({ ...item })); uiState.tabs.activeId = activeId; },
      updateSessionMetadata: (labels, titleSources) => { uiState.tabs.labels = { ...labels }; uiState.tabs.titleSources = { ...titleSources }; },
      updatePanel: (panel) => { uiState.panel = { ...uiState.panel, ...panel }; },
      setChatOpen: (open) => { uiState.tabs.chatOpen = open; },
      touchSession: () => {},
    },
    Preferences: {
      get(key, fallback) {
        return preferences.has(key) ? preferences.get(key) : fallback;
      },
      getBoolean(key, fallback = false) {
        const value = preferences.has(key) ? preferences.get(key) : (fallback ? "1" : "0");
        if (value === "1" || value === "true") return true;
        if (value === "0" || value === "false") return false;
        return fallback;
      },
      getNumber(key, fallback, min = -Infinity, max = Infinity) {
        if (!preferences.has(key)) return fallback;
        const raw = String(preferences.get(key));
        if (!raw.trim()) return fallback;
        const value = Number(raw);
        if (!Number.isFinite(value)) return fallback;
        return Math.max(min, Math.min(max, value));
      },
    },
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
    FileDiff: { render: () => "" },   // 渲染路径会调 App.FileDiff.render（bundle 里 file-diff-render.ts 总绑定）；测试不测 diff，空 mock 防崩
    Session: {},
    Settings: {},
    Git: {},
  };
  global.App = win.App;
  Object.defineProperty(testState, "M", {
    get: () => win.App.ChatState.getMessages(),
    set: (value) => win.App.ChatState.replaceMessages(value),
  });
  win.App.Tabs = {
    getSessionTabIds: () => [...testState._sessionTabs],
    getActiveSessionTabId: () => testState._activeSessionTabId || null,
    getActiveTab: () => {
      const id = testState._activeSessionTabId;
      return id ? { id, kind: id.startsWith("draft:") ? "chat" : "session", title: id, order: 0 } : null;
    },
    getTab: (id) => testState._sessionTabs.includes(id) ? { id, kind: id.startsWith("draft:") ? "chat" : "session", title: id, order: 0 } : undefined,
    openTab: (tab) => { if (!testState._sessionTabs.includes(tab.id)) testState._sessionTabs.push(tab.id); },
    closeTab: (id) => { testState._sessionTabs = testState._sessionTabs.filter((tabId) => tabId !== id); },
    replaceTab: (id, updates) => {
      const index = testState._sessionTabs.indexOf(id);
      if (index >= 0 && updates.id) testState._sessionTabs[index] = updates.id;
    },
    activateTab: (id) => { testState._activeSessionTabId = id; },
  };

  global.$ = (id) => doc.getElementById(id);
  global.S = (name, size = 16) => `<svg width="${size}" height="${size}"><use href="#${name}"/></svg>`;
  global.E = (value) => String(value ?? "");
  global.sb = () => {};
  global.toast = (message, type) => calls.push(["toast", message, type]);
  global.loadSessions = () => {};
  global.getD = async () => {};
  global.renderPanel = () => {};
  global.ExplorerService = { getWorkspacePath: () => "", _getTree: () => null };
  global.fetch = async () => ({ ok: true, json: async () => ({}) });
  win.fetch = global.fetch;
  win.msgs = () => testState.M.map((message) => `<div class="m"><div class="mt">${message.content}</div></div>`).join('');

  return {
    win,
    doc,
    state: testState,
    calls,
    setPreference(key, value) { preferences.set(key, typeof value === "boolean" ? (value ? "1" : "0") : value); },
    setScrollMetrics(next) {
      if (next.scrollTop !== undefined) scrollState.scrollTop = Number(next.scrollTop);
      if (next.scrollHeight !== undefined) scrollState.scrollHeight = Number(next.scrollHeight);
      if (next.clientHeight !== undefined) scrollState.clientHeight = Number(next.clientHeight);
    },
    getScrollTop() { return scrollState.scrollTop; },
    getLastScrollTo() { return scrollState.lastScrollTo; },
    clearLastScrollTo() { scrollState.lastScrollTo = null; },
  };
}

function refreshReadingSettings(env) {
  const refresh = env.win.App.Chat.refreshReadingSettings;
  assert.strictEqual(typeof refresh, "function", "App.Chat.refreshReadingSettings should be registered");
  refresh();
}

function refreshReadingSettingsIfAvailable(env) {
  const refresh = env.win.App.Chat.refreshReadingSettings;
  if (typeof refresh === "function") refresh();
}

describe("chat ui state", () => {
  let env;

  beforeEach(async () => {
    env = setupDom();
    const ts = Date.now() + Math.random();
    await import(`../src/frontend/services/chat-runtime-store.ts?t=${ts}`);
    env.win.App.ChatState.replaceMessages([{ role: "assistant", content: "hello" }]);
    await import(`../src/frontend/services/chat-stream.ts?t=${ts}`);
    await import(`../src/frontend/services/file-diff-render.ts?t=${ts}`);
    Object.assign(globalThis, await import(`../src/frontend/chat/subagent-state.ts?t=${ts}`));
    await import(`../src/frontend/chat/chat-composer.ts?t=${ts}`);
    await import(`../src/frontend/chat/chat-command-confirmation.ts?t=${ts}`);
    await import(`../src/frontend/chat/chat-model-picker.ts?t=${ts}`);
    await import(`../src/frontend/chat/chat-attachment-input.ts?t=${ts}`);
    await import(`../src/frontend/chat/chat-component-views.ts?t=${ts}`);
    await import(`../src/frontend/chat/chat-subagent-views.ts?t=${ts}`);
    await import(`../src/frontend/chat/chat-event-node.ts?t=${ts}`);
    await import(`../src/frontend/chat/chat-render.ts?t=${ts}`);
    await import(`../src/frontend/chat/chat-timeline.ts?t=${ts}`);
    await import(`../src/frontend/chat/chat-reading-controls.ts?t=${ts}`);
    await import(`../src/frontend/chat/chat-sse-controller.ts?t=${ts}`);
    await import(`../src/frontend/dashboard/dashboard-chat.ts?t=${ts}`);
    await import(`../src/frontend/dashboard/session-restore.ts?t=${ts}`);
    await import(`../src/frontend/dashboard/session-activation.ts?t=${ts}`);
    await import(`../src/frontend/dashboard/session-list-panel.ts?t=${ts}`);
    await import(`../src/frontend/dashboard/dashboard-sessions.ts?t=${ts}`);
    env.win.bind();
  });

  it("selects one local file and adds it as an attachment", async () => {
    const attachments = [];
    let selectFileCalls = 0;
    env.win.electronAPI = {
      selectFile: async () => { selectFileCalls += 1; return "/workspace/src/picked.ts"; },
    };
    global.ExplorerService.getWorkspacePath = () => "/workspace";
    env.win.App.Chat.addAttachment = (attachment) => attachments.push(attachment);

    env.doc.getElementById("fi-file-btn").click();
    await new Promise((resolve) => setImmediate(resolve));

    assert.strictEqual(selectFileCalls, 1);
    assert.deepStrictEqual(attachments, [{ kind: "file", path: "src/picked.ts", name: "picked.ts" }]);
  });

  it("does nothing when local file selection is cancelled", async () => {
    const attachments = [];
    let selectFileCalls = 0;
    env.win.electronAPI = {
      selectFile: async () => { selectFileCalls += 1; return null; },
    };
    env.win.App.Chat.addAttachment = (attachment) => attachments.push(attachment);

    env.doc.getElementById("fi-file-btn").click();
    await new Promise((resolve) => setImmediate(resolve));

    assert.strictEqual(selectFileCalls, 1);
    assert.deepStrictEqual(attachments, []);
  });

  it("shows an error when local file selection rejects", async () => {
    let selectFileCalls = 0;
    env.win.electronAPI = {
      selectFile: async () => { selectFileCalls += 1; throw new Error("attachment picker failed"); },
    };

    env.doc.getElementById("fi-file-btn").click();
    await new Promise((resolve) => setImmediate(resolve));

    assert.strictEqual(selectFileCalls, 1);
    assert.ok(env.calls.some((call) => (
      call[0] === "toast" && call[1].includes("attachment picker failed") && call[2] === "error"
    )), JSON.stringify(env.calls));
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

  it("输入框随内容增高但在上限后改为内部滚动", () => {
    const input = env.doc.getElementById("ci");
    let measuredHeight = 196;
    Object.defineProperty(input, "scrollHeight", {
      configurable: true,
      get: () => measuredHeight,
    });

    input.value = "多行输入";
    input.dispatchEvent(new env.win.Event("input", { bubbles: true }));
    assert.strictEqual(input.style.height, "144px");
    assert.strictEqual(input.style.overflowY, "auto");

    measuredHeight = 48;
    input.value = "短文本";
    input.dispatchEvent(new env.win.Event("input", { bubbles: true }));
    assert.strictEqual(input.style.height, "48px");
    assert.strictEqual(input.style.overflowY, "hidden");
  });

  it("运行中 Enter 投递补充而不是关闭流，输入框保持可用", async () => {
    const calls = [];
    const previousFetch = global.fetch;
    const previousWindowFetch = env.win.fetch;
    const fetchStub = async (url, options = {}) => {
      calls.push([url, JSON.parse(options.body || "{}")]);
      return { ok: true, json: async () => ({ ok: true, mode: "steer" }) };
    };
    global.fetch = fetchStub;
    env.win.fetch = fetchStub;
    env.win.App.ChatState.getMessages().at(-1).streaming = true;
    env.win.App.ChatState.setBusy(true);
    const input = env.doc.getElementById("ci");
    input.value = "补充一个检查点";
    env.win.updateUI();
    assert.strictEqual(input.disabled, false);
    input.dispatchEvent(new env.win.KeyboardEvent("keydown", { key: "Enter" }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.strictEqual(calls[0][0], "/api/chat/note");
    assert.strictEqual(calls[0][1].message, "补充一个检查点");
    assert.strictEqual(calls[0][1].mode, "steer");
    assert.match(calls[0][1].noteId, /^note-/);
    assert.strictEqual(env.win.App.ChatState.isBusy(), true);
    assert.ok(env.win.App.ChatState.getMessages().some((message) => message.blocks?.some((block) => block.type === "user_note" && block.text === "补充一个检查点")));
    global.fetch = previousFetch;
    env.win.fetch = previousWindowFetch;
  });

  it("运行中补充作为当前 assistant 事件流节点，不新增普通 user 气泡", async () => {
    const calls = [];
    const previousFetch = global.fetch;
    const previousWindowFetch = env.win.fetch;
    const fetchStub = async (url, options = {}) => {
      calls.push([url, JSON.parse(options.body || "{}")]);
      return { ok: true, json: async () => ({ ok: true, mode: "steer" }) };
    };
    global.fetch = fetchStub;
    env.win.fetch = fetchStub;
    env.win.App.ChatState.replaceMessages([
      { role: "user", content: "初始检查" },
      {
        role: "assistant", content: "", streaming: true, turnId: "turn-1",
        blocks: [{ type: "tool", name: "command", status: "running", blockId: "tool-1", seq: 1 }],
      },
    ]);
    env.win.App.ChatState.setBusy(true);
    env.win.updateUI();

    const input = env.doc.getElementById("ci");
    input.value = "第二阶段完成后检查 package.json";
    input.dispatchEvent(new env.win.KeyboardEvent("keydown", { key: "Enter" }));
    await new Promise((resolve) => setTimeout(resolve, 0));

    const messages = env.win.App.ChatState.getMessages();
    assert.deepStrictEqual(messages.map((message) => message.role), ["user", "assistant"]);
    assert.strictEqual(messages[1].blocks.length, 2);
    assert.strictEqual(messages[1].blocks[1].type, "user_note");
    assert.strictEqual(messages[1].blocks[1].text, "第二阶段完成后检查 package.json");
    assert.strictEqual(messages[1].blocks[1].status, "delivered");
    assert.strictEqual(messages[1].blocks[1].mode, "steer");
    assert.match(env.doc.getElementById("ms").innerHTML, /trace-user-note/);
    assert.ok(env.doc.getElementById("ms").innerHTML.includes("第二阶段完成后检查 package.json"));
    assert.ok(env.doc.getElementById("ms").innerHTML.includes("已送达"));
    assert.strictEqual(calls[0][1].mode, "steer");
    assert.match(calls[0][1].noteId, /^note-/);

    global.fetch = previousFetch;
    env.win.fetch = previousWindowFetch;
  });

  it("运行中可切换 followUp，独立中止按钮仍负责 stop", async () => {
    const calls = [];
    const previousFetch = global.fetch;
    const previousWindowFetch = env.win.fetch;
    const fetchStub = async (url, options = {}) => {
      calls.push([url, JSON.parse(options.body || "{}")]);
      return { ok: true, json: async () => ({ ok: true, mode: "followUp" }) };
    };
    global.fetch = fetchStub;
    env.win.fetch = fetchStub;
    let closed = 0;
    const originalClose = env.win.App.ChatStream.close;
    env.win.App.ChatStream.close = () => { closed++; };
    env.win.App.ChatState.getMessages().at(-1).streaming = true;
    env.win.App.ChatState.setBusy(true);
    env.win.updateUI();
    const mode = env.doc.getElementById("chat-note-mode");
    assert.notStrictEqual(mode.style.display, "none");
    mode.click();
    const input = env.doc.getElementById("ci");
    input.value = "做完后再处理";
    input.dispatchEvent(new env.win.Event("input", { bubbles: true }));
    env.doc.getElementById("cs").click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.strictEqual(calls[0][0], "/api/chat/note");
    assert.strictEqual(calls[0][1].message, "做完后再处理");
    assert.strictEqual(calls[0][1].mode, "followUp");
    assert.match(calls[0][1].noteId, /^note-/);
    env.doc.getElementById("chat-stop").click();
    assert.strictEqual(closed, 1);
    env.win.App.ChatStream.close = originalClose;
    global.fetch = previousFetch;
    env.win.fetch = previousWindowFetch;
  });

  it("输入框和外框由内容高度驱动而不是被 flex:1 固定", () => {
    const css = readFileSync(new URL("../src/frontend/dashboard.css", import.meta.url), "utf8");
    const boxRule = css.match(/(?:^|\n)\.fi-box\{([^}]*)\}/)?.[1] || "";
    const inputRule = css.match(/(?:^|\n)\.fi-box textarea\{([^}]*)\}/)?.[1] || "";

    assert.match(boxRule, /(?:^|;)flex:0 0 auto(?:;|$)/);
    assert.match(inputRule, /(?:^|;)flex:0 0 auto(?:;|$)/);
    assert.match(inputRule, /(?:^|;)height:34px(?:;|$)/);
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

    env.state.M[0].content = "hello again";
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
    env.state.M[0].content = "world";
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
        this.onerror = null; attachEventListeners(this);
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

    const last = env.state.M.at(-1);
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
      constructor() { this.onmessage = null; this.onerror = null; attachEventListeners(this); streams.push(this); }
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

  it("subagent SSE updates the matching nested task node without becoming a main block", () => {
    let subagentUpdates = 0;
    env.win.App.Chat.updateSubagentEvent = () => {
      subagentUpdates += 1;
      return true;
    };
    const streams = [];
    class MockEventSource {
      constructor() { this.onmessage = null; this.onerror = null; attachEventListeners(this); streams.push(this); }
      close() {}
    }
    global.EventSource = MockEventSource;
    env.win.EventSource = MockEventSource;

    const input = env.doc.getElementById("ci");
    input.value = "delegate";
    input.dispatchEvent(new env.win.KeyboardEvent("keydown", { key: "Enter" }));
    streams[0].onmessage({
      data: JSON.stringify({ type: "subagent_event", event: {
        type: "subagent_event", protocolVersion: 1, parentToolCallId: "delegate-call-1",
        batchId: "batch-1", taskId: "task-1", seq: 1, kind: "task_started",
        status: "running", timestamp: "2026-08-12T08:00:00.000Z", payload: {},
      } }),
    });

    assert.equal(subagentUpdates, 1);
    assert.equal(env.state.M.at(-1).blocks?.length ?? 0, 0);
  });

  it("subagent events stay attached to the assistant message that owns the delegate tool", () => {
    const owner = {
      role: "assistant",
      content: "delegating",
      blocks: [{
        type: "tool",
        name: "delegate_tasks",
        toolCallId: "delegate-call-1",
        blockId: "tool-delegate-call-1",
        seq: 1,
        status: "running",
      }],
    };
    const later = { role: "assistant", content: "later message", blocks: [] };
    env.win.App.ChatState.replaceMessages([owner, later]);

    const updated = env.win.App.Chat.updateSubagentEvent({
      type: "subagent_event",
      protocolVersion: 1,
      parentToolCallId: "delegate-call-1",
      batchId: "batch-1",
      taskId: "task-1",
      seq: 1,
      kind: "task_started",
      status: "running",
      timestamp: "2026-08-12T08:00:00.000Z",
      payload: {},
    });

    assert.equal(updated, false, "an earlier message requires a scheduled full render");
    assert.equal(owner.subagentEvents?.length, 1);
    assert.equal(owner.subagentBatches?.[0]?.parentToolCallId, "delegate-call-1");
    assert.equal(later.subagentEvents, undefined);
  });

  it("done SSE 不替换最后一条 assistant 消息", () => {
    const streams = [];
    class MockEventSource {
      constructor() { this.onmessage = null; this.onerror = null; attachEventListeners(this); streams.push(this); }
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
    env.state.M = [];
    env.win.App.Chat.updateLastBlock = () => true;
    const streams = [];
    class MockEventSource {
      constructor() { this.onmessage = null; this.onerror = null; attachEventListeners(this); streams.push(this); }
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

    assert.deepStrictEqual(env.state.M.map(message => message.role), ["user", "assistant"]);
    assert.strictEqual(env.state.M[1].blocks.length, 1);
    assert.strictEqual(env.state.M[1].blocks[0].text, "你好");
  });

  it("空白页发送后保留新建会话", async () => {
    env.state.M = [];
    const streams = [];
    class MockEventSource {
      constructor() { this.onmessage = null; this.onerror = null; attachEventListeners(this); streams.push(this); }
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

    assert.ok(!fetchCalls.some(([url, method]) => String(url).includes("/api/sessions/delete") && method === "POST"));
  });

  it("启动恢复未完成时发送消息只绑定一个恢复后的会话", async () => {
    env.state.M = [];
    env.state._sessionTabs = [];
    env.state._activeSessionTabId = null;
    let releaseRestore;
    const restore = new Promise((resolve) => { releaseRestore = resolve; });
    env.win.App.SessionRestore.whenReady = () => restore;
    env.win.App.Session.ensureDraftSessionTab = () => {
      env.state._sessionTabs = ["draft:restored"];
      env.state._activeSessionTabId = "draft:restored";
      return "draft:restored";
    };

    const streams = [];
    class MockEventSource {
      constructor() { this.onmessage = null; this.onerror = null; attachEventListeners(this); streams.push(this); }
      close() {}
    }
    global.EventSource = MockEventSource;
    env.win.EventSource = MockEventSource;
    const fetchCalls = [];
    global.fetch = async (url, init = {}) => {
      fetchCalls.push([url, init.method || "GET"]);
      if (String(url).includes("/api/sessions/new")) return { ok: true, json: async () => ({ ok: true, id: "restored-session" }) };
      return { ok: true, json: async () => ({ ok: true }) };
    };
    env.win.fetch = global.fetch;

    const input = env.doc.getElementById("ci");
    input.value = "恢复竞态";
    input.dispatchEvent(new env.win.KeyboardEvent("keydown", { key: "Enter" }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.strictEqual(fetchCalls.filter(([url]) => String(url).includes("/api/sessions/new")).length, 0);

    releaseRestore();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.strictEqual(fetchCalls.filter(([url]) => String(url).includes("/api/sessions/new")).length, 1);
    assert.ok(fetchCalls.some(([url]) => String(url).includes("/api/chat")));
    assert.ok(env.state._sessionTabs.includes("restored-session"));
    streams[0].onmessage({ data: JSON.stringify({ type: "done", text: "完成", sessionId: "restored-session" }) });
  });

  it("草稿标签首次发送会升级为真实会话", async () => {
    env.state.M = [];
    env.state._sessionTabs = ["draft:test"];
    env.state._activeSessionTabId = "draft:test";
    localStorage.setItem("session-tabs", JSON.stringify(["draft:test"]));
    localStorage.setItem("active-session-tab", "draft:test");
    const streams = [];
    class MockEventSource {
      constructor() { this.onmessage = null; this.onerror = null; attachEventListeners(this); streams.push(this); }
      close() {}
    }
    global.EventSource = MockEventSource;
    env.win.EventSource = MockEventSource;

    let committed = null;
    env.win.App.Session.commitSessionTab = (oldId, newId) => {
      committed = [oldId, newId];
      env.state._sessionTabs = [newId];
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

    assert.deepStrictEqual(env.state._sessionTabs, ["real-session"]);
    assert.ok(!fetchCalls.some(([url, method]) => String(url).includes("/api/sessions/delete") && method === "POST"));
  });

  it("创建真实会话后即使草稿绑定入口暂时不可用也不会丢失当前会话", async () => {
    env.state.M = [];
    env.state._sessionTabs = [];
    env.state._activeSessionTabId = null;
    const originalEnsureDraft = env.win.App.Session.ensureDraftSessionTab;
    // 模拟实机启动竞态：发送流程能创建 session，但草稿 tab 入口尚未可用。
    env.win.App.Session.ensureDraftSessionTab = undefined;

    const streams = [];
    class MockEventSource {
      constructor() { this.onmessage = null; this.onerror = null; attachEventListeners(this); streams.push(this); }
      close() {}
    }
    global.EventSource = MockEventSource;
    env.win.EventSource = MockEventSource;
    const fetchCalls = [];
    let created = 0;
    global.fetch = async (url, init = {}) => {
      const href = String(url);
      fetchCalls.push([href, init.method || "GET", init]);
      if (href.includes("/api/sessions/new")) {
        created += 1;
        return { ok: true, json: async () => ({ ok: true, id: `session-${created}` }) };
      }
      return { ok: true, json: async () => ({ ok: true }) };
    };
    env.win.fetch = global.fetch;

    const input = env.doc.getElementById("ci");
    input.value = "第一轮";
    input.dispatchEvent(new env.win.KeyboardEvent("keydown", { key: "Enter" }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
    streams[0].onmessage({ data: JSON.stringify({ type: "done", text: "完成一", sessionId: "session-1" }) });
    await new Promise((resolve) => setTimeout(resolve, 0));

    // 修复后首次创建的 session 必须已经成为当前 tab，第二轮不能再次 /new。
    assert.deepStrictEqual(env.state._sessionTabs, ["session-1"]);

    input.value = "第二轮";
    input.dispatchEvent(new env.win.KeyboardEvent("keydown", { key: "Enter" }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.strictEqual(created, 1, "连续两轮交互只能创建一个真实 session");
    assert.ok(fetchCalls.filter(([url, method]) => url.includes("/api/chat") && method === "POST").length >= 2);

    env.win.App.Session.ensureDraftSessionTab = originalEnsureDraft;
  });

  it("发送时以 TabStore 可见的已有 session tab 为准，不因旧兼容入口为空而新建会话", async () => {
    env.state.M = [];
    env.state._sessionTabs = ["existing-session"];
    env.state._activeSessionTabId = "existing-session";
    const originalAppGetActive = env.win.App.Session.getActiveSessionTabId;
    const originalTabsGetActive = env.win.App.Tabs.getActiveSessionTabId;
    // 模拟旧兼容投影暂时为空，但标签栏和 TabStore 已经有真实 active session。
    env.win.getActiveSessionTabId = () => { throw new Error("legacy path used"); };
    env.win.App.Session.getActiveSessionTabId = () => null;
    env.win.App.Tabs.getActiveSessionTabId = () => null;

    const streams = [];
    class MockEventSource {
      constructor() { this.onmessage = null; this.onerror = null; attachEventListeners(this); streams.push(this); }
      close() {}
    }
    global.EventSource = MockEventSource;
    env.win.EventSource = MockEventSource;
    const fetchCalls = [];
    global.fetch = async (url, init = {}) => {
      const href = String(url);
      fetchCalls.push([href, init.method || "GET"]);
      return { ok: true, json: async () => ({ ok: true }) };
    };
    env.win.fetch = global.fetch;

    const input = env.doc.getElementById("ci");
    input.value = "继续当前会话";
    env.doc.getElementById("cs").click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.strictEqual(fetchCalls.filter(([url, method]) => url.includes("/api/sessions/new") && method === "POST").length, 0);
    assert.ok(fetchCalls.some(([url, method]) => url.includes("/api/chat") && method === "POST"));
    assert.deepStrictEqual(env.state._sessionTabs, ["existing-session"]);

    env.win.App.Session.getActiveSessionTabId = originalAppGetActive;
    env.win.App.Tabs.getActiveSessionTabId = originalTabsGetActive;
    streams[0]?.onmessage?.({ data: JSON.stringify({ type: "done", text: "完成", sessionId: "existing-session" }) });
  });

  it("done 后为默认标题的持久会话自动生成标题", async () => {
    env.state.M = [];
    env.state._sessionTabs = ["draft:auto-title"];
    env.state._activeSessionTabId = "draft:auto-title";
    env.state._sessionTabLabels = {};
    env.state._sessionTitleSources = {};
    localStorage.setItem("session-tabs", JSON.stringify(["draft:auto-title"]));
    localStorage.setItem("active-session-tab", "draft:auto-title");
    const streams = [];
    class MockEventSource {
      constructor() { this.onmessage = null; this.onerror = null; attachEventListeners(this); streams.push(this); }
      close() {}
    }
    global.EventSource = MockEventSource;
    env.win.EventSource = MockEventSource;

    const fetchCalls = [];
    global.fetch = async (url, init = {}) => {
      fetchCalls.push([url, init.method || "GET", init]);
      if (String(url).includes("/api/sessions/new")) return { ok: true, json: async () => ({ ok: true, id: "auto-session" }) };
      if (String(url).includes("/api/sessions/rename")) return { ok: true, json: async () => ({ ok: true }) };
      if (String(url).includes("/api/sessions?")) return { ok: true, json: async () => ({ sessions: [], other: [] }) };
      return { ok: true, json: async () => ({ ok: true }) };
    };
    env.win.fetch = global.fetch;

    const input = env.doc.getElementById("ci");
    input.value = "请帮我修复标签栏关闭按钮无法点击的问题";
    input.dispatchEvent(new env.win.KeyboardEvent("keydown", { key: "Enter" }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));

    streams[0].onmessage({ data: JSON.stringify({ type: "done", text: "已修复这个标签栏问题。", sessionId: "auto-session" }) });
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));

    const renameCall = fetchCalls.find(([url, method]) => String(url).includes("/api/sessions/rename") && method === "POST");
    assert.ok(renameCall, "默认标题会话完成后应自动重命名");
    const body = JSON.parse(renameCall[2].body);
    assert.strictEqual(body.id, "auto-session");
    assert.strictEqual(body.titleSource, "auto");
    assert.ok(body.name.includes("标签栏关闭按钮无法点击"));
    assert.strictEqual(env.win.App.State.getSnapshot().tabs.labels?.["auto-session"], body.name);
    assert.strictEqual(env.win.App.State.getSnapshot().tabs.titleSources?.["auto-session"], "auto");
  });

  it("legacy localStorage keys no longer written by session functions", () => {
    const LEGACY_KEYS = ["session-tabs", "active-session-tab", "last-session-id", "session-tab-labels"];
    for (const key of LEGACY_KEYS) localStorage.removeItem(key);

    // migrateSessionTabLabels must NOT write to localStorage
    localStorage.setItem("session-tab-labels", JSON.stringify({ "sess-old": "新会话" }));
    const before = localStorage.getItem("session-tab-labels");
    if (typeof env.win.App.Session.migrateSessionTabLabels === "function") env.win.App.Session.migrateSessionTabLabels();
    assert.strictEqual(localStorage.getItem("session-tab-labels"), before,
      "migrateSessionTabLabels 不能改写旧的 session-tab-labels");
    localStorage.removeItem("session-tab-labels"); // 恢复干净状态

    // setActiveSessionTabId used to write active-session-tab and last-session-id
    env.state._sessionTabs = ["sess-a"];
    env.win.App.Session.setActiveSessionTabId("sess-a");
    for (const key of LEGACY_KEYS) {
      assert.strictEqual(localStorage.getItem(key), null, `setActiveSessionTabId: ${key}`);
    }

    // commitSessionTab used to write session-tabs, session-tab-labels, active-session-tab, last-session-id
    env.state._sessionTabs = ["draft:regression"];
    env.win.App.Session.commitSessionTab("draft:regression", "sess-real", "手动标题");
    for (const key of LEGACY_KEYS) {
      assert.strictEqual(localStorage.getItem(key), null, `commitSessionTab: ${key}`);
    }
    assert.deepStrictEqual(env.state._sessionTabs, ["sess-real"]);
    assert.strictEqual(env.win.App.State.getSnapshot().tabs.labels?.["sess-real"], "手动标题");
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
    env.state.M[0].content = prefix + "B".repeat(20) + suffix;
    env.state.M[0]._rv = 1;
    env.win.updateUI();

    assert.ok(replaces > 0, "_rv bump 应触发 replaceWith");
    assert.ok(panel.innerHTML.includes("B".repeat(20)));

    env.win.Element.prototype.replaceWith = origReplaceWith;
  });

  it("resetMsgKeys 暴露在 App.Chat 上", () => {
    assert.ok(typeof App.Chat.resetMsgKeys === "function", "resetMsgKeys 应是函数");
  });

  it("message reconciliation syncs Timeline without rebuilding unchanged turns and reset clears it", () => {
    env.win.App.ChatState.replaceMessages([
      { role: "user", content: "问题一" },
      { role: "assistant", content: "回复一" },
      { role: "user", content: "问题二" },
      { role: "assistant", content: "回复二" },
      { role: "user", content: "问题三" },
      { role: "assistant", content: "回复三" },
    ]);

    env.win.updateUI();
    const timeline = env.doc.getElementById("chat-timeline");
    assert.strictEqual(timeline.classList.contains("on"), true);
    const firstButton = timeline.querySelector('[data-timeline-index="0"]');
    assert.ok(firstButton);

    const last = env.win.App.ChatState.getMessages().at(-1);
    last.content = "回复三，继续流式更新";
    last._rv = 1;
    env.win.updateUI();

    assert.strictEqual(timeline.querySelector('[data-timeline-index="0"]'), firstButton);

    env.win.App.Chat.resetMsgKeys();
    assert.strictEqual(timeline.classList.contains("on"), false);
    assert.strictEqual(timeline.childElementCount, 0);
  });

  it("空 M 时 updateUI 渲染欢迎屏", () => {
    env.state.M = [];
    env.win.updateUI();
    const panel = env.doc.getElementById("ms");
    assert.ok(panel.innerHTML.includes("Pi"), "空 M 时应渲染欢迎屏");
    assert.ok(panel.innerHTML.includes("编码"), "欢迎屏应有提示文字");
  });

  it("用户离开底部后显示回到最新按钮，点击后平滑回到底部", async () => {
    const panel = env.doc.getElementById("ms");
    const button = env.doc.getElementById("chat-jump-latest");
    let scrollTop = 220;
    let scrollHeight = 1000;
    let behavior = "";
    Object.defineProperties(panel, {
      scrollTop: { configurable: true, get: () => scrollTop, set: (value) => { scrollTop = value; } },
      scrollHeight: { configurable: true, get: () => scrollHeight },
      clientHeight: { configurable: true, get: () => 300 },
    });
    panel.scrollTo = (options) => {
      scrollTop = options.top;
      behavior = options.behavior;
    };

    panel.dispatchEvent(new env.win.Event("scroll"));

    assert.strictEqual(button.classList.contains("on"), true);
    assert.strictEqual(button.getAttribute("aria-hidden"), "false");
    assert.strictEqual(button.tabIndex, 0);

    env.win.App.Chat.scrollToLatest({ force: false });
    assert.strictEqual(scrollTop, 220, "stream updates must not pull a user away from history");

    button.click();
    assert.strictEqual(scrollTop, scrollHeight);
    assert.strictEqual(behavior, "smooth");
    assert.strictEqual(button.classList.contains("on"), false);
    assert.strictEqual(button.getAttribute("aria-hidden"), "true");
    assert.strictEqual(button.tabIndex, -1);

    scrollHeight = 1200;
    env.win.App.Chat.scrollToLatest({ force: false });
    assert.strictEqual(scrollTop, 1200, "auto-follow resumes after returning to latest");
    await new Promise((resolve) => setTimeout(resolve, 130));
  });

  it("jump-to-latest button click uses the smooth preference", async () => {
    const panel = env.doc.getElementById("ms");
    const button = env.doc.getElementById("chat-jump-latest");
    env.setScrollMetrics({ scrollTop: 0, scrollHeight: 1000, clientHeight: 300 });
    panel.dispatchEvent(new env.win.Event("scroll"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.strictEqual(button.classList.contains("on"), true);

    env.setPreference("chat-jump-latest-smooth", false);
    refreshReadingSettings(env);

    let scrollToCalls = 0;
    panel.scrollTo = () => { scrollToCalls++; };
    button.click();

    assert.strictEqual(scrollToCalls, 0, "disabled smooth preference must not call scrollTo");
    assert.strictEqual(env.getScrollTop(), 1000, "button click must scroll directly to the bottom");
  });

  it("jump-to-latest disabled hides the button after reading settings refresh", async () => {
    const panel = env.doc.getElementById("ms");
    const button = env.doc.getElementById("chat-jump-latest");
    env.state._activeSessionTabId = "session-sentinel";
    env.setScrollMetrics({ scrollTop: 0, scrollHeight: 1000, clientHeight: 300 });
    panel.dispatchEvent(new env.win.Event("scroll"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.strictEqual(button.classList.contains("on"), true);

    const activeSessionBefore = env.state._activeSessionTabId;
    const scrollTopBefore = env.getScrollTop();
    const messagesBefore = env.win.App.ChatState.getMessages();
    const messageContentsBefore = messagesBefore.map((message) => message.content);

    env.setPreference("chat-jump-latest-enabled", false);
    refreshReadingSettings(env);

    assert.strictEqual(env.state._activeSessionTabId, activeSessionBefore);
    assert.strictEqual(env.getScrollTop(), scrollTopBefore);
    assert.strictEqual(env.win.App.ChatState.getMessages(), messagesBefore);
    assert.deepStrictEqual(messagesBefore.map((message) => message.content), messageContentsBefore);
    assert.strictEqual(button.classList.contains("on"), false);
    assert.strictEqual(button.getAttribute("aria-hidden"), "true");
    assert.strictEqual(button.tabIndex, -1);
  });

  it("jump-to-latest thresholds 48, 72, and 120 control near-latest visibility and invalid values use 72", async () => {
    const panel = env.doc.getElementById("ms");
    const button = env.doc.getElementById("chat-jump-latest");
    const scrollHeight = 1000;
    const clientHeight = 300;
    env.setScrollMetrics({ scrollHeight, clientHeight });

    const cases = [
      { value: 48, distance: 60, visible: true },
      { value: 48, distance: 48, visible: false },
      { value: 72, distance: 72, visible: false },
      { value: 120, distance: 80, visible: false },
      { value: 120, distance: 120, visible: false },
      { value: "invalid", distance: 60, visible: false },
      { value: "invalid", distance: 80, visible: true },
    ];
    const actualVisibility = cases.map((testCase) => {
      env.setPreference("chat-jump-latest-threshold", testCase.value);
      env.setScrollMetrics({ scrollTop: scrollHeight - clientHeight - testCase.distance });
      refreshReadingSettingsIfAvailable(env);
      panel.dispatchEvent(new env.win.Event("scroll"));
      return button.classList.contains("on");
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepStrictEqual(actualVisibility, cases.map((testCase) => testCase.visible), "threshold settings should control near-latest visibility");
  });

  it("jump-to-latest explicit smooth options override the persisted preference", async () => {
    const panel = env.doc.getElementById("ms");
    env.setScrollMetrics({ scrollTop: 0, scrollHeight: 1000, clientHeight: 300 });
    panel.dispatchEvent(new env.win.Event("scroll"));

    env.setPreference("chat-jump-latest-smooth", false);
    refreshReadingSettings(env);
    env.clearLastScrollTo();
    env.win.App.Chat.scrollToLatest({ force: true, smooth: true });

    assert.deepStrictEqual(env.getLastScrollTo(), { top: 1000, behavior: "smooth" });
    await new Promise((resolve) => setTimeout(resolve, 130));

    env.setPreference("chat-jump-latest-smooth", true);
    refreshReadingSettings(env);
    env.setScrollMetrics({ scrollTop: 0 });
    env.clearLastScrollTo();
    env.win.App.Chat.scrollToLatest({ force: true, smooth: false });

    assert.strictEqual(env.getScrollTop(), 1000);
    assert.strictEqual(env.getLastScrollTo(), null);
  });

  it("jump-to-latest smooth preference controls scrollToLatest without an explicit smooth option", async () => {
    const panel = env.doc.getElementById("ms");
    env.setScrollMetrics({ scrollTop: 700, scrollHeight: 1000, clientHeight: 300 });
    panel.dispatchEvent(new env.win.Event("scroll"));

    env.setPreference("chat-jump-latest-smooth", true);
    refreshReadingSettingsIfAvailable(env);
    env.setScrollMetrics({ scrollTop: 0 });
    env.win.App.Chat.scrollToLatest();
    const smoothScroll = env.getLastScrollTo();
    await new Promise((resolve) => setTimeout(resolve, 130));

    env.setPreference("chat-jump-latest-smooth", false);
    refreshReadingSettings(env);
    env.setScrollMetrics({ scrollTop: 0 });
    env.clearLastScrollTo();
    env.win.App.Chat.scrollToLatest();

    assert.deepStrictEqual(smoothScroll, { top: 1000, behavior: "smooth" });
    assert.strictEqual(env.getScrollTop(), 1000);
    assert.strictEqual(env.getLastScrollTo(), null, "immediate mode must not call smooth scroll");
  });
});
