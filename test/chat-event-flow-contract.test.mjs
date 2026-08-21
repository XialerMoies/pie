import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { attachEngineEvents } from "../src/server/server.ts";
import { CHAT_FLOW_ENGINE_EVENTS, blockSnapshot, latestBlocks } from "./fixtures/chat-event-flow.mjs";

function fakeEngine() {
  let listener;
  return {
    session: { id: "session-flow", workspace: "/workspace", isStreaming: true, isCompacting: false },
    subscribe(next) { listener = next; return () => { listener = undefined; }; },
    emit(event) { listener?.(event); },
    getContextUsage() { return undefined; },
    getSessionStats() { return undefined; },
  };
}

function fakeRuntime() {
  return { session: { sessionFile: undefined, sessionManager: { flushed: false, getSessionId: () => "session-flow" } } };
}

function stream() {
  return { textBuffer: "", thinkingBuffer: "", response: null, turnId: "", eventSeq: 0, eventHistory: [], blocks: [], emittedTraces: new Set(), blockSeq: 0 };
}

function payloads(chat) {
  return chat.eventHistory.map((entry) => JSON.parse(entry.data.split("data: ")[1]));
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
});
