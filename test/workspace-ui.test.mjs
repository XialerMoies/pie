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
  const legacyState = {
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
  win.electronAPI = {
    openWorkspaceFolder: async () => {
      calls.push(["openWorkspaceFolder"]);
      return { ok: true, action: "switching", workspace: "E:\\new-workspace" };
    },
    openFolder: async () => {
      calls.push(["legacyOpenFolder"]);
      return null;
    },
  };
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

  it("delegates File > Open Folder to Electron exactly once without local switching", async () => {
    env.win.fileAction("openFolder");
    await new Promise((resolve) => queueMicrotask(resolve));
    await new Promise((resolve) => queueMicrotask(resolve));

    assert.strictEqual(env.calls.filter((call) => call[0] === "openWorkspaceFolder").length, 1);
    assert.strictEqual(env.calls.filter((call) => call[0] === "legacyOpenFolder").length, 0);
    assert.strictEqual(env.fetchCalls.length, 0);
    assert.strictEqual(env.oldStream.closed, false);
    assert.strictEqual(env.win.App.ChatStream.isOpen(), true);
    assert.strictEqual(env.win.App.ChatState.isBusy(), true);
    assert.deepStrictEqual(env.win.App.ChatState.getMessages(), [
      { role: "user", content: "old" },
      { role: "assistant", content: "stream", streaming: true },
    ]);
    assert.strictEqual(env.doc.getElementById("ms").innerHTML, "old messages");
    assert.strictEqual(env.doc.getElementById("ci").disabled, true);
    assert.strictEqual(env.doc.getElementById("ci").value, "old input");
    assert.strictEqual(env.doc.getElementById("cs").disabled, true);
    assert.ok(!env.calls.some((call) => [
      "resetTabs",
      "clearAttachments",
      "resetWorkspace",
      "monacoDispose",
      "activateTab",
      "renderPanel",
      "loadSessions",
      "refreshGit",
      "syncTimeline",
    ].includes(call[0])), JSON.stringify(env.calls));
  });

  it("keeps the initiating page unchanged when Electron focuses an existing workspace", async () => {
    env.win.electronAPI.openWorkspaceFolder = async () => {
      env.calls.push(["openWorkspaceFolder"]);
      return { ok: true, action: "focused-existing", workspace: "E:\\other-workspace" };
    };

    env.win.fileAction("openFolder");
    await new Promise((resolve) => setImmediate(resolve));

    assert.strictEqual(env.calls.filter((call) => call[0] === "openWorkspaceFolder").length, 1);
    assert.strictEqual(env.calls.filter((call) => call[0] === "legacyOpenFolder").length, 0);
    assert.strictEqual(env.fetchCalls.length, 0);
    assert.strictEqual(env.oldStream.closed, false);
    assert.strictEqual(env.win.App.ChatStream.isOpen(), true);
    assert.strictEqual(env.win.App.ChatState.isBusy(), true);
    assert.strictEqual(env.doc.getElementById("ms").innerHTML, "old messages");
    assert.ok(!env.calls.some((call) => call[0] === "resetTabs" || call[0] === "resetWorkspace"));
  });

  it("selects a file once and reports the selected path", async () => {
    let selectFileCalls = 0;
    env.win.electronAPI.selectFile = async () => {
      selectFileCalls += 1;
      return "E:\\picked.ts";
    };

    env.win.fileAction("openFile");
    await new Promise((resolve) => setImmediate(resolve));

    assert.strictEqual(selectFileCalls, 1);
    assert.ok(env.calls.some((call) => call[0] === "toast" && call[1].includes("E:\\picked.ts")));
  });

  it("does nothing after a cancelled file selection", async () => {
    let selectFileCalls = 0;
    env.win.electronAPI.selectFile = async () => { selectFileCalls += 1; return null; };

    env.win.fileAction("openFile");
    await new Promise((resolve) => setImmediate(resolve));

    assert.strictEqual(selectFileCalls, 1);
    assert.ok(!env.calls.some((call) => call[0] === "toast"));
  });

  it("shows an error when file selection rejects", async () => {
    let selectFileCalls = 0;
    env.win.electronAPI.selectFile = async () => {
      selectFileCalls += 1;
      throw new Error("picker failed");
    };

    env.win.fileAction("openFile");
    await new Promise((resolve) => setImmediate(resolve));

    assert.strictEqual(selectFileCalls, 1);
    assert.ok(env.calls.some((call) => (
      call[0] === "toast" && call[1].includes("picker failed") && call[2] === "error"
    )), JSON.stringify(env.calls));
  });
});
