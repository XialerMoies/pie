import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { calculateContextUsageSnapshot } from "../src/agent/context-usage.ts"

function usage(totalTokens) {
  return {
    input: totalTokens,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens,
  }
}

function assistant({ text = "done", totalTokens = 100, stopReason = "stop" } = {}) {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    stopReason,
    usage: usage(totalTokens),
  }
}

function session(messages, nativeTokens = 0) {
  return {
    model: { contextWindow: 200 },
    messages,
    getContextUsage: () => ({
      tokens: nativeTokens,
      contextWindow: 200,
      percent: nativeTokens == null ? null : nativeTokens / 2,
    }),
  }
}

describe("calculateContextUsageSnapshot", () => {
  it("marks the last completed provider usage as exact", () => {
    const snapshot = calculateContextUsageSnapshot(session([
      { role: "user", content: "hello" },
      assistant({ totalTokens: 100 }),
    ], 100))

    assert.deepStrictEqual(snapshot, {
      tokens: 100,
      contextWindow: 200,
      percent: 50,
      source: "exact",
      exactTokens: 100,
      estimatedTokens: 0,
    })
  })

  it("adds estimated user, tool, and streaming assistant content after the exact baseline", () => {
    const snapshot = calculateContextUsageSnapshot(session([
      assistant({ totalTokens: 100 }),
      { role: "user", content: "12345678" },
      { role: "toolResult", content: [{ type: "text", text: "1234" }] },
      { role: "assistant", content: [{ type: "text", text: "12345678" }], stopReason: "stop", usage: usage(0) },
    ], 105))

    assert.deepStrictEqual(snapshot, {
      tokens: 105,
      contextWindow: 200,
      percent: 52.5,
      source: "mixed",
      exactTokens: 100,
      estimatedTokens: 5,
    })
  })

  it("stays mixed when a trailing context message currently estimates to zero tokens", () => {
    const snapshot = calculateContextUsageSnapshot(session([
      assistant({ totalTokens: 100 }),
      { role: "user", content: "" },
    ], 100))

    assert.deepStrictEqual(snapshot, {
      tokens: 100,
      contextWindow: 200,
      percent: 50,
      source: "mixed",
      exactTokens: 100,
      estimatedTokens: 0,
    })
  })

  it("marks the whole context estimated before any valid provider usage", () => {
    const snapshot = calculateContextUsageSnapshot(session([
      { role: "user", content: "12345678" },
      assistant({ text: "1234", totalTokens: 0 }),
    ], 3))

    assert.deepStrictEqual(snapshot, {
      tokens: 3,
      contextWindow: 200,
      percent: 1.5,
      source: "estimated",
      exactTokens: 0,
      estimatedTokens: 3,
    })
  })

  it("ignores aborted, errored, and zero-token assistant usage", () => {
    for (const message of [
      assistant({ totalTokens: 100, stopReason: "aborted" }),
      assistant({ totalTokens: 100, stopReason: "error" }),
      assistant({ totalTokens: 0, stopReason: "stop" }),
    ]) {
      const snapshot = calculateContextUsageSnapshot(session([message], 1))
      assert.strictEqual(snapshot?.source, "estimated")
      assert.strictEqual(snapshot?.exactTokens, 0)
      assert.strictEqual(snapshot?.estimatedTokens, 1)
    }
  })

  it("does not trust retained pre-compaction usage when PI reports an unknown context", () => {
    const snapshot = calculateContextUsageSnapshot(session([
      assistant({ totalTokens: 100 }),
      { role: "user", content: "12345678" },
    ], null))

    assert.deepStrictEqual(snapshot, {
      tokens: 3,
      contextWindow: 200,
      percent: 1.5,
      source: "estimated",
      exactTokens: 0,
      estimatedTokens: 3,
    })
  })

  it("returns undefined without a valid model context window", () => {
    assert.strictEqual(calculateContextUsageSnapshot({ model: undefined, messages: [] }), undefined)
    assert.strictEqual(calculateContextUsageSnapshot({ model: { contextWindow: 0 }, messages: [] }), undefined)
  })
})
