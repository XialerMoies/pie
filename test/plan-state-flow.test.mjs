import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { SessionManager } from "@xiamol/pi-coding-agent";

import {
  PLAN_STATE_CUSTOM_TYPE,
  defaultPlanState,
  persistPlanState,
  readPlanState,
  recoverPlanState,
  replacePlanState,
} from "../src/agent/plan-state.ts";
import { AgentRuntime } from "../src/agent/runtime.ts";
import { authorizeToolExecution } from "../src/agent/tool-registry.ts";
import { commandTool } from "../src/agent/tools/command.ts";
import { exitPlanModeTool } from "../src/agent/tools/plan-mode.ts";
import { PiAgentEngineAdapter } from "../src/agent-engine/pi-adapter.ts";
import { attachEngineEvents } from "../src/server/agent-event-router.ts";
import {
  createPlanExitConfirmCallback,
  handleChat,
  resolvePlanConfirmation,
} from "../src/server/routes/chat.ts";

function request(method, url, body) {
  const req = {
    method,
    url,
    headers: { host: "localhost", "content-type": "application/json" },
    on(event, callback) {
      if (event === "data" && body !== undefined) callback(Buffer.from(JSON.stringify(body)));
      if (event === "end") callback();
      return req;
    },
  };
  return req;
}

async function call(ctx, method, url, body) {
  const res = {
    status: 0,
    body: "",
    writeHead(status) { this.status = status; return this; },
    write(chunk) { this.body += String(chunk || ""); return true; },
    end(chunk) { if (chunk) this.body += String(chunk); },
  };
  const handled = await handleChat(request(method, url, body), res, ctx);
  await new Promise((resolveWait) => setImmediate(resolveWait));
  return { handled, status: res.status, body: JSON.parse(res.body || "null"), raw: res };
}

function runtimeHarness(streaming = false) {
  const runtime = Object.create(AgentRuntime.prototype);
  const entries = [];
  runtime._planState = defaultPlanState();
  runtime._planStateSubscriptions = new Set();
  runtime._eventSubscriptions = [];
  runtime.sessionManager = { appendCustomEntry(customType, data) { entries.push({ type: "custom", customType, data }); } };
  runtime._session = { isStreaming: streaming };
  return { runtime, entries };
}

