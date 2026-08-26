import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Window } from "happy-dom";
import { describe, it } from "node:test";
import { DETERMINISTIC_IDS, eventScriptFor } from "./fixtures/deterministic-event-script.mjs";

const ROOT = resolve(process.cwd());
const DIST_ROUTER = resolve(ROOT, "dist/server/agent-event-router.js");
const DIST_BUNDLE = resolve(ROOT, "dist/frontend/js/dashboard.js");

function loadDistWindow() {
  assert.ok(existsSync(DIST_BUNDLE), "dist frontend bundle must exist; run npm run build first");
  const win = new Window({ url: "http://127.0.0.1:5173/dashboard.html" });
  win.document.body.innerHTML = '<div id="ms"></div><div id="pc"></div><textarea id="ci"></textarea><button id="cs"></button>';
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

function makeServerFlow() {
  let listener;
  const sessionId = "dist-session";
  const turnId = "dist-turn";
  const engine = {
    session: { id: sessionId, workspace: ROOT, isStreaming: true, isCompacting: false },
    subscribe(next) {
      listener = next;
      return () => { listener = undefined; };
    },
    emit(event) { listener?.(event); },
    getContextUsage() { return undefined; },
    getSessionStats() { return undefined; },
  };
  const chat = {
    textBuffer: "",
    thinkingBuffer: "",
    response: { write() { return true; }, end() {} },
    turnId,
    traceSeq: 0,
    eventSeq: 0,
    eventHistory: [],
    blocks: [],
    emittedTraces: new Set(),
    blockSeq: 0,
  };
  const runtime = {
    session: {
      sessionFile: undefined,
      sessionManager: { flushed: false, getSessionId: () => sessionId },
    },
  };
  return { engine, chat, runtime, sessionId, turnId };
}

function payloads(chat) {
  return chat.eventHistory
    .map((entry) => JSON.parse(entry.data.split("data: ")[1]))
    .filter((payload) => payload.type === "block" || payload.type === "done");
}

function comparableText(text) {
  return text.replace(/Thought\.\.\./g, "Thought");
}

describe("built server and dashboard event flow", () => {
  it("loads the generated profile catalog from the built agent modules", async () => {
    const distCatalogModule = resolve(ROOT, "dist/agent/profile-catalog.js");
    assert.ok(existsSync(distCatalogModule), "dist profile catalog module must exist; run npm run build first");
    const { buildAllProfileCatalogs } = await import(`${pathToFileURL(distCatalogModule).href}?profile-catalog=${Date.now()}`);
    const built = buildAllProfileCatalogs();
    const generated = JSON.parse(readFileSync(resolve(ROOT, "docs/generated/profile-catalog.json"), "utf8")).profiles;
    assert.deepEqual(built, generated);
    assert.deepEqual(built.map((catalog) => catalog.id), ["minimal", "standard"]);
    assert.ok(built.every((catalog) => catalog.tools.every((tool) => tool.executable)));
    assert.ok(built.every((catalog) => catalog.tools.every((tool) => tool.source === "native" && tool.audiences.includes("main"))));
  });

  it("injects built server events into the built dashboard and preserves live/replay state", async () => {
    assert.ok(existsSync(DIST_ROUTER), "dist server router must exist; run npm run build first");
    const { attachEngineEvents } = await import(`${pathToFileURL(DIST_ROUTER).href}?dist-flow=${Date.now()}`);
    const serverFlow = makeServerFlow();
    attachEngineEvents(serverFlow.engine, serverFlow.runtime, serverFlow.chat);

    const base = {
      version: 1,
      sessionId: serverFlow.sessionId,
      turnId: serverFlow.turnId,
      timestamp: 1,
    };
    serverFlow.engine.emit({ ...base, type: "turn.started", seq: 1 });
    serverFlow.engine.emit({ ...base, type: "thinking.delta", seq: 2, text: "先检查" });
    serverFlow.engine.emit({
      ...base,
      type: "tool.started",
      seq: 3,
      toolCallId: "dist-tool",
      name: "file_read",
      input: { path: "missing.txt" },
    });
    serverFlow.engine.emit({
      ...base,
      type: "tool.failed",
      seq: 4,
      toolCallId: "dist-tool",
      name: "file_read",
      error: {
        kind: "not_found",
        code: "file_read_failed",
        message: "读取失败：HTTP 404",
        details: { status: 404 },
      },
    });
    serverFlow.engine.emit({ ...base, type: "content.delta", seq: 5, text: "已确认失败" });
    serverFlow.engine.emit({ ...base, type: "turn.completed", seq: 6 });

    const serverPayloads = payloads(serverFlow.chat);
    const done = serverPayloads.find((payload) => payload.type === "done");
    assert.ok(done, "built server must emit a terminal done payload");
    assert.deepEqual(done.blocks.map((block) => block.type), ["thinking", "tool", "step", "text"]);
    assert.equal(done.blocks.find((block) => block.type === "tool").status, "error");
    assert.equal(done.blocks.find((block) => block.type === "step").variant, "error");
    assert.deepEqual(done.blocks.map((block) => block.seq), [1, 2, 3, 4]);

    const win = loadDistWindow();
    const doc = win.document;
    const counters = { fullRenders: 0, scheduled: 0, closed: 0 };
    win.App.ChatState.replaceMessages([{ role: "assistant", content: "", streaming: true, blocks: [] }]);
    doc.getElementById("ms").innerHTML = win.App.Chat.msgs();
    // The generic dist frontend flow test exercises the real finalizer. This
    // server-payload test keeps terminal handling incremental so the assertion
    // remains focused on block identity and live/replay data equivalence.
    win.App.Chat.finalizeLastMessage = () => true;
    const root = doc.querySelector("#ms > .m");
    const identities = new Map();
    const mutations = { added: 0, removed: 0 };
    const observer = new win.MutationObserver((records) => {
      for (const record of records) {
        mutations.added += record.addedNodes.length;
        mutations.removed += record.removedNodes.length;
      }
    });
    observer.observe(doc.getElementById("ms"), { childList: true, subtree: true });
    const controller = new win.App.ChatViews.ChatSseControllerView({
      scheduleMessagesRender: () => { counters.scheduled++; },
      updateUI: () => {},
      markLastMessageRendered: () => {},
      renderMessages: () => { counters.fullRenders++; },
      refreshComposer: () => {},
      setAssistantError: () => {},
      completeSend: () => {},
      failSend: () => {},
    }, {
      chat: win.App.Chat,
      chatState: win.App.ChatState,
      chatStream: { isCurrent: () => true, setHandlers: () => true, close: () => { counters.closed++; } },
      chatViews: win.App.ChatViews,
    });
    assert.equal(controller.bind(1), true);

    for (const payload of serverPayloads) {
      if (payload.type === "done") observer.disconnect();
      controller.handleMessage(1, { data: JSON.stringify(payload) });
      for (const block of payload.blocks || [payload.block]) {
        if (!block) continue;
        const node = doc.querySelector(`[data-block-id="${block.blockId}"]`);
        assert.ok(node, `${block.blockId} must be mounted after its server event`);
        if (identities.has(block.blockId)) assert.equal(node, identities.get(block.blockId));
        else identities.set(block.blockId, node);
      }
    }
    observer.disconnect();

    assert.equal(doc.querySelector("#ms > .m"), root);
    assert.equal(counters.fullRenders, 0);
    assert.equal(counters.scheduled, 0);
    assert.equal(counters.closed, 1);
    assert.equal(mutations.removed, 0);
    assert.deepEqual([...doc.querySelectorAll("#ms [data-block-id]")].map((node) => node.dataset.blockId), [
      "thinking-dist-turn",
      "tool-dist-tool",
      "error-dist-turn",
      "text-trailing",
    ]);

    const liveSnapshot = [...doc.querySelectorAll("#ms [data-block-id]")].map((node) => ({
      id: node.dataset.blockId,
      text: comparableText(node.textContent),
    }));
    const refreshed = loadDistWindow();
    refreshed.App.ChatState.replaceMessages([{ role: "assistant", content: done.text, streaming: false, blocks: done.blocks }]);
    refreshed.document.getElementById("ms").innerHTML = refreshed.App.Chat.msgs();
    const replaySnapshot = [...refreshed.document.querySelectorAll("#ms [data-block-id]")].map((node) => ({
      id: node.dataset.blockId,
      text: comparableText(node.textContent),
    }));
    assert.deepEqual(replaySnapshot, liveSnapshot);
  });

  it("runs the shared deterministic event script through built router and built dashboard step by step", async () => {
    assert.ok(existsSync(DIST_ROUTER), "dist server router must exist; run npm run build first");
    const { attachEngineEvents } = await import(`${pathToFileURL(DIST_ROUTER).href}?deterministic-flow=${Date.now()}`);
    const serverFlow = makeServerFlow();
    attachEngineEvents(serverFlow.engine, serverFlow.runtime, serverFlow.chat);
    const script = eventScriptFor(serverFlow.sessionId, serverFlow.turnId);
    const blockSnapshots = [];
    const seqById = new Map();
    for (const step of script) {
      serverFlow.engine.emit(step.event);
      const blocks = serverFlow.chat.blocks.slice().sort((left, right) => left.seq - right.seq);
      for (const block of blocks) {
        if (seqById.has(block.blockId)) assert.equal(block.seq, seqById.get(block.blockId), `${step.id}: built seq must stay stable`);
        else seqById.set(block.blockId, block.seq);
      }
      blockSnapshots.push({ step: step.id, ids: blocks.map((block) => block.blockId), seq: blocks.map((block) => block.seq) });
    }
    const serverPayloads = payloads(serverFlow.chat);
    const done = serverPayloads.find((payload) => payload.type === "done");
    assert.ok(done);
    assert.deepEqual(done.blocks.map((block) => block.blockId), [
      DETERMINISTIC_IDS.firstThought,
      DETERMINISTIC_IDS.tool,
      DETERMINISTIC_IDS.secondThought,
      DETERMINISTIC_IDS.text,
    ]);
    assert.deepEqual(blockSnapshots.find((entry) => entry.step === "text-end").ids, done.blocks.map((block) => block.blockId));

    const win = loadDistWindow();
    const doc = win.document;
    const counters = { fullRenders: 0, scheduled: 0, closed: 0 };
    win.App.ChatState.replaceMessages([{ role: "assistant", content: "", streaming: true, blocks: [] }]);
    doc.getElementById("ms").innerHTML = win.App.Chat.msgs();
    const root = doc.querySelector("#ms > .m");
    const identities = new Map();
    const mutations = { added: 0, removed: 0 };
    const observer = new win.MutationObserver((records) => {
      for (const record of records) {
        mutations.added += record.addedNodes.length;
        mutations.removed += record.removedNodes.length;
      }
    });
    observer.observe(doc.getElementById("ms"), { childList: true, subtree: true });
    const controller = new win.App.ChatViews.ChatSseControllerView({
      scheduleMessagesRender: () => { counters.scheduled++; },
      updateUI: () => {},
      markLastMessageRendered: () => {},
      renderMessages: () => { counters.fullRenders++; },
      refreshComposer: () => {},
      setAssistantError: () => {},
      completeSend: () => {},
      failSend: () => {},
    }, {
      chat: win.App.Chat,
      chatState: win.App.ChatState,
      chatStream: { isCurrent: () => true, setHandlers: () => true, close: () => { counters.closed++; } },
      chatViews: win.App.ChatViews,
    });
    assert.equal(controller.bind(1), true);
    for (const payload of serverPayloads) {
      controller.handleMessage(1, { data: JSON.stringify(payload) });
      if (payload.type !== "block") continue;
      const node = doc.querySelector(`[data-block-id="${payload.block.blockId}"]`);
      assert.ok(node, `${payload.block.blockId} must be mounted immediately after ${payload.block.type}`);
      if (identities.has(payload.block.blockId)) assert.strictEqual(node, identities.get(payload.block.blockId), `${payload.block.blockId} identity must stay stable`);
      else identities.set(payload.block.blockId, node);
      assert.strictEqual(doc.querySelector("#ms > .m"), root, "assistant root must remain stable during stream");
    }
    observer.disconnect();
    assert.equal(counters.fullRenders, 0);
    assert.equal(counters.scheduled, 0);
    assert.equal(counters.closed, 1);
    assert.equal(mutations.removed, 0, "built live stream must not remove existing event nodes");
    assert.deepEqual([...doc.querySelectorAll("#ms [data-block-id]")].map((node) => node.dataset.blockId), done.blocks.map((block) => block.blockId));

    const liveSnapshot = [...doc.querySelectorAll("#ms [data-block-id]")].map((node) => ({
      id: node.dataset.blockId,
      text: node.textContent,
    }));
    const refreshed = loadDistWindow();
    refreshed.App.ChatState.replaceMessages([{ role: "assistant", content: done.text, streaming: false, blocks: done.blocks }]);
    refreshed.document.getElementById("ms").innerHTML = refreshed.App.Chat.msgs();
    const refreshSnapshot = [...refreshed.document.querySelectorAll("#ms [data-block-id]")].map((node) => ({
      id: node.dataset.blockId,
      text: node.textContent,
    }));
    assert.deepEqual(refreshSnapshot, liveSnapshot, "Ctrl+R/session refresh replay must match the live deterministic DOM");
  });
});
