import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { afterEach, describe, it } from "node:test";

import { commandTool } from "../src/agent/tools/command.ts";
import { fileReadTool } from "../src/agent/tools/file-read.ts";
import { ToolRegistry } from "../src/agent/types.ts";
import { buildToolContextExtra } from "../src/agent/runtime.ts";
import { mapPiEvent } from "../src/agent-engine/event-normalizer.ts";
import { attachEngineEvents } from "../src/server/agent-event-router.ts";
import { AGENT_FAULT_MATRIX_SCRIPT } from "./fixtures/agent-fault-matrix-script.mjs";

const originalServerPort = process.env.SERVER_PORT;
const servers = new Set();

afterEach(async () => {
  if (originalServerPort === undefined) delete process.env.SERVER_PORT;
  else process.env.SERVER_PORT = originalServerPort;
  await Promise.all([...servers].map(async (server) => {
    if (!server.listening) return;
    server.close();
    await once(server, "close");
  }));
  servers.clear();
});

async function listen(handler) {
  const server = createServer(handler);
  servers.add(server);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  process.env.SERVER_PORT = String(server.address().port);
  return server;
}

function makeFlow(id) {
  let listener;
  const sessionId = `fault-script-${id}`;
  const turnId = `turn-${id}`;
  const engine = {
    session: { id: sessionId, workspace: process.cwd(), isStreaming: true, isCompacting: false },
    subscribe(next) { listener = next; return () => { listener = undefined; }; },
    emit(event) { listener?.(event); },
    getContextUsage() { return undefined; },
    getSessionStats() { return undefined; },
  };
  const chat = {
    textBuffer: "", thinkingBuffer: "", response: { write() {}, end() {} },
    turnId: "", traceSeq: 0, eventSeq: 0, eventHistory: [], blocks: [], blockSeq: 0,
    emittedTraces: new Set(), textSegments: [], thinkingBlockGenerations: {},
  };
  const traces = [];
  const runtime = { session: { sessionFile: undefined, sessionManager: { flushed: false, getSessionId: () => sessionId } } };
  attachEngineEvents(engine, runtime, chat);
  return { engine, chat, traces, sessionId, turnId };
}

function payloads(chat) {
  return chat.eventHistory.map((entry) => JSON.parse(entry.data.split("data: ")[1]));
}

function replayTraceEvents(flow) {
  let seq = 1;
  for (const trace of flow.traces) {
    const mapped = mapPiEvent(trace, {
      base: { version: 1, sessionId: flow.sessionId, turnId: flow.turnId, seq: ++seq, timestamp: seq },
    });
    for (const event of mapped.events) flow.engine.emit(event);
  }
}

function terminal(flow, outcome) {
  if (outcome === "success") {
    flow.engine.emit({ version: 1, type: "content.delta", sessionId: flow.sessionId, turnId: flow.turnId, seq: 90, timestamp: 90, text: "故障脚本已完成" });
    flow.engine.emit({ version: 1, type: "turn.completed", sessionId: flow.sessionId, turnId: flow.turnId, seq: 91, timestamp: 91 });
  } else if (outcome === "cancelled") {
    flow.engine.emit({ version: 1, type: "turn.cancelled", sessionId: flow.sessionId, turnId: flow.turnId, seq: 91, timestamp: 91, reason: "工具已取消" });
  } else {
    flow.engine.emit({ version: 1, type: "turn.failed", sessionId: flow.sessionId, turnId: flow.turnId, seq: 91, timestamp: 91, error: { category: "tool", code: outcome, message: outcome, retryable: false } });
  }
}

async function runFileReadScenario(scenario) {
  let server;
  if (scenario.transport === "http") {
    server = await listen((req, res) => {
      const status = Number(new URL(req.url, "http://127.0.0.1").searchParams.get("status") || scenario.status);
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: status === 403 ? "Access denied" : "ENOENT" }));
    });
  } else if (scenario.transport === "pending") {
    server = await listen(() => {});
  } else if (scenario.transport === "socket") {
    server = await listen((req) => req.socket.destroy());
    server.close();
    await once(server, "close");
  }

  const flow = makeFlow(scenario.id);
  const registry = new ToolRegistry();
  registry.register(fileReadTool);
  const [tool] = registry.toPITools(process.cwd(), (trace) => flow.traces.push(trace));
  flow.engine.emit({ version: 1, type: "turn.started", sessionId: flow.sessionId, turnId: flow.turnId, seq: 1, timestamp: 1 });
  let outcome = "failed";
  const controller = new AbortController();
  const request = tool.execute(`call-${scenario.id}`, { path: scenario.path }, scenario.transport === "pending" ? controller.signal : undefined);
  if (scenario.transport === "pending") setTimeout(() => controller.abort(), 20);
  try {
    await request;
    outcome = "success";
  } catch {
    outcome = scenario.category === "cancelled" ? "cancelled" : scenario.category;
  }
  const traceOutcome = flow.traces.at(-1)?.outcome;
  if (traceOutcome?.status === "failed") outcome = scenario.category === "cancelled" ? "cancelled" : scenario.category;
  replayTraceEvents(flow);
  const liveToolBlock = flow.chat.blocks.find((block) => block.type === "tool");
  terminal(flow, outcome);
  const events = payloads(flow.chat);
  const done = events.find((event) => event.type === "done");
  const cancelled = events.find((event) => event.type === "cancelled");
  const terminalEvent = done || cancelled;
  const toolBlock = terminalEvent?.blocks?.find((block) => block.type === "tool") || liveToolBlock;
  assert.ok(toolBlock, `${scenario.id}: tool block must be produced`);
  assert.equal(toolBlock.status, outcome === "success" ? "success" : "error", `${scenario.id}: block status must match outcome`);
  assert.equal(outcome === "cancelled" ? !!cancelled : !!done, true, `${scenario.id}: exactly one terminal presentation event expected`);
  if (done) assert.equal(done.task.status === "completed" || done.task.status === "blocked" || done.task.status === "failed", true);
  return { flow, outcome, toolBlock, done, cancelled };
}

