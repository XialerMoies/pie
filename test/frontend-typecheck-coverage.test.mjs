import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { describe, it } from "node:test";

describe("frontend TypeScript coverage gate", () => {
  it("covers every frontend source and declaration while recording the legacy exception explicitly", () => {
    const output = execFileSync(process.execPath, ["scripts/check-frontend-type-coverage.mjs"], {
      cwd: new URL("..", import.meta.url),
      encoding: "utf8",
      env: { ...process.env, NODE_OPTIONS: "--max-old-space-size=2048" },
    });
    const counts = output.match(/(\d+) source files \+ (\d+) declarations covered/u);
    assert.ok(counts, "coverage output must report source and declaration counts");
    assert.ok(Number(counts[1]) > 0, "frontend source coverage must not be empty");
    assert.ok(Number(counts[2]) > 0, "frontend declaration coverage must not be empty");
    assert.match(output, /legacy global scripts syntax-only/);
    assert.match(output, /strict modules use tsconfig\.frontend\.strict\.json/);
  });
});
