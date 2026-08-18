import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { execFileSync } from "node:child_process";

const ROOT = resolve(import.meta.dirname, "..");

describe("frontend state ownership", () => {
  it("does not ship legacy window state projections", () => {
    let output = "";
    try {
      output = execFileSync("rg", ["-l", "--glob", "*.ts", "--glob", "*.js", "window\\.__state|window\\.__tabs|window\\.__uiStateStore|__state\\b|__tabs\\b", resolve(ROOT, "src/frontend")], { encoding: "utf8" });
    } catch (error) {
      output = error?.stdout?.toString?.() ?? "";
    }
    const files = output.split(/\r?\n/).filter(Boolean);
    assert.deepEqual(files, []);
  });

  it("publishes state through App.State only", () => {
    const source = readFileSync(resolve(ROOT, "src/frontend/services/ui-state-store.ts"), "utf8");
    assert.match(source, /app\.State\s*=\s*\{/);
    assert.doesNotMatch(source, /__uiStateStore|window\.__state|window\.__tabs/);
  });
});
