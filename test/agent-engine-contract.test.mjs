import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  AgentEngineError,
  assertTerminalTransition,
  normalizeEngineError,
  normalizeEngineEvent,
  normalizeEngineUsage,
  normalizeModelCapabilities,
} from "../src/agent-engine/index.ts";

describe("AgentEngine public contract", () => {
  it("accepts a versioned event envelope and rejects invalid identity fields", () => {
    const event = normalizeEngineEvent({
      version: 1,
      type: "turn.started",
      sessionId: "session-1",
      turnId: "turn-1",
      seq: 1,
      timestamp: 1_700_000_000_000,
    });
    assert.deepEqual(event, {
      version: 1,
      type: "turn.started",
      sessionId: "session-1",
      turnId: "turn-1",
      seq: 1,
      timestamp: 1_700_000_000_000,
    });
    assert.throws(() => normalizeEngineEvent({ ...event, seq: 0 }), /seq/);
    assert.throws(() => normalizeEngineEvent({ ...event, version: 2 }), /version/);
  });

  it("allows one terminal state per turn and rejects terminal replacement", () => {
    assert.equal(assertTerminalTransition(undefined, "turn.completed"), "turn.completed");
    assert.equal(assertTerminalTransition("turn.cancelled", "turn.cancelled"), "turn.cancelled");
    assert.throws(
      () => assertTerminalTransition("turn.completed", "turn.failed"),
      /already terminated/,
    );
  });

  it("normalizes usage without inventing unknown cost", () => {
    assert.deepEqual(normalizeEngineUsage({
      input: 12,
      output: 4,
      cacheRead: 3,
      cacheWrite: 2,
      source: "exact",
    }), {
      input: 12,
      output: 4,
      cacheRead: 3,
      cacheWrite: 2,
      reasoning: 0,
      source: "exact",
      cost: { status: "unknown" },
    });
    assert.deepEqual(normalizeEngineUsage({
      input: -1,
      output: Number.NaN,
      source: "mixed",
      cost: { status: "known", amount: 0.25, currency: "USD" },
    }), {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      reasoning: 0,
      source: "mixed",
      cost: { status: "known", amount: 0.25, currency: "USD" },
    });
  });

  it("represents absent model capabilities as unknown", () => {
    assert.deepEqual(normalizeModelCapabilities({}), {
      reasoning: "unknown",
      imageInput: "unknown",
      contextWindow: { status: "unknown" },
      maxOutputTokens: { status: "unknown" },
    });
    assert.deepEqual(normalizeModelCapabilities({
      reasoning: false,
      input: ["text", "image"],
      contextWindow: 128_000,
      maxTokens: 8_192,
    }), {
      reasoning: "unsupported",
      imageInput: "supported",
      contextWindow: { status: "known", value: 128_000 },
      maxOutputTokens: { status: "known", value: 8_192 },
    });
  });

  it("normalizes errors to stable public fields without serializing the cause", () => {
    const cause = new Error("provider secret sk-private-value");
    const error = normalizeEngineError(cause, {
      code: "provider_failed",
      category: "provider",
      retryable: true,
      message: "模型服务暂时不可用",
    });
    assert.ok(error instanceof AgentEngineError);
    assert.equal(error.cause, cause);
    assert.deepEqual(error.toJSON(), {
      code: "provider_failed",
      category: "provider",
      retryable: true,
      message: "模型服务暂时不可用",
    });
    assert.equal(JSON.stringify(error).includes("sk-private-value"), false);
  });
});
