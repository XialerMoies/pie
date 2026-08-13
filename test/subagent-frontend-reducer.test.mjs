import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  reduceFrontendSubagentEvents,
  selectSubagentBatchesForTool,
} from "../src/frontend/chat/subagent-state.ts";

function event(overrides = {}) {
  return {
    type: "subagent_event",
    protocolVersion: 1,
    parentToolCallId: "delegate-call-1",
    batchId: "batch-1",
    taskId: "task-1",
    seq: 1,
    kind: "task_queued",
    status: "queued",
    timestamp: "2026-08-12T08:00:00.000Z",
    payload: {},
    ...overrides,
  };
}

describe("frontend subagent reducer", () => {
  it("deduplicates out-of-order events and preserves terminal task details", () => {
    const batches = reduceFrontendSubagentEvents([
      event({ seq: 3, kind: "task_completed", status: "completed", payload: { result: { summary: "checked", findings: ["one"] } } }),
      event({ seq: 1 }),
      event({ seq: 2, kind: "task_started", status: "running" }),
      event({ seq: 2, kind: "task_started", status: "running" }),
      event({ taskId: null, seq: 4, kind: "batch_completed", status: "completed" }),
    ]);

    assert.equal(batches.length, 1);
    assert.equal(batches[0].status, "completed");
    assert.deepEqual(batches[0].events.map((item) => item.seq), [1, 2, 3, 4]);
    assert.equal(batches[0].tasks[0].summary, "checked");
    assert.deepEqual(batches[0].tasks[0].findings, ["one"]);
  });

  it("selects only batches owned by the matching delegate tool call", () => {
    const batches = reduceFrontendSubagentEvents([
      event(),
      event({ parentToolCallId: "delegate-call-2", batchId: "batch-2", taskId: "task-2" }),
    ]);
    assert.deepEqual(
      selectSubagentBatchesForTool(batches, "delegate-call-1").map((batch) => batch.batchId),
      ["batch-1"],
    );
  });

  it("preserves configured agent identity from queued events", () => {
    const batches = reduceFrontendSubagentEvents([
      event({
        payload: {
          profile: "reviewer",
          prompt: "Review security boundaries",
          agentId: "security-reviewer",
          agentName: "Security Reviewer",
        },
      }),
    ]);

    assert.equal(batches[0].tasks[0].agentId, "security-reviewer");
    assert.equal(batches[0].tasks[0].agentName, "Security Reviewer");
  });
});
