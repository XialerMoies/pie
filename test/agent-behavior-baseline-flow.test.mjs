import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { describe, it } from "node:test";
import { evaluateBehavior } from "../scripts/agent-behavior-report.mjs";

describe("T-06 agent behavior baseline cross-layer flow", () => {
  it("evaluates every replay scenario beyond final text", () => {
    const report = evaluateBehavior();
    assert.equal(report.passed, true);
    assert.equal(report.scenarios.length, 5);
    for (const scenario of report.scenarios) {
      assert.equal(scenario.status, "pass", scenario.failures.join("; "));
      assert.equal(scenario.correct, true);
      assert.equal(typeof scenario.toolCalls, "number");
      assert.equal(typeof scenario.unrelatedReads, "number");
      assert.equal(typeof scenario.retryDecision, "string");
      assert.ok(["done", "failed", "cancelled"].includes(scenario.terminalState));
      assert.ok(["unknown", "measured"].includes(scenario.tokenCountStatus));
    }
  });

  it("fails closed for deterministic behavioral regressions", () => {
    for (const fault of ["unrelated-read", "retry", "terminal", "leak", "missing-evidence", "memory"]) {
      const child = spawnSync(process.execPath, ["--import", "tsx", "scripts/agent-behavior-report.mjs", "--check", "--scenario", "task-a-skill-verification", "--fault", fault], {
        cwd: process.cwd(),
        encoding: "utf8",
        env: { ...process.env, NODE_OPTIONS: `${process.env.NODE_OPTIONS || ""} --max-old-space-size=2048`.trim() },
      });
      assert.notEqual(child.status, 0, `${fault} fault unexpectedly passed`);
    }
  });

  it("does not treat unavailable token usage as zero", () => {
    const report = evaluateBehavior({ scenarioId: "task-a-skill-verification" });
    assert.equal(report.scenarios[0].tokenCount, null);
    assert.equal(report.scenarios[0].tokenCountStatus, "unknown");
  });

  it("separates an explicitly accepted behavior change from a regression", () => {
    const previous = process.env.MY_CODE_AGENT_EXPECTED_BEHAVIOR_CHANGES;
    process.env.MY_CODE_AGENT_EXPECTED_BEHAVIOR_CHANGES = "unrelatedReads";
    try {
      const report = evaluateBehavior({ scenarioId: "task-a-skill-verification", fault: "unrelated-read" });
      assert.equal(report.passed, true);
      assert.equal(report.scenarios[0].status, "expected_change");
    } finally {
      if (previous === undefined) delete process.env.MY_CODE_AGENT_EXPECTED_BEHAVIOR_CHANGES;
      else process.env.MY_CODE_AGENT_EXPECTED_BEHAVIOR_CHANGES = previous;
    }
  });
});
