import { after, describe, it } from "node:test";
import assert from "node:assert";
import { CHAT_FLOW_SSE_BLOCKS } from "./fixtures/chat-event-flow.mjs";

const originalWindow = global.window;
const originalMark = global.mark;
const originalScroll = global.sb;
const originalToast = global.toast;

const messages = [{ role: "assistant", content: "", streaming: true, blocks: [] }];
let handlers;
let closed;
let updateCalls;
let finalized;
let scheduledRenders;
let markedRendered;
let fullRenders;

function reset() {
  messages.splice(0, messages.length, { role: "assistant", content: "", streaming: true, blocks: [] });
  handlers = undefined;
  closed = false;
  updateCalls = [];
  finalized = false;
  scheduledRenders = 0;
  markedRendered = 0;
  fullRenders = 0;
}

global.mark = () => {};
global.sb = () => {};
global.toast = () => {};
global.window = {
  App: {
    ChatViews: {},
    Chat: {
      updateLastBlock(block) {
        updateCalls.push(block.blockId);
        return true;
      },
      finalizeLastMessage() {
        finalized = true;
        return true;
      },
    },
    ChatState: {
      getMessages: () => messages,
      setBusy: () => {},
      appendMessage: (message) => messages.push(message),
    },
    ChatStream: {
      setHandlers: (_generation, nextHandlers) => {
        handlers = nextHandlers;
        return true;
      },
      isCurrent: () => true,
      close: () => { closed = true; },
    },
  },
};

await import(`../src/frontend/chat/chat-sse-controller.ts?flow-test=${Date.now()}`);

after(() => {
  global.window = originalWindow;
  global.mark = originalMark;
  global.sb = originalScroll;
  global.toast = originalToast;
});

describe("chat SSE controller event flow", () => {
  it("routes a complete event script through incremental rendering without a full message render", () => {
    reset();
    const controller = global.window.App.ChatViews.createSseController({
      scheduleMessagesRender: () => { scheduledRenders += 1; },
      updateUI: () => {},
      markLastMessageRendered: () => { markedRendered += 1; },
      renderMessages: () => { fullRenders += 1; },
      refreshComposer: () => {},
      setAssistantError: () => {},
      completeSend: () => {},
      failSend: () => {},
    });

    assert.strictEqual(controller.bind(7), true);
    for (const block of CHAT_FLOW_SSE_BLOCKS) {
      handlers.onMessage({ data: JSON.stringify({ type: "block", block }) });
    }

    const terminalBlocks = CHAT_FLOW_SSE_BLOCKS
      .filter((block, index, all) => all.findLastIndex((item) => item.blockId === block.blockId) === index)
      .map((block) => block.type === "thinking" ? { ...block, status: "done" } : block);
    handlers.onMessage({ data: JSON.stringify({ type: "done", text: "final answer", blocks: terminalBlocks }) });

    assert.deepStrictEqual(updateCalls, CHAT_FLOW_SSE_BLOCKS.map((block) => block.blockId));
    assert.strictEqual(scheduledRenders, 0, "successful block updates must not schedule a full message render");
    assert.strictEqual(fullRenders, 0, "a successful terminal update must not replace the assistant message");
    assert.strictEqual(markedRendered, CHAT_FLOW_SSE_BLOCKS.length + 1, "each incremental and terminal update must synchronize the message diff key");
    assert.strictEqual(finalized, true);
    assert.strictEqual(closed, true);
    assert.strictEqual(messages[0].streaming, false);
    assert.deepStrictEqual(messages[0].blocks.map((block) => block.blockId), ["thinking-flow-1", "tool-flow", "thinking-flow-2", "text-flow"]);
  });

  it("ignores compatibility thinking frames once block streaming owns the assistant node", () => {
    reset();
    const controller = global.window.App.ChatViews.createSseController({
      scheduleMessagesRender: () => { scheduledRenders += 1; },
      updateUI: () => {},
      markLastMessageRendered: () => { markedRendered += 1; },
      renderMessages: () => { fullRenders += 1; },
      refreshComposer: () => {},
      setAssistantError: () => {},
      completeSend: () => {},
      failSend: () => {},
    });

    assert.strictEqual(controller.bind(8), true);
    handlers.onMessage({ data: JSON.stringify({ type: "block", block: CHAT_FLOW_SSE_BLOCKS[0] }) });
    const revisionAfterBlock = messages[0]._rv;
    handlers.onMessage({ data: JSON.stringify({ type: "thinking", text: "兼容重复帧" }) });

    assert.strictEqual(messages[0].thinking, undefined, "block 流已有可见 Thought 节点时不应再写兼容 thinking 字段");
    assert.strictEqual(messages[0]._rv, revisionAfterBlock, "兼容 thinking 帧不得制造额外 UI revision");
    assert.strictEqual(markedRendered, 1);
    assert.strictEqual(scheduledRenders, 0);
    assert.strictEqual(fullRenders, 0);
  });
});
