import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentToolToPIToolDefinition, structuredToolResult } from "../src/agent/types.ts";
import { CorrelationLedger } from "../src/server/correlation.ts";
import { EvidenceLedger } from "../src/server/evidence-ledger.ts";
import { attachEngineEvents } from "../src/server/agent-event-router.ts";
import { ToolOutcomeMetrics, createToolOutcomeObserver, diagnosticsSnapshot, StructuredLogger } from "../src/server/observability.ts";
import { replayChatEvents } from "../src/server/chat-stream.ts";
import { handleDiagnostics } from "../src/server/routes/diagnostics.ts";
import { createMockModelContext } from "./helpers/context.mjs";

function flow() {
  const sessionId = "session-correlation";
  const chat = {
    textBuffer: "", thinkingBuffer: "", currentTextSnapshot: "", currentThinkingSnapshot: "",
    response: null, turnId: "", traceId: "", sessionId, traceSeq: 0, emittedTraces: new Set(),
    blocks: [], blockSeq: 0, eventSeq: 0, eventHistory: [], correlationLedger: undefined,
  };
  const listeners = new Set();
  const engine = {
    id: "fake-engine",
    session: { id: sessionId, workspace: "E:\\workspace", isStreaming: false, isCompacting: false },
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    emit(event) { for (const listener of [...listeners]) listener(event); },
  };
  const sessionFile = join(mkdtempSync(join(tmpdir(), "a10-correlation-")), "session.jsonl");
  writeFileSync(sessionFile, `${JSON.stringify({ type: "session", id: sessionId })}\n`, "utf8");
  const runtime = { session: { sessionFile, sessionManager: { flushed: true } } };
  const correlation = new CorrelationLedger({ clock: () => 1_700_000_000_000 });
  const evidence = new EvidenceLedger({ clock: () => 1_700_000_000_000 });
  const metrics = new ToolOutcomeMetrics();
  const observer = createToolOutcomeObserver(metrics, new StructuredLogger(), evidence, correlation);
  chat.correlationLedger = correlation;
  const observability = { logger: new StructuredLogger(), appVersion: "test", startedAt: 1_700_000_000_000, toolOutcomeMetrics: metrics, evidenceLedger: evidence, correlationLedger: correlation };
  const ctx = {
    groups: {
      core: { engine, runtime, chatStream: chat, appEvents: { publish() {} } },
      security: {},
      storage: { paths: { SESSIONS_DIR: "E:\\sessions", APP_ROOT: "E:\\workspace" } },
      providers: { model: createMockModelContext() },
      infra: { observability },
    },
  };
  attachEngineEvents(engine, runtime, chat, ctx);
  return { sessionId, chat, engine, runtime, correlation, evidence, metrics, observer, ctx };
}

function base(flow, turnId, seq, type, extra = {}) {
  return { version: 1, type, sessionId: flow.sessionId, turnId, seq, timestamp: seq, ...extra };
}

function payloads(chat) {
  return chat.eventHistory.map((entry) => JSON.parse(entry.data.split("data: ")[1]));
}

