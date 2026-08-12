import { beforeEach, describe, it } from "node:test";
import assert from "node:assert";
import { Window } from "happy-dom";

let importSeq = 0;
let win;
let calls;
let messages;
let pending;
let requests;

async function loadSubject() {
  await import(`../src/frontend/dashboard/session-activation.ts?test=${++importSeq}`);
  return win.App.SessionActivation;
}

function resolveActivation(id, content = `message-${id}`) {
  const resolve = pending.get(id);
  assert.ok(resolve, `pending activation for ${id}`);
  resolve({
    ok: true,
    json: async () => ({
      ok: true,
      activeSessionId: id,
      messages: [{ role: "assistant", content }],
    }),
  });
  pending.delete(id);
}

beforeEach(() => {
  win = new Window();
  calls = [];
  messages = [];
  pending = new Map();
  requests = [];
  win.document.body.innerHTML = '<div id="ms"></div><textarea id="ci"></textarea><button id="cs"></button>';
  win.msgs = () => messages.map(message => `<div class="m">${message.content}</div>`).join("");
  win.S = () => "<svg></svg>";
  win.App = {
    State: { getWorkspacePath: () => "E:\\workspace" },
    Chat: { resetMsgKeys: () => calls.push(["resetMsgKeys"]) },
    ChatState: {
      replaceMessages: next => { messages = next; calls.push(["replaceMessages", next.map(message => message.content)]); },
      getMessages: () => messages,
      clearMessages: () => { messages = []; calls.push(["clearMessages"]); },
      setBusy: value => calls.push(["setBusy", value]),
    },
    ChatStream: { close: () => calls.push(["closeStream"]) },
    ChatTimeline: { sync: () => calls.push(["timelineSync"]) },
    SessionTabs: {
      isDraftSessionId: id => typeof id === "string" && id.startsWith("draft:"),
      setActiveSessionTabId: id => calls.push(["setActive", id]),
      renderSessionTabs: id => calls.push(["renderTabs", id]),
      saveUiState: () => calls.push(["saveUiState"]),
    },
    SessionRestore: {
      markUserInteraction: () => calls.push(["markUserInteraction"]),
    },
    Tabs: {
      getTab: () => undefined,
      getTabBehavior: () => undefined,
    },
  };
  global.window = win;
  global.document = win.document;
  global.App = win.App;
  global.$ = id => win.document.getElementById(id);
  global.toast = message => calls.push(["toast", message]);
  global.fetch = (_url, init) => {
    const body = JSON.parse(String(init?.body || "{}"));
    requests.push(body);
    const id = body.id;
    return new Promise(resolve => pending.set(id, resolve));
  };
  win.fetch = global.fetch;
});

