/**
 * Block 持久化生命周期测试
 *
 * persistBlockEvent / flushPendingBlockPersist / emitBlock
 */
import { describe, it } from "node:test";
import assert from "node:assert";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { tmpdir } from "node:os";

import { persistBlockEvent, flushPendingBlockPersist, nextBlockSeq } from "../src/server/server.ts";

function jsonl(file) {
  return readFileSync(file, "utf-8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function mockRuntime(sessionFile, sessionManager = {}) {
  return {
    session: {
      sessionFile,
      sessionManager: {
        flushed: false,
        getSessionId: () => "session-1",
        ...sessionManager,
      },
    },
  };
}

describe("block persistence lifecycle", () => {
  it("keeps block pending before SDK flush, then appends once on flush", () => {
    const dir = mkdtempSync(resolve(tmpdir(), "block-pending-"));
    const sessionFile = resolve(dir, "session.jsonl");
    const runtime = mockRuntime(sessionFile);
    const block = {
      type: "tool_use",
      status: "running",
      name: "search",
      toolCallId: "call-1",
      turnId: "turn-1",
      blockId: "b1",
      seq: 1,
    };

    // Before session flush: pending, no file created
    assert.strictEqual(persistBlockEvent(runtime, block), false);
    assert.strictEqual(existsSync(sessionFile), false,
      "must not create the file before PI SessionManager flushes it");

    // After session flush: pending blocks get written once
    writeFileSync(sessionFile, JSON.stringify({ type: "session", id: "session-1" }) + "\n");
    runtime.session.sessionManager.flushed = true;

    flushPendingBlockPersist(runtime, "turn-1");
    flushPendingBlockPersist(runtime, "turn-1"); // idempotent

    const records = jsonl(sessionFile).filter((entry) => entry.type === "assistant_block");
    assert.strictEqual(records.length, 1, "pending block should flush once");
    assert.strictEqual(records[0].block.blockId, "b1");
    assert.strictEqual(records[0].turnId, "turn-1");
  });

  it("writes tool_use and tool_result blocks in order", () => {
    const dir = mkdtempSync(resolve(tmpdir(), "block-order-"));
    const sessionFile = resolve(dir, "session.jsonl");
    writeFileSync(sessionFile, JSON.stringify({ type: "session", id: "session-1" }) + "\n");
    const runtime = mockRuntime(sessionFile, { flushed: true });

    const toolUse = { type: "tool_use", status: "running", name: "search", toolCallId: "call-1", turnId: "turn-1", blockId: "b1", seq: 1 };
    const toolResult = { type: "tool_result", toolUseId: "call-1", output: "ok", turnId: "turn-1", blockId: "b2", seq: 2 };

    persistBlockEvent(runtime, toolUse);
    persistBlockEvent(runtime, toolResult);

    const records = jsonl(sessionFile).filter((entry) => entry.type === "assistant_block");
    assert.strictEqual(records.length, 2);
    assert.strictEqual(records[0].block.type, "tool_use");
    assert.strictEqual(records[1].block.type, "tool_result");
  });

  it("same blockId overwrites pending (no duplicate on flush)", () => {
    const dir = mkdtempSync(resolve(tmpdir(), "block-dedup-"));
    const sessionFile = resolve(dir, "session.jsonl");
    const runtime = mockRuntime(sessionFile);

    const v1 = { type: "thinking", text: "step 1", status: "streaming", turnId: "turn-1", blockId: "think-1", seq: 1 };
    const v2 = { type: "thinking", text: "step 1 step 2", status: "streaming", turnId: "turn-1", blockId: "think-1", seq: 2 };

    persistBlockEvent(runtime, v1);
    persistBlockEvent(runtime, v2);

    writeFileSync(sessionFile, JSON.stringify({ type: "session", id: "session-1" }) + "\n");
    runtime.session.sessionManager.flushed = true;

    flushPendingBlockPersist(runtime, "turn-1");

    const records = jsonl(sessionFile).filter((entry) => entry.type === "assistant_block");
    assert.strictEqual(records.length, 1, "dedup by blockId: only latest version written");
    assert.strictEqual(records[0].block.text, "step 1 step 2");
    assert.strictEqual(records[0].block.seq, 2);
  });

  it("nextBlockSeq increments and returns matching id and seq", () => {
    const chatStream = { blockSeq: 0, blocks: [] };
    const s1 = nextBlockSeq(chatStream);
    assert.strictEqual(s1, 1);
    const s2 = nextBlockSeq(chatStream);
    assert.strictEqual(s2, 2);
    assert.strictEqual(chatStream.blockSeq, 2);
  });
});
