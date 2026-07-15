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
  global.setTimeout = (fn) => { fn(); return 0; };
  global.clearTimeout = () => {};

  doc.body.innerHTML = [
    '<div id="pc"></div>',
    '<div id="ms">old messages</div>',
    '<textarea id="ci" disabled style="height:80px">old input</textarea>',
    '<button id="cs" disabled>stop</button>',
    '<div id="fi-attach-bar">old attachments</div>',
  ].join('');

  const oldStream = {
    closed: false,
    onmessage: () => {},
    onerror: () => {},
    close() { this.closed = true; },
  };
  win.__state = {
    D: null,
    M: [{ role: "user", content: "old" }, { role: "assistant", content: "stream", streaming: true }],
    IL: true,
    CS: oldStream,
    CT: "chat",
    _activePanel: "explorer",
    _fileTabs: [{ id: "old.ts", label: "old.ts", content: "", lang: "ts" }],
    _activeFileTab: "old.ts",
    _activeSessionTabId: null,
  };

  const calls = [];
  win.App = {
    Constants: { WS_KEY: "workspace_path" },
    UI: {},
    Chat: { clearAttachments: () => calls.push(["clearAttachments"]) },
    File: {},
    Session: {},
    Settings: {},
    Git: { refreshGit: () => calls.push(["refreshGit"]) },
  };
  global.App = win.App;
  win.electronAPI = { openFolder: async () => "E:\\new-workspace" };
  win.__monaco = { dispose: () => calls.push(["monacoDispose"]) };

  global.$ = (id) => doc.getElementById(id);
  global.S = (name, size = 16) => `<svg width="${size}" height="${size}"><use href="#${name}"/></svg>`;
  global.E = (value) => String(value ?? "");
  global.toast = (message, type) => calls.push(["toast", message, type || "info"]);
  global.switchTab = (id) => calls.push(["switchTab", id]);
  win.__tabs = { activateTab: (id) => { calls.push(["activateTab", id]); if (id === null) win.__state._activeFileTab = null; }, reset: () => {} };
  global.renderPanel = (name, container) => calls.push(["renderPanel", name, Boolean(container)]);
  global.loadSessions = () => calls.push(["loadSessions"]);
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

  return { win, doc, calls, fetchCalls, oldStream };
}

describe("workspace ui isolation", () => {
  let env;

  beforeEach(async () => {
    env = setupDom();
    const ts = Date.now() + Math.random();
    await import(`../src/frontend/dashboard/dashboard-menus.ts?t=${ts}`);
  });

  it("openFolder waits for backend switch then clears cross-workspace state", async () => {
    env.win.fileAction("openFolder");
    await new Promise((resolve) => queueMicrotask(resolve));
    await new Promise((resolve) => queueMicrotask(resolve));

    assert.strictEqual(env.fetchCalls.length, 1);
    assert.strictEqual(env.fetchCalls[0][0], "/api/workspace/switch");
    assert.strictEqual(JSON.parse(env.fetchCalls[0][1].body).workspace, "E:\\new-workspace");

    assert.strictEqual(localStorage.getItem("workspace_path"), "E:\\new-workspace");
    assert.strictEqual(localStorage.getItem("file-tabs"), null);
    assert.strictEqual(localStorage.getItem("last-session-id"), null);

    assert.strictEqual(env.oldStream.closed, true);
    assert.strictEqual(env.oldStream.onmessage, null);
    assert.strictEqual(env.oldStream.onerror, null);
    assert.strictEqual(env.win.__state.CS, null);
    assert.strictEqual(env.win.__state.IL, false);
    assert.deepStrictEqual(env.win.__state.M, []);
    // _fileTabs 是 TabStore 投影，不再直接清除；TabStore.reset() 和 activateTab(null) 已验证
    assert.strictEqual(env.win.__state._activeFileTab, null);

    assert.strictEqual(env.doc.getElementById("ms").innerHTML, '<div class="wl">empty</div>');
    assert.strictEqual(env.doc.getElementById("ci").disabled, false);
    assert.strictEqual(env.doc.getElementById("ci").value, "");
    assert.strictEqual(env.doc.getElementById("cs").disabled, false);

    assert.ok(env.calls.some((call) => call[0] === "clearAttachments"));
    assert.ok(env.calls.some((call) => call[0] === "monacoDispose"));
    assert.ok(env.calls.some((call) => call[0] === "activateTab" && call[1] === null));
    assert.ok(env.calls.some((call) => call[0] === "renderPanel" && call[1] === "explorer"));
    assert.ok(env.calls.some((call) => call[0] === "loadSessions"));
    assert.ok(env.calls.some((call) => call[0] === "refreshGit"));
  });
});