describe("A-10 observability correlation cross-layer flow", () => {
  it("correlates tool → evidence → task → presentation → SSE replay and diagnostics", async () => {
    const f = flow();
    f.chat.traceId = "trace-success";
    f.chat.correlation = { traceId: "trace-success", turnId: "turn-success", sessionId: f.sessionId };
    const tool = {
      name: "probe_read",
      description: "probe",
      parameters: { type: "object", properties: {} },
      resultFormat: "structured",
      async execute() { return structuredToolResult("事实已读取", { value: "ok" }); },
    };
    const trace = [];
    const definition = agentToolToPIToolDefinition(tool, "E:\\workspace", (event) => trace.push(event), {
      toolOutcomeObserver: f.observer,
      toolOutcomeSource: "live",
      getCorrelationContext: () => f.chat.correlation,
    });
    await definition.execute("call-success", {});
    assert.equal(f.evidence.getSuccessfulFacts(["call-success"]).length, 1);
    assert.equal(trace.at(-1).toolCallId, "call-success");

    f.engine.emit(base(f, "turn-success", 1, "turn.started"));
    f.engine.emit(base(f, "turn-success", 2, "tool.started", { toolCallId: "call-success", name: "probe_read", input: {} }));
    f.engine.emit(base(f, "turn-success", 3, "tool.completed", { toolCallId: "call-success", name: "probe_read", output: "事实已读取" }));
    f.engine.emit(base(f, "turn-success", 4, "content.delta", { text: "最终正文" }));
    f.engine.emit(base(f, "turn-success", 5, "turn.completed"));

    const done = payloads(f.chat).find((event) => event.type === "done");
    assert.equal(done.correlation.traceId, "trace-success");
    assert.equal(done.task.traceId, "trace-success");
    assert.equal(done.evidence[0].toolCallId, "call-success");
    assert.ok(f.correlation.entries().some((record) => record.stage === "tool.outcome" && record.evidenceId));
    assert.ok(f.correlation.entries().some((record) => record.stage === "task.transition" && record.status === "completed"));
    assert.ok(f.correlation.entries().some((record) => record.stage === "presentation.emitted" && record.eventType === "done"));
    const persisted = readFileSync(f.runtime.session.sessionFile, "utf8");
    assert.match(persisted, /"type":"task_lifecycle"/);
    assert.match(persisted, /trace-success/);
    assert.ok(f.correlation.entries().some((record) => record.stage === "session.persisted" && record.details?.persisted === true));

    const replay = [];
    replayChatEvents(f.chat, { write(frame) { replay.push(frame); } }, 0);
    assert.equal(replay.length > 0, true);
    assert.equal(f.correlation.entries().some((record) => record.stage === "sse.replay" && record.replay), true);

    const diagnostics = diagnosticsSnapshot(f.ctx.groups.infra.observability, "request-1", "E:\\workspace", "instance-1");
    assert.equal(diagnostics.correlation.traces, 1);
    assert.equal(JSON.stringify(diagnostics).includes("事实已读取"), false);
    assert.equal(JSON.stringify(diagnostics).includes("secret-value"), false);
    let body = "";
    const response = {
      writeHead() {},
      end(value) { body = String(value || ""); },
    };
    await handleDiagnostics({ url: "/api/diagnostics", method: "GET", headers: {}, requestContext: { requestId: "request-1" } }, response, {
      groups: {
        ...f.ctx.groups,
        core: { ...f.ctx.groups.core, runtime: { currentWorkspace: "E:\\workspace" } },
        storage: { ...f.ctx.groups.storage, paths: { ...f.ctx.groups.storage.paths, STARTUP: { instanceId: "instance-1" } } },
      },
    });
    const routeDiagnostics = JSON.parse(body);
    assert.equal(routeDiagnostics.correlation.traces, 1);
  });

  it("keeps failure, retry, cancellation and duplicate evidence linked without leaking payloads", () => {
    const f = flow();
    f.chat.traceId = "trace-failure";
    f.chat.correlation = { traceId: "trace-failure", turnId: "turn-failure", sessionId: f.sessionId };
    f.observer({ source: "live", toolName: "probe_read", toolCallId: "call-failed", outcome: "failed", failureKind: "permission_denied", requestScope: { target: "E:\\secret", argsFingerprint: "hash" }, payloadSummary: "Bearer secret-value", complete: false, correlation: f.chat.correlation });
    f.observer({ source: "live", toolName: "probe_read", toolCallId: "call-duplicate", outcome: "success", requestScope: { target: "E:\\safe", argsFingerprint: "same" }, payloadSummary: "ok", complete: true, correlation: f.chat.correlation });
    f.observer({ source: "live", toolName: "probe_read", toolCallId: "call-duplicate-2", outcome: "success", requestScope: { target: "E:\\safe", argsFingerprint: "same" }, payloadSummary: "ok", complete: true, correlation: f.chat.correlation });

    f.engine.emit(base(f, "turn-failure", 1, "turn.started"));
    f.engine.emit(base(f, "turn-failure", 2, "tool.started", { toolCallId: "call-failed", name: "probe_read", input: { target: "secret" } }));
    f.engine.emit(base(f, "turn-failure", 3, "tool.failed", { toolCallId: "call-failed", name: "probe_read", error: { category: "permission", kind: "permission_denied", code: "denied", message: "拒绝", retryable: false } }));
    f.engine.emit(base(f, "turn-failure", 4, "turn.cancelled", { reason: "用户取消" }));
    const records = f.correlation.entries();
    assert.ok(records.some((record) => record.failureKind === "permission_denied"));
    assert.ok(records.some((record) => record.stage === "task.transition" && record.status === "blocked"), "hard tool failure remains blocked when provider cancellation arrives");
    assert.ok(f.evidence.entries().some((entry) => entry.duplicateOf));
    const diagnostics = diagnosticsSnapshot(f.ctx.groups.infra.observability, undefined, undefined, undefined);
    assert.equal(JSON.stringify(diagnostics).includes("secret-value"), false);
    assert.equal(JSON.stringify(diagnostics).includes("E:\\secret"), false);

    const retry = flow();
    retry.chat.traceId = "trace-retry";
    retry.chat.correlation = { traceId: "trace-retry", turnId: "turn-retry", sessionId: retry.sessionId };
    retry.engine.emit(base(retry, "turn-retry", 1, "turn.started"));
    retry.engine.emit(base(retry, "turn-retry", 2, "tool.started", { toolCallId: "call-retry", name: "probe_read", input: { target: "unstable" } }));
    retry.engine.emit(base(retry, "turn-retry", 3, "tool.failed", { toolCallId: "call-retry", name: "probe_read", error: { category: "network", kind: "transport_error", code: "offline", message: "网络中断", retryable: true } }));
    retry.engine.emit(base(retry, "turn-retry", 4, "tool.started", { toolCallId: "call-retry-2", name: "probe_read", input: { target: "unstable" } }));
    retry.engine.emit(base(retry, "turn-retry", 5, "tool.failed", { toolCallId: "call-retry-2", name: "probe_read", error: { category: "network", kind: "transport_error", code: "offline", message: "网络中断", retryable: true } }));
    retry.engine.emit(base(retry, "turn-retry", 6, "turn.failed", { error: { category: "network", code: "offline", message: "网络中断", retryable: false } }));
    assert.ok(retry.correlation.entries().some((record) => record.stage === "task.transition" && record.details?.status === "failed"));
    assert.ok(retry.correlation.entries().some((record) => record.failureKind === "transport_error"));
  });
});