describe("session activation", () => {
  it("drops a late restore response after the user activates another session", async () => {
    const activation = await loadSubject();
    activation.init({
      rememberSessionTab: id => calls.push(["remember", id]),
      loadSessions: () => calls.push(["loadSessions"]),
      setupDraftSession: id => calls.push(["draft", id]),
    });

    const restore = activation.activateById("sess-restore", {
      silent: true,
      skipTabState: true,
      refreshSessions: false,
    });
    const user = activation.activateById("sess-user");

    resolveActivation("sess-user", "user-current");
    await user;
    resolveActivation("sess-restore", "restore-stale");
    await restore;

    assert.deepStrictEqual(messages.map(message => message.content), ["user-current"]);
    assert.strictEqual(calls.some(call => call[0] === "replaceMessages" && call[1][0] === "restore-stale"), false);
  });

  it("keeps startup restoration silent and skips duplicate tab state", async () => {
    const activation = await loadSubject();
    activation.init({
      rememberSessionTab: id => calls.push(["remember", id]),
      loadSessions: () => calls.push(["loadSessions"]),
      setupDraftSession: id => calls.push(["draft", id]),
    });
    let emitted = false;
    activation.onceActivated("sess-restore", () => { emitted = true; });

    const result = activation.activateById("sess-restore", {
      silent: true,
      skipTabState: true,
      refreshSessions: false,
    });
    resolveActivation("sess-restore");
    await result;

    assert.strictEqual(calls.some(call => call[0] === "toast"), false);
    assert.strictEqual(calls.some(call => call[0] === "markUserInteraction"), false);
    assert.strictEqual(calls.some(call => ["remember", "setActive", "renderTabs", "saveUiState", "loadSessions"].includes(call[0])), false);
    assert.strictEqual(emitted, false);
    assert.deepStrictEqual(messages.map(message => message.content), ["message-sess-restore"]);
  });

  it("uses the session tab workspace when activating a session from another project", async () => {
    const activation = await loadSubject();
    activation.init({
      rememberSessionTab: id => calls.push(["remember", id]),
      loadSessions: () => calls.push(["loadSessions"]),
      setupDraftSession: id => calls.push(["draft", id]),
    });
    win.App.Tabs.getTab = id => id === "sess-other"
      ? { id, kind: "session", title: "Other", order: 0, workspace: "E:\\other-project" }
      : undefined;

    const result = activation.activate({ id: "sess-other", kind: "session", title: "Other", order: 0, workspace: "E:\\other-project" });
    assert.deepStrictEqual(requests, [{ id: "sess-other", workspace: "E:\\other-project" }]);
    resolveActivation("sess-other");
    await result;
  });

  it("preserves replayed subagent batches when restoring a session", async () => {
    const activation = await loadSubject();
    activation.init({
      rememberSessionTab: id => calls.push(["remember", id]),
      loadSessions: () => calls.push(["loadSessions"]),
      setupDraftSession: id => calls.push(["draft", id]),
    });

    const result = activation.activateById("sess-subagents", {
      silent: true,
      skipTabState: true,
      refreshSessions: false,
    });
    const resolve = pending.get("sess-subagents");
    assert.ok(resolve, "pending activation for sess-subagents");
    const subagentBatches = [{
      batchId: "batch-1",
      parentToolCallId: "delegate-call-1",
      status: "completed",
      events: [],
      tasks: [{ taskId: "task-1", status: "completed", events: [] }],
    }];
    resolve({
      ok: true,
      json: async () => ({
        ok: true,
        activeSessionId: "sess-subagents",
        messages: [{
          role: "assistant",
          content: "done",
          blocks: [{ type: "tool", name: "delegate_tasks", toolCallId: "delegate-call-1" }],
          subagentBatches,
        }],
      }),
    });
    pending.delete("sess-subagents");
    await result;

    assert.deepStrictEqual(messages[0].subagentBatches, subagentBatches);
  });

  it("preserves normal activation side effects and emits once", async () => {
    const activation = await loadSubject();
    activation.init({
      rememberSessionTab: id => calls.push(["remember", id]),
      loadSessions: () => calls.push(["loadSessions"]),
      setupDraftSession: id => calls.push(["draft", id]),
    });
    const emitted = [];
    activation.onceActivated("sess-user", id => emitted.push(id));

    const result = activation.activateById("sess-user");
    resolveActivation("sess-user");
    await result;

    assert.deepStrictEqual(emitted, ["sess-user"]);
    for (const expected of ["markUserInteraction", "remember", "setActive", "renderTabs", "saveUiState", "loadSessions", "toast"]) {
      assert.ok(calls.some(call => call[0] === expected), `${expected} should run`);
    }
  });

  it("lets the draft setup callback own stream cleanup", async () => {
    const activation = await loadSubject();
    activation.init({
      rememberSessionTab: id => calls.push(["remember", id]),
      loadSessions: () => calls.push(["loadSessions"]),
      setupDraftSession: id => {
        calls.push(["draft", id]);
        win.App.ChatState.setBusy(false);
        win.App.ChatStream.close();
      },
    });

    await activation.activateById("draft:new");

    assert.strictEqual(calls.filter(call => call[0] === "closeStream").length, 1);
    assert.strictEqual(calls.filter(call => call[0] === "setBusy").length, 1);
  });

  it("shows the server activation error instead of hiding it as an invalid session", async () => {
    const activation = await loadSubject();
    activation.init({
      rememberSessionTab: id => calls.push(["remember", id]),
      loadSessions: () => calls.push(["loadSessions"]),
      setupDraftSession: id => calls.push(["draft", id]),
    });
    const result = activation.activateById("sess-missing");
    const resolve = pending.get("sess-missing");
    assert.ok(resolve);
    resolve({
      ok: false,
      status: 404,
      json: async () => ({ error: "session not found" }),
    });
    pending.delete("sess-missing");
    await result;
    assert.ok(calls.some(call => call[0] === "toast" && call[1].includes("session not found")));
  });
});