describe("A-08 real-entry agent fault matrix", () => {
  it("runs HTTP, transport, cancellation and validation failures through tool → trace → normalizer → reducer → terminal presentation", async () => {
    for (const scenario of AGENT_FAULT_MATRIX_SCRIPT.filter((entry) => ["http", "socket", "pending"].includes(entry.transport))) {
      const result = await runFileReadScenario(scenario);
      assert.equal(result.outcome, scenario.category === "cancelled" ? "cancelled" : scenario.category);
      assert.equal(result.flow.traces.at(-1).outcome.status, "failed");
      assert.equal(result.flow.traces.at(-1).outcome.failure.kind, scenario.category);
    }
  });

  it("keeps invalid arguments fail-closed instead of creating success evidence", async () => {
    const scenario = AGENT_FAULT_MATRIX_SCRIPT.find((entry) => entry.id === "invalid-path");
    const flow = makeFlow(scenario.id);
    const registry = new ToolRegistry();
    registry.register(fileReadTool);
    const [tool] = registry.toPITools(process.cwd(), (trace) => flow.traces.push(trace));
    flow.engine.emit({ version: 1, type: "turn.started", sessionId: flow.sessionId, turnId: flow.turnId, seq: 1, timestamp: 1 });
    await tool.execute("call-invalid-path", { path: "" });
    replayTraceEvents(flow);
    const liveToolBlock = flow.chat.blocks.find((block) => block.type === "tool");
    terminal(flow, "validation_error");
    const done = payloads(flow.chat).find((event) => event.type === "done");
    assert.equal(flow.traces.at(-1).outcome.failure.kind, "validation_error");
    assert.equal(done?.blocks.find((block) => block.type === "tool")?.status || liveToolBlock?.status, "error");
    assert.equal(done?.task.status, "blocked");
    assert.equal(done?.evidence, undefined, "failed input must not become evidence");
  });

  it("runs real command permission approval and timeout through the same adapter boundary", async () => {
    for (const scenario of AGENT_FAULT_MATRIX_SCRIPT.filter((entry) => entry.transport === "command")) {
      const flow = makeFlow(scenario.id);
      const registry = new ToolRegistry();
      registry.register(commandTool);
      const [tool] = registry.toPITools(process.cwd(), (trace) => flow.traces.push(trace), {
        permissionMode: "standard",
        confirmCommand: async () => true,
      });
      flow.engine.emit({ version: 1, type: "turn.started", sessionId: flow.sessionId, turnId: flow.turnId, seq: 1, timestamp: 1 });
      try {
        await tool.execute(`call-${scenario.id}`, { command: scenario.command, timeout: scenario.id === "command-timeout" ? 30 : undefined });
      } catch {}
      replayTraceEvents(flow);
      const outcome = flow.traces.at(-1).outcome;
      assert.equal(outcome.status, scenario.id === "permission-approved" ? "success" : "failed");
      assert.equal(outcome.status === "failed" ? outcome.failure.kind : undefined, scenario.id === "command-timeout" ? "transport_error" : undefined);
      terminal(flow, outcome.status === "success" ? "success" : "transport_error");
      const done = payloads(flow.chat).find((event) => event.type === "done");
      assert.ok(done);
      assert.equal(done.blocks.find((block) => block.type === "tool")?.status, outcome.status === "success" ? "success" : "error");
    }
  });

  it("forwards one host capability object through runtime config, registry, and PI execution", async () => {
    const observer = () => {};
    const captured = {};
    const registry = new ToolRegistry();
    registry.register({
      name: "context_probe",
      description: "captures host context",
      parameters: { type: "object", properties: {} },
      resultFormat: "structured",
      execute: async (_args, ctx) => {
        captured.permissionMode = ctx.permissionMode;
        captured.shellDialect = ctx.shellDialect;
        captured.observer = ctx.toolOutcomeObserver;
        return { text: "ok", data: {}, outcome: { status: "success" } };
      },
    });
    const extra = buildToolContextExtra({
      agentDir: process.cwd(), cwd: process.cwd(), sessionsDir: process.cwd(), authFile: "auth", modelsFile: "models",
      permissionMode: "dontAsk", shellDialect: "posix-bash", toolOutcomeObserver: observer,
    });
    const [tool] = registry.toPITools(process.cwd(), undefined, extra);
    const result = await tool.execute("context-probe", {});
    assert.equal(result.content[0].text, "ok");
    assert.equal(captured.permissionMode, "dontAsk");
    assert.equal(captured.shellDialect, "posix-bash");
    assert.equal(captured.observer, observer);
  });
});
