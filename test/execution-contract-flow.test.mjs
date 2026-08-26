import assert from "node:assert/strict";
import { createServer } from "node:http";
import * as http from "node:http";
import { describe, it } from "node:test";

import {
  agentToolToPIToolDefinition,
  defineAgentTool,
  structuredToolResult,
} from "../src/agent/types.ts";
import { authorizeExecutionContractAttempt, expandTaskRequirements, inferTaskRequirements, markFactVerificationStep } from "../src/server/task-lifecycle.ts";
import { formatExecutionContractGuidance } from "../src/server/task-lifecycle.ts";
import { skillFactsTool } from "../src/agent/tools/skill-facts.ts";
import { fileReadTool } from "../src/agent/tools/file-read.ts";
import { readMemoryTool, writeMemoryTool } from "../src/agent/tools/memory.ts";
import { attachEngineEvents } from "../src/server/agent-event-router.ts";
import { dispatchRoute } from "../src/server/routes/index.ts";
import { handleSkillSettings } from "../src/server/routes/settings/skills.ts";
import { EvidenceLedger } from "../src/server/evidence-ledger.ts";
import { withServerGroups } from "./helpers/context.mjs";

function toolHarness(contract, authorizeExecutionContract) {
  let executions = 0;
  const traces = [];
  const outcomes = [];
  const tool = defineAgentTool({
    name: "file_read",
    description: "read a file",
    parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
    isReadOnly: true,
    resultFormat: "structured",
    execute: async (args) => {
      executions++;
      return structuredToolResult(`read:${args.path}`, { path: args.path, content: "fixture" });
    },
  });
  const piTool = agentToolToPIToolDefinition(tool, "E:/workspace", (event) => traces.push(event), {
    getExecutionContract: () => contract,
    authorizeExecutionContract,
    toolOutcomeSource: "test",
    toolOutcomeObserver: (observation) => outcomes.push(observation),
  });
  return { piTool, traces, outcomes, get executions() { return executions; } };
}

