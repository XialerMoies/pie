import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { EvidenceLedger } from "../src/server/evidence-ledger.ts";
import {
  assertInvariantReport,
  inspectEngineEventSequence,
  inspectEvidenceEntries,
  inspectPresentationBlocks,
  inspectPresentationTransitions,
  inspectReplayConvergence,
  minimizeFailingSequence,
} from "../src/agent-engine/invariants.ts";
import { loadReplayCatalog, runReplayScenario } from "./fixtures/agent-session-replay.mjs";

function rng(seed) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

function generatedValidSequence(seed) {
  const random = rng(seed);
  const sessionId = `property-session-${seed}`;
  const turnId = `property-turn-${seed}`;
  let seq = 0;
  const next = (event) => ({ version: 1, sessionId, turnId, seq: ++seq, timestamp: seq, ...event });
  const events = [next({ type: "turn.started" })];
  if (random() > 0.25) events.push(next({ type: "thinking.delta", messageSeq: 1, contentIndex: 0, phase: "start", text: "think" }));
  if (random() > 0.35) events.push(next({ type: "thinking.delta", messageSeq: 1, contentIndex: 0, phase: "end", text: "" }));
  if (random() > 0.4) {
    events.push(next({ type: "tool.started", toolCallId: `property-tool-${seed}`, name: "file_read", input: { path: "<workspace>/fixture" } }));
    if (random() > 0.5) events.push(next({ type: "tool.updated", toolCallId: `property-tool-${seed}`, name: "file_read", output: "partial" }));
    events.push(next({ type: "tool.completed", toolCallId: `property-tool-${seed}`, name: "file_read", output: "result" }));
  }
  events.push(next({ type: "content.delta", messageSeq: 1, contentIndex: 1, phase: "start", text: "answer" }));
  if (random() > 0.2) events.push(next({ type: "content.delta", messageSeq: 1, contentIndex: 1, phase: "delta", text: " ready" }));
  events.push(next({ type: "content.delta", messageSeq: 1, contentIndex: 1, phase: "end", text: "" }));
  events.push(next({ type: "turn.completed" }));
  return events;
}

describe("T-02 event/session invariant state machine", () => {
  it("accepts every replay fixture and proves live/replay/refresh convergence", () => {
    for (const scenario of loadReplayCatalog().scenarios) {
      assertInvariantReport(inspectEngineEventSequence(scenario.events), `${scenario.id}: engine events`);
      const result = runReplayScenario(scenario, "replay");
      assertInvariantReport(inspectPresentationBlocks(result.live.blocks), `${scenario.id}: live blocks`);
      assertInvariantReport(inspectPresentationBlocks(result.replay.blocks), `${scenario.id}: replay blocks`);
      assertInvariantReport(inspectPresentationBlocks(result.refresh.blocks), `${scenario.id}: refresh blocks`);
      assertInvariantReport(inspectPresentationTransitions(result.intermediate), `${scenario.id}: block transitions`);
      assertInvariantReport(inspectReplayConvergence(result.live.blocks, result.replay.blocks), `${scenario.id}: live/replay convergence`);
      assertInvariantReport(inspectReplayConvergence(result.replay.blocks, result.refresh.blocks), `${scenario.id}: replay/refresh convergence`);
    }
  });

  it("runs deterministic property sequences through runtime invariants", () => {
    for (let seed = 1; seed <= 100; seed += 1) {
      const sequence = generatedValidSequence(seed);
      const report = inspectEngineEventSequence(sequence);
      assert.equal(report.ok, true, `valid property sequence ${seed} violated: ${JSON.stringify(report.issues)}`);
      const duplicate = [...sequence.slice(0, 2), sequence[1], ...sequence.slice(2)];
      assert.equal(inspectEngineEventSequence(duplicate).ok, false, `duplicate sequence ${seed} was accepted`);
      const late = [...sequence, { ...sequence[1], seq: sequence.at(-1).seq + 1, timestamp: sequence.at(-1).timestamp + 1 }];
      assert.equal(inspectEngineEventSequence(late).issues.some((entry) => entry.code === "late_event_after_terminal"), true, `late event ${seed} was not rejected`);
    }
  });

  it("detects reorder and emits a minimal reproducible failing fixture", () => {
    const source = generatedValidSequence(42);
    const reordered = [...source];
    [reordered[2], reordered[3]] = [reordered[3], reordered[2]];
    const report = inspectEngineEventSequence(reordered);
    assert.equal(report.issues.some((entry) => entry.code === "out_of_order_seq"), true);
    const minimized = minimizeFailingSequence(reordered, inspectEngineEventSequence);
    assert.ok(minimized.length < reordered.length);
    assert.equal(inspectEngineEventSequence(minimized).ok, false);
  });

  it("keeps terminal blocks and evidence facts immutable", () => {
    const badBlocks = [
      { type: "text", blockId: "text-1", seq: 1, status: "done", text: "final" },
      { type: "tool", blockId: "tool-1", seq: 1, status: "success" },
    ];
    assert.equal(inspectPresentationBlocks(badBlocks).ok, false);
    const ledger = new EvidenceLedger({ clock: () => 1_700_000_000_000 });
    ledger.observe({ source: "test", toolName: "file_read", toolCallId: "evidence-1", outcome: "success", complete: true, requestScope: { target: "fixture" }, payloadSummary: "facts" });
    ledger.observe({ source: "test", toolName: "file_read", toolCallId: "evidence-2", outcome: "failed", failureKind: "not_found", complete: false, requestScope: { target: "missing" }, payloadSummary: "missing" });
    const evidence = ledger.entries();
    assertInvariantReport(inspectEvidenceEntries(evidence), "evidence ledger");
    assert.equal(inspectEvidenceEntries([{ ...evidence[0], complete: false }]).ok, false);
    assert.equal(inspectEvidenceEntries([{ ...evidence[0], evidenceId: "duplicate" }, { ...evidence[0], evidenceId: "duplicate" }]).ok, false);
  });
});
