import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { SessionManager } from "@xiamol/pi-coding-agent";

import { recoverConversationLeaf } from "../src/agent/runtime.ts";

describe("session leaf recovery", () => {
  it("recovers the message branch when display records and an orphan settings branch trail it", () => {
    const manager = SessionManager.inMemory("E:/workspace");
    manager.appendMessage({ role: "user", content: [{ type: "text", text: "hello" }], timestamp: 1 });
    const assistantId = manager.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "world" }],
      provider: "test",
      model: "test-model",
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: "stop",
      timestamp: 2,
    });

    // Simulate a reload choosing an orphan model/settings branch after app-only records.
    manager.resetLeaf();
    manager.appendModelChange("test", "test-model");
    manager.appendThinkingLevelChange("high");
    assert.equal(manager.buildSessionContext().messages.length, 0);

    assert.equal(recoverConversationLeaf(manager), true);
    assert.equal(manager.getLeafId(), assistantId);
    assert.deepEqual(manager.buildSessionContext().messages.map((message) => message.role), ["user", "assistant"]);
  });
});
