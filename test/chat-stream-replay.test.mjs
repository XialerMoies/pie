import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { replayChatEvents, writeChatEvent } from "../src/server/chat-stream.ts";

function response() {
  return {
    body: "",
    write(chunk) { this.body += String(chunk); },
  };
}

describe("chat SSE replay", () => {
  it("assigns event ids and replays events after Last-Event-ID", () => {
    const live = response();
    const state = { response: live, eventSeq: 0, eventHistory: [] };

    assert.equal(writeChatEvent(state, { type: "one" }), 1);
    state.response = null;
    assert.equal(writeChatEvent(state, { type: "two" }), 2);
    assert.equal(writeChatEvent(state, { type: "three" }), 3);

    const resumed = response();
    replayChatEvents(state, resumed, "1");

    assert.match(resumed.body, /^id: 2\ndata: \{"type":"two"\}\n\nid: 3\ndata: \{"type":"three"\}\n\n$/);
    assert.doesNotMatch(resumed.body, /"one"/);
  });
});
