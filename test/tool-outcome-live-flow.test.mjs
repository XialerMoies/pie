import { once } from "node:events";
import { createServer } from "node:http";
import assert from "node:assert/strict";
import { describe, it, afterEach } from "node:test";

import { fileReadTool } from "../src/agent/tools/file-read.ts";
import { ToolRegistry } from "../src/agent/types.ts";
import { mapPiEvent } from "../src/agent-engine/event-normalizer.ts";
import { attachEngineEvents } from "../src/server/agent-event-router.ts";

const originalServerPort = process.env.SERVER_PORT;
const servers = new Set();

afterEach(async () => {
  if (originalServerPort === undefined) delete process.env.SERVER_PORT;
  else process.env.SERVER_PORT = originalServerPort;
  await Promise.all([...servers].map((server) => closeServer(server)));
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

async function closeServer(server) {
  if (!server || !server.listening) return;
  server.close();
  await once(server, "close");
}

function flow() {
  let listener;
  const sessionId = "session-live-outcome";
  const turnId = "turn-live-outcome";
  const engine = {
    session: { id: sessionId, workspace: process.cwd(), isStreaming: true, isCompacting: false },
    subscribe(next) {
      listener = next;
      return () => { listener = undefined; };
    },
    emit(event) { listener?.(event); },
    getContextUsage() { return undefined; },
    getSessionStats() { return undefined; },
  };
  const chat = {
    textBuffer: "",
    thinkingBuffer: "",
    response: { write() { return true; }, end() {} },
    turnId,
    traceSeq: 0,
    eventSeq: 0,
    eventHistory: [],
    blocks: [],
    emittedTraces: new Set(),
    blockSeq: 0,
  };
  const runtime = {
    session: {
      sessionFile: undefined,
      sessionManager: { flushed: false, getSessionId: () => sessionId },
    },
  };
  const traces = [];
  const registry = new ToolRegistry();
  registry.register(fileReadTool);
  const [tool] = registry.toPITools(process.cwd(), (event) => traces.push(event));
  attachEngineEvents(engine, runtime, chat);
  engine.emit({ version: 1, type: "turn.started", sessionId, turnId, seq: 1, timestamp: 1 });
  engine.emit({
    version: 1,
    type: "tool.started",
    sessionId,
    turnId,
    seq: 2,
    timestamp: 2,
    toolCallId: "call-live-outcome",
    name: "file_read",
    input: { path: "fixture.txt" },
  });
  return { engine, chat, tool, traces, sessionId, turnId };
}

function applyLatestTrace(testFlow) {
  const mapped = mapPiEvent(testFlow.traces.at(-1), {
    base: {
      version: 1,
      sessionId: testFlow.sessionId,
      turnId: testFlow.turnId,
      seq: 3,
      timestamp: 3,
    },
  });
  assert.equal(mapped.events.length, 1);
  testFlow.engine.emit(mapped.events[0]);
  return mapped.events[0];
}

describe("live tool outcome flow", () => {
  it("maps a real HTTP 404 through tool execution, trace, normalizer, and server block", async () => {
    await listen((_req, res) => {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "ENOENT" }));
    });
    const testFlow = flow();
    const result = await testFlow.tool.execute("call-live-outcome", { path: "missing.txt" });

    assert.equal(testFlow.traces.at(-1).outcome.status, "failed");
    assert.equal(testFlow.traces.at(-1).outcome.failure.kind, "not_found");
    assert.equal(result.details.data, null);
    assert.equal(applyLatestTrace(testFlow).type, "tool.failed");
    assert.equal(testFlow.chat.blocks.find((block) => block.type === "tool").status, "error");
  });

  it("maps a real HTTP 403 through tool execution, trace, normalizer, and server block", async () => {
    await listen((_req, res) => {
      res.writeHead(403, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "Access denied" }));
    });
    const testFlow = flow();
    await testFlow.tool.execute("call-live-outcome", { path: "forbidden.txt" });

    assert.equal(testFlow.traces.at(-1).outcome.failure.kind, "permission_denied");
    assert.equal(applyLatestTrace(testFlow).type, "tool.failed");
    assert.equal(testFlow.chat.blocks.find((block) => block.type === "tool").status, "error");
  });

  it("classifies a real transport failure as transport_error instead of execution_error", async () => {
    const server = await listen((req) => req.socket.destroy());
    await closeServer(server);
    const testFlow = flow();

    await assert.rejects(
      () => testFlow.tool.execute("call-live-outcome", { path: "transport.txt" }),
      /fetch failed|socket|network/i,
    );
    assert.equal(testFlow.traces.at(-1).outcome.failure.kind, "transport_error");
    assert.equal(applyLatestTrace(testFlow).type, "tool.failed");
  });

  it("classifies an AbortSignal cancellation from a real pending request as cancelled", async () => {
    const server = await listen(() => {});
    const testFlow = flow();
    const controller = new AbortController();
    const pending = testFlow.tool.execute("call-live-outcome", { path: "pending.txt" }, controller.signal);
    setTimeout(() => controller.abort(), 20);

    await assert.rejects(() => pending, /aborted|abort|cancel/i);
    assert.equal(testFlow.traces.at(-1).outcome.failure.kind, "cancelled");
    assert.equal(applyLatestTrace(testFlow).type, "tool.failed");
    await closeServer(server);
  });
});
