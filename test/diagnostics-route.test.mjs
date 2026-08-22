import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { handleDiagnostics } from "../src/server/routes/diagnostics.ts";
import { StructuredLogger, ToolOutcomeMetrics } from "../src/server/observability.ts";

function context({ runtime, observability, paths }) {
  return {
    groups: {
      core: { runtime },
      security: {},
      storage: { paths },
      providers: { model: { modelRuntime: {}, modelRegistry: {}, syncModelProviders: async () => 0, runWithStableSession: async (operation) => operation() } },
      infra: { observability },
    },
  };
}

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
      context({ runtime: { currentWorkspace: "C:\\Projects\\demo" }, paths: { STARTUP: { instanceId: "instance-1" } }, observability: { logger, appVersion: "0.1.0", startedAt: Date.now() - 1000 } }),
    );
    assert.equal(handled, true);
    assert.equal(res.statusCode, 200);
    const payload = JSON.parse(res.body);
    assert.equal(payload.ok, true);
    assert.equal(payload.appVersion, "0.1.0");
    assert.equal(payload.requestId, "req-1");
    assert.equal(payload.logs[0].fields.apiKey, undefined);
    assert.equal(JSON.stringify(payload).includes("secret"), false);
    assert.equal(JSON.stringify(payload).includes("C:\\Projects"), false);
  });

  it("exports metadata-only logs without Thought, tool payloads, or raw errors", async () => {
    const res = response();
    const logger = new StructuredLogger({ maxEntries: 2 });
    logger.error("agent.internal", {
      method: "POST",
      url: "/api/chat",
      thinking: "private chain of thought",
      input: { command: "secret command" },
      output: "secret output",
      error: "raw provider failure",
      status: 500,
    });
    await handleDiagnostics(
      { url: "/api/diagnostics", method: "GET", headers: {} },
      res,
      context({ runtime: { currentWorkspace: "" }, paths: { STARTUP: { instanceId: "instance-1" } }, observability: { logger, appVersion: "0.1.0", startedAt: Date.now() } }),
    );
    const payload = JSON.parse(res.body);
    assert.deepEqual(payload.logs[0].fields, { method: "POST", url: "/api/chat", status: 500 });
    const serialized = JSON.stringify(payload);
    for (const forbidden of ["private chain of thought", "secret command", "secret output", "raw provider failure"]) {
      assert.equal(serialized.includes(forbidden), false);
    }
  });

  it("exports bounded tool outcome migration metrics", async () => {
    const res = response();
    const logger = new StructuredLogger({ maxEntries: 10 });
    const toolOutcomeMetrics = new ToolOutcomeMetrics();
    toolOutcomeMetrics.observe({ source: "live", toolName: "file_read", toolCallId: "call-1", outcome: "success", legacy: false });
    toolOutcomeMetrics.observe({ source: "live", toolName: "explorer_list", toolCallId: "call-2", outcome: "success", legacy: true, legacyReason: "missing_outcome" });
    toolOutcomeMetrics.observe({ source: "replay", toolName: "file_read", toolCallId: "old-1", outcome: "failed", failureKind: "not_found", legacy: true, legacyReason: "string_result" });
    await handleDiagnostics(
      { url: "/api/diagnostics", method: "GET", headers: {} },
      res,
      context({ runtime: { currentWorkspace: "" }, paths: { STARTUP: { instanceId: "instance-1" } }, observability: { logger, appVersion: "0.1.0", startedAt: Date.now(), toolOutcomeMetrics } }),
    );
    const payload = JSON.parse(res.body);
    assert.deepEqual(payload.toolOutcomeMetrics, {
      total: 3,
      structured: 1,
      legacy: 2,
      missingOutcome: 1,
      invalidOutcome: 0,
      failures: 1,
      bySource: {
        live: { total: 2, structured: 1, legacy: 1, missingOutcome: 1, invalidOutcome: 0, failures: 0 },
        replay: { total: 1, structured: 0, legacy: 1, missingOutcome: 0, invalidOutcome: 0, failures: 1 },
      },
      byTool: {
        file_read: { total: 2, structured: 1, legacy: 1, failures: 1 },
        explorer_list: { total: 1, structured: 0, legacy: 1, failures: 0 },
      },
    });
  });

  it("fails the strict live gate only for compatibility hits", () => {
    const metrics = new ToolOutcomeMetrics();
    metrics.observe({ source: "live", toolName: "legacy", toolCallId: "call-1", outcome: "success", legacy: true, legacyReason: "string_result" });
    assert.throws(() => metrics.assertLiveClean(), /compatibility hits/);
    const replay = new ToolOutcomeMetrics();
    replay.observe({ source: "replay", toolName: "legacy", toolCallId: "old-1", outcome: "success", legacy: true, legacyReason: "string_result" });
    assert.doesNotThrow(() => replay.assertLiveClean());
  });
});
