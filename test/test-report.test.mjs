import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildTestReport, reportMarkdown } from "../scripts/test-report.mjs";

describe("generated test report", () => {
  it("derives suite/layer/flow statistics from the manifest", () => {
    const report = buildTestReport();
    assert.equal(report.source, "scripts/test-manifest.mjs");
    assert.equal(report.files, report.entries.length);
    assert.ok(report.declaredTests > 0);
    assert.ok(report.filesByLayer.integration > 0);
    assert.ok(report.testsBySuite.routes > 0);
    assert.match(reportMarkdown(report), /do not edit counts manually/);
  });
});
