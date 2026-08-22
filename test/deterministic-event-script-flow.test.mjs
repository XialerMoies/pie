import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { attachEngineEvents } from "../src/server/agent-event-router.ts";
import { replayChatEvents } from "../src/server/chat-stream.ts";
import { parseSessionMessages } from "../src/server/routes/session-message-parser.ts";
import {
  DETERMINISTIC_FINAL_BLOCKS,
  DETERMINISTIC_IDS,
  assertLinearBlocks,
  eventScriptFor,
} from "./fixtures/deterministic-event-script.mjs";

function fakeEngine(sessionId = "script-session") {
  let listener;
  return {
    session: { id: sessionId, workspace: process.cwd(), isStreaming: true, isCompacting: false },
    subscribe(next) { listener = next; return () => { listener = undefined; }; },
    emit(event) { listener?.(event); },
    getContextUsage() { return undefined; },
    getSessionStats() { return undefined; },
  };
}

function stream() {
  return {
    textBuffer: "", thinkingBuffer: "", response: { write() {}, end() {} },
    turnId: "", traceSeq: 0, eventSeq: 0, eventHistory: [], blocks: [], blockSeq: 0,
    emittedTraces: new Set(), textSegments: [], thinkingBlockGenerations: {},
  };
}

function runtime(sessionFile, sessionId = "script-session") {
  return { session: { sessionFile, sessionManager: { flushed: true, getSessionId: () => sessionId } } };
}

function payloads(chat) {
  return chat.eventHistory.map((entry) => JSON.parse(entry.data.split("data: ")[1]));
}

function replayPayloads(chat, cursor) {
  const output = [];
  replayChatEvents(chat, { write: (chunk) => output.push(String(chunk)) }, cursor);
  return output.map((frame) => JSON.parse(frame.split("data: ")[1]));
}

function logicalBlocks(blocks) {
  return blocks.map((block) => Object.fromEntries(Object.entries({
    type: block.type,
    blockId: block.blockId,
    seq: block.seq,
    status: block.status,
    text: block.text,
    toolCallId: block.toolCallId,
    output: block.output,
  }).filter(([, value]) => value !== undefined)));
}

