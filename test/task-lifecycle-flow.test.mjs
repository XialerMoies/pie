import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { attachEngineEvents } from "../src/server/agent-event-router.ts";
import { EvidenceLedger } from "../src/server/evidence-ledger.ts";
import { TaskLifecycle, inferTaskRequirements } from "../src/server/task-lifecycle.ts";
import { createMockModelContext } from "./helpers/context.mjs";

function base(type, seq, extra = {}) {
  return { version: 1, type, sessionId: "session-a04", turnId: "turn-a04", seq, timestamp: seq, ...extra };
}

function chat(requirements) {
  return {
    textBuffer: "", thinkingBuffer: "", currentTextSnapshot: "", currentThinkingSnapshot: "", response: null,
    turnId: "", traceSeq: 0, emittedTraces: new Set(), blocks: [], blockSeq: 0, eventSeq: 0, eventHistory: [],
    taskRequirements: requirements,
  };
}

function wire(requirements, ledger = new EvidenceLedger(), sessionFile) {
  const engine = new EventEmitter();
  engine.session = { id: "session-a04" };
  engine.subscribe = (listener) => { engine.on("event", listener); return () => engine.off("event", listener); };
  const stream = chat(requirements);
  const runtime = { session: { sessionFile, sessionManager: { flushed: Boolean(sessionFile) } } };
  attachEngineEvents(engine, runtime, stream, {
    groups: {
      core: { engine, runtime, chatStream: stream, appEvents: { publish() {} } },
      security: {},
      storage: { paths: { SESSIONS_DIR: tmpdir() } },
      providers: { model: createMockModelContext() },
      infra: { observability: { evidenceLedger: ledger } },
    },
  });
  return { engine, stream, ledger };
}

