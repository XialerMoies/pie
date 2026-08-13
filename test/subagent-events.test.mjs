import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  MAX_SUBAGENT_EVENT_PAYLOAD_BYTES,
  MAX_SUBAGENT_PROGRESS_EVENTS_PER_BATCH,
  MAX_SUBAGENT_REPLAY_EVENTS,
  createSubagentEvent,
  createSubagentEventSink,
  isSubagentEvent,
  reduceSubagentEventReplay,
} from "../src/server/subagent-events.ts";

function event(overrides = {}) {
  return createSubagentEvent({
    protocolVersion: 1,
    parentToolCallId: "delegate-call-1",
    batchId: "batch-1",
    taskId: "task-1",
    seq: 1,
    kind: "task_started",
    status: "running",
    timestamp: "2026-08-12T08:00:00.000Z",
    payload: {},
    ...overrides,
  });
}

function chatStream() {
  return {
    response: null,
    eventSeq: 0,
    eventHistory: [],
  };
}

function payloads(stream) {
  return stream.eventHistory.map((frame) => {
    const line = frame.data.split("\n").find((candidate) => candidate.startsWith("data: "));
    return JSON.parse(line.slice("data: ".length));
  });
}

describe("subagent_event schema", () => {
  it("creates a discriminated event with explicit batch identity and bounded payload", () => {
    const created = event({
      taskId: null,
      kind: "batch_started",
      payload: {
        taskCount: 2,
        prompt: "x".repeat(MAX_SUBAGENT_EVENT_PAYLOAD_BYTES * 4),
      },
    });

    assert.equal(isSubagentEvent(created), true);
    assert.deepEqual({
      type: created.type,
      protocolVersion: created.protocolVersion,
      parentToolCallId: created.parentToolCallId,
      batchId: created.batchId,
      taskId: created.taskId,
      seq: created.seq,
      kind: created.kind,
      status: created.status,
      timestamp: created.timestamp,
    }, {
      type: "subagent_event",
      protocolVersion: 1,
      parentToolCallId: "delegate-call-1",
      batchId: "batch-1",
      taskId: null,
      seq: 1,
      kind: "batch_started",
      status: "running",
      timestamp: "2026-08-12T08:00:00.000Z",
    });
    assert.ok(
      Buffer.byteLength(JSON.stringify(created.payload), "utf8") <= MAX_SUBAGENT_EVENT_PAYLOAD_BYTES,
      "persisted payload must have a hard byte boundary",
    );
  });

  it("rejects malformed identities, sequence numbers, and kind/status pairs", () => {
    const valid = event();
    assert.equal(isSubagentEvent({ ...valid, batchId: "" }), false);
    assert.equal(isSubagentEvent({ ...valid, protocolVersion: 2 }), false);
    assert.equal(isSubagentEvent({ ...valid, parentToolCallId: "" }), false);
    assert.equal(isSubagentEvent({ ...valid, seq: 0 }), false);
    assert.equal(isSubagentEvent({ ...valid, taskId: null }), false);
    assert.equal(isSubagentEvent({ ...valid, kind: "task_completed", status: "running" }), false);
    assert.equal(isSubagentEvent({ ...valid, timestamp: "not-a-date" }), false);
  });
});