describe("A-08/a deterministic event script", () => {
  it("drives engine, domain blocks, presentation SSE, JSONL replay and reconnect from one script", () => {
    const dir = mkdtempSync(join(tmpdir(), "deterministic-event-script-"));
    const sessionFile = join(dir, "session.jsonl");
    writeFileSync(sessionFile, [
      JSON.stringify({ type: "session", id: "script-session" }),
      JSON.stringify({ type: "message", id: "user-1", message: { role: "user", content: [{ type: "text", text: "检查" }] } }),
      JSON.stringify({ type: "message", id: "assistant-1", turnId: "script-turn", message: { role: "assistant", content: [] } }),
    ].join("\n") + "\n");
    try {
      const engine = fakeEngine();
      const chat = stream();
      attachEngineEvents(engine, runtime(sessionFile), chat);
      const snapshots = [];
      const seqByBlock = new Map();
      const closedTextByBlock = new Map();

      for (const step of eventScriptFor()) {
        engine.emit(step.event);
        const blocks = assertLinearBlocks(chat.blocks, assert);
        for (const block of blocks) {
          if (seqByBlock.has(block.blockId)) assert.equal(block.seq, seqByBlock.get(block.blockId), `${step.id}: seq must stay stable`);
          else seqByBlock.set(block.blockId, block.seq);
          if (closedTextByBlock.has(block.blockId)) assert.equal(block.text, closedTextByBlock.get(block.blockId), `${step.id}: closed node must not receive later text`);
          if (block.type === "thinking" && block.status === "done") closedTextByBlock.set(block.blockId, block.text);
        }
        snapshots.push({ step: step.id, blocks: logicalBlocks(blocks), eventCount: chat.eventHistory.length });
      }

      const liveEvents = payloads(chat);
      const done = liveEvents.find((event) => event.type === "done");
      assert.ok(done, "the script must produce one terminal presentation event");
      assert.equal(liveEvents.filter((event) => event.type === "done").length, 1);
      assert.equal(liveEvents.some((event) => ["trace", "delta", "thinking"].includes(event.type)), false);
      assert.deepEqual(logicalBlocks(done.blocks), DETERMINISTIC_FINAL_BLOCKS);
      assert.deepEqual(snapshots.find((entry) => entry.step === "text-end").blocks, DETERMINISTIC_FINAL_BLOCKS);
      assert.deepEqual(snapshots.at(-1).blocks, [], "terminal handling may clear the live accumulator after publishing done");
      assert.equal(snapshots.find((entry) => entry.step === "thought-2-start").blocks[0].text, "先分析");
      assert.equal(snapshots.find((entry) => entry.step === "thought-2-start").blocks[0].status, "done");

      const replayFromCursor = replayPayloads(chat, 2);
      assert.deepEqual(replayFromCursor, liveEvents.filter((_event, index) => index >= 2), "Last-Event-ID replay must preserve the same presentation frames");

      const persisted = parseSessionMessages(readFileSync(sessionFile, "utf8"));
      const replayBlocks = persisted.find((message) => message.role === "assistant")?.blocks || [];
      assert.deepEqual(logicalBlocks(replayBlocks), DETERMINISTIC_FINAL_BLOCKS, "session replay must converge to live blocks");
      assert.deepEqual(replayBlocks.map((block) => block.blockId), [
        DETERMINISTIC_IDS.firstThought,
        DETERMINISTIC_IDS.tool,
        DETERMINISTIC_IDS.secondThought,
        DETERMINISTIC_IDS.text,
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects duplicate/out-of-order/late events without reopening closed nodes", () => {
    const engine = fakeEngine("script-fault-session");
    const chat = stream();
    attachEngineEvents(engine, runtime(undefined, "script-fault-session"), chat);
    const faultScript = eventScriptFor("script-fault-session", "script-fault-turn");
    const step = (id) => faultScript.find((entry) => entry.id === id);
    const first = step("turn-start");
    const second = step("thought-start");
    const toolStart = step("tool-start");
    const toolResult = step("tool-result");
    const textStart = step("text-start");
    const complete = step("turn-complete");
    engine.emit(first.event);
    engine.emit(second.event);
    engine.emit(toolStart.event);
    engine.emit({ ...toolStart.event, seq: 99, timestamp: 99 });
    engine.emit({ ...toolResult.event, seq: 4, timestamp: 4 });
    engine.emit(toolResult.event);
    engine.emit(textStart.event);
    engine.emit(complete.event);
    const terminal = JSON.stringify(chat.blocks);
    const eventCount = chat.eventHistory.length;
    engine.emit({ ...second.event, seq: 100, timestamp: 100, text: "迟到 Thought" });
    assert.equal(JSON.stringify(chat.blocks), terminal, "terminal 后迟到 delta 不得改变 blocks");
    assert.equal(chat.eventHistory.length, eventCount, "terminal 后迟到 delta 不得发新 presentation event");
    const terminalPayload = payloads(chat).find((event) => event.type === "done");
    assert.ok(terminalPayload);
    assert.equal(terminalPayload.blocks.filter((block) => block.blockId === DETERMINISTIC_IDS.tool).length, 1);
    assert.equal(terminalPayload.blocks.find((block) => block.blockId === DETERMINISTIC_IDS.firstThought)?.text, "先");
  });

  it("keeps failure and cancellation terminal paths explicit and single-shot", () => {
    for (const terminal of [
      { type: "turn.failed", error: { category: "provider", code: "provider_failed", message: "失败", retryable: false } },
      { type: "turn.cancelled", reason: "用户取消" },
    ]) {
      const sessionId = `script-${terminal.type}`;
      const engine = fakeEngine(sessionId);
      const chat = stream();
      attachEngineEvents(engine, runtime(undefined, sessionId), chat);
      engine.emit({ version: 1, type: "turn.started", sessionId, turnId: sessionId, seq: 1, timestamp: 1 });
      engine.emit({ version: 1, type: "thinking.delta", sessionId, turnId: sessionId, seq: 2, timestamp: 2, text: "进行中" });
      engine.emit({ version: 1, ...terminal, sessionId, turnId: sessionId, seq: 3, timestamp: 3 });
      engine.emit({ version: 1, ...terminal, sessionId, turnId: sessionId, seq: 4, timestamp: 4 });
      const events = payloads(chat);
      assert.equal(events.filter((event) => event.type === "done" || event.type === "cancelled").length, 1);
      const terminalEvent = events.find((event) => event.type === "done" || event.type === "cancelled");
      assert.ok(terminalEvent);
      if (terminal.type === "turn.failed") {
        assert.equal(terminalEvent.blocks.find((block) => block.type === "thinking")?.status, "done");
      }
    }
  });

  it("keeps a verification turn without evidence explicitly unverified", () => {
    const sessionId = "script-unverified-session";
    const engine = fakeEngine(sessionId);
    const chat = stream();
    chat.taskRequirements = { kind: "verification", requiresEvidence: true, minSuccessfulEvidence: 1 };
    attachEngineEvents(engine, runtime(undefined, sessionId), chat);
    engine.emit({ version: 1, type: "turn.started", sessionId, turnId: "script-unverified-turn", seq: 1, timestamp: 1 });
    engine.emit({ version: 1, type: "content.delta", sessionId, turnId: "script-unverified-turn", seq: 2, timestamp: 2, text: "看起来完成" });
    engine.emit({ version: 1, type: "turn.completed", sessionId, turnId: "script-unverified-turn", seq: 3, timestamp: 3 });
    const done = payloads(chat).find((event) => event.type === "done");
    assert.ok(done);
    assert.equal(done.status, "error");
    assert.equal(done.task.status, "blocked");
    assert.equal(done.task.reason, "evidence_insufficient");
    assert.match(done.text, /^未验证：/);
  });

  it("keeps concurrent session event streams and JSONL writes isolated", async () => {
    const dir = mkdtempSync(join(tmpdir(), "deterministic-concurrent-sessions-"));
    const sessions = ["script-concurrent-a", "script-concurrent-b"].map((sessionId) => {
      const sessionFile = join(dir, `${sessionId}.jsonl`);
      writeFileSync(sessionFile, [
        JSON.stringify({ type: "session", id: sessionId }),
        JSON.stringify({ type: "message", id: `${sessionId}-assistant`, turnId: `${sessionId}-turn`, message: { role: "assistant", content: [] } }),
      ].join("\n") + "\n");
      const engine = fakeEngine(sessionId);
      const chat = stream();
      attachEngineEvents(engine, runtime(sessionFile, sessionId), chat);
      return { sessionId, sessionFile, engine, chat };
    });
    try {
      await Promise.all(sessions.map(async ({ engine, sessionId }) => {
        for (const entry of eventScriptFor(sessionId, `${sessionId}-turn`)) {
          engine.emit(entry.event);
          await Promise.resolve();
        }
      }));
      for (const { sessionId, sessionFile, chat } of sessions) {
        const done = payloads(chat).find((event) => event.type === "done");
        assert.ok(done, `${sessionId} must finish independently`);
        assert.equal(done.blocks.every((block) => block.turnId === `${sessionId}-turn`), true);
        const replay = parseSessionMessages(readFileSync(sessionFile, "utf8"));
        const blocks = replay.find((message) => message.role === "assistant")?.blocks || [];
        assert.equal(blocks.every((block) => block.turnId === `${sessionId}-turn`), true);
        assert.deepEqual(logicalBlocks(blocks), DETERMINISTIC_FINAL_BLOCKS);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
