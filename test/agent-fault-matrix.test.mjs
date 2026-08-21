import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, afterEach } from "node:test";

import { commandTool } from "../src/agent/tools/command.ts";
import { fileWriteTool } from "../src/agent/tools/file-write.ts";
import { ToolRegistry } from "../src/agent/types.ts";
import { attachEngineEvents } from "../src/server/agent-event-router.ts";
import { replayChatEvents, writeChatEvent } from "../src/server/chat-stream.ts";

const tempRoots = new Set();

afterEach(() => {
  for (const root of tempRoots) rmSync(root, { recursive: true, force: true });
  tempRoots.clear();
});

function flow(sessionId = "fault-session", turnId = "fault-turn") {
  let listener;
  const engine = {
    session: { id: sessionId, workspace: process.cwd(), isStreaming: true, isCompacting: false },
    subscribe(next) { listener = next; return () => { listener = undefined; }; },
    emit(event) { listener?.(event); },
    getContextUsage() { return undefined; },
    getSessionStats() { return undefined; },
  };
  const chat = {
    textBuffer: "", thinkingBuffer: "", response: { write() { return true; }, end() {} },
    turnId, traceSeq: 0, eventSeq: 0, eventHistory: [], blocks: [], emittedTraces: new Set(), blockSeq: 0,
  };
  const runtime = { session: { sessionFile: undefined, sessionManager: { flushed: false, getSessionId: () => sessionId } } };
  attachEngineEvents(engine, runtime, chat);
  return { engine, chat, sessionId, turnId };
}

function payloads(chat) {
  return chat.eventHistory.map((entry) => JSON.parse(entry.data.split("data: ")[1]));
}

describe("agent fault matrix flows", () => {
  it("waits for real permission approval and emits one completed command result", async () => {
    const updates = [];
    let release;
    const waiting = new Promise((resolve) => { release = resolve; });
    const resultPromise = commandTool.execute({ command: "node --version" }, {
      cwd: process.cwd(), sessionId: "permission-flow", permissionMode: "standard",
      confirmCommand: async () => { updates.push("waiting"); await waiting; return true; },
      onUpdate: (chunk) => updates.push(chunk),
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.ok(updates.includes("waiting"), "permission flow must remain waiting before approval");
    release();
    const result = await resultPromise;
    assert.equal(result.outcome.status, "success");
    assert.equal((result.text.match(/用户已允许命令执行/g) || []).length, 1);
  });

  it("reports a real command timeout as a failed tool outcome", async () => {
    const registry = new ToolRegistry();
    registry.register(commandTool);
    const traces = [];
    const [tool] = registry.toPITools(process.cwd(), (event) => traces.push(event), { permissionMode: "dontAsk" });
    await assert.rejects(() => tool.execute("timeout-flow", {
      command: 'node -e "setTimeout(() => {}, 500)"',
      timeout: 30,
    }));
    const terminal = traces.at(-1);
    assert.equal(terminal.outcome.status, "failed");
    assert.equal(terminal.outcome.failure.kind, "transport_error");
    assert.equal(terminal.outcome.failure.code, "tool_timeout");
  });

  it("keeps duplicate, out-of-order, and late events from changing the terminal stream", () => {
    const testFlow = flow();
    const base = { version: 1, sessionId: testFlow.sessionId, turnId: testFlow.turnId, timestamp: 1 };
    testFlow.engine.emit({ ...base, type: "turn.started", seq: 1 });
    testFlow.engine.emit({ ...base, type: "thinking.delta", seq: 2, text: "先" });
    testFlow.engine.emit({ ...base, type: "tool.started", seq: 4, toolCallId: "duplicate", name: "read", input: {} });
    testFlow.engine.emit({ ...base, type: "tool.started", seq: 3, toolCallId: "duplicate", name: "read", input: {} });
    testFlow.engine.emit({ ...base, type: "content.delta", seq: 5, text: "正文" });
    testFlow.engine.emit({ ...base, type: "turn.completed", seq: 6 });
    testFlow.engine.emit({ ...base, type: "thinking.delta", seq: 7, text: "迟到" });

    const payloadsAfterTerminal = payloads(testFlow.chat);
    const done = payloadsAfterTerminal.find((payload) => payload.type === "done");
    assert.ok(done);
    assert.deepEqual(done.blocks.map((block) => block.type), ["thinking", "tool", "text"]);
    assert.equal(done.blocks.filter((block) => block.blockId === "tool-duplicate").length, 1);
    assert.equal(done.blocks.find((block) => block.type === "thinking").text, "先");
    assert.equal(payloadsAfterTerminal.filter((payload) => payload.type === "done").length, 1);
  });

  it("replays only events after the reconnect cursor and preserves event ordering", () => {
    const state = { eventSeq: 0, eventHistory: [] };
    writeChatEvent(state, { type: "block", block: { blockId: "one", seq: 1 } });
    writeChatEvent(state, { type: "block", block: { blockId: "two", seq: 2 } });
    writeChatEvent(state, { type: "done", blocks: [] });
    const chunks = [];
    replayChatEvents(state, { write: (chunk) => chunks.push(chunk) }, "1");
    assert.equal(chunks.length, 2);
    assert.match(chunks[0], /"blockId":"two"/);
    assert.match(chunks[1], /"type":"done"/);
  });

  it("keeps concurrent read/write operations scoped to one workspace and leaves a complete file", async () => {
    const root = mkdtempSync(join(tmpdir(), "agent-fault-matrix-"));
    tempRoots.add(root);
    const path = "concurrent.txt";
    const write = fileWriteTool.execute({ file_path: path, content: "complete-write\n" }, {
      cwd: root, workspace: root, sessionId: "concurrent-flow", permissionMode: "dontAsk",
    });
    const read = fileWriteTool.execute({ file_path: path, content: "complete-write\n" }, {
      cwd: root, workspace: root, sessionId: "concurrent-flow", permissionMode: "dontAsk",
    });
    const results = await Promise.all([write, read]);
    assert.ok(results.every((result) => result.outcome.status === "success"));
    assert.equal(readFileSync(join(root, path), "utf8"), "complete-write\n");
  });
});
