import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { describe, it } from "node:test";
import { evaluateBehavior } from "../scripts/agent-behavior-report.mjs";

describe("T-06 agent behavior baseline cross-layer flow", () => {
  it("evaluates every replay scenario beyond final text", () => {
    const report = evaluateBehavior();
    assert.equal(report.passed, true);
    assert.equal(report.scenarios.length, 9);
    for (const scenario of report.scenarios) {
      assert.equal(scenario.status, "pass", scenario.failures.join("; "));
      assert.equal(scenario.correct, true);
      assert.equal(typeof scenario.toolCalls, "number");
      assert.equal(typeof scenario.unrelatedReads, "number");
      assert.equal(typeof scenario.retryDecision, "string");
      assert.ok(["done", "failed", "cancelled"].includes(scenario.terminalState));
      assert.ok(["unknown", "measured"].includes(scenario.tokenCountStatus));
      assert.equal(scenario.instructionViolations.length, 0);
      assert.equal(scenario.scopeViolations.length, 0);
      assert.equal(scenario.latestInstructionHonored, true);
      assert.equal(scenario.phaseOrderValid, true);
    }
  });

  it("measures ambiguous, corrected, long-context and multi-tool engineering behavior", () => {
    const report = evaluateBehavior();
    const byClass = new Map(report.scenarios.map((scenario) => [scenario.taskClass, scenario]));
    assert.deepEqual(
      [...byClass.keys()].filter((key) => key !== "baseline").sort(),
      ["ambiguous_instruction", "long_context", "multi_tool", "user_correction"],
    );
    assert.equal(byClass.get("user_correction").latestInstructionHonored, true);
    assert.equal(byClass.get("long_context").contextMessageCount, 64);
    assert.equal(byClass.get("long_context").normalizedContextChars, 48_200);
    assert.ok(byClass.get("multi_tool").toolDiversity >= 4);
    assert.equal(byClass.get("multi_tool").phaseOrderValid, true);
  });

  it("fails closed for deterministic behavioral regressions", () => {
    const faults = [
      ["unrelated-read", "task-a-skill-verification"],
      ["retry", "task-a-skill-verification"],
      ["terminal", "task-a-skill-verification"],
      ["leak", "task-a-skill-verification"],
      ["missing-evidence", "task-a-skill-verification"],
      ["memory", "task-a-skill-verification"],
      ["instruction", "engineering-mid-turn-correction"],
      ["scope", "engineering-mid-turn-correction"],
      ["phase", "engineering-multi-tool-refactor"],
    ];
    for (const [fault, scenario] of faults) {
      const child = spawnSync(process.execPath, ["--import", "tsx", "scripts/agent-behavior-report.mjs", "--check", "--scenario", scenario, "--fault", fault], {
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
