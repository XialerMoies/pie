import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { Window } from "happy-dom";

describe("ChatStream lifecycle", () => {
  let win;
  let streams;

  beforeEach(() => {
    win = new Window();
    streams = [];
    class MockEventSource {
      constructor(url) {
        this.url = url;
        this.onmessage = null;
        this.onerror = null;
        this.closed = false;
        streams.push(this);
      }
      close() {
        this.closed = true;
      }
    }
    win.EventSource = MockEventSource;
    global.EventSource = MockEventSource;
    global.window = win;
    win.App = {};
  });

  it("closes the previous connection and rejects stale generations", async () => {
    await import(`../src/frontend/services/chat-stream.ts?${Date.now()}-${Math.random()}`);
    const received = [];
    const firstGeneration = win.App.ChatStream.open({
      onMessage: (event) => received.push(["first", event.data]),
    });
    const first = streams[0];
    const secondGeneration = win.App.ChatStream.open({
      onMessage: (event) => received.push(["second", event.data]),
    });
    const second = streams[1];

    assert.equal(first.url, "/api/chat/stream");
    assert.equal(first.closed, true);
    assert.equal(win.App.ChatStream.isCurrent(firstGeneration), false);
    assert.equal(win.App.ChatStream.isCurrent(secondGeneration), true);

    first.onmessage?.({ data: "stale" });
    second.onmessage?.({ data: "current" });
    assert.deepEqual(received, [["second", "current"]]);

    win.App.ChatStream.close();
    assert.equal(second.closed, true);
    assert.equal(win.App.ChatStream.isCurrent(secondGeneration), false);
    assert.equal(second.onmessage, null);
    assert.equal(second.onerror, null);
  });
});