describe("subagent event sink", () => {
  it("writes live SSE without a main turnId and persists a normal custom entry", () => {
    const stream = chatStream();
    const persisted = [];
    const runtime = {
      session: {
        sessionManager: {
          appendCustomEntry(customType, data) {
            persisted.push({ customType, data });
            return "entry-1";
          },
        },
      },
    };
    const sink = createSubagentEventSink({ runtime, chatStream: stream });
    const emitted = event({ seq: 7, kind: "task_progress", status: "running" });

    sink(emitted);

    assert.deepEqual(persisted, [{ customType: "subagent_event", data: emitted }]);
    assert.deepEqual(payloads(stream), [{ type: "subagent_event", event: emitted }]);
    assert.equal("turnId" in payloads(stream)[0], false);
    assert.equal("turnId" in emitted, false);
  });

  it("logs persistence failures but still publishes the live event", async () => {
    const stream = chatStream();
    const warnings = [];
    const runtime = {
      session: {
        sessionManager: {
          appendCustomEntry() {
            throw new Error("disk full");
          },
        },
      },
    };
    const sink = createSubagentEventSink({
      runtime,
      chatStream: stream,
      warn(message) { warnings.push(message); },
    });

    assert.doesNotThrow(() => sink(event()));
    assert.equal(payloads(stream).length, 1);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /disk full/);
  });

  it("captures the target session manager instead of following a later runtime.session switch", () => {
    const stream = chatStream();
    const firstEntries = [];
    const secondEntries = [];
    const runtime = {
      session: {
        sessionManager: {
          appendCustomEntry(customType, data) { firstEntries.push({ customType, data }); },
        },
      },
    };
    const sink = createSubagentEventSink({ runtime, chatStream: stream });
    runtime.session = {
      sessionManager: {
        appendCustomEntry(customType, data) { secondEntries.push({ customType, data }); },
      },
    };

    sink(event());

    assert.equal(firstEntries.length, 1);
    assert.equal(secondEntries.length, 0);
  });

  it("limits persisted progress without stopping live updates and always retains terminal events", () => {
    const stream = chatStream();
    const persisted = [];
    const runtime = {
      session: {
        sessionManager: {
          appendCustomEntry(_customType, data) { persisted.push(data); },
        },
      },
    };
    const sink = createSubagentEventSink({ runtime, chatStream: stream });
    sink(event({ taskId: null, seq: 1, kind: "batch_started", status: "running" }));
    for (let index = 0; index < MAX_SUBAGENT_PROGRESS_EVENTS_PER_BATCH + 25; index += 1) {
      sink(event({
        seq: index + 2,
        kind: "task_progress",
        status: "running",
        payload: { phase: "turn", turns: index + 1 },
      }));
    }
    sink(event({
      seq: MAX_SUBAGENT_PROGRESS_EVENTS_PER_BATCH + 27,
      kind: "task_completed",
      status: "completed",
    }));
    sink(event({
      taskId: null,
      seq: MAX_SUBAGENT_PROGRESS_EVENTS_PER_BATCH + 28,
      kind: "batch_completed",
      status: "completed",
    }));

    const publishedEvents = payloads(stream).map((payload) => payload.event);
    assert.equal(
      publishedEvents.filter((item) => item.kind === "task_progress").length,
      MAX_SUBAGENT_PROGRESS_EVENTS_PER_BATCH + 25,
    );
    assert.equal(
      persisted.filter((item) => item.kind === "task_progress").length,
      MAX_SUBAGENT_PROGRESS_EVENTS_PER_BATCH,
    );
    assert.ok(publishedEvents.some((item) => item.kind === "task_completed"));
    assert.ok(publishedEvents.some((item) => item.kind === "batch_completed"));
    assert.ok(persisted.some((item) => item.kind === "task_completed"));
    assert.ok(persisted.some((item) => item.kind === "batch_completed"));
  });
});

