import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

describe("release gate", () => {
  it("defines one fail-closed command covering all release gates", () => {
    const pkg = JSON.parse(readFileSync(resolve("package.json"), "utf8"));
    const command = pkg.scripts?.["release:check"];
    assert.equal(command, "node scripts/release-check.mjs");
    const runner = readFileSync(resolve("scripts/release-check.mjs"), "utf8");
    for (const gate of [
      "typecheck",
      "test",
      "build",
      "test:build",
      "test:electron:e2e",
    ]) {
      assert.ok(runner.includes(`"${gate}"`), `release gate ${gate} is missing`);
    }
  });
});