describe("A-04 task lifecycle cross-layer flow", () => {
  it("moves discovering → verifying → answering and completes only with ledger evidence", () => {
    const requirements = inferTaskRequirements("请检查并验证 docs/任务清单.md 的状态，只报告实际读取到的事实");
    assert.equal(requirements.kind, "verification");
    assert.equal(requirements.requiresEvidence, true);
    assert.equal(requirements.minSuccessfulEvidence, 1);
    assert.equal(requirements.verificationPolicy?.mode, "hard");
    const flow = wire(requirements);
    flow.ledger.observe({ source: "live", toolName: "read", toolCallId: "call-1", outcome: "success",
      requestScope: { target: "fixture.txt" }, payloadSummary: "verified", complete: true });
    flow.engine.emit("event", base("turn.started", 1));
    flow.engine.emit("event", base("tool.started", 2, { toolCallId: "call-1", name: "read", input: { target: "fixture.txt" } }));
    flow.engine.emit("event", base("tool.completed", 3, { toolCallId: "call-1", name: "read", output: "verified", metadata: { evidenceFields: ["content"] } }));
    flow.engine.emit("event", base("content.delta", 4, { text: "文件状态正常" }));
    flow.engine.emit("event", base("turn.completed", 5));

    const payloads = flow.stream.eventHistory.map((entry) => JSON.parse(entry.data.split("data: ")[1]));
    const done = payloads.find((payload) => payload.type === "done");
    assert.equal(done.status, "done");
    assert.equal(done.task.phase, "answering");
    assert.equal(done.task.status, "completed");
    assert.equal(done.task.successfulEvidence, 1);
    assert.equal(done.task.metrics.toolCalls, 1);
    assert.equal(done.task.metrics.evidenceSatisfied, true);
    assert.equal(done.task.metrics.finalStatus, "completed");
    assert.equal(done.evidence.length, 1);
  });

  it("blocks a verification task with insufficient evidence and marks the answer unverified", () => {
    const flow = wire({ kind: "verification", requiresEvidence: true, minSuccessfulEvidence: 1 });
    flow.engine.emit("event", base("turn.started", 1));
    flow.engine.emit("event", base("content.delta", 2, { text: "看起来正常" }));
    flow.engine.emit("event", base("turn.completed", 3));
    const done = flow.stream.eventHistory.map((entry) => JSON.parse(entry.data.split("data: ")[1])).find((payload) => payload.type === "done");
    assert.equal(done.status, "error");
    assert.equal(done.task.status, "blocked");
    assert.equal(done.task.reason, "evidence_insufficient");
    assert.match(done.text, /^未验证：/);
    assert.equal("evidence" in done, false);
  });

  it("completes a contract only when every required evidence field is observed", () => {
    const requirements = inferTaskRequirements("请按 checkpoint-a-verification 检查 agent/skills/skill-verification/SKILL.md 的状态和内容");
    const ledger = new EvidenceLedger();
    const flow = wire(requirements, ledger);
    ledger.observe({ source: "live", toolName: "skill_facts", toolCallId: "facts-1", outcome: "success",
      requestScope: { target: "agent/skills/skill-verification/SKILL.md" }, payloadSummary: "facts", complete: true,
      evidenceFields: ["trust", "enabled", "parse"] });
    ledger.observe({ source: "live", toolName: "file_read", toolCallId: "read-1", outcome: "success",
      requestScope: { target: "agent/skills/skill-verification/SKILL.md" }, payloadSummary: "content", complete: true,
      evidenceFields: ["content"] });
    flow.engine.emit("event", base("turn.started", 1));
    flow.engine.emit("event", base("tool.started", 2, { toolCallId: "facts-1", name: "skill_facts", input: { id: "skill-verification" } }));
    flow.engine.emit("event", base("tool.completed", 3, { toolCallId: "facts-1", name: "skill_facts", output: "facts", metadata: { evidenceFields: ["trust", "enabled", "parse"] } }));
    flow.engine.emit("event", base("tool.started", 4, { toolCallId: "read-1", name: "file_read", input: { path: "agent/skills/skill-verification/SKILL.md" } }));
    flow.engine.emit("event", base("tool.completed", 5, { toolCallId: "read-1", name: "file_read", output: "content", metadata: { evidenceFields: ["content"] } }));
    flow.engine.emit("event", base("content.delta", 6, { text: "已核验" }));
    flow.engine.emit("event", base("turn.completed", 7));
    const done = flow.stream.eventHistory.map((entry) => JSON.parse(entry.data.split("data: ")[1])).find((payload) => payload.type === "done");
    assert.equal(done.status, "done");
    assert.equal(done.task.status, "completed");
    assert.deepEqual(done.task.satisfiedEvidence, ["content", "trust", "enabled", "parse"]);
    assert.deepEqual(done.task.missingEvidence, []);
    assert.equal(done.task.metrics.toolCalls, 2);
    assert.equal(done.task.metrics.unrelatedAttempts, 0);
    assert.equal(done.task.metrics.blockedAttempts, 0);
    assert.equal(done.task.metrics.evidenceSatisfied, true);
    assert.equal(done.task.metrics.finalStatus, "completed");
    assert.equal(done.task.metrics.userExpansion, false);
    assert.ok(done.task.metrics.durationMs >= 0);
  });

  it("creates a scoped memory contract and reports an empty scope as unverified", () => {
    const requirements = inferTaskRequirements("请按 checkpoint-a-verification 检查用户级记忆中的一个条目，说明作用域、启用状态和证据来源");
    assert.equal(requirements.contract?.kind, "fact_verification");
    assert.deepEqual(requirements.contract?.targets, ["memory:user"]);
    assert.deepEqual(requirements.contract?.allowedTools, ["list_memory", "read_memory"]);

    const ledger = new EvidenceLedger();
    const flow = wire(requirements, ledger);
    ledger.observe({ source: "live", toolName: "list_memory", toolCallId: "memory-list-1", outcome: "success",
      requestScope: { target: "memory:user" }, payloadSummary: "暂无记忆。", complete: true, evidenceFields: ["scope"] });
    flow.engine.emit("event", base("turn.started", 1));
    flow.engine.emit("event", base("tool.started", 2, { toolCallId: "memory-list-1", name: "list_memory", input: { scope: "user" } }));
    flow.engine.emit("event", base("tool.completed", 3, { toolCallId: "memory-list-1", name: "list_memory", output: "暂无记忆。", metadata: { evidenceFields: ["scope"] } }));
    flow.engine.emit("event", base("content.delta", 4, { text: "当前没有用户级记忆条目，无法核验具体条目。" }));
    flow.engine.emit("event", base("turn.completed", 5));

    const done = flow.stream.eventHistory.map((entry) => JSON.parse(entry.data.split("data: ")[1])).find((payload) => payload.type === "done");
    assert.equal(done.status, "done");
    assert.equal(done.task.status, "blocked");
    assert.equal(done.task.reason, "evidence_unverified");
    assert.match(done.text, /^未验证：缺少证据字段：/);
    assert.equal("error" in done, false);
  });

  it("completes combined A+B+C verification with independent evidence namespaces and ordered memory reads", () => {
    const message = [
      "任务 A：请按 checkpoint-a-verification 检查 agent/skills/skill-verification/SKILL.md 的状态和内容，只报告实际读取到的事实。",
      "任务 B：请按 checkpoint-a-verification 检查用户级记忆中的一个条目，说明作用域、启用状态和证据来源。",
      "任务 C：请按 checkpoint-a-verification 检查当前工作区的一个记忆条目，说明作用域、启用状态和证据来源。",
    ].join("\\n");
    const requirements = inferTaskRequirements(message);
    assert.equal(requirements.contract?.kind, "fact_verification_batch");
    const ledger = new EvidenceLedger();
    const flow = wire(requirements, ledger);
    const evidence = [
      ["a-read", "file_read", "agent/skills/skill-verification/SKILL.md", ["content"], { path: "agent/skills/skill-verification/SKILL.md" }],
      ["a-facts", "skill_facts", "agent/skills/skill-verification/SKILL.md", ["trust", "enabled", "parse"], { id: "skill-verification" }],
      ["b-list", "list_memory", "memory:user", ["scope", "entry", "enabled", "source"], { scope: "user" }],
      ["b-read", "read_memory", "memory:user/checkpoint-user-preference", ["scope", "entry", "enabled", "source", "content"], { name: "checkpoint-user-preference", scope: "user" }],
      ["c-list", "list_memory", "memory:workspace", ["scope", "entry", "enabled", "source"], { scope: "workspace" }],
      ["c-read", "read_memory", "memory:workspace/checkpoint-workspace-rule", ["scope", "entry", "enabled", "source", "content"], { name: "checkpoint-workspace-rule", scope: "workspace" }],
    ];
    flow.engine.emit("event", base("turn.started", 1));
    let seq = 2;
    for (const [id, name, target, fields, input] of evidence) {
      ledger.observe({ source: "live", toolName: name, toolCallId: id, outcome: "success", requestScope: { target }, payloadSummary: "evidence", complete: true, evidenceFields: fields });
      flow.engine.emit("event", base("tool.started", seq++, { toolCallId: id, name, input }));
      flow.engine.emit("event", base("tool.completed", seq++, { toolCallId: id, name, output: "evidence", metadata: { evidenceFields: fields } }));
    }
    flow.engine.emit("event", base("content.delta", seq++, { text: "A、B、C 均已核验。" }));
    flow.engine.emit("event", base("turn.completed", seq));

    const done = flow.stream.eventHistory.map((entry) => JSON.parse(entry.data.split("data: ")[1])).find((payload) => payload.type === "done");
    assert.equal(done.status, "done");
    assert.equal(done.task.status, "completed");
    assert.deepEqual(done.task.missingEvidence, []);
    assert.equal(done.task.metrics.toolCalls, 6);
    assert.equal(done.task.metrics.evidenceSatisfied, true);
    assert.equal(done.task.metrics.blockedAttempts, 0);
  });

  it("persists the terminal task contract for refresh/replay inspection", async () => {
    const root = await mkdtemp(join(tmpdir(), "mca-a04-task-"));
    const sessionFile = join(root, "session.jsonl");
    await writeFile(sessionFile, JSON.stringify({ type: "session", id: "session-a04" }) + "\n", "utf8");
    const flow = wire({ kind: "verification", requiresEvidence: true, minSuccessfulEvidence: 1 }, new EvidenceLedger(), sessionFile);
    flow.engine.emit("event", base("turn.started", 1));
    flow.engine.emit("event", base("content.delta", 2, { text: "缺少证据" }));
    flow.engine.emit("event", base("turn.completed", 3));
    const records = (await readFile(sessionFile, "utf8")).trim().split(/\r?\n/).map((line) => JSON.parse(line));
    const taskRecord = records.find((record) => record.type === "task_lifecycle");
    assert.equal(taskRecord.task.status, "blocked");
    assert.equal(taskRecord.task.reason, "evidence_insufficient");
    assert.equal(taskRecord.task.metrics.finalStatus, "blocked");
  });

  it("allows a changed retry but blocks repeated retry of the same failed request", () => {
    const lifecycle = new TaskLifecycle({ requirements: { kind: "verification", requiresEvidence: true, minSuccessfulEvidence: 1 } });
    lifecycle.start("turn-retry");
    lifecycle.toolStarted("failed-1", "read", { target: "a.txt" });
    lifecycle.toolFailed("failed-1", "read", { category: "network", code: "timeout", message: "timeout", retryable: true });
    assert.equal(lifecycle.snapshot().status, "running");
    lifecycle.toolStarted("failed-2", "read", { target: "b.txt" });
    lifecycle.toolFailed("failed-2", "read", { category: "network", code: "timeout", message: "timeout", retryable: true });
    assert.equal(lifecycle.snapshot().status, "running");
    lifecycle.toolStarted("failed-3", "read", { target: "b.txt" });
    lifecycle.toolFailed("failed-3", "read", { category: "network", code: "timeout", message: "timeout", retryable: true });
    assert.equal(lifecycle.snapshot().status, "blocked");
    assert.equal(lifecycle.snapshot().reason, "transport_error_retry_budget_exhausted");
    assert.deepEqual(lifecycle.snapshot().retryDecisions.map((decision) => decision.action), ["retry", "retry", "block"]);
    assert.equal(lifecycle.snapshot().retryDecisions[0].category, "transport_error");
  });

  it("stops re-planning after a completed task and blocks non-retryable permission failures", () => {
    const lifecycle = new TaskLifecycle();
    lifecycle.start("turn-done");
    lifecycle.contentDelta("完成");
    lifecycle.complete(true, 0);
    lifecycle.toolStarted("late", "read", { target: "late.txt" });
    assert.equal(lifecycle.snapshot().status, "completed");
    assert.equal(lifecycle.snapshot().phase, "answering");

    const blocked = new TaskLifecycle();
    blocked.start("turn-blocked");
    blocked.toolStarted("permission", "command", { command: "rm" });
    blocked.toolFailed("permission", "command", { category: "permission", code: "denied", message: "denied", retryable: false });
    assert.equal(blocked.snapshot().status, "blocked");
    assert.equal(blocked.snapshot().reason, "permission_must_change_before_retry");
  });
});
