import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { attachEngineEvents, attachSessionEvents } from "../src/server/server.ts";
import { parseSessionMessages } from "../src/server/routes/session-message-parser.ts";
import {
  CHAT_FLOW_ENGINE_EVENTS,
  CHAT_FLOW_STRUCTURED_EVENTS,
  CHAT_FLOW_STRUCTURED_EXPECTED,
  blockSnapshot,
  latestBlocks,
} from "./fixtures/chat-event-flow.mjs";

function fakeEngine(sessionId = "session-flow") {
  let listener;
  return {
    session: { id: sessionId, workspace: "/workspace", isStreaming: true, isCompacting: false },
    subscribe(next) { listener = next; return () => { listener = undefined; }; },
    emit(event) { listener?.(event); },
    getContextUsage() { return undefined; },
    getSessionStats() { return undefined; },
  };
}

function fakeRuntime(sessionId = "session-flow") {
  return { session: { sessionFile: undefined, sessionManager: { flushed: false, getSessionId: () => sessionId } } };
}

function persistedRuntime(sessionFile, sessionId = "session-flow") {
  return { session: { sessionFile, sessionManager: { flushed: true, getSessionId: () => sessionId } } };
}

function stream() {
  return { textBuffer: "", thinkingBuffer: "", response: null, turnId: "", eventSeq: 0, eventHistory: [], blocks: [], emittedTraces: new Set(), blockSeq: 0 };
}

function payloads(chat) {
  return chat.eventHistory.map((entry) => JSON.parse(entry.data.split("data: ")[1]));
}

function logicalBlocks(blocks) {
  return blocks.map((block) => ({
    type: block.type,
    blockId: block.blockId,
    text: block.text,
    status: block.status,
    toolCallId: block.toolCallId,
    output: block.output,
  }));
}

function runLegacyStructuredFlow() {
  let listener;
  const runtime = {
    session: { sessionFile: undefined, sessionManager: { getSessionId: () => "session-structured" }, agent: { waitForIdle: async () => {} } },
    onEvent(next) { listener = next; return () => { listener = undefined; }; },
  };
  const chat = stream();
  chat.turnId = "turn-structured";
  attachSessionEvents(runtime, chat);
  const update = (content, assistantMessageEvent) => listener({
    type: "message_update",
    turnId: "turn-structured",
    message: { role: "assistant", content },
    assistantMessageEvent,
  });
  listener({ type: "message_start", turnId: "turn-structured", message: { role: "assistant", content: [] } });
  update([{ type: "thinking", thinking: "先" }], { type: "thinking_start", contentIndex: 0 });
  update([{ type: "thinking", thinking: "先分析" }], { type: "thinking_delta", contentIndex: 0, delta: "分析" });
  update([{ type: "thinking", thinking: "先分析" }], { type: "thinking_end", contentIndex: 0 });
  listener({ type: "tool_execution_start", turnId: "turn-structured", toolCallId: "call-structured", toolName: "search", args: { query: "structured" } });
  listener({ type: "tool_execution_end", turnId: "turn-structured", toolCallId: "call-structured", toolName: "search", result: "找到结果", isError: false });
  listener({ type: "message_start", turnId: "turn-structured", message: { role: "assistant", content: [] } });
  update([{ type: "thinking", thinking: "再" }], { type: "thinking_start", contentIndex: 0 });
  update([{ type: "thinking", thinking: "再验证" }], { type: "thinking_delta", contentIndex: 0, delta: "验证" });
  update([{ type: "thinking", thinking: "再验证" }], { type: "thinking_end", contentIndex: 0 });
  update([{ type: "thinking", thinking: "再验证" }, { type: "text", text: "最终" }], { type: "text_start", contentIndex: 1 });
  update([{ type: "thinking", thinking: "再验证" }, { type: "text", text: "最终正文" }], { type: "text_delta", contentIndex: 1, delta: "正文" });
  update([{ type: "thinking", thinking: "再验证" }, { type: "text", text: "最终正文" }], { type: "text_end", contentIndex: 1 });
  listener({ type: "agent_end", turnId: "turn-structured", messages: [] });
  return payloads(chat).find((event) => event.type === "done");
}