describe("A-17/AP-12 execution contract cross-layer flow", () => {
  it("derives a bounded fact-verification contract from task A", () => {
    const requirements = inferTaskRequirements("请按 checkpoint-a-verification 检查 agent/skills/skill-verification/SKILL.md 的状态和内容");
    assert.equal(requirements.kind, "verification");
    assert.equal(requirements.contract?.kind, "fact_verification");
    assert.deepEqual(requirements.contract?.targets, ["agent/skills/skill-verification/SKILL.md"]);
    assert.deepEqual(requirements.contract?.allowedTools, ["file_read", "skill_facts"]);
    assert.deepEqual(requirements.contract?.instructionSources, ["agent/skills/checkpoint-a-verification/SKILL.md"]);
    assert.equal(requirements.contract?.onMissingEvidence, "report_unverified");
  });

  it("builds independent contracts for combined tasks A+B+C and enforces each task sequence", () => {
    const message = [
      "任务 A：请按 checkpoint-a-verification 检查 agent/skills/skill-verification/SKILL.md 的状态和内容，只报告实际读取到的事实。",
      "任务 B：请按 checkpoint-a-verification 检查用户级记忆中的一个条目，说明作用域、启用状态和证据来源。",
      "任务 C：请按 checkpoint-a-verification 检查当前工作区的一个记忆条目，说明作用域、启用状态和证据来源。",
    ].join("\\n");
    const requirements = inferTaskRequirements(message);
    assert.equal(requirements.contract?.kind, "fact_verification_batch");
    assert.deepEqual(requirements.contract?.tasks?.map((task) => task.id), ["A", "B", "C"]);
    assert.match(formatExecutionContractGuidance(requirements), /B: first call list_memory/);
    assert.match(formatExecutionContractGuidance(requirements), /C: first call list_memory/);

    const attempts = new Set();
    const progress = new Map();
    const blocked = authorizeExecutionContractAttempt(requirements.contract, undefined, attempts, "read_memory", { target: "memory:user/checkpoint-user-preference", argsFingerprint: "read-before-list" }, undefined, progress);
    assert.equal(blocked.allowed, false);
    assert.equal(blocked.reason, "sequence_required");

    const listed = authorizeExecutionContractAttempt(requirements.contract, undefined, attempts, "list_memory", { target: "memory:user", argsFingerprint: "list-user" }, undefined, progress);
    assert.equal(listed.allowed, true);
    markFactVerificationStep(progress, requirements.contract, "list_memory", { scope: "user" });
    const read = authorizeExecutionContractAttempt(requirements.contract, undefined, attempts, "read_memory", { target: "memory:user/checkpoint-user-preference", argsFingerprint: "read-user" }, undefined, progress);
    assert.equal(read.allowed, true);

    const workspaceReadBeforeList = authorizeExecutionContractAttempt(requirements.contract, undefined, attempts, "read_memory", { target: "memory:workspace/checkpoint-workspace-rule", argsFingerprint: "read-workspace-before-list" }, undefined, progress);
    assert.equal(workspaceReadBeforeList.allowed, false);
    assert.equal(workspaceReadBeforeList.reason, "sequence_required");
  });

  it("requires only complete content for an ordinary file fact check", () => {
    const requirements = inferTaskRequirements("请检查 docs/任务清单.md 的内容，只报告实际读取到的事实");
    assert.deepStrictEqual(requirements.contract?.allowedTools, ["file_read"]);
    assert.deepStrictEqual(requirements.contract?.allowedSources, ["docs/任务清单.md"]);
    assert.deepStrictEqual(requirements.contract?.requiredEvidence, ["content"]);
  });

  it("keeps verification as a per-turn overlay independent of the active capability profile", () => {
    const ordinaryStandard = inferTaskRequirements("帮我做点事情", "standard");
    const ordinaryMinimal = inferTaskRequirements("帮我做点事情", "minimal");
    assert.equal(ordinaryStandard.contract, undefined);
    assert.equal(ordinaryMinimal.contract, undefined);
    const longContext = `${"历史上下文。".repeat(4000)}\n请核验 \`docs/任务清单.md\`，只报告实际读取到的事实。`;
    const bounded = inferTaskRequirements(longContext, "minimal");
    assert.deepStrictEqual(bounded.contract?.targets, ["docs/任务清单.md"]);
    assert.deepStrictEqual(bounded.contract?.allowedTools, ["file_read"]);
    assert.deepStrictEqual(bounded.contract?.requiredEvidence, ["content"]);
    const expanded = expandTaskRequirements(bounded, "继续查实现源码", "minimal");
    assert.equal(expanded?.contract?.revision, 2);
    assert.equal(expanded?.userExpansion, true);
  });

  it("provides a bounded first-step control frame without widening evidence scope", () => {
    const requirements = inferTaskRequirements("请按 checkpoint-a-verification 检查 agent/skills/skill-verification/SKILL.md 的状态和内容");
    const guidance = formatExecutionContractGuidance(requirements);
    assert.match(guidance, /First read the requested target with file_read/);
    assert.match(guidance, /Then call skill_facts/);
    assert.match(guidance, /Do not use explorer_list/);
    assert.match(guidance, /instruction source only if needed/);
  });

  it("guides scoped-memory verification to the memory tools instead of file search", () => {
    const requirements = inferTaskRequirements("请按 checkpoint-a-verification 检查用户级记忆中的一个条目，说明作用域、启用状态和证据来源");
    const guidance = formatExecutionContractGuidance(requirements);
    assert.match(guidance, /list_memory with scope=user/);
    assert.match(guidance, /read_memory/);
    assert.doesNotMatch(guidance, /file_read/);
    assert.match(guidance, /Do not use explorer_list/);
  });

  it("does not impose a fact contract on implementation or diagnosis requests", () => {
    assert.equal(inferTaskRequirements("请检查 src/server/agent-event-router.ts 并修复事件流 bug").contract, undefined);
    assert.equal(inferTaskRequirements("请读取 src/server/agent-event-router.ts").contract, undefined);
    assert.equal(inferTaskRequirements("请分析这段聊天为什么会反复执行：请按 checkpoint-a-verification 检查 agent/skills/skill-verification/SKILL.md").contract, undefined);
  });

  it("keeps low-confidence standard checks open and uses guidance instead of a whitelist", () => {
    const requirements = inferTaskRequirements("请检查 src/server/agent-event-router.ts 的状态");
    assert.equal(requirements.requiresEvidence, false);
    assert.equal(requirements.contract, undefined);
    assert.equal(requirements.verificationPolicy?.mode, "soft");
    assert.deepEqual(requirements.verificationPolicy?.preferredTools, ["file_read"]);
    const guidance = formatExecutionContractGuidance(requirements);
    assert.match(guidance, /Host verification guidance: soft/);
    assert.match(guidance, /may inspect other relevant sources/i);
    assert.doesNotMatch(guidance, /Do not use/);
  });

  it("creates a new open-work contract revision only after explicit user expansion", () => {
    const requirements = inferTaskRequirements("请按 checkpoint-a-verification 检查 agent/skills/skill-verification/SKILL.md 的状态");
    const expanded = expandTaskRequirements(requirements, "继续查 parse 的实现源码");
    assert.equal(expanded?.contract?.kind, "diagnosis");
    assert.equal(expanded?.contract?.revision, 2);
    assert.equal(expanded?.contract?.allowedSources, undefined);
    assert.equal(expanded?.userExpansion, true);
    assert.equal(expandTaskRequirements(requirements, "继续"), undefined);
    assert.equal(expandTaskRequirements(requirements, "好的，谢谢"), undefined);
  });

  it("reads normalized skill facts through the real local HTTP settings route", async () => {
    const server = createServer((req, res) => {
      void handleSkillSettings(req, res, withServerGroups({
        skillService: {
          list: async () => ({
            revision: "rev-skill",
            skills: [{ id: "skill-verification", source: "workspace", trust: "trusted", enabled: true, parse: "valid", path: "skill-verification/SKILL.md" }],
            diagnostics: [],
          }),
        },
        runtime: { refreshSystemPrompt: async () => ({ ok: true }) },
      }));
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = server.address().port;
    const previousPort = process.env.SERVER_PORT;
    process.env.SERVER_PORT = String(port);
    try {
      const result = await skillFactsTool.execute({ id: "skill-verification", source: "workspace" }, { cwd: process.cwd(), workspace: process.cwd() });
      assert.equal(result.outcome.status, "success");
      assert.deepEqual(result.data.evidenceFields, ["trust", "enabled", "parse"]);
      assert.equal(result.data.revision, "rev-skill");
    } finally {
      if (previousPort === undefined) delete process.env.SERVER_PORT;
      else process.env.SERVER_PORT = previousPort;
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it("does not claim parse evidence when the normalized status API omits parse", async () => {
    const server = createServer((req, res) => {
      void handleSkillSettings(req, res, withServerGroups({
        skillService: { list: async () => ({ revision: "rev-missing-parse", skills: [{ id: "skill-verification", source: "workspace", trust: "trusted", enabled: true }], diagnostics: [] }) },
        runtime: { refreshSystemPrompt: async () => ({ ok: true }) },
      }));
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const previousPort = process.env.SERVER_PORT;
    process.env.SERVER_PORT = String(server.address().port);
    try {
      const result = await skillFactsTool.execute({ id: "skill-verification", source: "workspace" }, { cwd: process.cwd(), workspace: process.cwd() });
      assert.deepEqual(result.data.evidenceFields, ["trust", "enabled"]);
    } finally {
      if (previousPort === undefined) delete process.env.SERVER_PORT; else process.env.SERVER_PORT = previousPort;
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it("blocks an unrelated source before the underlying tool executes", async () => {
    const contract = {
      kind: "fact_verification",
      targets: ["agent/skills/skill-verification/SKILL.md"],
      allowedSources: ["agent/skills/skill-verification/SKILL.md", "data/user/skill-state.json"],
      allowedTools: ["file_read"],
      requiredEvidence: ["content", "trust", "enabled", "parse"],
      completionCondition: "evidence_satisfied",
      onMissingEvidence: "report_unverified",
      maxUnrelatedAttempts: 0,
      revision: 1,
    };
    const harness = toolHarness(contract);
    const result = await harness.piTool.execute("call-1", { path: "vite.config.ts" });
    assert.equal(harness.executions, 0);
    assert.match(result.content[0].text, /契约禁止读取该来源/);
    assert.equal(result.details.retryable, false);
    assert.equal(harness.outcomes.at(-1).failureKind, "validation_error");
    assert.equal(harness.traces.at(-1).outcome.failure.code, "execution_contract_violation");
  });

  it("uses the host contract callback as the single authoritative hard decision", async () => {
    const contract = {
      kind: "fact_verification",
      targets: ["agent/skills/skill-verification/SKILL.md"],
      allowedSources: ["agent/skills/skill-verification/SKILL.md"],
      allowedTools: ["file_read"],
      completionCondition: "evidence_satisfied",
      revision: 1,
    };
    const harness = toolHarness(contract, () => ({ allowed: true }));
    const result = await harness.piTool.execute("host-authorized", { path: "vite.config.ts" });
    assert.equal(harness.executions, 1);
    assert.match(result.content[0].text, /vite.config.ts/);
  });

  it("allows a declared source and leaves open tasks unrestricted", async () => {
    const strict = toolHarness({
      kind: "fact_verification",
      targets: ["agent/skills/skill-verification/SKILL.md"],
      allowedSources: ["agent/skills/skill-verification/SKILL.md"],
      allowedTools: ["file_read"],
      completionCondition: "evidence_satisfied",
      revision: 1,
    });
    const allowed = await strict.piTool.execute("call-2", { path: "agent/skills/skill-verification/SKILL.md" });
    assert.equal(strict.executions, 1);
    assert.match(allowed.content[0].text, /skill-verification/);

    const open = toolHarness({ kind: "diagnosis", completionCondition: "change_verified", revision: 1 });
    const exploratory = await open.piTool.execute("call-3", { path: "src/server/agent-event-router.ts" });
    assert.equal(open.executions, 1);
    assert.match(exploratory.content[0].text, /agent-event-router/);
  });

  it("allows an instruction source but strips its generic content evidence", async () => {
    const contract = {
      kind: "fact_verification",
      targets: ["agent/skills/skill-verification/SKILL.md"],
      instructionSources: ["agent/skills/checkpoint-a-verification/SKILL.md"],
      allowedSources: ["agent/skills/skill-verification/SKILL.md", "data/user/skill-state.json"],
      allowedTools: ["file_read"],
      requiredEvidence: ["content", "trust", "enabled", "parse"],
      completionCondition: "evidence_satisfied",
      onMissingEvidence: "report_unverified",
      revision: 1,
    };
    let executions = 0;
    const outcomes = [];
    const traces = [];
    const tool = defineAgentTool({
      name: "file_read",
      description: "read a file",
      parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
      resultFormat: "structured",
      execute: async () => {
        executions++;
        return structuredToolResult("instruction body", { content: "instruction body" }, [], { evidenceFields: ["content"] });
      },
    });
    const piTool = agentToolToPIToolDefinition(tool, "E:/workspace", (event) => traces.push(event), {
      getExecutionContract: () => contract,
      authorizeExecutionContract: () => ({ allowed: true }),
      toolOutcomeSource: "test",
      toolOutcomeObserver: (observation) => outcomes.push(observation),
    });
    const result = await piTool.execute("instruction-1", { path: "agent/skills/checkpoint-a-verification/SKILL.md" });
    assert.equal(executions, 1);
    assert.equal(result.details.evidenceFields, undefined);
    assert.equal(outcomes.at(-1).evidenceFields, undefined);
    assert.equal(traces.at(-1).metadata?.evidenceFields, undefined);
  });

  it("does not retry the same strict-contract attempt", async () => {
    const seen = new Set();
    const strict = toolHarness({
      kind: "fact_verification",
      targets: ["agent/skills/skill-verification/SKILL.md"],
      allowedSources: ["agent/skills/skill-verification/SKILL.md"],
      allowedTools: ["file_read"],
      completionCondition: "evidence_satisfied",
      revision: 1,
    }, (_tool, _input, scope) => {
      const key = `${scope.target}:${scope.argsFingerprint}`;
      if (seen.has(key)) return { allowed: false, code: "duplicate_attempt", reason: "duplicate_attempt", retryable: false };
      seen.add(key);
      return { allowed: true };
    });
    await strict.piTool.execute("call-4", { path: "agent/skills/skill-verification/SKILL.md" });
    const second = await strict.piTool.execute("call-5", { path: "agent/skills/skill-verification/SKILL.md" });
    assert.equal(strict.executions, 1);
    assert.match(second.content[0].text, /契约禁止/);
    assert.equal(second.details.retryable, false);
  });

  it("never satisfies a fresh verification turn from the cross-turn evidence cache", async () => {
    let executions = 0;
    let cacheLookups = 0;
    const contract = inferTaskRequirements("请检查 docs/任务清单.md 的内容，只报告实际读取到的事实").contract;
    const tool = defineAgentTool({
      name: "file_read",
      description: "read current source",
      parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
      isReadOnly: true,
      resultFormat: "structured",
      execute: async () => { executions += 1; return structuredToolResult("fresh", { content: "fresh" }, [], { evidenceFields: ["content"] }); },
    });
    const definition = agentToolToPIToolDefinition(tool, process.cwd(), undefined, {
      getExecutionContract: () => contract,
      authorizeExecutionContract: () => ({ allowed: true }),
      evidenceLookup: () => { cacheLookups += 1; return { evidenceId: "old", summary: "stale", payloadHash: "old" }; },
    });
    const result = await definition.execute("fresh-read", { path: "docs/任务清单.md" });
    assert.strictEqual(executions, 1);
    assert.strictEqual(cacheLookups, 0);
    assert.equal(result.content[0].text, "fresh");
  });

  it("drives the real HTTP file tool through success, permission, not-found, transport, cancellation, and truncation", async () => {
    const longContent = Array.from({ length: 5000 }, (_, index) => `line-${index + 1}`).join("\n");
    const server = createServer((req, res) => {
      const path = new URL(req.url, "http://127.0.0.1").searchParams.get("path");
      if (path === "transport.txt") { req.socket.destroy(); return; }
      if (path === "cancel.txt") { setTimeout(() => { if (!res.destroyed) { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ content: "late", encoding: "text", size: 4 })); } }, 250); return; }
      if (path === "denied.txt") { res.writeHead(403, { "content-type": "application/json" }); res.end(JSON.stringify({ error: "Access denied" })); return; }
      if (path === "missing.txt") { res.writeHead(404, { "content-type": "application/json" }); res.end(JSON.stringify({ error: "File not found" })); return; }
      const content = path === "long.txt" ? longContent : "current-content";
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ content, encoding: "text", size: Buffer.byteLength(content), mtime: "2026-08-24T00:00:00.000Z" }));
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const previousPort = process.env.SERVER_PORT;
    process.env.SERVER_PORT = String(server.address().port);
    const run = async (path, options = {}) => {
      const outcomes = [];
      const contract = {
        kind: "fact_verification", targets: [path], allowedSources: [path], allowedTools: ["file_read"], requiredEvidence: ["content"],
        completionCondition: "evidence_satisfied", onMissingEvidence: "report_unverified", maxUnrelatedAttempts: 0, revision: 1,
      };
      const definition = agentToolToPIToolDefinition(fileReadTool, process.cwd(), undefined, {
        getExecutionContract: () => contract,
        authorizeExecutionContract: () => ({ allowed: true }),
        toolOutcomeSource: "test",
        toolOutcomeObserver: (observation) => outcomes.push(observation),
      });
      try {
        const result = await definition.execute(`call-${path}`, { path, ...(options.maxLines ? { maxLines: options.maxLines } : {}) }, options.signal);
        return { result, outcomes };
      } catch (error) { return { error, outcomes }; }
    };
    try {
      const success = await run("ok.txt");
      assert.deepStrictEqual(success.result.details.evidenceFields, ["content"]);
      assert.equal(success.outcomes.at(-1).outcome, "success");

      const denied = await run("denied.txt");
      assert.equal(denied.result.details.outcome.failure.kind, "permission_denied");
      assert.equal(denied.outcomes.at(-1).status, undefined);
      assert.equal(denied.outcomes.at(-1).outcome, "failed");

      const missing = await run("missing.txt");
      assert.equal(missing.result.details.outcome.failure.kind, "not_found");
      assert.equal(missing.outcomes.at(-1).failureKind, "not_found");

      const transport = await run("transport.txt");
      assert.ok(transport.error);
      assert.equal(transport.outcomes.at(-1).failureKind, "transport_error");

      const controller = new AbortController();
      const cancelledPromise = run("cancel.txt", { signal: controller.signal });
      controller.abort(new Error("cancelled by test"));
      const cancelled = await cancelledPromise;
      assert.ok(cancelled.error);
      assert.equal(cancelled.outcomes.at(-1).failureKind, "cancelled");

      const truncated = await run("long.txt", { maxLines: 10 });
      assert.equal(truncated.result.details.data.truncated, true);
      assert.deepStrictEqual(truncated.result.details.evidenceFields, []);
      assert.deepStrictEqual(truncated.outcomes.at(-1).evidenceFields, []);
    } finally {
      if (previousPort === undefined) delete process.env.SERVER_PORT; else process.env.SERVER_PORT = previousPort;
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it("requires list_memory metadata followed by the real entry body before memory evidence is complete", async () => {
    const { mkdtempSync, rmSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const { tmpdir } = await import("node:os");
    const root = mkdtempSync(resolve(tmpdir(), "fact-memory-flow-"));
    const ctx = { cwd: process.cwd(), workspace: process.cwd(), userMemoryRoot: root };
    try {
      await writeMemoryTool.execute({ name: "preference", content: "Use focused evidence.", scope: "user" }, ctx);
      const requirements = inferTaskRequirements("请按 checkpoint-a-verification 检查用户级记忆中的一个条目，说明作用域、启用状态和证据来源");
      assert.deepStrictEqual(requirements.contract?.requiredEvidence, ["scope", "entry", "enabled", "source", "content"]);
      const result = await readMemoryTool.execute({ name: "preference", scope: "user" }, ctx);
      assert.equal(result.outcome.status, "success");
      assert.deepStrictEqual(result.metadata.evidenceFields, ["scope", "entry", "enabled", "source", "content"]);
      const decision = authorizeExecutionContractAttempt(requirements.contract, undefined, new Set(), "read_memory", {
        target: "memory:user/preference", argsFingerprint: "preference",
      });
      assert.equal(decision.allowed, true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("stops a strict contract before a tool call once all evidence fields are complete", () => {
    const contract = inferTaskRequirements("请按 checkpoint-a-verification 检查 agent/skills/skill-verification/SKILL.md 的状态和内容").contract;
    const attempts = new Set();
    const decision = authorizeExecutionContractAttempt(contract, {
      status: "running", missingEvidence: [], phase: "answering", turnId: "turn", kind: "verification",
      requiresEvidence: true, successfulEvidence: 2, retryableFailures: 0, retryDecisions: [], phaseHistory: [],
    }, attempts, "file_read", { target: "agent/skills/skill-verification/SKILL.md", argsFingerprint: "same" });
    assert.equal(decision.allowed, false);
    assert.equal(decision.code, "execution_contract_complete");
    assert.equal(attempts.size, 0);
  });

  it("records blocked and unrelated hard-contract attempts separately", () => {
    const contract = inferTaskRequirements("请按 checkpoint-a-verification 检查 agent/skills/skill-verification/SKILL.md 的状态和内容").contract;
    const attempts = new Set();
    const metrics = { unrelatedAttempts: 0, blockedAttempts: 0 };
    const unrelated = authorizeExecutionContractAttempt(contract, undefined, attempts, "file_read", {
      target: "vite.config.ts", argsFingerprint: "unrelated",
    }, metrics);
    assert.equal(unrelated.allowed, false);
    assert.deepEqual(metrics, { unrelatedAttempts: 1, blockedAttempts: 1 });

    const first = authorizeExecutionContractAttempt(contract, undefined, attempts, "file_read", {
      target: "agent/skills/skill-verification/SKILL.md", argsFingerprint: "same",
    }, metrics);
    const duplicate = authorizeExecutionContractAttempt(contract, undefined, attempts, "file_read", {
      target: "agent/skills/skill-verification/SKILL.md", argsFingerprint: "same",
    }, metrics);
    assert.equal(first.allowed, true);
    assert.equal(duplicate.code, "duplicate_attempt");
    assert.deepEqual(metrics, { unrelatedAttempts: 1, blockedAttempts: 2 });
  });

  it("keeps the completed-contract code consistent across the tool outcome", async () => {
    const strict = toolHarness({
      kind: "fact_verification",
      targets: ["agent/skills/skill-verification/SKILL.md"],
      allowedSources: ["agent/skills/skill-verification/SKILL.md"],
      allowedTools: ["file_read"],
      completionCondition: "evidence_satisfied",
      revision: 1,
    }, () => ({ allowed: false, code: "execution_contract_complete", reason: "evidence_satisfied", retryable: false }));
    const result = await strict.piTool.execute("call-complete", { path: "agent/skills/skill-verification/SKILL.md" });
    assert.equal(result.details.outcome.failure.code, "execution_contract_complete");
    assert.equal(strict.traces.at(-1).outcome.failure.code, "execution_contract_complete");
    assert.equal(strict.outcomes.at(-1).executionContract.code, "execution_contract_complete");
  });

  it("normalizes pending sibling tools and preserves the terminal contract reason", () => {
    const listeners = new Set();
    const engine = {
      session: { id: "a17-terminal-session", workspace: process.cwd(), isStreaming: false, isCompacting: false },
      subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
      cancel: async () => {},
      emit(event) { for (const listener of listeners) listener(event); },
    };
    const chatStream = {
      textBuffer: "", thinkingBuffer: "", response: null, currentWorkspace: process.cwd(),
      traceId: "", traceSeq: 0, emittedTraces: new Set(), blocks: [], blockSeq: 0, eventSeq: 0, eventHistory: [],
      taskRequirements: inferTaskRequirements("请按 checkpoint-a-verification 检查 agent/skills/skill-verification/SKILL.md 的状态和内容"),
    };
    const runtime = { session: engine.session, currentWorkspace: process.cwd(), switchWorkspace: async () => {}, onEvent: () => () => {} };
    const ctx = withServerGroups({
      engine, runtime, chatStream, sseClients: [],
      observability: { evidenceLedger: new EvidenceLedger() },
      paths: { APP_ROOT: process.cwd(), DATA_DIR: process.cwd(), PI_CONFIG_DIR: process.cwd(), SESSIONS_DIR: process.cwd(), FRONTEND_DIR: process.cwd(), FRONTEND_SRC_DIR: process.cwd(), HAS_BUILT_FRONTEND: false },
    });
    attachEngineEvents(engine, runtime, chatStream, ctx);
    const base = { version: 1, sessionId: engine.session.id, turnId: "a17-terminal-turn", timestamp: Date.now() };
    engine.emit({ ...base, seq: 1, type: "turn.started" });
    engine.emit({ ...base, seq: 2, type: "tool.started", toolCallId: "explorer-1", name: "explorer_list", input: { path: "agent/skills" } });
    engine.emit({ ...base, seq: 3, type: "turn.completed" });
    const events = chatStream.eventHistory.map((entry) => JSON.parse(entry.data.split("data: ")[1]));
    const done = events.find((event) => event.type === "done");
    assert.equal(done?.status, "error");
    assert.equal(done?.task.reason, "tool_incomplete_at_terminal");
    assert.equal(done?.error, "tool_incomplete_at_terminal");
    assert.ok(done?.blocks.every((block) => block.type !== "tool" || block.status !== "running"));
    assert.equal(done?.blocks.find((block) => block.toolCallId === "explorer-1")?.status, "error");
  });

  it("drives a real chat HTTP/SSE turn to an unverified terminal without exploration", async () => {
    const ledger = new EvidenceLedger();
    const listeners = new Set();
    const calls = [];
    const engine = {
      session: { id: "a17-http-session", workspace: process.cwd(), isStreaming: false, isCompacting: false },
      subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
      syncModelProviders: async () => 0,
      prompt: async () => {
        const base = { version: 1, sessionId: "a17-http-session", turnId: "a17-http-turn", timestamp: Date.now() };
        const emit = (event) => { for (const listener of listeners) listener({ ...base, seq: calls.length + 1, ...event }); };
        emit({ type: "turn.started" });
        calls.push("skill_facts");
        ledger.observe({ source: "live", toolName: "skill_facts", toolCallId: "facts-1", outcome: "success", requestScope: { target: "agent/skills/skill-verification/SKILL.md" }, payloadSummary: "facts", complete: true, evidenceFields: ["trust", "enabled"] });
        emit({ type: "tool.started", toolCallId: "facts-1", name: "skill_facts", input: { id: "skill-verification" } });
        emit({ type: "tool.completed", toolCallId: "facts-1", name: "skill_facts", output: "trust=trusted enabled=true parse=valid", metadata: { evidenceFields: ["trust", "enabled"] } });
        emit({ type: "content.delta", text: "状态看起来正常" });
        emit({ type: "turn.completed" });
      },
    };
    const chatStream = { textBuffer: "", thinkingBuffer: "", response: null, currentWorkspace: process.cwd(), traceSeq: 0, emittedTraces: new Set(), blocks: [], blockSeq: 0, eventSeq: 0, eventHistory: [] };
    const runtime = { session: engine.session, currentWorkspace: process.cwd(), switchWorkspace: async () => {}, onEvent: () => () => {} };
    const ctx = withServerGroups({
      engine,
      runtime,
      chatStream,
      sseClients: [],
      observability: { evidenceLedger: ledger },
      paths: {
        APP_ROOT: process.cwd(), DATA_DIR: process.cwd(), PI_CONFIG_DIR: process.cwd(), SESSIONS_DIR: process.cwd(), SETTINGS_FILE: "", FRONTEND_DIR: process.cwd(), FRONTEND_SRC_DIR: process.cwd(), HAS_BUILT_FRONTEND: false,
      },
    });
    attachEngineEvents(engine, runtime, chatStream, ctx);
    const server = createServer((req, res) => { void dispatchRoute(req, res, ctx); });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = server.address().port;
    const ssePromise = new Promise((resolve, reject) => {
      const request = http.get({ hostname: "127.0.0.1", port, path: "/api/chat/stream" });
      let body = "";
      request.on("response", (response) => {
        response.setEncoding("utf8");
        response.on("data", (chunk) => { body += chunk; });
        response.on("end", () => resolve(body));
      });
      request.on("error", reject);
    });
    // The stream stays open until the turn completes, so POST after connecting.
    const post = await new Promise((resolve, reject) => {
      const request = http.request({ hostname: "127.0.0.1", port, path: "/api/chat", method: "POST", headers: { "content-type": "application/json" } }, (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => { body += chunk; });
        response.on("end", () => resolve({ status: response.statusCode, body }));
      });
      request.on("error", reject);
      request.end(JSON.stringify({ message: "请按 checkpoint-a-verification 检查 agent/skills/skill-verification/SKILL.md 的状态和内容" }));
    });
    const sse = await ssePromise;
    assert.equal(post.status, 200);
    const events = chatStream.eventHistory.map((entry) => JSON.parse(entry.data.split("data: ")[1]));
    const done = events.find((event) => event.type === "done");
    assert.ok(done);
    assert.equal(done.status, "done");
    assert.equal(done.task.reason, "evidence_unverified");
    assert.deepEqual(done.task.missingEvidence, ["content", "parse"]);
    assert.match(done.text, /^未验证：/);
    assert.doesNotMatch(done.text, /状态看起来正常/);
    assert.deepEqual(calls, ["skill_facts"]);
    const replayFrom = Math.max(0, done ? events.find((event) => event.type === "done")?.id || 0 : 0);
    const replayBody = await new Promise((resolve, reject) => {
      const request = http.get({ hostname: "127.0.0.1", port, path: "/api/chat/stream", headers: { "Last-Event-ID": String(Math.max(0, replayFrom - 1)) } });
      let body = "";
      request.on("response", (response) => {
        response.setEncoding("utf8");
        response.on("data", (chunk) => {
          body += chunk;
          if (body.includes('"type":"done"')) {
            request.destroy();
            resolve(body);
          }
        });
      });
      request.on("error", (error) => error.code === "ECONNRESET" ? resolve(body) : reject(error));
    });
    assert.match(replayBody, /"type":"done"/);
    assert.match(replayBody, /"reason":"evidence_unverified"/);
    await new Promise((resolve) => server.close(resolve));
  });

  it("drives combined A+B+C through HTTP/SSE with per-task evidence and no source rejection", async () => {
    const ledger = new EvidenceLedger();
    const listeners = new Set();
    let promptMessage = "";
    const engine = {
      session: { id: "batch-fact-session", workspace: process.cwd(), isStreaming: false, isCompacting: false },
      subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
      syncModelProviders: async () => 0,
      prompt: async ({ message }) => {
        promptMessage = message;
        const base = { version: 1, sessionId: "batch-fact-session", turnId: "batch-fact-turn", timestamp: Date.now() };
        let seq = 1;
        const emit = (event) => { for (const listener of listeners) listener({ ...base, seq: seq++, ...event }); };
        const calls = [
          ["batch-a-read", "file_read", "agent/skills/skill-verification/SKILL.md", ["content"], { path: "agent/skills/skill-verification/SKILL.md" }],
          ["batch-a-facts", "skill_facts", "agent/skills/skill-verification/SKILL.md", ["trust", "enabled", "parse"], { id: "skill-verification" }],
          ["batch-b-list", "list_memory", "memory:user", ["scope", "entry", "enabled", "source"], { scope: "user" }],
          ["batch-b-read", "read_memory", "memory:user/checkpoint-user-preference", ["scope", "entry", "enabled", "source", "content"], { name: "checkpoint-user-preference", scope: "user" }],
          ["batch-c-list", "list_memory", "memory:workspace", ["scope", "entry", "enabled", "source"], { scope: "workspace" }],
          ["batch-c-read", "read_memory", "memory:workspace/checkpoint-workspace-rule", ["scope", "entry", "enabled", "source", "content"], { name: "checkpoint-workspace-rule", scope: "workspace" }],
        ];
        emit({ type: "turn.started" });
        for (const [toolCallId, name, target, evidenceFields, input] of calls) {
          ledger.observe({ source: "live", toolName: name, toolCallId, outcome: "success", requestScope: { target }, payloadSummary: "evidence", complete: true, evidenceFields });
          emit({ type: "tool.started", toolCallId, name, input });
          emit({ type: "tool.completed", toolCallId, name, output: "evidence", metadata: { evidenceFields } });
        }
        emit({ type: "content.delta", text: "A、B、C 均已完成核验。" });
        emit({ type: "turn.completed" });
      },
    };
    const chatStream = { textBuffer: "", thinkingBuffer: "", response: null, currentWorkspace: process.cwd(), traceSeq: 0, emittedTraces: new Set(), blocks: [], blockSeq: 0, eventSeq: 0, eventHistory: [] };
    const runtime = { session: engine.session, currentWorkspace: process.cwd(), switchWorkspace: async () => {}, onEvent: () => () => {} };
    const ctx = withServerGroups({ engine, runtime, chatStream, sseClients: [], observability: { evidenceLedger: ledger },
      paths: { APP_ROOT: process.cwd(), DATA_DIR: process.cwd(), PI_CONFIG_DIR: process.cwd(), SESSIONS_DIR: process.cwd(), FRONTEND_DIR: process.cwd(), FRONTEND_SRC_DIR: process.cwd(), HAS_BUILT_FRONTEND: false } });
    attachEngineEvents(engine, runtime, chatStream, ctx);
    const server = createServer((req, res) => { void dispatchRoute(req, res, ctx); });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = server.address().port;
    const message = [
      "任务 A：请按 checkpoint-a-verification 检查 agent/skills/skill-verification/SKILL.md 的状态和内容，只报告实际读取到的事实。",
      "任务 B：请按 checkpoint-a-verification 检查用户级记忆中的一个条目，说明作用域、启用状态和证据来源。",
      "任务 C：请按 checkpoint-a-verification 检查当前工作区的一个记忆条目，说明作用域、启用状态和证据来源。",
    ].join("\\n");
    const ssePromise = new Promise((resolve, reject) => {
      const request = http.get({ hostname: "127.0.0.1", port, path: "/api/chat/stream" });
      let body = "";
      request.on("response", (response) => { response.setEncoding("utf8"); response.on("data", (chunk) => { body += chunk; }); response.on("end", () => resolve(body)); });
      request.on("error", reject);
    });
    const post = await new Promise((resolve, reject) => {
      const request = http.request({ hostname: "127.0.0.1", port, path: "/api/chat", method: "POST", headers: { "content-type": "application/json" } }, (response) => { response.resume(); response.on("end", () => resolve(response.statusCode)); });
      request.on("error", reject); request.end(JSON.stringify({ message }));
    });
    await ssePromise;
    assert.equal(post, 200);
    assert.match(promptMessage, /fact_verification_batch/);
    assert.match(promptMessage, /B: first call list_memory/);
    assert.match(promptMessage, /C: first call list_memory/);
    const events = chatStream.eventHistory.map((entry) => JSON.parse(entry.data.split("data: ")[1]));
    const done = events.find((event) => event.type === "done");
    assert.equal(done.status, "done");
    assert.equal(done.task.status, "completed");
    assert.deepEqual(done.task.missingEvidence, []);
    assert.equal(done.task.metrics.toolCalls, 6);
    assert.equal(done.task.metrics.blockedAttempts, 0);
    await new Promise((resolve) => server.close(resolve));
  });

  it("keeps a standard low-confidence check open across HTTP, tools, SSE, and terminal metrics", async () => {
    const listeners = new Set();
    let promptMessage = "";
    const engine = {
      session: { id: "ap12-soft-session", workspace: process.cwd(), isStreaming: false, isCompacting: false, profile: { id: "standard", revision: 1 } },
      subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
      syncModelProviders: async () => 0,
      prompt: async ({ message }) => {
        promptMessage = message;
        const base = { version: 1, sessionId: "ap12-soft-session", turnId: "ap12-soft-turn", timestamp: Date.now() };
        const emit = (event, seq) => { for (const listener of listeners) listener({ ...base, seq, ...event }); };
        emit({ type: "turn.started" }, 1);
        emit({ type: "tool.started", toolCallId: "read-soft", name: "file_read", input: { path: "src/server/task-lifecycle.ts" } }, 2);
        emit({ type: "tool.completed", toolCallId: "read-soft", name: "file_read", output: "source" }, 3);
        emit({ type: "tool.started", toolCallId: "search-soft", name: "search", input: { query: "requiresEvidence" } }, 4);
        emit({ type: "tool.completed", toolCallId: "search-soft", name: "search", output: "matches" }, 5);
        emit({ type: "content.delta", text: "检查完成，相关实现需要两处来源。" }, 6);
        emit({ type: "turn.completed", usage: {
          input: 10, output: 5, cacheRead: 2, cacheWrite: 1, reasoning: 3,
          source: "exact", cost: { status: "unknown" },
        } }, 7);
      },
    };
    const chatStream = { textBuffer: "", thinkingBuffer: "", response: null, currentWorkspace: process.cwd(), traceSeq: 0, emittedTraces: new Set(), blocks: [], blockSeq: 0, eventSeq: 0, eventHistory: [] };
    const runtime = { session: engine.session, currentWorkspace: process.cwd(), switchWorkspace: async () => {}, onEvent: () => () => {} };
    const ctx = withServerGroups({ engine, runtime, chatStream, sseClients: [], paths: { APP_ROOT: process.cwd(), DATA_DIR: process.cwd(), PI_CONFIG_DIR: process.cwd(), SESSIONS_DIR: process.cwd(), FRONTEND_DIR: process.cwd(), FRONTEND_SRC_DIR: process.cwd(), HAS_BUILT_FRONTEND: false } });
    attachEngineEvents(engine, runtime, chatStream, ctx);
    const server = createServer((req, res) => { void dispatchRoute(req, res, ctx); });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = server.address().port;
    const ssePromise = new Promise((resolve, reject) => {
      const request = http.get({ hostname: "127.0.0.1", port, path: "/api/chat/stream" });
      let body = "";
      request.on("response", (response) => { response.setEncoding("utf8"); response.on("data", (chunk) => { body += chunk; }); response.on("end", () => resolve(body)); });
      request.on("error", reject);
    });
    const status = await new Promise((resolve, reject) => {
      const request = http.request({ hostname: "127.0.0.1", port, path: "/api/chat", method: "POST", headers: { "content-type": "application/json" } }, (response) => { response.resume(); response.on("end", () => resolve(response.statusCode)); });
      request.on("error", reject);
      request.end(JSON.stringify({ message: "请检查 src/server/task-lifecycle.ts 的状态" }));
    });
    await ssePromise;
    assert.equal(status, 200);
    assert.match(promptMessage, /Host verification guidance: soft/);
    assert.doesNotMatch(promptMessage, /Do not use explorer_list/);
    assert.equal(chatStream.taskRequirements.contract, undefined);
    const done = chatStream.eventHistory.map((entry) => JSON.parse(entry.data.split("data: ")[1])).find((event) => event.type === "done");
    assert.equal(done.status, "done");
    assert.equal(done.task.status, "completed");
    assert.equal(done.task.metrics.toolCalls, 2);
    assert.equal(done.task.metrics.blockedAttempts, 0);
    assert.equal(done.task.metrics.evidenceSatisfied, false);
    assert.deepEqual(done.task.metrics.tokenUsage, { input: 10, output: 5, cacheRead: 2, cacheWrite: 1, reasoning: 3, total: 18 });
    await new Promise((resolve) => server.close(resolve));
  });

  it("keeps an ordinary request open when no verification overlay is requested", async () => {
    const listeners = new Set();
    let promptMessage = "";
    const engine = {
      session: { id: "ordinary-profile-http", workspace: process.cwd(), isStreaming: false, isCompacting: false, profile: { id: "standard", revision: 1 } },
      subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
      syncModelProviders: async () => 0,
      prompt: async ({ message }) => {
        promptMessage = message;
        const base = { version: 1, sessionId: "ordinary-profile-http", turnId: "ordinary-profile-turn", timestamp: Date.now() };
        const emit = (event, seq) => { for (const listener of listeners) listener({ ...base, seq, ...event }); };
        emit({ type: "turn.started" }, 1);
        emit({ type: "content.delta", text: "我猜应该可以。" }, 2);
        emit({ type: "turn.completed" }, 3);
      },
    };
    const chatStream = { textBuffer: "", thinkingBuffer: "", response: null, currentWorkspace: process.cwd(), traceSeq: 0, emittedTraces: new Set(), blocks: [], blockSeq: 0, eventSeq: 0, eventHistory: [] };
    const runtime = { session: engine.session, currentWorkspace: process.cwd(), switchWorkspace: async () => {}, onEvent: () => () => {} };
    const ctx = withServerGroups({ engine, runtime, chatStream, sseClients: [], observability: { evidenceLedger: new EvidenceLedger() },
      paths: { APP_ROOT: process.cwd(), DATA_DIR: process.cwd(), PI_CONFIG_DIR: process.cwd(), SESSIONS_DIR: process.cwd(), FRONTEND_DIR: process.cwd(), FRONTEND_SRC_DIR: process.cwd(), HAS_BUILT_FRONTEND: false } });
    attachEngineEvents(engine, runtime, chatStream, ctx);
    const server = createServer((req, res) => { void dispatchRoute(req, res, ctx); });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = server.address().port;
    const ssePromise = new Promise((resolve, reject) => {
      const request = http.get({ hostname: "127.0.0.1", port, path: "/api/chat/stream" });
      let body = "";
      request.on("response", (response) => { response.setEncoding("utf8"); response.on("data", (chunk) => { body += chunk; }); response.on("end", () => resolve(body)); });
      request.on("error", reject);
    });
    const post = await new Promise((resolve, reject) => {
      const request = http.request({ hostname: "127.0.0.1", port, path: "/api/chat", method: "POST", headers: { "content-type": "application/json" } }, (response) => { response.resume(); response.on("end", () => resolve(response.statusCode)); });
      request.on("error", reject); request.end(JSON.stringify({ message: "帮我做点事情" }));
    });
    await ssePromise;
    assert.equal(post, 200);
    assert.equal(promptMessage, "帮我做点事情");
    const done = chatStream.eventHistory.map((entry) => JSON.parse(entry.data.split("data: ")[1])).find((event) => event.type === "done");
    assert.equal(done.status, "done");
    assert.equal(done.task.status, "completed");
    assert.match(done.text, /我猜应该可以/);
    await new Promise((resolve) => server.close(resolve));
  });

  it("keeps a source-not-allowed contract stop out of the generic reply-failed UI", async () => {
    const ledger = new EvidenceLedger();
    const listeners = new Set();
    const engine = {
      session: { id: "memory-empty-session", workspace: process.cwd(), isStreaming: false, isCompacting: false },
      subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
      syncModelProviders: async () => 0,
      prompt: async () => {
        const base = { version: 1, sessionId: "memory-empty-session", turnId: "memory-empty-turn", timestamp: Date.now() };
        const emit = (event, seq) => { for (const listener of listeners) listener({ ...base, seq, ...event }); };
        emit({ type: "turn.started" }, 1);
        ledger.observe({ source: "live", toolName: "list_memory", toolCallId: "memory-list-1", outcome: "success",
          requestScope: { target: "memory:user" }, payloadSummary: "暂无记忆。", complete: true, evidenceFields: ["scope"] });
        emit({ type: "tool.started", toolCallId: "memory-list-1", name: "list_memory", input: { scope: "user" } }, 2);
        emit({ type: "tool.completed", toolCallId: "memory-list-1", name: "list_memory", output: "暂无记忆。", metadata: { evidenceFields: ["scope"] } }, 3);
        // A host contract rejection is an honest unverified report, not a
        // generic "回复失败" terminal.
        emit({ type: "tool.started", toolCallId: "out-of-scope", name: "file_read", input: { path: "vite.config.ts" } }, 4);
        emit({ type: "tool.failed", toolCallId: "out-of-scope", name: "file_read",
          error: { category: "validation", kind: "validation_error", code: "execution_contract_violation", message: "未执行：事实核验契约禁止读取该来源。", retryable: false, details: { reason: "source_not_allowed" } } }, 5);
        emit({ type: "content.delta", text: "没有可供核验的用户级记忆条目。" }, 6);
        emit({ type: "turn.failed", error: { category: "validation", kind: "validation_error", code: "execution_contract_violation", message: "未执行：事实核验契约禁止读取该来源。", retryable: false, details: { reason: "source_not_allowed" } } }, 7);
      },
    };
    const chatStream = { textBuffer: "", thinkingBuffer: "", response: null, currentWorkspace: process.cwd(), traceSeq: 0, emittedTraces: new Set(), blocks: [], blockSeq: 0, eventSeq: 0, eventHistory: [],
      taskRequirements: inferTaskRequirements("请按 checkpoint-a-verification 检查用户级记忆中的一个条目，说明作用域、启用状态和证据来源") };
    const runtime = { session: engine.session, currentWorkspace: process.cwd(), switchWorkspace: async () => {}, onEvent: () => () => {} };
    const ctx = withServerGroups({ engine, runtime, chatStream, sseClients: [], observability: { evidenceLedger: ledger },
      paths: { APP_ROOT: process.cwd(), DATA_DIR: process.cwd(), PI_CONFIG_DIR: process.cwd(), SESSIONS_DIR: process.cwd(), FRONTEND_DIR: process.cwd(), FRONTEND_SRC_DIR: process.cwd(), HAS_BUILT_FRONTEND: false } });
    attachEngineEvents(engine, runtime, chatStream, ctx);
    const server = createServer((req, res) => { void dispatchRoute(req, res, ctx); });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = server.address().port;
    const ssePromise = new Promise((resolve, reject) => {
      const request = http.get({ hostname: "127.0.0.1", port, path: "/api/chat/stream" });
      let body = "";
      request.on("response", (response) => { response.setEncoding("utf8"); response.on("data", (chunk) => { body += chunk; }); response.on("end", () => resolve(body)); });
      request.on("error", reject);
    });
    const post = await new Promise((resolve, reject) => {
      const request = http.request({ hostname: "127.0.0.1", port, path: "/api/chat", method: "POST", headers: { "content-type": "application/json" } }, (response) => {
        let body = ""; response.setEncoding("utf8"); response.on("data", (chunk) => { body += chunk; }); response.on("end", () => resolve({ status: response.statusCode, body }));
      });
      request.on("error", reject);
      request.end(JSON.stringify({ message: "请按 checkpoint-a-verification 检查用户级记忆中的一个条目，说明作用域、启用状态和证据来源" }));
    });
    await ssePromise;
    assert.equal(post.status, 200);
    const events = chatStream.eventHistory.map((entry) => JSON.parse(entry.data.split("data: ")[1]));
    const done = events.find((event) => event.type === "done");
    assert.ok(done);
    assert.equal(done.status, "done");
    assert.equal(done.task.status, "blocked");
    assert.equal(done.task.reason, "source_not_allowed");
    assert.equal(done.blocks.find((block) => block.type === "step" && block.status === "error")?.text, "validation_error：source_not_allowed");
    assert.match(done.text, /^未验证：/);
    assert.equal("error" in done, false);
    await new Promise((resolve) => server.close(resolve));
  });

  it("re-reads the real source after refresh instead of inheriting an earlier unverified result", async () => {
    const ledger = new EvidenceLedger();
    const listeners = new Set();
    const calls = [];
    let promptCount = 0;
    const engine = {
      session: { id: "a17-refresh-session", workspace: process.cwd(), isStreaming: false, isCompacting: false },
      subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
      syncModelProviders: async () => 0,
      prompt: async () => {
        promptCount += 1;
        const turnId = `a17-refresh-turn-${promptCount}`;
        const base = { version: 1, sessionId: "a17-refresh-session", turnId, timestamp: Date.now() };
        let seq = 0;
        const emit = (event) => { seq += 1; for (const listener of listeners) listener({ ...base, seq, ...event }); };
        emit({ type: "turn.started" });
        calls.push("skill_facts");
        const fields = promptCount === 1 ? ["trust", "enabled"] : ["trust", "enabled", "parse"];
        ledger.observe({ source: "live", toolName: "skill_facts", toolCallId: `facts-${promptCount}`, outcome: "success",
          requestScope: { target: "agent/skills/skill-verification/SKILL.md" }, payloadSummary: "facts", complete: true, evidenceFields: fields });
        emit({ type: "tool.started", toolCallId: `facts-${promptCount}`, name: "skill_facts", input: { id: "skill-verification" } });
        emit({ type: "tool.completed", toolCallId: `facts-${promptCount}`, name: "skill_facts", output: "facts", metadata: { evidenceFields: fields } });
        if (promptCount === 2) {
          emit({ type: "tool.started", toolCallId: "read-2", name: "file_read", input: { path: "agent/skills/skill-verification/SKILL.md" } });
          emit({ type: "tool.completed", toolCallId: "read-2", name: "file_read", output: "content", metadata: { evidenceFields: ["content"] } });
        }
        emit({ type: "content.delta", text: promptCount === 1 ? "状态未完整" : "已重新读取并核验" });
        emit({ type: "turn.completed" });
      },
    };
    const chatStream = { textBuffer: "", thinkingBuffer: "", response: null, currentWorkspace: process.cwd(), traceSeq: 0, emittedTraces: new Set(), blocks: [], blockSeq: 0, eventSeq: 0, eventHistory: [] };
    const runtime = { session: engine.session, currentWorkspace: process.cwd(), switchWorkspace: async () => {}, onEvent: () => () => {} };
    const ctx = withServerGroups({
      engine, runtime, chatStream, sseClients: [],
      observability: { evidenceLedger: ledger },
      paths: { APP_ROOT: process.cwd(), DATA_DIR: process.cwd(), PI_CONFIG_DIR: process.cwd(), SESSIONS_DIR: process.cwd(), FRONTEND_DIR: process.cwd(), FRONTEND_SRC_DIR: process.cwd(), HAS_BUILT_FRONTEND: false },
    });
    attachEngineEvents(engine, runtime, chatStream, ctx);
    const server = createServer((req, res) => { void dispatchRoute(req, res, ctx); });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = server.address().port;
    const taskMessage = "请按 checkpoint-a-verification 检查 agent/skills/skill-verification/SKILL.md 的状态和内容";
    const readStream = async (lastEventId) => new Promise((resolve, reject) => {
      const request = http.get({ hostname: "127.0.0.1", port, path: "/api/chat/stream", ...(lastEventId !== undefined ? { headers: { "Last-Event-ID": String(lastEventId) } } : {}) });
        let body = "";
        request.on("response", (response) => {
          response.setEncoding("utf8");
          response.on("data", (chunk) => { body += chunk; if (body.includes('"type":"done"')) { request.destroy(); resolve(body); } });
          response.on("end", () => resolve(body));
        });
        request.on("error", (error) => error.code === "ECONNRESET" ? resolve(body) : reject(error));
    });
    const postTurn = async () => {
      const post = await new Promise((resolve, reject) => {
        const request = http.request({ hostname: "127.0.0.1", port, path: "/api/chat", method: "POST", headers: { "content-type": "application/json" } }, (response) => {
          let body = ""; response.setEncoding("utf8"); response.on("data", (chunk) => { body += chunk; }); response.on("end", () => resolve({ status: response.statusCode, body }));
        });
        request.on("error", reject); request.end(JSON.stringify({ message: taskMessage }));
      });
      return { post };
    };
    const firstPost = await postTurn();
    const first = { ...firstPost, body: await readStream(), done: undefined };
    first.done = first.body.match(/data: (\{[^\n]*"type":"done"[^\n]*\})/)?.[1] ? JSON.parse(first.body.match(/data: (\{[^\n]*"type":"done"[^\n]*\})/)?.[1]) : undefined;
    assert.equal(first.post.status, 200);
    assert.equal(first.done?.status, "done");
    assert.equal(first.done?.task.reason, "evidence_unverified");

    // A reconnect can replay the failed terminal event, but it must not turn it into success.
    const replay = { body: await readStream(0) };
    assert.match(replay.body, /"reason":"evidence_unverified"/);

    // Ctrl+R/new request starts a fresh contract attempt and reads the source again.
    const secondPost = await postTurn();
    const secondBody = await readStream();
    const secondDoneText = secondBody.match(/data: (\{[^\n]*"type":"done"[^\n]*\})/)?.[1];
    const second = { ...secondPost, body: secondBody, done: secondDoneText ? JSON.parse(secondDoneText) : undefined };
    assert.equal(second.post.status, 200);
    assert.equal(second.done?.status, "done", JSON.stringify(second.done));
    assert.equal(second.done?.task.status, "completed");
    assert.deepEqual(calls, ["skill_facts", "skill_facts"]);
    assert.equal(promptCount, 2);
    await new Promise((resolve) => server.close(resolve));
  });

  it("expands the contract through consecutive chat requests only after explicit scope expansion", async () => {
    const listeners = new Set();
    const prompts = [];
    const engine = {
      session: { id: "a17-expand-session", workspace: process.cwd(), isStreaming: false, isCompacting: false },
      subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
      syncModelProviders: async () => 0,
      prompt: async ({ message }) => {
        prompts.push(message);
        const turnId = `a17-expand-turn-${prompts.length}`;
        const base = { version: 1, sessionId: "a17-expand-session", turnId, timestamp: Date.now() };
        let seq = 0;
        const emit = (event) => { seq += 1; for (const listener of listeners) listener({ ...base, seq, ...event }); };
        emit({ type: "turn.started" });
        const path = prompts.length === 1 ? "agent/skills/skill-verification/SKILL.md" : "src/server/skill-service.ts";
        emit({ type: "tool.started", toolCallId: `read-${prompts.length}`, name: "file_read", input: { path } });
        emit({ type: "tool.completed", toolCallId: `read-${prompts.length}`, name: "file_read", output: "source content", metadata: { evidenceFields: ["content"] } });
        emit({ type: "content.delta", text: prompts.length === 1 ? "已读取目标文件" : "已展开到实现源码" });
        emit({ type: "turn.completed" });
      },
    };
    const chatStream = { textBuffer: "", thinkingBuffer: "", response: null, currentWorkspace: process.cwd(), traceSeq: 0, emittedTraces: new Set(), blocks: [], blockSeq: 0, eventSeq: 0, eventHistory: [] };
    const runtime = { session: engine.session, currentWorkspace: process.cwd(), switchWorkspace: async () => {}, onEvent: () => () => {} };
    const ctx = withServerGroups({ engine, runtime, chatStream, sseClients: [], paths: { APP_ROOT: process.cwd(), DATA_DIR: process.cwd(), PI_CONFIG_DIR: process.cwd(), SESSIONS_DIR: process.cwd(), FRONTEND_DIR: process.cwd(), FRONTEND_SRC_DIR: process.cwd(), HAS_BUILT_FRONTEND: false } });
    attachEngineEvents(engine, runtime, chatStream, ctx);
    const server = createServer((req, res) => { void dispatchRoute(req, res, ctx); });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = server.address().port;
    const run = async (message) => {
      await new Promise((resolve, reject) => { const request = http.request({ hostname: "127.0.0.1", port, path: "/api/chat", method: "POST", headers: { "content-type": "application/json" } }, (response) => { response.resume(); response.on("end", resolve); }); request.on("error", reject); request.end(JSON.stringify({ message })); });
      return new Promise((resolve, reject) => {
        const request = http.get({ hostname: "127.0.0.1", port, path: "/api/chat/stream" });
        let body = ""; request.on("response", (response) => { response.setEncoding("utf8"); response.on("data", (chunk) => { body += chunk; if (body.includes('"type":"done"')) { request.destroy(); resolve(body); } }); response.on("end", () => resolve(body)); }); request.on("error", (error) => error.code === "ECONNRESET" ? resolve(body) : reject(error));
      });
    };
    const first = await run("请按 checkpoint-a-verification 检查 agent/skills/skill-verification/SKILL.md 的状态和内容");
    assert.match(first, /"contractRevision":1/);
    const second = await run("继续查 parse 的实现源码");
    assert.match(second, /"contractRevision":2/, second);
    assert.match(second, /"userExpansion":true/, second);
    assert.match(second, /已展开到实现源码/);
    assert.equal(chatStream.taskRequirements.contract.kind, "diagnosis");
    assert.equal(prompts.length, 2);
    await new Promise((resolve) => server.close(resolve));
  });
});
