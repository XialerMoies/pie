import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";

import { attachEngineEvents } from "../src/server/agent-event-router.ts";
import { EvidenceLedger } from "../src/server/evidence-ledger.ts";
import { RetryPolicy } from "../src/server/retry-policy.ts";
import { TaskLifecycle } from "../src/server/task-lifecycle.ts";

const failures = [
  { kind: "transport_error", category: "network", code: "fetch_failed", retryable: true, expected: "retry" },
  { kind: "not_found", category: "provider", code: "not_found", retryable: true, expected: "stop" },
  { kind: "permission_denied", category: "permission", code: "forbidden", retryable: false, expected: "stop" },
  { kind: "validation_error", category: "validation", code: "invalid_args", retryable: false, expected: "stop" },
  { kind: "cancelled", category: "cancelled", code: "aborted", retryable: false, expected: "cancel" },
];

function event(type, seq, extra = {}) {
  return { version: 1, type, sessionId: "s-a07", turnId: "t-a07", seq, timestamp: seq, ...extra };
}

function flow() {
  const engine = new EventEmitter();
  engine.session = { id: "s-a07" };
  engine.subscribe = (listener) => { engine.on("event", listener); return () => engine.off("event", listener); };
  const chat = {
    textBuffer: "", thinkingBuffer: "", currentTextSnapshot: "", currentThinkingSnapshot: "", response: null,
    turnId: "", traceSeq: 0, emittedTraces: new Set(), blocks: [], blockSeq: 0, eventSeq: 0, eventHistory: [],
    taskRequirements: { kind: "general", requiresEvidence: false, minSuccessfulEvidence: 0 },
  };
  attachEngineEvents(engine, { session: { sessionFile: undefined, sessionManager: { flushed: false } } }, chat, {
    appEvents: { publish() {} },
    observability: { evidenceLedger: new EvidenceLedger() },
  });
  return { engine, chat };
}

describe("A-07 category-driven retry cross-layer flow", () => {
  it("maps the failure matrix through tool.failed → task snapshot → final presentation", () => {
    for (const [index, failure] of failures.entries()) {
      const current = flow();
      current.engine.emit("event", event("turn.started", 1));
      current.engine.emit("event", event("tool.started", 2, { toolCallId: `call-${index}`, name: "read", input: { target: `target-${index}` } }));
      current.engine.emit("event", event("tool.failed", 3, {
        toolCallId: `call-${index}`, name: "read",
        error: { category: failure.category, kind: failure.kind, code: failure.code, message: failure.code, retryable: failure.retryable },
      }));
      const task = current.chat.taskLifecycle;
      assert.equal(task.retryDecisions.at(-1).category, failure.kind);
      assert.equal(task.retryDecisions.at(-1).action, failure.expected);
      if (failure.expected === "cancel") assert.equal(task.status, "cancelled");
      else assert.equal(task.status, failure.expected === "retry" ? "running" : "blocked");
    }
  });

  it("limits only transport retries and does not share budget across changed requests", () => {
    const lifecycle = new TaskLifecycle();
    lifecycle.start("t-transport");
    const error = { category: "network", kind: "transport_error", code: "fetch_failed", message: "failed", retryable: true };
    lifecycle.toolStarted("a1", "fetch", { url: "/a" });
    lifecycle.toolFailed("a1", "fetch", error);
    lifecycle.toolStarted("a2", "fetch", { url: "/a" });
    lifecycle.toolFailed("a2", "fetch", error);
    assert.equal(lifecycle.snapshot().status, "blocked");
    assert.equal(lifecycle.snapshot().reason, "transport_error_retry_budget_exhausted");

    const changed = new TaskLifecycle();
    changed.start("t-changed");
    changed.toolStarted("b1", "fetch", { url: "/a" });
    changed.toolFailed("b1", "fetch", error);
    changed.toolStarted("b2", "fetch", { url: "/b" });
    changed.toolFailed("b2", "fetch", error);
    assert.equal(changed.snapshot().status, "running");
    assert.deepEqual(changed.snapshot().retryDecisions.map((decision) => decision.action), ["retry", "retry"]);
  });

  it("does not use a global call-count breaker for unrelated successful work", () => {
    const policy = new RetryPolicy();
    const error = { category: "network", kind: "transport_error", code: "fetch_failed", message: "failed", retryable: true };
    assert.equal(policy.decide("fetch", "a", error).action, "retry");
    assert.equal(policy.decide("fetch", "b", error).action, "retry");
    assert.equal(policy.decide("fetch", "c", error).action, "retry");
    assert.deepEqual(policy.decisions().map((decision) => decision.requestKey), ["a", "b", "c"]);
  });
});

