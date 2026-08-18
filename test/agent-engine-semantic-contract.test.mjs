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
});