describe("AP-07 planning lifecycle and permission separation", () => {
  it("persists complete replacement facts and restores the latest state", () => {
    const root = mkdtempSync(resolve(tmpdir(), "plan-state-flow-"));
    try {
      const manager = SessionManager.create(root, root);
      const active = replacePlanState(defaultPlanState(), "active", "user", { reason: "plan_requested" });
      const committed = replacePlanState(active, "committed", "user", { reason: "approved" });
      persistPlanState(manager, active);
      persistPlanState(manager, committed);
      manager.appendMessage({ role: "assistant", content: [], timestamp: Date.now() });
      const reopened = SessionManager.open(manager.getSessionFile(), undefined, root);
      assert.deepEqual(readPlanState(reopened.getEntries()), committed);
      assert.ok(reopened.getEntries().some((entry) => entry.type === "custom" && entry.customType === PLAN_STATE_CUSTOM_TYPE));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("queues streaming switches until a turn boundary and distinguishes no-op and cancellation", () => {
    const { runtime, entries } = runtimeHarness(true);
    const pending = runtime.requestPlanState("active", "user");
    assert.equal(pending.status, "pending");
    assert.equal(pending.pendingTarget, "active");
    assert.equal(runtime.requestPlanState("active", "user").revision, pending.revision, "same pending target must be a no-op");
    runtime._session.isStreaming = false;
    const active = runtime.commitPendingPlanState("agent_end");
    assert.equal(active.status, "active");
    assert.equal(runtime.requestPlanState("active").revision, active.revision, "same target must be a no-op");
    const cancelled = runtime.requestPlanState("cancelled", "user");
    assert.equal(cancelled.status, "cancelled");
    assert.equal(entries.length, 3);
  });

  it("settles interrupted pending states at the restore boundary", () => {
    const pendingTransition = replacePlanState(defaultPlanState(), "pending", "user", {
      pendingTarget: "active",
      reason: "queued_until_turn_boundary",
    });
    const restoredActive = recoverPlanState(pendingTransition);
    assert.equal(restoredActive.status, "active");
    assert.equal(restoredActive.source, "restore");
    assert.equal(restoredActive.reason, "pending_transition_committed_during_restore");

    const pendingApproval = replacePlanState(restoredActive, "pending", "agent", {
      pendingTarget: "committed",
      summary: "review this plan",
      reason: "awaiting_user_approval",
    });
    const restoredReview = recoverPlanState(pendingApproval);
    assert.equal(restoredReview.status, "active");
    assert.equal(restoredReview.summary, "review this plan");
    assert.equal(restoredReview.reason, "approval_interrupted_during_restore");
  });

  it("commits a queued switch through the existing runtime event subscription", () => {
    const { runtime } = runtimeHarness(true);
    let listener;
    let subscribeCalls = 0;
    const session = {
      isStreaming: true,
      subscribe(callback) {
        subscribeCalls += 1;
        listener = callback;
        return () => { listener = undefined; };
      },
    };
    runtime.session = session;
    const seen = [];
    const unsubscribe = runtime.onEvent((event) => seen.push(event.type));

    assert.equal(runtime.requestPlanState("active", "user").status, "pending");
    session.isStreaming = false;
    listener({ type: "agent_end" });

    assert.equal(runtime.planState.status, "active");
    assert.deepEqual(seen, ["agent_end"]);
    assert.equal(subscribeCalls, 1, "plan boundaries must reuse the canonical event subscription");
    unsubscribe();
  });

  it("replaces a queued selection with cancellation before the safe boundary", () => {
    const { runtime } = runtimeHarness(true);
    const pendingActive = runtime.requestPlanState("active", "user");
    const pendingCancelled = runtime.requestPlanState("cancelled", "user", "user_cancelled_pending_selection");

    assert.equal(pendingActive.status, "pending");
    assert.equal(pendingCancelled.status, "pending");
    assert.equal(pendingCancelled.pendingTarget, "cancelled");
    runtime._session.isStreaming = false;
    const cancelled = runtime.commitPendingPlanState("turn_boundary");
    assert.equal(cancelled.status, "cancelled");
    assert.equal(cancelled.reason, "turn_boundary");
  });

  it("blocks mutations before permission mode while preserving read-only exploration", async () => {
    const active = replacePlanState(defaultPlanState(), "active", "user");
    await assert.doesNotReject(() => authorizeToolExecution(commandTool, { command: "git status" }, {
      cwd: process.cwd(), sessionId: "plan-read", getPlanState: () => active, getPermissionMode: () => "yes",
    }));
    await assert.rejects(() => authorizeToolExecution(commandTool, { command: "npm install" }, {
      cwd: process.cwd(), sessionId: "plan-write", getPlanState: () => active, getPermissionMode: () => "yes",
    }), (error) => error?.code === "plan_state_mutation_blocked");
    await assert.doesNotReject(() => authorizeToolExecution(commandTool, { command: "npm install" }, {
      cwd: process.cwd(), sessionId: "committed-write", getPlanState: () => replacePlanState(active, "committed", "user"), getPermissionMode: () => "yes",
    }));
  });

  it("requires an explicit host approval result for exit_plan_mode", async () => {
    const active = replacePlanState(defaultPlanState(), "active", "agent");
    const denied = await exitPlanModeTool.execute({ summary: "step one" }, {
      cwd: process.cwd(), sessionId: "denied", getPlanState: () => active,
      requestPlanExit: async () => ({ approved: false, state: active }),
    });
    assert.equal(denied.outcome.status, "success");
    assert.equal(denied.data.approved, false);
    const committed = replacePlanState(active, "committed", "user");
    const approved = await exitPlanModeTool.execute({ summary: "step one" }, {
      cwd: process.cwd(), sessionId: "approved", getPlanState: () => active,
      requestPlanExit: async () => ({ approved: true, state: committed }),
    });
    assert.equal(approved.outcome.status, "success");
    assert.equal(approved.data.approved, true);
  });
});

describe("AP-07 HTTP, engine event, SSE, and approval flow", () => {
  it("round-trips plan state through HTTP without changing permission mode", async () => {
    let state = defaultPlanState();
    const engine = {
      get session() { return { id: "plan-http", workspace: process.cwd(), isStreaming: false, isCompacting: false, planState: state }; },
      async requestPlanState(target) { state = replacePlanState(state, target, "user"); return state; },
    };
    const permissionMode = { value: "dontAsk" };
    const ctx = { groups: {
      core: { engine, runtime: {}, chatStream: { response: null } },
      storage: { paths: { APP_ROOT: process.cwd() } },
      security: { permissionMode: { get: () => permissionMode.value } }, providers: {}, infra: {},
    } };
    const before = await call(ctx, "GET", "/api/plan-state");
    assert.equal(before.body.state.status, "committed");
    const changed = await call(ctx, "POST", "/api/plan-state", { target: "active" });
    assert.equal(changed.body.state.status, "active");
    assert.equal(permissionMode.value, "dontAsk");
  });

  it("emits a plan approval request and settles it only through the matching endpoint", async () => {
    const stream = {
      response: { writableEnded: false, destroyed: false, write() {} },
      eventSeq: 0,
      eventHistory: [],
    };
    const confirm = createPlanExitConfirmCallback(stream);
    const pending = confirm({ requestId: "request-1", summary: "inspect then edit" });
    const frame = stream.eventHistory.at(-1).data;
    const event = JSON.parse(frame.split("data: ")[1]);
    assert.equal(event.type, "plan_confirm");
    assert.equal(resolvePlanConfirmation("wrong-id", true), false);
    assert.equal(resolvePlanConfirmation(event.id, false), true);
    assert.equal(await pending, false);
  });

  it("publishes plan.changed independently of permission state in the engine snapshot", () => {
    const listeners = new Set();
    const planListeners = new Set();
    let state = defaultPlanState();
    const runtime = {
      currentWorkspace: process.cwd(),
      session: { sessionManager: { getSessionId: () => "engine-plan" }, messages: [], isStreaming: false, isCompacting: false, agent: { state: { tools: [] } } },
      modelRegistry: { find() {} }, activeProfile: { id: "standard", revision: 1 }, activeProfileLifecycle: undefined,
      get planState() { return state; },
      onPlanStateChange(callback) { planListeners.add(callback); return () => planListeners.delete(callback); },
      onEvent(callback) { listeners.add(callback); return () => listeners.delete(callback); },
      getContextUsageSnapshot() {}, runWithStableSession: async (operation) => operation(),
      switchWorkspace: async () => {}, openSession: async () => {}, createNewSession: async () => "", switchProfile: async () => ({ id: "standard", revision: 1 }),
      requestPlanState(target) { state = replacePlanState(state, target, "user"); for (const callback of planListeners) callback(state); return state; },
      syncModelProviders: async () => 0, dispose() {},
    };
    const engine = new PiAgentEngineAdapter(runtime);
    const events = [];
    engine.subscribe((event) => events.push(event));
    engine.requestPlanState("active");
    assert.equal(engine.session.planState.status, "active");
    assert.equal(events.at(-1).type, "plan.changed");
    assert.equal(events.at(-1).state.status, "active");
    engine.dispose();
  });

  it("streams and replays the complete plan state through the canonical server bridge", () => {
    let listener;
    const state = replacePlanState(defaultPlanState(), "active", "user", { reason: "route_flow" });
    const engine = {
      session: { id: "plan-sse", workspace: process.cwd(), isStreaming: false, isCompacting: false, planState: state },
      subscribe(callback) { listener = callback; return () => { listener = undefined; }; },
    };
    const stream = {
      textBuffer: "", thinkingBuffer: "", response: null, turnId: "", traceId: "", traceSeq: 0,
      emittedTraces: new Set(), blocks: [], blockSeq: 0, eventSeq: 0, eventHistory: [],
    };
    attachEngineEvents(engine, { session: { sessionFile: undefined, sessionManager: {} } }, stream, {
      groups: { core: { appEvents: { publish() {} } }, security: {}, storage: { paths: {} }, providers: {}, infra: {} },
    });
    listener({ version: 1, type: "plan.changed", sessionId: "plan-sse", turnId: "", seq: 1, timestamp: 1, state });
    const payload = JSON.parse(stream.eventHistory.at(-1).data.split("data: ")[1]);
    assert.equal(payload.type, "plan_state");
    assert.deepEqual(payload.state, state);
  });
});