describe("chat event flow contract", () => {
  it("preserves linear node boundaries at every server event and matches terminal replay", () => {
    const engine = fakeEngine();
    const chat = stream();
    attachEngineEvents(engine, fakeRuntime(), chat);
    const snapshots = [];

    for (const event of CHAT_FLOW_ENGINE_EVENTS) {
      engine.emit(event);
      snapshots.push(chat.blocks.map(blockSnapshot));
    }

    const done = payloads(chat).find((event) => event.type === "done");
    assert.ok(done, "terminal done event must exist");
    assert.equal(payloads(chat).filter((event) => event.type === "done").length, 1);

    const ordered = done.blocks.slice().sort((left, right) => left.seq - right.seq);
    assert.deepEqual(ordered.map((block) => block.type), ["thinking", "tool", "thinking", "text"]);
    assert.deepEqual(ordered.map((block) => block.seq), [1, 2, 3, 4]);
    assert.equal(new Set(ordered.map((block) => block.blockId)).size, ordered.length);
    assert.equal(ordered[0].status, "done");
    assert.equal(ordered[2].status, "done");
    assert.equal(ordered[0].text, "先分析路径");
    assert.equal(ordered[2].text, "再验证结论");
    assert.equal(ordered[3].text, "最终正文");

    const streamed = latestBlocks(payloads(chat));
    assert.deepEqual(streamed, ordered.map(blockSnapshot), "live block stream and terminal replay must converge");

    const secondThoughtIndex = snapshots.findIndex((blocks) => blocks.some((block) => block.blockId.endsWith("#2")));
    assert.ok(secondThoughtIndex >= 0, "a post-tool Thought must have a new block id");
    const firstThought = snapshots[secondThoughtIndex].find((block) => block.type === "thinking" && block.seq === 1);
    assert.equal(firstThought?.text, "先分析路径", "closed Thought cannot receive later deltas");
  });

  it("ignores late streaming events after a terminal event", () => {
    const engine = fakeEngine();
    const chat = stream();
    attachEngineEvents(engine, fakeRuntime(), chat);

    for (const event of CHAT_FLOW_ENGINE_EVENTS) engine.emit(event);
    const eventCount = chat.eventHistory.length;
    const terminalSnapshot = chat.eventHistory.at(-1).data;

    engine.emit({
      version: 1,
      type: "thinking.delta",
      sessionId: "session-flow",
      turnId: "turn-flow",
      seq: 99,
      timestamp: 99,
      text: "迟到内容",
    });

    assert.equal(chat.eventHistory.length, eventCount, "terminal 后不得再发 SSE block/delta");
    assert.equal(chat.eventHistory.at(-1).data, terminalSnapshot);
    assert.deepEqual(chat.blocks, [], "终止后的迟到事件不得重新打开内存节点");
  });

  it("preserves explicit start/delta/end boundaries across tool transitions", () => {
    const engine = fakeEngine("session-structured");
    const chat = stream();
    attachEngineEvents(engine, fakeRuntime("session-structured"), chat);
    const snapshots = [];

    for (const event of CHAT_FLOW_STRUCTURED_EVENTS) {
      engine.emit(event);
      snapshots.push(chat.blocks.map(blockSnapshot));
    }

    const done = chat.eventHistory
      .map((entry) => JSON.parse(entry.data.split("data: ")[1]))
      .find((event) => event.type === "done");
    assert.ok(done);
    assert.deepEqual(done.blocks.map(blockSnapshot), CHAT_FLOW_STRUCTURED_EXPECTED);
    assert.deepEqual(done.blocks.map((block) => block.seq), [1, 2, 3, 4]);
    assert.equal(new Set(done.blocks.map((block) => block.blockId)).size, done.blocks.length);

    const beforeSecondThinking = snapshots.find((blocks) => blocks.some((block) => block.blockId === "m2:thinking-0"));
    assert.ok(beforeSecondThinking);
    assert.equal(beforeSecondThinking.find((block) => block.blockId === "m1:thinking-0")?.text, "先分析");
    assert.equal(beforeSecondThinking.find((block) => block.blockId === "m1:thinking-0")?.status, "done");

    const legacyDone = runLegacyStructuredFlow();
    assert.deepEqual(logicalBlocks(legacyDone.blocks), logicalBlocks(done.blocks), "旧事件桥和新事件桥必须产生同一规范化节点流");
    assert.deepEqual(legacyDone.blocks.map((block) => block.seq), done.blocks.map((block) => block.seq), "旧事件桥和新事件桥必须使用同一逻辑节点序号");
    for (const output of [done.blocks, legacyDone.blocks]) {
      const seq = output.slice().sort((left, right) => left.seq - right.seq).map((block) => block.seq);
      assert.ok(seq.every((value, index) => index === 0 || value > seq[index - 1]), "两条桥的 seq 都必须严格单调");
    }
  });

  it("deduplicates repeated tool events and emits one terminal event for failure/cancellation", () => {
    for (const terminal of [
      { type: "turn.failed", error: { category: "provider", code: "failed", message: "provider failed", retryable: true } },
      { type: "turn.cancelled", reason: "用户取消" },
    ]) {
      const engine = fakeEngine(`session-${terminal.type}`);
      const chat = stream();
      attachEngineEvents(engine, fakeRuntime(`session-${terminal.type}`), chat);
      engine.emit({ version: 1, type: "turn.started", sessionId: `session-${terminal.type}`, turnId: terminal.type, seq: 1, timestamp: 1 });
      const tool = { version: 1, type: "tool.started", sessionId: `session-${terminal.type}`, turnId: terminal.type, seq: 2, timestamp: 2, toolCallId: "duplicate", name: "search", input: {} };
      engine.emit(tool);
      engine.emit(tool);
      engine.emit({ ...tool, type: "tool.completed", seq: 3, timestamp: 3, output: "done" });
      engine.emit(terminal);
      engine.emit(terminal);

      const events = payloads(chat);
      assert.equal(events.filter((event) => event.type === "done" || event.type === "cancelled").length, 1);
      assert.equal(chat.blocks.filter((block) => block.blockId === "tool-duplicate").length, 0, "terminal cleanup must clear live blocks");
      const toolBlockEvents = events.filter((event) => event.type === "block" && event.block?.type === "tool");
      assert.equal(new Set(toolBlockEvents.map((event) => event.block.blockId)).size, 1, "repeated tool start must not create duplicate tool block ids");
    }
  });

  it("keeps live blocks identical to JSONL persistence and refresh replay", () => {
    const dir = mkdtempSync(join(tmpdir(), "chat-event-flow-"));
    const sessionFile = join(dir, "session.jsonl");
    writeFileSync(sessionFile, [
      JSON.stringify({ type: "session", id: "session-structured" }),
      JSON.stringify({ type: "message", id: "u1", message: { role: "user", content: [{ type: "text", text: "structured" }] } }),
      JSON.stringify({ type: "message", id: "a1", turnId: "turn-structured", message: { role: "assistant", content: [] } }),
    ].join("\n") + "\n");
    try {
      const engine = fakeEngine("session-structured");
      const chat = stream();
      attachEngineEvents(engine, persistedRuntime(sessionFile, "session-structured"), chat);
      for (const event of CHAT_FLOW_STRUCTURED_EVENTS) engine.emit(event);
      const done = payloads(chat).find((event) => event.type === "done");
      assert.ok(done);

      const replay = parseSessionMessages(readFileSync(sessionFile, "utf8"));
      const replayBlocks = replay.find((message) => message.role === "assistant")?.blocks || [];
      assert.deepEqual(logicalBlocks(replayBlocks), logicalBlocks(done.blocks), "JSONL 回放必须保留实时节点的 ID、顺序、文本和状态");
      assert.deepEqual(replayBlocks.map((block) => block.seq), [1, 2, 3, 4]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
