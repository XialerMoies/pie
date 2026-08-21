import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { attachEngineEvents } from "../src/server/agent-event-router.ts";

function fakeEngine(sessionId = "session-persist") {
  let listener;
  return {
    session: { id: sessionId, workspace: "E:/workspace", isStreaming: true, isCompacting: false },
    subscribe(next) { listener = next; return () => { listener = undefined; }; },
    emit(event) { listener?.(event); },
  };
}

function runtime(sessionFile, sessionId = "session-persist") {
  return { session: { sessionFile, sessionManager: { flushed: true, getSessionId: () => sessionId } } };
}

function chat() {
  return {
    textBuffer: "", thinkingBuffer: "", currentTextSnapshot: "", currentThinkingSnapshot: "",
    response: { write() { return true; }, end() {} }, turnId: "", traceSeq: 0,
    emittedTraces: new Set(), blocks: [], blockSeq: 0, eventSeq: 0, eventHistory: [],
    textSegments: [], thinkingBlockGenerations: {},
  };
}

function records(file) {
  return readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

describe("production event persistence flow", () => {
  it("persists the same ordered blocks that were streamed live", () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-event-persist-"));
    const sessionFile = join(dir, "session.jsonl");
    writeFileSync(sessionFile, JSON.stringify({ type: "session", id: "session-persist" }) + "\n");
    try {
      const engine = fakeEngine();
      const stream = chat();
      attachEngineEvents(engine, runtime(sessionFile), stream);
      engine.emit({ version: 1, type: "turn.started", sessionId: "session-persist", turnId: "turn-1", seq: 1, timestamp: 1 });
      engine.emit({ version: 1, type: "thinking.delta", sessionId: "session-persist", turnId: "turn-1", text: "先分析", seq: 2, timestamp: 2 });
      engine.emit({ version: 1, type: "tool.started", sessionId: "session-persist", turnId: "turn-1", toolCallId: "call-1", name: "search", input: {}, seq: 3, timestamp: 3 });
      engine.emit({ version: 1, type: "tool.completed", sessionId: "session-persist", turnId: "turn-1", toolCallId: "call-1", name: "search", output: "ok", seq: 4, timestamp: 4 });
      engine.emit({ version: 1, type: "content.delta", sessionId: "session-persist", turnId: "turn-1", text: "最终正文", seq: 5, timestamp: 5 });
      engine.emit({ version: 1, type: "turn.completed", sessionId: "session-persist", turnId: "turn-1", seq: 6, timestamp: 6 });

      const persisted = records(sessionFile)
        .filter((entry) => entry.type === "assistant_block")
        .map((entry) => entry.block)
        .sort((left, right) => left.seq - right.seq);
      assert.deepEqual(persisted.map((block) => block.type), ["thinking", "tool", "text"]);
      assert.deepEqual(persisted.map((block) => block.seq), [1, 2, 3]);
      assert.equal(persisted[0].status, "done");
      assert.equal(persisted[1].status, "success");
      assert.equal(persisted[2].text, "最终正文");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("persists a terminal fallback text block for a failed thought-only turn", () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-event-failed-"));
    const sessionFile = join(dir, "session.jsonl");
    writeFileSync(sessionFile, JSON.stringify({ type: "session", id: "session-persist" }) + "\n");
    try {
      const engine = fakeEngine();
      const stream = chat();
      attachEngineEvents(engine, runtime(sessionFile), stream);
      engine.emit({ version: 1, type: "turn.started", sessionId: "session-persist", turnId: "turn-failed", seq: 1, timestamp: 1 });
      engine.emit({ version: 1, type: "thinking.delta", sessionId: "session-persist", turnId: "turn-failed", text: "未完成", seq: 2, timestamp: 2 });
      engine.emit({ version: 1, type: "turn.failed", sessionId: "session-persist", turnId: "turn-failed", seq: 3, timestamp: 3, error: { category: "provider", code: "failed", message: "provider failed", retryable: false } });

      const persisted = records(sessionFile).filter((entry) => entry.type === "assistant_block").map((entry) => entry.block);
      assert.equal(persisted.at(-1)?.type, "text");
      assert.match(persisted.at(-1)?.text || "", /未完成|中断/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
