import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { attachEngineEvents } from "../src/server/server.ts";
import { mapPiEvent } from "../src/agent-engine/event-normalizer.ts";
import { commandTool } from "../src/agent/tools/command.ts";

function fakeEngine() {
  let listener;
  return {
    session: { id: "session-1", workspace: "/workspace", isStreaming: true, isCompacting: false },
    subscribe(next) { listener = next; return () => { listener = undefined; }; },
    emit(event) { listener?.(event); },
    getContextUsage() { return undefined; },
    getSessionStats() { return undefined; },
  };
}

function fakeRuntime() {
  return {
    session: { sessionFile: undefined, sessionManager: { flushed: false, getSessionId: () => "session-1" } },
  };
}

function stream() {
  return { textBuffer: "", thinkingBuffer: "", response: null, turnId: "", eventSeq: 0, eventHistory: [], blocks: [], emittedTraces: new Set(), blockSeq: 0 };
}

describe("AgentEngine lifecycle semantics", () => {
  it("keeps a serializable tool result in the normalized completion event", () => {
    const mapped = mapPiEvent({
      type: "tool_execution_end",
      toolCallId: "call-structured-result",
      toolName: "search",
      result: { matches: ["a.ts"], count: 1 },
      isError: false,
    }, {
      base: { version: 1, sessionId: "session-1", turnId: "turn-structured-result", seq: 1, timestamp: 1 },
    });

    assert.deepEqual(mapped.events[0], {
      version: 1,
      type: "tool.completed",
      sessionId: "session-1",
      turnId: "turn-structured-result",
      seq: 1,
      timestamp: 1,
      toolCallId: "call-structured-result",
      name: "search",
      output: '{"matches":["a.ts"],"count":1}',
    });
  });

  it("publishes normalized content and a single completed terminal", () => {
    const engine = fakeEngine();
    const chat = stream();
    attachEngineEvents(engine, fakeRuntime(), chat);
    engine.emit({ version: 1, type: "turn.started", sessionId: "session-1", turnId: "turn-1", seq: 1, timestamp: 1 });
    engine.emit({ version: 1, type: "content.delta", sessionId: "session-1", turnId: "turn-1", seq: 2, timestamp: 2, text: "完成" });
    engine.emit({ version: 1, type: "turn.completed", sessionId: "session-1", turnId: "turn-1", seq: 3, timestamp: 3 });
    engine.emit({ version: 1, type: "turn.completed", sessionId: "session-1", turnId: "turn-1", seq: 4, timestamp: 4 });

    const payloads = chat.eventHistory.map((entry) => JSON.parse(entry.data.split("data: ")[1]));
    assert.equal(payloads.filter((event) => event.type === "done").length, 1);
    assert.equal(payloads.find((event) => event.type === "done").text, "完成");
  });

  it("does not emit a done event after cancellation", () => {
    const engine = fakeEngine();
    const chat = stream();
    attachEngineEvents(engine, fakeRuntime(), chat);
    engine.emit({ version: 1, type: "turn.started", sessionId: "session-1", turnId: "turn-2", seq: 1, timestamp: 1 });
    engine.emit({ version: 1, type: "turn.cancelled", sessionId: "session-1", turnId: "turn-2", seq: 2, timestamp: 2, reason: "cancelled_by_user" });

    const payloads = chat.eventHistory.map((entry) => JSON.parse(entry.data.split("data: ")[1]));
    assert.equal(payloads.some((event) => event.type === "done"), false);
    assert.deepEqual(payloads.at(-1), { type: "cancelled", turnId: "turn-2", sessionId: "session-1", reason: "cancelled_by_user" });
  });

  it("does not promote a thought-only turn into the final answer", () => {
    const engine = fakeEngine();
    const chat = stream();
    attachEngineEvents(engine, fakeRuntime(), chat);
    engine.emit({ version: 1, type: "turn.started", sessionId: "session-1", turnId: "turn-thought-only", seq: 1, timestamp: 1 });
    engine.emit({ version: 1, type: "thinking.delta", sessionId: "session-1", turnId: "turn-thought-only", seq: 2, timestamp: 2, text: "把回答错误地写进 Thought" });
    engine.emit({ version: 1, type: "turn.completed", sessionId: "session-1", turnId: "turn-thought-only", seq: 3, timestamp: 3 });

    const payloads = chat.eventHistory.map((entry) => JSON.parse(entry.data.split("data: ")[1]));
    const done = payloads.find((event) => event.type === "done");
    assert.ok(done, "应有 done 事件");
    assert.equal(done.text, "本轮未生成最终回复。");
    assert.equal(done.blocks.at(-1).type, "text");
    assert.equal(done.blocks.at(-1).text, "本轮未生成最终回复。");
    assert.equal(done.blocks.some((block) => block.type === "thinking" && block.text.includes("错误地")), true);
  });

  it("preserves a real dangerous-command permission failure as an errored tool block", async () => {
    const engine = fakeEngine();
    const chat = stream();
    attachEngineEvents(engine, fakeRuntime(), chat);
    engine.emit({ version: 1, type: "turn.started", sessionId: "session-1", turnId: "turn-danger", seq: 1, timestamp: 1 });
    engine.emit({ version: 1, type: "tool.started", sessionId: "session-1", turnId: "turn-danger", seq: 2, timestamp: 2, toolCallId: "call-danger", name: "command", input: { command: "rm -rf /" } });

    const result = await commandTool.execute(
      { command: "rm -rf /" },
      { cwd: process.cwd(), workspace: process.cwd(), sessionId: "session-1", permissionMode: "yes" },
    );
    assert.equal(result.metadata.permissionFailure.code, "dangerous");

    const mapped = mapPiEvent({
      type: "tool_execution_end",
      toolCallId: "call-danger",
      toolName: "command",
      result: result.text,
      metadata: result.metadata,
      isError: false,
    }, {
      base: { version: 1, sessionId: "session-1", turnId: "turn-danger", seq: 3, timestamp: 3 },
    });
    engine.emit(mapped.events[0]);

    const block = chat.blocks.find((item) => item.type === "tool" && item.toolCallId === "call-danger");
    assert.equal(block.status, "error");
    assert.deepEqual(block.metadata.permissionFailure, result.metadata.permissionFailure);
    const payloads = chat.eventHistory.map((entry) => JSON.parse(entry.data.split("data: ")[1]));
    const streamed = payloads.find((event) => event.type === "block" && event.block?.toolCallId === "call-danger" && event.block?.status === "error");
    assert.deepEqual(streamed.block.metadata.permissionFailure, result.metadata.permissionFailure);
  });

  it("cuts off a streaming thinking block when text content follows", () => {
    const engine = fakeEngine();
    const chat = stream();
    attachEngineEvents(engine, fakeRuntime(), chat);
    engine.emit({ version: 1, type: "turn.started", sessionId: "session-1", turnId: "turn-1", seq: 1, timestamp: 1 });
    engine.emit({ version: 1, type: "thinking.delta", sessionId: "session-1", turnId: "turn-1", seq: 2, timestamp: 2, text: "思考" });
    engine.emit({ version: 1, type: "content.delta", sessionId: "session-1", turnId: "turn-1", seq: 3, timestamp: 3, text: "正文" });

    const thinkingBlock = chat.blocks.find((item) => item.type === "thinking");
    assert.strictEqual(thinkingBlock?.status, "done", "正文出现时 streaming thinking 必须标 done");
    const textBlock = chat.blocks.find((item) => item.type === "text");
    assert.strictEqual(textBlock?.text, "正文");
    assert.ok(thinkingBlock && textBlock && thinkingBlock.seq < textBlock.seq, "thinking 在 text 之前线性排列");
  });

  it("closes streaming thinking at a tool boundary", () => {
    const engine = fakeEngine();
    const chat = stream();
    attachEngineEvents(engine, fakeRuntime(), chat);
    engine.emit({ version: 1, type: "turn.started", sessionId: "session-1", turnId: "turn-1", seq: 1, timestamp: 1 });
    engine.emit({ version: 1, type: "thinking.delta", sessionId: "session-1", turnId: "turn-1", seq: 2, timestamp: 2, text: "思考" });
    engine.emit({ version: 1, type: "tool.started", sessionId: "session-1", turnId: "turn-1", seq: 3, timestamp: 3, toolCallId: "call-1", name: "search", input: {} });

    const thinkingBlock = chat.blocks.find((item) => item.type === "thinking");
    assert.strictEqual(thinkingBlock?.status, "done", "工具边界时 streaming thinking 必须标 done");
  });

  it("opens a new thinking node after a tool boundary instead of overwriting the closed one", () => {
    const engine = fakeEngine();
    const chat = stream();
    attachEngineEvents(engine, fakeRuntime(), chat);
    engine.emit({ version: 1, type: "turn.started", sessionId: "session-1", turnId: "turn-1", seq: 1, timestamp: 1 });
    engine.emit({ version: 1, type: "thinking.delta", sessionId: "session-1", turnId: "turn-1", seq: 2, timestamp: 2, text: "第一段思考" });
    engine.emit({ version: 1, type: "tool.started", sessionId: "session-1", turnId: "turn-1", seq: 3, timestamp: 3, toolCallId: "call-1", name: "search", input: {} });
    engine.emit({ version: 1, type: "thinking.delta", sessionId: "session-1", turnId: "turn-1", seq: 4, timestamp: 4, text: "第二段思考" });

    const thinkingBlocks = chat.blocks
      .filter((item) => item.type === "thinking")
      .sort((a, b) => a.seq - b.seq);
    assert.strictEqual(thinkingBlocks.length, 2, "工具边界后的新思考必须开新节点");
    assert.strictEqual(thinkingBlocks[0].status, "done", "第一段思考保持 done");
    assert.strictEqual(thinkingBlocks[0].text, "第一段思考", "第一段思考不被覆盖");
    assert.strictEqual(thinkingBlocks[1].status, "streaming", "第二段思考进行中");
    assert.notStrictEqual(thinkingBlocks[0].blockId, thinkingBlocks[1].blockId, "两段思考 blockId 不同");
  });

  it("opens a new thinking node after text content instead of overwriting the closed one", () => {
    const engine = fakeEngine();
    const chat = stream();
    attachEngineEvents(engine, fakeRuntime(), chat);
    engine.emit({ version: 1, type: "turn.started", sessionId: "session-1", turnId: "turn-1", seq: 1, timestamp: 1 });
    engine.emit({ version: 1, type: "thinking.delta", sessionId: "session-1", turnId: "turn-1", seq: 2, timestamp: 2, text: "思考" });
    engine.emit({ version: 1, type: "content.delta", sessionId: "session-1", turnId: "turn-1", seq: 3, timestamp: 3, text: "正文" });
    engine.emit({ version: 1, type: "thinking.delta", sessionId: "session-1", turnId: "turn-1", seq: 4, timestamp: 4, text: "再思考" });

    const thinkingBlocks = chat.blocks
      .filter((item) => item.type === "thinking")
      .sort((a, b) => a.seq - b.seq);
    assert.strictEqual(thinkingBlocks.length, 2, "正文后的新思考必须开新节点");
    assert.strictEqual(thinkingBlocks[0].status, "done", "第一段思考保持 done");
    assert.strictEqual(thinkingBlocks[0].text, "思考", "第一段思考不被覆盖");
    assert.strictEqual(thinkingBlocks[1].text, "再思考", "第二段思考独立");
    assert.notStrictEqual(thinkingBlocks[0].blockId, thinkingBlocks[1].blockId, "两段思考 blockId 不同");
  });

  it("keeps each post-tool thinking segment in its own node without reverting to the closed one", () => {
    const engine = fakeEngine();
    const chat = stream();
    attachEngineEvents(engine, fakeRuntime(), chat);
    const emit = (type, text, seq) => engine.emit({ version: 1, type, sessionId: "session-1", turnId: "turn-1", seq, timestamp: seq, ...(text !== undefined ? { text } : {}) });
    emit("turn.started", undefined, 1);
    // 第一段思考
    emit("thinking.delta", "第一", 2);
    emit("thinking.delta", "段", 3);
    // 工具边界
    emit("tool.started", undefined, 4);
    // 第二段思考（多个 delta 不应回退到已 done 的第一段节点）
    emit("thinking.delta", "第二", 5);
    emit("thinking.delta", "段", 6);
    emit("thinking.delta", "思考", 7);

    const thinkingBlocks = chat.blocks
      .filter((item) => item.type === "thinking")
      .sort((a, b) => a.seq - b.seq);
    assert.strictEqual(thinkingBlocks.length, 2, "工具边界后两段思考两个节点");
    assert.strictEqual(thinkingBlocks[0].text, "第一段", "第一段文本保持");
    assert.strictEqual(thinkingBlocks[0].status, "done", "第一段保持 done");
    assert.strictEqual(thinkingBlocks[1].text, "第二段思考", "第二段完整累积，不回退到旧节点");
    assert.strictEqual(thinkingBlocks[1].status, "streaming", "第二段进行中");
    assert.notStrictEqual(thinkingBlocks[0].blockId, thinkingBlocks[1].blockId, "两段 blockId 不同");
  });

  it("keeps structured Thought segments linear and rejects late writes", () => {
    const engine = fakeEngine();
    const chat = stream();
    attachEngineEvents(engine, fakeRuntime(), chat);
    const emit = (type, text, seq, phase) => engine.emit({
      version: 1, type, sessionId: "session-1", turnId: "turn-structured", seq, timestamp: seq,
      text, messageSeq: 1, contentIndex: 0, phase,
    });
    engine.emit({ version: 1, type: "turn.started", sessionId: "session-1", turnId: "turn-structured", seq: 1, timestamp: 1 });
    emit("thinking.delta", "第一段", 2, "start");
    emit("thinking.delta", "追加", 3, "delta");
    emit("thinking.delta", "", 4, "end");
    // A delta after end must be dropped, not appended to the closed Thought node.
    emit("thinking.delta", "迟到内容", 5, "delta");
    emit("thinking.delta", "第二段", 6, "start");
    emit("thinking.delta", "继续", 7, "delta");
    engine.emit({ version: 1, type: "turn.completed", sessionId: "session-1", turnId: "turn-structured", seq: 8, timestamp: 8 });

    const thinkingBlocks = chat.eventHistory
      .map((entry) => JSON.parse(entry.data.split("data: ")[1]))
      .filter((event) => event.type === "done")
      .at(-1).blocks.filter((block) => block.type === "thinking");
    assert.deepEqual(thinkingBlocks.map((block) => block.text), ["第一段追加", "第二段继续"]);
    assert.ok(thinkingBlocks[0].seq < thinkingBlocks[1].seq, "Thought 节点必须按开启顺序排列");
    assert.equal(thinkingBlocks[0].status, "done");
    assert.equal(thinkingBlocks[1].status, "done");
  });

  it("keeps done block payload ordered when completion arrives out of order", () => {
    const engine = fakeEngine();
    const chat = stream();
    attachEngineEvents(engine, fakeRuntime(), chat);
    engine.emit({ version: 1, type: "turn.started", sessionId: "session-1", turnId: "turn-order", seq: 1, timestamp: 1 });
    engine.emit({ version: 1, type: "tool.started", sessionId: "session-1", turnId: "turn-order", seq: 2, timestamp: 2, toolCallId: "a", name: "a" });
    engine.emit({ version: 1, type: "tool.started", sessionId: "session-1", turnId: "turn-order", seq: 3, timestamp: 3, toolCallId: "b", name: "b" });
    engine.emit({ version: 1, type: "tool.completed", sessionId: "session-1", turnId: "turn-order", seq: 4, timestamp: 4, toolCallId: "b", name: "b", output: "B" });
    engine.emit({ version: 1, type: "tool.completed", sessionId: "session-1", turnId: "turn-order", seq: 5, timestamp: 5, toolCallId: "a", name: "a", output: "A" });
    engine.emit({ version: 1, type: "turn.completed", sessionId: "session-1", turnId: "turn-order", seq: 6, timestamp: 6 });

    const done = chat.eventHistory.map((entry) => JSON.parse(entry.data.split("data: ")[1])).find((event) => event.type === "done");
    assert.deepEqual(done.blocks.filter((block) => block.type === "tool").map((block) => block.toolCallId), ["a", "b"]);
  });
});
