import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { describe, it } from "node:test";

import { commandTool } from "../src/agent/tools/command.ts";
import { ToolRegistry } from "../src/agent/types.ts";
import { mapPiEvent } from "../src/agent-engine/event-normalizer.ts";
import { attachEngineEvents } from "../src/server/agent-event-router.ts";

function event(type, seq, extra = {}) {
  return {
    version: 1,
    type,
    sessionId: "s-a12",
    turnId: "t-a12",
    seq,
    timestamp: seq,
    ...extra,
  };
}

function makeFlow() {
  const engine = new EventEmitter();
  engine.session = { id: "s-a12", workspace: process.cwd(), isStreaming: true, isCompacting: false };
  engine.subscribe = (listener) => {
    engine.on("engine-event", listener);
    return () => engine.off("engine-event", listener);
  };
  engine.cancelCalls = [];
  engine.cancel = async (turnId) => {
    engine.cancelCalls.push(turnId);
    engine.emit("engine-event", event("turn.cancelled", 50, { reason: "runtime_blocked" }));
    return true;
  };
  const chat = {
    textBuffer: "",
    thinkingBuffer: "",
    currentTextSnapshot: "",
    currentThinkingSnapshot: "",
    response: { write() {}, end() {} },
    turnId: "",
    traceSeq: 0,
    eventSeq: 0,
    eventHistory: [],
    emittedTraces: new Set(),
    blocks: [],
    blockSeq: 0,
    textSegments: [],
    thinkingBlockGenerations: {},
    taskRequirements: { kind: "general", requiresEvidence: false, minSuccessfulEvidence: 0 },
  };
  const runtime = { session: { sessionFile: undefined, sessionManager: { flushed: false } } };
  attachEngineEvents(engine, runtime, chat);
  return { engine, chat };
}

function emit(flow, value) {
  flow.engine.emit("engine-event", value);
}

function replayTrace(flow, trace) {
  const mapped = mapPiEvent(trace, {
    base: event("engine.ready", 0),
  });
  for (const mappedEvent of mapped.events) emit(flow, mappedEvent);
}

function payloads(chat) {
  return chat.eventHistory.map((entry) => JSON.parse(entry.data.slice(entry.data.indexOf("data: ") + 6)));
}

describe("A-12 runtime terminal guard cross-layer flow", () => {
  it("turns a real command permission denial into blocked/cancelled final state and rejects late work", async () => {
    const flow = makeFlow();
    emit(flow, event("turn.started", 1));

    const traces = [];
    const registry = new ToolRegistry();
    registry.register(commandTool);
    const [tool] = registry.toPITools(process.cwd(), (trace) => traces.push(trace), {
      permissionMode: "standard",
      confirmCommand: async () => false,
    });
    await tool.execute("call-denied", { command: "node -e \"console.log('denied')\"" });
    assert.equal(traces.at(-1)?.outcome?.status, "failed");
    assert.equal(traces.at(-1)?.outcome?.failure?.kind, "permission_denied");
    replayTrace(flow, traces.at(-1));

    assert.deepEqual(flow.engine.cancelCalls, ["t-a12"], "blocked failure must abort the active turn");
    const beforeLate = JSON.stringify({ blocks: flow.chat.blocks, events: payloads(flow.chat) });
    emit(flow, event("tool.started", 60, { toolCallId: "late-tool", name: "read", input: { path: "late" } }));
    emit(flow, event("content.delta", 61, { text: "late content" }));
    assert.equal(JSON.stringify({ blocks: flow.chat.blocks, events: payloads(flow.chat) }), beforeLate);

    const done = payloads(flow.chat).find((item) => item.type === "done");
    assert.ok(done, "runtime abort must still produce one final presentation");
    assert.equal(done.status, "error");
    assert.equal(done.task.status, "blocked");
    assert.match(done.task.reason, /permission|change/i);
    assert.equal(done.blocks.some((block) => block.toolCallId === "late-tool"), false);
  });

  it("does not treat a completed tool frame with permissionFailure metadata as success", () => {
    const flow = makeFlow();
    emit(flow, event("turn.started", 1));
    emit(flow, event("tool.started", 2, { toolCallId: "call-metadata-denied", name: "command", input: { command: "echo denied" } }));
    emit(flow, event("tool.completed", 3, {
      toolCallId: "call-metadata-denied",
      name: "command",
      output: "⛔ 用户已拒绝命令执行。",
      metadata: { permissionFailure: { code: "permission_denied", message: "拒绝执行" } },
    }));

    const done = payloads(flow.chat).find((item) => item.type === "done");
    const block = done?.blocks.find((item) => item.toolCallId === "call-metadata-denied");
    assert.ok(block);
    assert.equal(block.status, "error");
    assert.equal(done.task.status, "blocked");
    assert.deepEqual(flow.engine.cancelCalls, ["t-a12"]);
  });
});
