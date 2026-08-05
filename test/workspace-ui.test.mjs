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
  global.setTimeout = (fn) => { fn(); return 0; };
  global.clearTimeout = () => {};

  doc.body.innerHTML = [
    '<div id="pc"></div>',
    '<div id="ms">old messages</div>',
    '<textarea id="ci" disabled style="height:80px">old input</textarea>',
    '<button id="cs" disabled>stop</button>',
    '<div id="fi-attach-bar">old attachments</div>',
  ].join('');

  const streams = [];
  class MockEventSource {
    constructor(url) {
      this.url = url;
      this.closed = false;
      this.listeners = new Map();
      streams.push(this);
    }
    addEventListener(type, listener) { this.listeners.set(type, listener); }
    removeEventListener(type, listener) {
      if (this.listeners.get(type) === listener) this.listeners.delete(type);
    }
    close() { this.closed = true; }
  }
  global.EventSource = MockEventSource;
  win.EventSource = MockEventSource;
  win.__state = {
    D: null,
    M: [{ role: "user", content: "old" }, { role: "assistant", content: "stream", streaming: true }],
    IL: true,
    CS: null,
    CT: "chat",
    _activePanel: "explorer",
    _fileTabs: [{ id: "old.ts", label: "old.ts", content: "", lang: "ts" }],
    _activeFileTab: "old.ts",
    _activeSessionTabId: null,
  };

  const calls = [];
  win.App = {
    Constants: { WS_KEY: "workspace_path" },
    State: {
      getWorkspacePath: () => "E:\\old-workspace",
      resetWorkspace: (workspace) => calls.push(["resetWorkspace", workspace]),
    },
    UI: {},
    Chat: { clearAttachments: () => calls.push(["clearAttachments"]) },
    ChatTimeline: { sync: () => calls.push(["syncTimeline"]) },
    File: {},
    Session: { loadSessions: () => calls.push(["loadSessions"]) },
    SessionTabs: { renderSessionTabs: () => calls.push(["renderSessionTabs"]) },
    Settings: {},
    Git: { refreshGit: () => calls.push(["refreshGit"]) },
    Tabs: {
      activateTab: (id) => calls.push(["activateTab", id]),
      reset: () => calls.push(["resetTabs"]),
    },
  };
  global.App = win.App;
  win.electronAPI = { openFolder: async () => "E:\\new-workspace" };
  win.__monaco = { dispose: () => calls.push(["monacoDispose"]) };

  global.$ = (id) => doc.getElementById(id);
  global.S = (name, size = 16) => `<svg width="${size}" height="${size}"><use href="#${name}"/></svg>`;
  global.E = (value) => String(value ?? "");
  global.toast = (message, type) => calls.push(["toast", message, type || "info"]);
  global.switchTab = (id) => calls.push(["switchTab", id]);
  global.renderPanel = (name, container) => calls.push(["renderPanel", name, Boolean(container)]);
  win.msgs = () => "<div class=\"wl\">empty</div>";

  const fetchCalls = [];
  global.fetch = async (url, init = {}) => {
    fetchCalls.push([url, init]);
    return { ok: true, json: async () => ({ ok: true }) };
  };
  win.fetch = global.fetch;

  localStorage.setItem("workspace_path", "E:\\old-workspace");
  localStorage.setItem("file-tabs", JSON.stringify([{ id: "old.ts" }]));
  localStorage.setItem("last-session-id", "old-session");

  return { win, doc, calls, fetchCalls, streams, oldStream: null };
}

describe("workspace ui isolation", () => {
  let env;

  beforeEach(async () => {
    env = setupDom();
    await import(`../src/frontend/services/chat-runtime-store.ts?workspace-ui=${Date.now()}-${Math.random()}`);
    await import(`../src/frontend/services/chat-stream.ts?workspace-ui=${Date.now()}-${Math.random()}`);
    env.win.App.ChatState.replaceMessages([{ role: "user", content: "old" }, { role: "assistant", content: "stream", streaming: true }]);
    env.win.App.ChatState.setBusy(true);
    env.win.App.ChatStream.open();
    env.oldStream = env.streams[0];
    await import(`../src/frontend/dashboard/dashboard-menus.ts?workspace-ui=${Date.now()}-${Math.random()}`);
  });

  it("openFolder waits for backend switch then clears cross-workspace state", async () => {
    env.win.fileAction("openFolder");
    await new Promise((resolve) => queueMicrotask(resolve));
    await new Promise((resolve) => queueMicrotask(resolve));

    assert.strictEqual(env.fetchCalls.length, 1);
    assert.strictEqual(env.fetchCalls[0][0], "/api/workspace/switch");
    assert.strictEqual(JSON.parse(env.fetchCalls[0][1].body).workspace, "E:\\new-workspace");

    assert.strictEqual(env.oldStream.closed, true);
    assert.strictEqual(env.oldStream.listeners.size, 0);
    assert.strictEqual(env.win.App.ChatStream.isOpen(), false);
    assert.strictEqual(env.win.App.ChatState.isBusy(), false);
    assert.deepStrictEqual(env.win.App.ChatState.getMessages(), []);
    // _fileTabs 是 TabStore 投影，不再直接清除；TabStore.reset() 和 activateTab(null) 已验证
    assert.ok(env.calls.some((call) => call[0] === "resetTabs"));

    assert.strictEqual(env.doc.getElementById("ms").innerHTML, '<div class="wl">empty</div>');
    assert.strictEqual(env.doc.getElementById("ci").disabled, false);
    assert.strictEqual(env.doc.getElementById("ci").value, "");
    assert.strictEqual(env.doc.getElementById("cs").disabled, false);

    assert.ok(env.calls.some((call) => call[0] === "clearAttachments"));
    assert.ok(env.calls.some((call) => call[0] === "resetWorkspace" && call[1] === "E:\\new-workspace"));
    assert.ok(env.calls.some((call) => call[0] === "monacoDispose"));
    assert.ok(env.calls.some((call) => call[0] === "activateTab" && call[1] === null));
    assert.ok(env.calls.some((call) => call[0] === "renderPanel" && call[1] === "explorer"));
    assert.ok(env.calls.some((call) => call[0] === "loadSessions"));
    assert.ok(env.calls.some((call) => call[0] === "refreshGit"));
    assert.ok(env.calls.some((call) => call[0] === "syncTimeline"));
  });

  it("openFolder ignores an equivalent Windows workspace path", async () => {
    env.win.electronAPI.openFolder = async () => "e:/old-workspace/";

    env.win.fileAction("openFolder");
    await new Promise((resolve) => queueMicrotask(resolve));

    assert.strictEqual(env.fetchCalls.length, 0);
    assert.ok(!env.calls.some((call) => call[0] === "resetWorkspace"));
  });

  it("openFolder reports the server permission error without resetting workspace state", async () => {
    global.fetch = async (url, init = {}) => {
      env.fetchCalls.push([url, init]);
      return {
        ok: false,
        status: 403,
        text: async () => JSON.stringify({
          error: "Permission confirmation denied or timed out",
          code: "permission_denied",
        }),
      };
    };
    env.win.fetch = global.fetch;

    env.win.fileAction("openFolder");
    await new Promise((resolve) => setImmediate(resolve));

    assert.ok(env.calls.some((call) => (
      call[0] === "toast" &&
      call[1].includes("E:\\new-workspace") &&
      call[1].includes("permission_denied") &&
      call[2] === "error"
    )), JSON.stringify(env.calls));
    assert.ok(!env.calls.some((call) => call[0] === "resetWorkspace"));
  });
});
