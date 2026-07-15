import { describe, it } from "node:test";
import assert from "node:assert";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { tmpdir } from "node:os";

import { attachSessionEvents, flushPendingTracePersist, persistTraceEvent, tagSessionHeader } from "../src/server/server.ts";

function jsonl(file) {
  return readFileSync(file, "utf-8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function mockRuntime(sessionFile, sessionManager = {}) {
  let callback = null;
  return {
    session: {
      sessionFile,
      sessionManager: {
        flushed: false,
        getSessionId: () => "session-1",
        ...sessionManager,
      },
    },
    onEvent(handler) {
      callback = handler;
      return () => {};
    },
    emit(event) {
      assert.ok(callback, "attachSessionEvents should register a runtime callback");
      callback(event);
    },
  };
}

describe("trace persistence lifecycle", () => {
  it("keeps trace pending before SDK flush, then appends without creating the session file early", () => {
    const dir = mkdtempSync(resolve(tmpdir(), "trace-pending-"));
    const sessionFile = resolve(dir, "session.jsonl");
    const runtime = mockRuntime(sessionFile);
    const trace = {
      type: "tool",
      status: "running",
      name: "search",
      input: { query: "SessionManager" },
      turnId: "turn-1",
      id: "tool-1@turn-1",
      seq: 1,
    };

    assert.strictEqual(persistTraceEvent(runtime, trace, { force: true }), false);
    assert.strictEqual(existsSync(sessionFile), false, "trace must not create the file before PI SessionManager flushes it");

    writeFileSync(sessionFile, JSON.stringify({ type: "session", id: "session-1" }) + "\n");
    runtime.session.sessionManager.flushed = true;

    flushPendingTracePersist(runtime, "turn-1");
    flushPendingTracePersist(runtime, "turn-1");

    const traces = jsonl(sessionFile).filter((entry) => entry.type === "trace");
    assert.strictEqual(traces.length, 1, "pending trace should flush once");
    assert.deepStrictEqual(traces[0].event, trace);
  });

  it("tags workspace headers with ESM-safe fs imports", () => {
    const dir = mkdtempSync(resolve(tmpdir(), "trace-header-"));
    const sessionFile = resolve(dir, "session.jsonl");
    writeFileSync(sessionFile, JSON.stringify({ type: "session", id: "session-1" }) + "\n");

    tagSessionHeader(sessionFile, "E:\\workspace\\pay");

    const [header] = jsonl(sessionFile);
    assert.strictEqual(header.workspace, "E:\\workspace\\pay");
  });
});

describe("SSE agent_end ordering", () => {
  it("flushes trace and tags workspace before sending done", () => {
    const dir = mkdtempSync(resolve(tmpdir(), "trace-done-"));
    const sessionFile = resolve(dir, "session.jsonl");
    writeFileSync(sessionFile, JSON.stringify({ type: "session", id: "session-1" }) + "\n");

    const runtime = mockRuntime(sessionFile, { flushed: true, getSessionId: () => "session-1" });
    const writes = [];
    let fileAtDone = "";
    let ended = false;
    const response = {
      write(chunk) {
        const text = String(chunk);
        writes.push(text);
        if (text.includes('"type":"done"')) {
          fileAtDone = readFileSync(sessionFile, "utf-8");
        }
        return true;
      },
      end() {
        ended = true;
      },
    };
    const chatStream = {
      textBuffer: "final answer",
      thinkingBuffer: "1. inspect\n2. fix",
      currentTextSnapshot: "final answer",
      currentThinkingSnapshot: "1. inspect\n2. fix",
      response,
      currentWorkspace: "E:\\workspace\\pay",
      turnId: "turn-1",
      traceSeq: 0,
      emittedTraces: new Set(),
      blocks: [],
      blockSeq: 0,
    };

    attachSessionEvents(runtime, chatStream);
    runtime.emit({ type: "agent_end" });

    assert.strictEqual(ended, true, "SSE response should be ended");
    assert.strictEqual(chatStream.response, null, "chatStream response should be cleared after done");

    const doneWrite = writes.find((text) => text.includes('"type":"done"'));
    assert.ok(doneWrite, "done event should be written");
    const donePayload = JSON.parse(doneWrite.replace(/^data: /, "").trim());
    assert.strictEqual(donePayload.type, "done");
    assert.strictEqual(donePayload.text, "final answer");
    assert.strictEqual(donePayload.thinking, "1. inspect\n2. fix");
    assert.strictEqual(donePayload.turnId, "turn-1");
    assert.strictEqual(donePayload.sessionId, "session-1");
    assert.deepStrictEqual(donePayload.blocks, []);

    const entriesAtDone = fileAtDone.trim().split("\n").map((line) => JSON.parse(line));
    assert.strictEqual(entriesAtDone[0].workspace, "E:\\workspace\\pay", "workspace should be tagged before done reaches the frontend");
    assert.ok(
      entriesAtDone.some((entry) => entry.type === "trace" && entry.event?.type === "thinking" && entry.event?.status === "done"),
      "thinking trace should be persisted before done reaches the frontend",
    );
  });
});