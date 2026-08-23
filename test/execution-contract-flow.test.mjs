import assert from "node:assert/strict";
import { createServer } from "node:http";
import * as http from "node:http";
import { describe, it } from "node:test";

import {
  agentToolToPIToolDefinition,
  defineAgentTool,
  structuredToolResult,
} from "../src/agent/types.ts";
import { authorizeExecutionContractAttempt, expandTaskRequirements, inferTaskRequirements } from "../src/server/task-lifecycle.ts";
import { formatExecutionContractGuidance } from "../src/server/task-lifecycle.ts";
import { skillFactsTool } from "../src/agent/tools/skill-facts.ts";
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

describe("A-17 execution contract cross-layer flow", () => {
  it("derives a bounded fact-verification contract from task A", () => {
    const requirements = inferTaskRequirements("请按 checkpoint-a-verification 检查 agent/skills/skill-verification/SKILL.md 的状态和内容");
    assert.equal(requirements.kind, "verification");
    assert.equal(requirements.contract?.kind, "fact_verification");
    assert.deepEqual(requirements.contract?.targets, ["agent/skills/skill-verification/SKILL.md"]);
    assert.deepEqual(requirements.contract?.allowedTools, ["file_read", "skill_facts"]);
    assert.deepEqual(requirements.contract?.instructionSources, ["agent/skills/checkpoint-a-verification/SKILL.md"]);
    assert.equal(requirements.contract?.onMissingEvidence, "report_unverified");
  });

  it("provides a bounded first-step control frame without widening evidence scope", () => {
    const requirements = inferTaskRequirements("请按 checkpoint-a-verification 检查 agent/skills/skill-verification/SKILL.md 的状态和内容");
    const guidance = formatExecutionContractGuidance(requirements);
    assert.match(guidance, /First read the requested target with file_read/);
    assert.match(guidance, /Then call skill_facts/);
    assert.match(guidance, /Do not use explorer_list/);
    assert.match(guidance, /instruction source only if needed/);
  });

  it("does not impose a fact contract on implementation or diagnosis requests", () => {
    assert.equal(inferTaskRequirements("请检查 src/server/agent-event-router.ts 并修复事件流 bug").contract, undefined);
    assert.equal(inferTaskRequirements("请读取 src/server/agent-event-router.ts").contract, undefined);
  });

  it("creates a new open-work contract revision only after explicit user expansion", () => {
    const requirements = inferTaskRequirements("请检查 agent/skills/skill-verification/SKILL.md 的状态");
    const expanded = expandTaskRequirements(requirements, "继续查 parse 的实现源码");
    assert.equal(expanded?.contract?.kind, "diagnosis");
    assert.equal(expanded?.contract?.revision, 2);
    assert.equal(expanded?.contract?.allowedSources, undefined);
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

  it("stops a strict contract before a tool call once all evidence fields are complete", () => {
    const contract = inferTaskRequirements("请检查 agent/skills/skill-verification/SKILL.md 的状态和内容").contract;
    const attempts = new Set();
    const decision = authorizeExecutionContractAttempt(contract, {
      status: "running", missingEvidence: [], phase: "answering", turnId: "turn", kind: "verification",
      requiresEvidence: true, successfulEvidence: 2, retryableFailures: 0, retryDecisions: [], phaseHistory: [],
    }, attempts, "file_read", { target: "agent/skills/skill-verification/SKILL.md", argsFingerprint: "same" });
    assert.equal(decision.allowed, false);
    assert.equal(decision.code, "execution_contract_complete");
    assert.equal(attempts.size, 0);
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
    assert.equal(done.status, "error");
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
    assert.equal(first.done?.status, "error");
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
    assert.match(second, /已展开到实现源码/);
    assert.equal(chatStream.taskRequirements.contract.kind, "diagnosis");
    assert.equal(prompts.length, 2);
    await new Promise((resolve) => server.close(resolve));
  });
});
