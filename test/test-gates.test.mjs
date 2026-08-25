import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { describe, it } from "node:test";
import { GATES, shouldRetry, validateGateDag } from "../scripts/test-gates.mjs";
import { validateTestExceptions } from "../scripts/test-exceptions.mjs";

describe("T-05 test gate governance", () => {
  it("has an acyclic explicit gate DAG with profile/resource ownership", () => {
    assert.deepEqual(validateGateDag(GATES), []);
    assert.ok(GATES.some((gate) => gate.name === "build" && gate.deps.includes("typecheck") && gate.deps.includes("unit")));
    assert.ok(GATES.some((gate) => gate.name === "build" && gate.deps.includes("replay") && gate.deps.includes("coverage")));
    assert.ok(GATES.some((gate) => gate.name === "profile-catalog" && gate.args.includes("profiles:generate")));
    assert.ok(GATES.some((gate) => gate.name === "report" && gate.deps.includes("profile-catalog")));
    assert.equal(GATES.find((gate) => gate.name === "coverage")?.optional, undefined);
    assert.ok(GATES.every((gate) => typeof gate.profile === "string" && Array.isArray(gate.deps)));
  });

  it("keeps every skip/platform/live exception bounded and reviewable", () => {
    assert.deepEqual(validateTestExceptions(), []);
  });

  it("rejects dependency cycles and expired or incomplete exceptions", () => {
    assert.match(validateGateDag([{ name: "a", deps: ["b"], profile: "light" }, { name: "b", deps: ["a"], profile: "light" }]).join("\n"), /cycle/u);
    assert.ok(validateTestExceptions({ version: 1, exceptions: [{ file: "x", kind: "skip", reason: "old", owner: "x", expires: "2020-01-01" }] }).some((error) => /expired/u.test(error)));
  });

  it("never retries a blocking gate and only permits one observation retry", () => {
    const live = GATES.find((gate) => gate.name === "live");
    const unit = GATES.find((gate) => gate.name === "unit");
    assert.equal(shouldRetry(unit, "blocking", 1), false);
    assert.equal(shouldRetry(live, "blocking", 1), false);
    assert.equal(shouldRetry(live, "observe", 1), true);
    assert.equal(shouldRetry(live, "observe", 2), false);
  });

  it("runs a selected gate and only its dependencies as a process-level flow", () => {
    const output = execFileSync(process.execPath, ["scripts/test-gates.mjs", "governance", "manifest"], { encoding: "utf8" });
    assert.ok(output.indexOf("finish governance") < output.indexOf("finish manifest"));
    assert.match(output, /all 2 gates passed/u);
    assert.doesNotMatch(output, /start unit|start routes|start electron/u);
  });
});
