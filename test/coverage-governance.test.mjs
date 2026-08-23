import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  inspectCoverageSummary,
  loadCoveragePolicy,
  validateCoveragePolicy,
} from "../scripts/test-coverage.mjs";
import { GATES } from "../scripts/test-gates.mjs";
import { loadTestExceptions } from "../scripts/test-exceptions.mjs";

function summary(percentages) {
  return {
    total: Object.fromEntries(Object.entries(percentages).map(([metric, pct]) => [metric, { pct }])),
    "src/example.ts": {},
  };
}

describe("coverage collector governance", () => {
  it("uses the default c8 policy and instruments every prerequisite producer", () => {
    const policy = loadCoveragePolicy();
    assert.deepEqual(validateCoveragePolicy(policy), []);
    assert.deepEqual(
      GATES.filter((gate) => gate.coverageProducer).map((gate) => gate.name),
      ["unit", "routes", "frontend"],
    );
    assert.deepEqual(GATES.find((gate) => gate.name === "coverage")?.deps, ["unit", "routes", "frontend"]);
    const pkg = JSON.parse(readFileSync(resolve(process.cwd(), "package.json"), "utf8"));
    assert.equal(pkg.scripts["test:coverage"], "node scripts/test-gates.mjs coverage");
  });

  it("rejects zero thresholds and no longer allows a collector-wide exemption", () => {
    const policy = loadCoveragePolicy();
    assert.match(validateCoveragePolicy({ ...policy, thresholds: { ...policy.thresholds, lines: 0 } }).join("\n"), /lines/u);
    assert.match(validateCoveragePolicy({ ...policy, maximumRawMb: 0 }).join("\n"), /maximumRawMb/u);
    assert.equal(loadTestExceptions().exceptions.some((entry) => entry.kind === "coverage_exemption"), false);
  });

  it("fails closed when any reported metric falls below policy", () => {
    const policy = loadCoveragePolicy();
    const passing = summary(policy.baseline);
    assert.equal(inspectCoverageSummary(passing, policy).ok, true);
    const failing = summary({ ...policy.thresholds, branches: policy.thresholds.branches - 0.01 });
    assert.equal(inspectCoverageSummary(failing, policy).ok, false);
    const regressed = summary({ ...policy.baseline, lines: policy.baseline.lines - policy.maximumRegressionPoints - 0.01 });
    assert.match(inspectCoverageSummary(regressed, policy).errors.join("\n"), /regressed/u);
  });
});
