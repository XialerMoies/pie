import { describe, it, beforeEach } from "node:test";
import assert from "node:assert";
import { Window } from "happy-dom";

describe("ChatState facade", () => {
  let win;

  beforeEach(() => {
    const dom = new Window();
    win = dom;
    global.window = win;
    global.document = win.document;
    win.__state = { D: null, M: [], IL: false, CS: null };
    win.App = {};
  });

  it("owns messages, busy state, and dashboard data while preserving legacy projection", async () => {
    await import(`../src/frontend/services/chat-runtime-store.ts?${Date.now()}-${Math.random()}`);

    const state = win.App.ChatState;
    const messages = [{ role: "user", content: "hello" }];
    const dashboard = { modelId: "test-model", modelProvider: "test", isIdle: true };

    state.replaceMessages(messages);
    state.setBusy(true);
    state.setDashboard(dashboard);

    assert.deepStrictEqual(state.getMessages(), messages);
    assert.strictEqual(state.isBusy(), true);
    assert.deepStrictEqual(state.getDashboard(), dashboard);
    assert.strictEqual(win.__state.M, messages);
    assert.strictEqual(win.__state.IL, true);
    assert.strictEqual(win.__state.D, dashboard);

    state.clearMessages();
    assert.deepStrictEqual(state.getMessages(), []);
    assert.deepStrictEqual(win.__state.M, []);
  });

  it("appends messages without exposing a second message array", async () => {
    await import(`../src/frontend/services/chat-runtime-store.ts?${Date.now()}-${Math.random()}`);

    const state = win.App.ChatState;
    state.replaceMessages([]);
    const message = { role: "assistant", content: "streaming", streaming: true };

    state.appendMessage(message);

    assert.strictEqual(state.getMessages()[0], message);
    assert.strictEqual(win.__state.M[0], message);
  });
});
