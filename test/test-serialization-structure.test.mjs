import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it } from "node:test";
import { buildTestManifest } from "../scripts/test-manifest.mjs";

const packageJson = JSON.parse(readFileSync(resolve(import.meta.dirname, "..", "package.json"), "utf8"));

describe("timing-sensitive test serialization", () => {
  it("runs file-lock outside the parallel unit group with concurrency one", () => {
    const stages = packageJson.scripts["test:unit"].split("&&").map((stage) => stage.trim());

    assert.deepEqual(stages, ["node scripts/test-suite.mjs unit"]);
    assert.deepEqual(buildTestManifest().suites.unitSerial, [
      "test/custom-provider-multi-server.test.mjs",
      "test/custom-provider-store.test.mjs",
      "test/file-lock.test.mjs",
    ]);
  });

  it("runs frontend tests with file-level concurrency one", () => {
    assert.strictEqual(packageJson.scripts["test:frontend"], "node scripts/test-suite.mjs frontend");
    assert.ok(buildTestManifest().suites.frontend.length > 0);
  });

  it("keeps the reviewed frontend HTML sink baseline in the frontend suite", () => {
    assert.ok(buildTestManifest().suites.frontend.includes("test/frontend-xss-sinks.test.mjs"));
  });
});
