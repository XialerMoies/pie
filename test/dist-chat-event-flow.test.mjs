import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { Window } from "happy-dom";
import { CHAT_FLOW_SSE_BLOCKS } from "./fixtures/chat-event-flow.mjs";

const ROOT = resolve(process.cwd());
const DIST_BUNDLE = resolve(ROOT, "dist/frontend/js/dashboard.js");

function loadDistWindow() {
  assert.ok(existsSync(DIST_BUNDLE), "dist frontend bundle must exist; run npm run build first");
  const win = new Window({ url: "http://127.0.0.1:5173/dashboard.html" });
  const doc = win.document;
  doc.body.innerHTML = '<div id="app"></div><div id="ms"></div><div id="pc"></div><textarea id="ci"></textarea><button id="cs"></button>';
  win.fetch = async () => ({ ok: true, json: async () => ({}) });
  win.localStorage.clear();
  win.requestAnimationFrame = (callback) => setTimeout(callback, 0);
  win.cancelAnimationFrame = (id) => clearTimeout(id);
  win.mark = () => {};
  win.logTiming = () => {};
  win.toast = () => {};
  win.confirmAsync = async () => true;
  win.winCtrl = () => {};
  win.refresh = async () => {};
  win.getPane = () => null;
  win.eval(readFileSync(DIST_BUNDLE, "utf8"));
  return win;
}

function createController(win, counters) {
  const stream = {
    isCurrent: () => true,
    setHandlers: () => true,
    close: () => { counters.closed += 1; },
  };
  const controller = new win.App.ChatViews.ChatSseControllerView({
    scheduleMessagesRender: () => { counters.scheduled += 1; },
    updateUI: () => {},
    markLastMessageRendered: () => { counters.marked += 1; },
    renderMessages: () => { counters.fullRenders += 1; },
    refreshComposer: () => {},
    setAssistantError: () => {},
    completeSend: () => {},
    failSend: () => {},
  }, {
    chat: win.App.Chat,
    chatState: win.App.ChatState,
    chatStream: stream,
    chatViews: win.App.ChatViews,
  });
  return { controller, stream };
}

function latestBlocks() {
  const latest = new Map();
  for (const block of CHAT_FLOW_SSE_BLOCKS) latest.set(block.blockId, block);
  return [...latest.values()].map((block) => block.type === "thinking" ? { ...block, status: "done" } : block);
}

describe("built dashboard event flow", () => {
  it("loads the dist bundle and preserves DOM identity across live, reconnect, and refresh replay", () => {
    const win = loadDistWindow();
    const doc = win.document;
    const counters = { scheduled: 0, marked: 0, fullRenders: 0, closed: 0 };
    win.App.ChatState.replaceMessages([{ role: "assistant", content: "", streaming: true, blocks: [] }]);
    doc.getElementById("ms").innerHTML = win.App.Chat.msgs();
    const root = doc.querySelector("#ms > .m");
    const nodes = new Map();
    const mutationCounts = { added: 0, removed: 0 };
    const observer = new win.MutationObserver((records) => {
      for (const record of records) {
        mutationCounts.added += record.addedNodes.length;
        mutationCounts.removed += record.removedNodes.length;
      }
    });
    observer.observe(doc.getElementById("ms"), { childList: true, subtree: true });

    const { controller } = createController(win, counters);
    assert.strictEqual(controller.bind(1), true);
    const livePrefix = CHAT_FLOW_SSE_BLOCKS.slice(0, 2);
    const reconnectTail = CHAT_FLOW_SSE_BLOCKS.slice(1);
    for (const block of [...livePrefix, ...reconnectTail]) {
      controller.handleMessage(1, { data: JSON.stringify({ type: "block", block }) });
      const mounted = doc.querySelector(`[data-block-id="${block.blockId}"]`);
      assert.ok(mounted, `${block.blockId} must be visible after its event`);
      if (nodes.has(block.blockId)) assert.strictEqual(mounted, nodes.get(block.blockId), `${block.blockId} identity must remain stable`);
      else nodes.set(block.blockId, mounted);
      assert.strictEqual(doc.querySelector("#ms > .m"), root, "assistant root must remain mounted");
      if (block.text) assert.ok(mounted.textContent.includes(block.text), `${block.blockId} text must update immediately`);
      else assert.ok(mounted.textContent.trim().length > 0, `${block.blockId} state must render immediately`);
    }

    const terminalBlocks = latestBlocks();
    controller.handleMessage(1, { data: JSON.stringify({ type: "done", text: "最终正文", blocks: terminalBlocks }) });
    observer.disconnect();

    assert.strictEqual(counters.scheduled, 0, "successful SSE events must not schedule full renders");
    assert.strictEqual(counters.fullRenders, 0, "terminal replay must not replace the assistant root");
    assert.strictEqual(counters.closed, 1);
    assert.deepEqual([...doc.querySelectorAll("#ms [data-block-id]")].map((node) => node.dataset.blockId), [
      "thinking-flow-1", "tool-flow", "thinking-flow-2", "text-flow",
    ]);
    assert.strictEqual(mutationCounts.removed, 0, "live stream must not remove mounted event nodes");
    assert.ok(mutationCounts.added <= 4, "live stream may add each logical node once");

    const liveSnapshot = [...doc.querySelectorAll("#ms [data-block-id]")].map((node) => ({
      id: node.dataset.blockId,
      text: node.textContent,
    }));

    const refreshed = loadDistWindow();
    refreshed.App.ChatState.replaceMessages([{ role: "assistant", content: "最终正文", streaming: false, blocks: terminalBlocks }]);
    refreshed.document.getElementById("ms").innerHTML = refreshed.App.Chat.msgs();
    const replaySnapshot = [...refreshed.document.querySelectorAll("#ms [data-block-id]")].map((node) => ({
      id: node.dataset.blockId,
      text: node.textContent,
    }));
    assert.deepEqual(replaySnapshot, liveSnapshot, "refresh replay must match the live terminal DOM snapshot");
  });
});