describe("subagent event replay reducer", () => {
  it("deduplicates and orders events by batchId + taskId + seq", () => {
    const started = event({ seq: 2, kind: "task_started", status: "running" });
    const queued = event({ seq: 1, kind: "task_queued", status: "queued" });
    const completed = event({ seq: 3, kind: "task_completed", status: "completed" });
    const replay = reduceSubagentEventReplay([completed, started, queued, { ...started }], {
      activeTaskIds: ["task-1"],
    });

    assert.deepEqual(replay.batches[0].events.map((item) => item.seq), [1, 2, 3]);
    assert.deepEqual(replay.batches[0].tasks[0].events.map((item) => item.seq), [1, 2, 3]);
    assert.equal(replay.batches[0].tasks[0].status, "completed");
  });

  it("replays persisted session custom entries without treating other custom data as events", () => {
    const queued = event({ seq: 1, kind: "task_queued", status: "queued" });
    const replay = reduceSubagentEventReplay([
      { type: "custom", customType: "other", data: queued },
      { type: "custom", customType: "subagent_event", data: queued },
    ], { activeTaskIds: ["task-1"] });

    assert.equal(replay.batches.length, 1);
    assert.deepEqual(replay.batches[0].events, [queued]);
  });

  it("rebuilds render-safe task details from queued and completed payloads", () => {
    const queued = event({
      seq: 1,
      kind: "task_queued",
      status: "queued",
      payload: { profile: "reviewer", prompt: "Review replay boundaries" },
    });
    const completed = event({
      seq: 2,
      kind: "task_completed",
      status: "completed",
      payload: {
        result: {
          summary: "Replay is bounded",
          findings: ["Lifecycle events are retained"],
          evidence: ["subagent-events.ts:266"],
        },
      },
    });

    const replay = reduceSubagentEventReplay([queued, completed]);

    assert.deepEqual(replay.batches[0].tasks[0], {
      taskId: "task-1",
      status: "completed",
      profile: "reviewer",
      prompt: "Review replay boundaries",
      summary: "Replay is bounded",
      findings: ["Lifecycle events are retained"],
      evidence: ["subagent-events.ts:266"],
      events: [queued, completed],
    });
  });

  it("preserves configured agent identity in replay task snapshots", () => {
    const replay = reduceSubagentEventReplay([
      event({
        seq: 1,
        kind: "task_queued",
        status: "queued",
        payload: {
          profile: "reviewer",
          prompt: "Review security boundaries",
          agentId: "security-reviewer",
          agentName: "Security Reviewer",
        },
      }),
    ]);

    assert.equal(replay.batches[0].tasks[0].agentId, "security-reviewer");
    assert.equal(replay.batches[0].tasks[0].agentName, "Security Reviewer");
  });

  it("marks an unfinished restored batch and its inactive tasks as interrupted", () => {
    const replay = reduceSubagentEventReplay([
      event({ taskId: null, seq: 1, kind: "batch_started", status: "running" }),
      event({ seq: 2, kind: "task_queued", status: "queued" }),
      event({ seq: 3, kind: "task_started", status: "running" }),
    ]);

    assert.equal(replay.batches[0].status, "interrupted");
    assert.equal(replay.batches[0].tasks[0].status, "interrupted");
  });

  it("keeps an unfinished batch running while at least one task is active", () => {
    const replay = reduceSubagentEventReplay([
      event({ taskId: null, seq: 1, kind: "batch_started", status: "running" }),
      event({ seq: 2, kind: "task_started", status: "running" }),
    ], { activeTaskIds: ["task-1"] });

    assert.equal(replay.batches[0].status, "running");
    assert.equal(replay.batches[0].tasks[0].status, "running");
  });

  it("bounds replay history while retaining lifecycle terminal events", () => {
    const events = [
      event({ taskId: null, seq: 1, kind: "batch_started", status: "running" }),
      ...Array.from({ length: MAX_SUBAGENT_REPLAY_EVENTS + 100 }, (_, index) => event({
        seq: index + 2,
        kind: "task_progress",
        status: "running",
        payload: { phase: "turn", turns: index + 1 },
      })),
      event({
        seq: MAX_SUBAGENT_REPLAY_EVENTS + 102,
        kind: "task_completed",
        status: "completed",
      }),
      event({
        taskId: null,
        seq: MAX_SUBAGENT_REPLAY_EVENTS + 103,
        kind: "batch_completed",
        status: "completed",
      }),
    ];

    const replay = reduceSubagentEventReplay(events);

    assert.ok(replay.batches[0].events.length <= MAX_SUBAGENT_REPLAY_EVENTS);
    assert.ok(replay.batches[0].events.some((item) => item.kind === "batch_started"));
    assert.ok(replay.batches[0].events.some((item) => item.kind === "task_completed"));
    assert.ok(replay.batches[0].events.some((item) => item.kind === "batch_completed"));
  });
});
