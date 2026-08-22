import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { describe, it } from "node:test";

describe("frontend TypeScript coverage gate", () => {
  it("covers every frontend source and records the legacy exception explicitly", () => {
    const output = execFileSync(process.execPath, ["scripts/check-frontend-type-coverage.mjs"], {
      cwd: new URL("..", import.meta.url),
      encoding: "utf8",
      env: { ...process.env, NODE_OPTIONS: "--max-old-space-size=2048" },
    });
    assert.match(output, /source files \+ dashboard\.d\.ts covered/);
    assert.match(output, /legacy global scripts syntax-only/);
  });
});
