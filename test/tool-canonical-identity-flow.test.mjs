import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";

import {
  ToolRegistry,
  agentToolToPIToolDefinition,
  structuredToolResult,
} from "../src/agent/types.ts";
import { EvidenceLedger } from "../src/server/evidence-ledger.ts";
import { RetryPolicy } from "../src/server/retry-policy.ts";
import { attachEngineEvents } from "../src/server/agent-event-router.ts";
import { parseSessionMessages } from "../src/server/routes/session-message-parser.ts";

function event(type, seq, extra = {}) {
  return { version: 1, type, sessionId: "s-a05", turnId: "t-a05", seq, timestamp: seq, ...extra };
}

function stream() {
  return {
    textBuffer: "", thinkingBuffer: "", currentTextSnapshot: "", currentThinkingSnapshot: "",
    response: null, turnId: "", traceSeq: 0, emittedTraces: new Set(), blocks: [], blockSeq: 0,
    eventSeq: 0, eventHistory: [], taskRequirements: { kind: "general", requiresEvidence: false, minSuccessfulEvidence: 0 },
  };
}

describe("A-05 canonical tool identity cross-layer flow", () => {
  it("resolves aliases once, exposes only canonical PI tools, and shares evidence/retry identity", async () => {
    const registry = new ToolRegistry();
    let executions = 0;
    registry.register({
      name: "fixture_read",
      aliases: ["legacy-read"],
      description: "fixture",
      parameters: { type: "object", properties: { target: { type: "string" } } },
      isReadOnly: true,
      resultFormat: "structured",
      execute: async (args) => {
        executions++;
        return structuredToolResult(`contents:${args.target}`, { target: args.target });
      },
    });

    assert.equal(registry.get("legacy-read"), registry.get("fixture_read"));
    assert.equal(registry.getCanonicalName("legacy-read"), "fixture_read");
    assert.deepEqual(registry.getAll().map((tool) => tool.name), ["fixture_read"]);
    assert.deepEqual([...registry.getAliases().entries()], [["legacy-read", "fixture_read"]]);

    const ledger = new EvidenceLedger();
    const definition = agentToolToPIToolDefinition(registry.get("legacy-read"), "C:/workspace", undefined, {
      toolOutcomeObserver: (observation) => ledger.observe(observation),
      toolOutcomeSource: "test",
      evidenceLookup: (toolName, scope) => ledger.lookup(toolName, scope),
    });
    await definition.execute("call-1", { target: "fixture.txt" });
    await definition.execute("call-2", { target: "fixture.txt" });

    assert.equal(executions, 1, "alias and canonical calls must share the evidence read-through cache");
    assert.deepEqual(ledger.entries().map((entry) => entry.canonicalTool), ["fixture_read", "fixture_read"]);
    assert.equal(ledger.entries()[1].duplicateOf, ledger.entries()[0].evidenceId);

    const retry = new RetryPolicy({ transportAttempts: 2 });
    const error = { category: "network", kind: "transport_error", code: "fetch_failed", message: "failed", retryable: true };
    assert.equal(retry.decide(registry.getCanonicalName("legacy-read"), "same-request", error).action, "retry");
    assert.equal(retry.decide(registry.getCanonicalName("fixture_read"), "same-request", error).action, "block");
  });

  it("keeps canonical identity through runtime events, presentation blocks, and terminal evidence", () => {
    const engine = new EventEmitter();
    engine.session = { id: "s-a05" };
    engine.subscribe = (listener) => { engine.on("event", listener); return () => engine.off("event", listener); };
    const chat = stream();
    const ledger = new EvidenceLedger();
    ledger.observe({ source: "live", toolName: "file_read", toolCallId: "call-file", outcome: "success", legacy: false,
      requestScope: { target: "fixture.txt" }, payloadSummary: "contents", complete: true });
    const observability = { evidenceLedger: ledger };
    attachEngineEvents(engine, { session: { sessionFile: undefined, sessionManager: { flushed: false } } }, chat, {
      groups: {
        core: { engine, runtime: { session: engine.session }, chatStream: chat, appEvents: { publish() {} } },
        security: {},
        storage: { paths: { SESSIONS_DIR: "C:/workspace" } },
        providers: { model: { modelRuntime: {}, modelRegistry: {}, syncModelProviders: async () => 0, runWithStableSession: async (operation) => operation() } },
        infra: { observability },
      },
    });

    engine.emit("event", event("turn.started", 1));
    engine.emit("event", event("tool.started", 2, { toolCallId: "call-file", name: "file-read", input: { target: "fixture.txt" } }));
    engine.emit("event", event("tool.completed", 3, { toolCallId: "call-file", name: "file-read", output: "contents" }));
    engine.emit("event", event("content.delta", 4, { text: "已读取" }));
    engine.emit("event", event("turn.completed", 5));

    const toolBlocks = chat.eventHistory
      .map((entry) => JSON.parse(entry.data.split("data: ")[1]))
      .filter((payload) => payload.type === "block" && payload.block?.type === "tool");
    assert.ok(toolBlocks.length >= 2);
    assert.equal(toolBlocks.at(-1).block.name, "file_read");
    const done = chat.eventHistory
      .map((entry) => JSON.parse(entry.data.split("data: ")[1]))
      .find((payload) => payload.type === "done");
    assert.equal(done.evidence[0].canonicalTool, "file_read");
    assert.equal(done.blocks.find((block) => block.type === "tool").name, "file_read");
  });

  it("normalizes observed legacy names during old-session replay without changing unrelated names", () => {
    const content = [
      JSON.stringify({ type: "trace", event: { type: "tool", status: "running", name: "file-read", id: "call-1", turnId: "t-a05" } }),
      JSON.stringify({ type: "trace", event: { type: "tool", status: "success", name: "file-read", id: "call-1", output: "ok", turnId: "t-a05" } }),
      JSON.stringify({ type: "message", id: "t-a05", message: { role: "assistant", content: [{ type: "text", text: "done" }] } }),
    ].join("\n");
    const assistant = parseSessionMessages(content).find((message) => message.role === "assistant");
    assert.equal(assistant.blocks.find((block) => block.type === "tool").name, "file_read");
  });

  it("rejects aliases that collide with an existing canonical tool", () => {
    const registry = new ToolRegistry();
    const base = (name, aliases = []) => ({
      name, aliases, description: name, parameters: { type: "object", properties: {} }, isReadOnly: true,
      execute: async () => "ok",
    });
    registry.register(base("one", ["old-one"]));
    assert.throws(() => registry.register(base("two", ["old-one"])), /alias conflicts/);
    assert.throws(() => registry.register(base("old-one")), /identity conflicts/);
  });
});
