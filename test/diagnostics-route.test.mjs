import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { handleDiagnostics } from "../src/server/routes/diagnostics.ts";
import { StructuredLogger } from "../src/server/observability.ts";

function response() {
  return {
    statusCode: 0,
    headers: {},
    body: "",
    writeHead(status, headers) { this.statusCode = status; Object.assign(this.headers, headers); },
    end(value = "") { this.body += value; },
  };
}

describe("diagnostics route", () => {
  it("exports bounded, redacted diagnostics without absolute paths", async () => {
    const res = response();
    const logger = new StructuredLogger({ maxEntries: 10 });
    logger.error("provider.failure", { apiKey: "secret", status: 429 });
    const handled = await handleDiagnostics(
      { url: "/api/diagnostics", method: "GET", headers: { "x-request-id": "req-1" } },
      res,
      {
        runtime: { currentWorkspace: "C:\\Projects\\demo" },
        paths: { STARTUP: { instanceId: "instance-1" } },
        observability: { logger, appVersion: "0.1.0", startedAt: Date.now() - 1000 },
      },
    );
    assert.equal(handled, true);
    assert.equal(res.statusCode, 200);
    const payload = JSON.parse(res.body);
    assert.equal(payload.ok, true);
    assert.equal(payload.appVersion, "0.1.0");
    assert.equal(payload.requestId, "req-1");
    assert.equal(payload.logs[0].fields.apiKey, "[redacted]");
    assert.equal(JSON.stringify(payload).includes("C:\\Projects"), false);
  });
});
