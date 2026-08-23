import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Window } from "happy-dom";

import {
  fixturePath,
  loadReplayCatalog,
  replayMode,
  runReplayScenario,
} from "./fixtures/agent-session-replay.mjs";

describe("T-01 replay-first Agent/Session flow", () => {
  it("keeps the fixture catalog declared, deterministic and drift-checked", () => {
    const catalog = loadReplayCatalog();
    assert.equal(replayMode("replay"), "replay");
    assert.match(fixturePath(), /agent-session-replay-fixtures\.json$/u);
    assert.equal(catalog.scenarios.length, 5);
    for (const scenario of catalog.scenarios) {
      assert.equal(scenario.events[0].timestamp, 1, `${scenario.id}: logical timestamps must start at one`);
      assert.equal(scenario.events.at(-1).type, "turn.completed", `${scenario.id}: replay fixtures must have a successful terminal for this gate`);
      assert.ok(scenario.modelResponses.every((response) => response.provider === "replay"));
      assert.ok(scenario.toolCalls.every((call) => typeof call.id === "string" && typeof call.name === "string"));
    }
  });

  it("replays every required scenario through runtime events, SSE, persistence and refresh", () => {
    const catalog = loadReplayCatalog();
    for (const scenario of catalog.scenarios) {
      const result = runReplayScenario(scenario, "replay");
      assert.equal(result.mode, "replay");
      assert.equal(result.live.text, result.replay.text, `${scenario.id}: live and replay text must converge`);
      assert.equal(result.replay.text, result.refresh.text, `${scenario.id}: replay and refresh text must converge`);
      assert.deepEqual(result.live.blocks, result.replay.blocks, `${scenario.id}: live and replay blocks must converge`);
      assert.deepEqual(result.replay.blocks, result.refresh.blocks, `${scenario.id}: replay and refresh blocks must converge`);
      assert.ok(result.reconnect.length > 0, `${scenario.id}: reconnect must replay a suffix`);
      assert.ok(result.intermediate.length === scenario.events.length, `${scenario.id}: every event must be observed`);
    }
  });

  it("supports refresh as a persistence-only path without re-running model or tool calls", () => {
    const catalog = loadReplayCatalog();
    const scenario = catalog.scenarios.find((entry) => entry.id === "refresh-recovery");
    assert.ok(scenario);
    const result = runReplayScenario(scenario, "refresh");
    assert.equal(result.mode, "refresh");
    assert.equal(result.live.text, "Recovered answer");
    assert.equal(result.refresh.text, "Recovered answer");
  });

  it("projects the same replay presentation into the built dashboard and preserves DOM identity", () => {
    const root = resolve(process.cwd());
    const bundle = resolve(root, "dist/frontend/js/dashboard.js");
    assert.equal(existsSync(bundle), true, "built dashboard is required for the T-01 frontend projection gate");
    const scenario = loadReplayCatalog().scenarios.find((entry) => entry.id === "event-node-order");
    assert.ok(scenario);
    const result = runReplayScenario(scenario, "replay");
    const createWindow = () => {
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
      win.eval(readFileSync(bundle, "utf8"));
      return win;
    };
    const win = createWindow();
    win.App.ChatState.replaceMessages([{ role: "assistant", content: "", streaming: true, blocks: [] }]);
    win.document.getElementById("ms").innerHTML = win.App.Chat.msgs();
    const rootNode = win.document.querySelector("#ms > .m");
    const identities = new Map();
    let removed = 0;
    const observer = new win.MutationObserver((records) => { for (const record of records) removed += record.removedNodes.length; });
    observer.observe(win.document.getElementById("ms"), { childList: true, subtree: true });
    const controller = new win.App.ChatViews.ChatSseControllerView({
      scheduleMessagesRender: () => {}, updateUI: () => {}, markLastMessageRendered: () => {},
      renderMessages: () => {}, refreshComposer: () => {}, setAssistantError: () => {},
      completeSend: () => {}, failSend: () => {},
    }, {
      chat: win.App.Chat, chatState: win.App.ChatState,
      chatStream: { isCurrent: () => true, setHandlers: () => true, close: () => {} }, chatViews: win.App.ChatViews,
    });
    assert.equal(controller.bind(1), true);
    for (const payload of result.live.presentation) {
      controller.handleMessage(1, { data: JSON.stringify(payload) });
      for (const block of payload.blocks || (payload.block ? [payload.block] : [])) {
        const node = win.document.querySelector(`[data-block-id="${block.blockId}"]`);
        assert.ok(node, `${block.blockId} must mount from replay presentation`);
        if (identities.has(block.blockId)) assert.equal(node, identities.get(block.blockId), `${block.blockId} identity changed during replay`);
        else identities.set(block.blockId, node);
      }
    }
    observer.disconnect();
    assert.equal(win.document.querySelector("#ms > .m"), rootNode);
    assert.equal(removed, 0, "replay presentation must not remove existing nodes");
    const liveSnapshot = [...win.document.querySelectorAll("#ms [data-block-id]")].map((node) => ({ id: node.dataset.blockId, text: node.textContent }));
    const refreshed = createWindow();
    refreshed.App.ChatState.replaceMessages([{ role: "assistant", content: result.live.text, streaming: false, blocks: result.live.presentation.find((payload) => payload.type === "done").blocks }]);
    refreshed.document.getElementById("ms").innerHTML = refreshed.App.Chat.msgs();
    const refreshSnapshot = [...refreshed.document.querySelectorAll("#ms [data-block-id]")].map((node) => ({ id: node.dataset.blockId, text: node.textContent }));
    assert.deepEqual(refreshSnapshot, liveSnapshot, "built dashboard refresh must converge to replay presentation");
    win.close();
    refreshed.close();
  });

  it("rejects record mode unless recording is explicitly enabled", () => {
    const previous = process.env.MY_CODE_AGENT_REPLAY_RECORD;
    delete process.env.MY_CODE_AGENT_REPLAY_RECORD;
    try {
      assert.throws(() => replayMode("record"), /record mode is opt-in/u);
    } finally {
      if (previous === undefined) delete process.env.MY_CODE_AGENT_REPLAY_RECORD;
      else process.env.MY_CODE_AGENT_REPLAY_RECORD = previous;
    }
  });

  it("writes an explicit record artifact only when both record guards are enabled", () => {
    const previousRecord = process.env.MY_CODE_AGENT_REPLAY_RECORD;
    const previousDir = process.env.MY_CODE_AGENT_REPLAY_RECORD_DIR;
    const outputDir = mkdtempSync(join(tmpdir(), "agent-replay-record-"));
    process.env.MY_CODE_AGENT_REPLAY_RECORD = "1";
    process.env.MY_CODE_AGENT_REPLAY_RECORD_DIR = outputDir;
    try {
      const scenario = loadReplayCatalog().scenarios[0];
      const result = runReplayScenario(scenario, "record");
      assert.equal(result.mode, "record");
      assert.deepEqual(readdirSync(outputDir), [`${scenario.id}.json`]);
    } finally {
      if (previousRecord === undefined) delete process.env.MY_CODE_AGENT_REPLAY_RECORD;
      else process.env.MY_CODE_AGENT_REPLAY_RECORD = previousRecord;
      if (previousDir === undefined) delete process.env.MY_CODE_AGENT_REPLAY_RECORD_DIR;
      else process.env.MY_CODE_AGENT_REPLAY_RECORD_DIR = previousDir;
      rmSync(outputDir, { recursive: true, force: true });
    }
  });
});
