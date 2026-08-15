import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it } from "node:test";

const packageJson = JSON.parse(readFileSync(resolve(import.meta.dirname, "..", "package.json"), "utf8"));

describe("timing-sensitive test serialization", () => {
  it("runs file-lock outside the parallel unit group with concurrency one", () => {
    const stages = packageJson.scripts["test:unit"].split("&&").map((stage) => stage.trim());

    assert.strictEqual(stages.length, 2, "test:unit should have a parallel main stage and a serial file-lock stage");
    assert.doesNotMatch(stages[0], /test\/file-lock\.test\.mjs/);
    assert.match(stages[1], /--test-concurrency=1\s+test\/file-lock\.test\.mjs$/);
  });

  it("runs frontend tests with file-level concurrency one", () => {
    assert.match(packageJson.scripts["test:frontend"], /--test-concurrency=1/);
  });

  it("keeps the reviewed frontend HTML sink baseline in the frontend suite", () => {
    assert.match(packageJson.scripts["test:frontend"], /test\/frontend-xss-sinks\.test\.mjs/);
  });
});
