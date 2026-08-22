import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { agentToolToPIToolDefinition, structuredToolError, structuredToolResult } from "../src/agent/types.ts";
import { EvidenceLedger } from "../src/server/evidence-ledger.ts";
import { attachEngineEvents } from "../src/server/agent-event-router.ts";

function event(type, turnId = "turn-1", seq = 1, extra = {}) {
  return { version: 1, type, sessionId: "session-1", turnId, seq, timestamp: seq, ...extra };
}

function stream() {
  return {
    textBuffer: "", thinkingBuffer: "", currentTextSnapshot: "", currentThinkingSnapshot: "",
    response: null, turnId: "", traceSeq: 0, emittedTraces: new Set(), blocks: [], blockSeq: 0,
    eventSeq: 0, eventHistory: [],
  };
}

describe("runtime evidence ledger cross-layer flow", () => {
  it("records adapter outcomes, persists/reloads them, and final answer references only successful evidence", async () => {
    const root = await mkdtemp(join(tmpdir(), "mca-evidence-flow-"));
    const ledgerFile = join(root, "evidence-ledger.jsonl");
    const sessionFile = join(root, "session.jsonl");
    await writeFile(sessionFile, JSON.stringify({ type: "session", id: "session-1" }) + "\n", "utf8");

    const ledger = new EvidenceLedger({ filePath: ledgerFile, clock: () => 1700000000000 });
    let executions = 0;
    const tool = {
      name: "read",
      description: "read fixture",
      parameters: {},
      resultFormat: "structured",
      execute: async (args) => { executions += 1; return args.target === "missing"
        ? structuredToolError("missing", { kind: "not_found", code: "file_not_found" })
        : structuredToolResult("actual contents", { target: args.target }); },
    };
    const definition = agentToolToPIToolDefinition(tool, root, undefined, {
      toolOutcomeObserver: (observation) => ledger.observe(observation),
      toolOutcomeSource: "live",
      evidenceLookup: (toolName, scope) => ledger.lookup(toolName, scope),
    });

    await definition.execute("call-failed", { target: "missing" });
    await definition.execute("call-success", { target: "present" });
    await definition.execute("call-duplicate", { target: "present" });

    const entries = ledger.entries();
    assert.equal(entries.length, 3);
    assert.equal(entries[0].status, "failed");
    assert.equal(entries[0].failureKind, "not_found");
    assert.equal(entries[1].status, "success");
    assert.equal(entries[1].complete, true);
    assert.equal(entries[2].duplicateOf, entries[1].evidenceId);
    assert.equal(executions, 2, "未变化的成功证据必须走 read-through cache，不应再次执行工具");
    assert.match(entries[1].payloadHash, /^[a-f0-9]{64}$/);
    assert.equal(new EvidenceLedger({ filePath: ledgerFile }).entries().length, 3, "刷新后必须恢复 ledger");

    const engine = new EventEmitter();
    engine.session = { id: "session-1" };
    engine.subscribe = (listener) => { engine.on("event", listener); return () => engine.off("event", listener); };
    const chat = stream();
    const runtime = { session: { sessionFile, sessionManager: { flushed: true } } };
    attachEngineEvents(engine, runtime, chat, {
      groups: {
        core: { engine, runtime, chatStream: chat, appEvents: { publish() {} } },
        security: {}, storage: { paths: { SESSIONS_DIR: root } },
        providers: { model: { modelRuntime: {}, modelRegistry: {}, syncModelProviders: async () => 0, runWithStableSession: async (operation) => operation() } },
        infra: { observability: { evidenceLedger: ledger } },
      },
    });
    engine.emit("event", event("turn.started", "turn-1", 1));
    engine.emit("event", event("tool.started", "turn-1", 2, { toolCallId: "call-success", name: "read", input: { target: "present" } }));
    engine.emit("event", event("tool.completed", "turn-1", 3, { toolCallId: "call-success", name: "read", output: "actual contents" }));
    engine.emit("event", event("content.delta", "turn-1", 4, { text: "事实已读取", phase: "delta" }));
    engine.emit("event", event("turn.completed", "turn-1", 5));

    const payloads = chat.eventHistory.map((entry) => JSON.parse(entry.data.split("data: ")[1]));
    const done = payloads.find((payload) => payload.type === "done");
    assert.ok(done, "跨层事件桥必须生成 done");
    assert.deepEqual(done.evidence.map((item) => item.evidenceId), [entries[1].evidenceId]);
    assert.equal(done.evidence.some((item) => item.evidenceId === entries[0].evidenceId), false, "失败记录不能进入最终成功证据");
    assert.equal(done.evidence.some((item) => item.evidenceId === entries[2].evidenceId), false, "未引用的重复读取不能伪造额外事实");
    const persisted = (await readFile(ledgerFile, "utf8")).trim().split(/\r?\n/).map((line) => JSON.parse(line));
    assert.equal(persisted.every((entry) => entry.complete === (entry.status === "success")), true);
  });

  it("keeps the complete failure matrix out of successful facts", async () => {
    const ledger = new EvidenceLedger({ clock: () => 1700000000000 });
    const kinds = ["not_found", "permission_denied", "transport_error", "validation_error", "cancelled", "execution_error"];
    const tool = {
      name: "fixture",
      description: "failure fixture",
      parameters: {},
      resultFormat: "structured",
      execute: async (args) => structuredToolError(String(args.kind), { kind: args.kind, code: `fixture_${args.kind}` }),
    };
    const definition = agentToolToPIToolDefinition(tool, "C:/workspace", undefined, {
      toolOutcomeObserver: (observation) => ledger.observe(observation),
      toolOutcomeSource: "test",
    });
    for (const [index, kind] of kinds.entries()) await definition.execute(`failure-${index}`, { kind });
    const entries = ledger.entries();
    assert.deepEqual(entries.map((entry) => entry.failureKind), kinds);
    assert.equal(ledger.getSuccessfulFacts().length, 0);
    assert.equal(entries.every((entry) => entry.status === "failed" && entry.complete === false), true);
  });
});
