import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  READ_ONLY_SUBAGENT_TOOLS,
  SubagentSupervisor,
} from "../src/server/subagent-supervisor.ts";

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function waitFor(predicate, message = "condition was not reached") {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.fail(message);
}

class ManualTimers {
  constructor() {
    this.entries = [];
    this.nextId = 1;
  }

  setTimeout = (callback, delay) => {
    const entry = { id: this.nextId++, callback, delay, cleared: false, fired: false };
    this.entries.push(entry);
    return entry.id;
  };

  clearTimeout = (id) => {
    const entry = this.entries.find((candidate) => candidate.id === id);
    if (entry) entry.cleared = true;
  };

  pending(delay) {
    return this.entries.filter((entry) => (
      !entry.cleared && !entry.fired && (delay === undefined || entry.delay === delay)
    ));
  }

  fire(entry) {
    assert.ok(entry, "expected a pending timer");
    assert.strictEqual(entry.cleared, false, "cannot fire a cleared timer");
    entry.fired = true;
    entry.callback();
  }
}

function assistantMessage({ summary, findings = [], evidence = [], usage = {} }) {
  return {
    role: "assistant",
    content: [{
      type: "text",
      text: JSON.stringify({ summary, findings, evidence }),
    }],
    usage: {
      input: usage.input ?? 0,
      output: usage.output ?? 0,
      cacheRead: usage.cacheRead ?? 0,
      cacheWrite: usage.cacheWrite ?? 0,
      cost: { total: usage.cost ?? 0 },
    },
  };
}

function makeFakeSession(label) {
  const listeners = new Set();
  const promptGate = deferred();
  let promptSettled = false;

  const session = {
    label,
    messages: [],
    prompts: [],
    abortCalls: 0,
    disposeCalls: 0,
    unsubscribeCalls: 0,

    subscribe(listener) {
      listeners.add(listener);
      let subscribed = true;
      return () => {
        if (!subscribed) return;
        subscribed = false;
        session.unsubscribeCalls += 1;
        listeners.delete(listener);
      };
    },

    async prompt(prompt) {
      session.prompts.push(prompt);
      return promptGate.promise;
    },

    async abort() {
      session.abortCalls += 1;
      if (!promptSettled) {
        promptSettled = true;
        promptGate.resolve();
      }
    },

    dispose() {
      session.disposeCalls += 1;
    },

    emit(event) {
      for (const listener of [...listeners]) listener(event);
    },

    emitAssistant(payload) {
      const message = assistantMessage(payload);
      session.messages.push(message);
      session.emit({ type: "message_end", message });
      return message;
    },

    complete(payload = { summary: `${label} complete` }) {
      if (promptSettled) return;
      session.emitAssistant(payload);
      promptSettled = true;
      promptGate.resolve();
    },

    fail(error = new Error(`${label} failed`)) {
      if (promptSettled) return;
      promptSettled = true;
      promptGate.reject(error);
    },

    get listenerCount() {
      return listeners.size;
    },
  };

  return session;
}

function makeHarness(options = {}) {
  const timers = new ManualTimers();
  const factoryCalls = [];
  const sessions = new Map();

  const sessionFactory = async (options) => {
    factoryCalls.push(options);
    const session = makeFakeSession(options.task.prompt);
    sessions.set(options.task.prompt, session);
    return session;
  };

  const supervisor = new SubagentSupervisor({
    sessionFactory,
    onEvent: options.onEvent,
    timers: {
      setTimeout: timers.setTimeout,
      clearTimeout: timers.clearTimeout,
    },
  });

  return {
    supervisor,
    timers,
    factoryCalls,
    sessions,
    sessionFor(prompt) {
      const session = sessions.get(prompt);
      assert.ok(session, `session for ${prompt} should exist`);
      return session;
    },
  };
}

function task(prompt, overrides = {}) {
  return {
    profile: "explorer",
    prompt,
    focusPaths: [],
    deliverable: "Return findings with evidence.",
    ...overrides,
  };
}

async function completeAllAsTheyStart(harness, prompts) {
  const remaining = new Set(prompts);
  while (remaining.size > 0) {
    await waitFor(
      () => [...remaining].some((prompt) => harness.sessions.has(prompt)),
      "the next queued task did not start",
    );
    for (const prompt of [...remaining]) {
      const session = harness.sessions.get(prompt);
      if (!session) continue;
      session.complete({ summary: `${prompt} done` });
      remaining.delete(prompt);
    }
    await new Promise((resolve) => setImmediate(resolve));
  }
}

describe("SubagentSupervisor concurrency and identity", () => {
  it("emits ordered batch, task, progress, and terminal events outside the main turn namespace", async () => {
    const events = [];
    const harness = makeHarness({ onEvent: (event) => events.push(event) });
    const batch = harness.supervisor.startBatch({
      workspace: "/repo",
      maxConcurrent: 1,
      tasks: [task("event-a"), task("event-b")],
    });

    await waitFor(() => harness.factoryCalls.length === 1);
    const first = harness.sessionFor("event-a");
    first.emit({
      type: "tool_execution_start",
      toolCallId: "call-1",
      toolName: "search",
      args: { query: "secret input must not be copied" },
    });
    first.emit({ type: "turn_end", turnIndex: 1 });
    first.complete({ summary: "A done" });
    await waitFor(() => harness.factoryCalls.length === 2);
    harness.sessionFor("event-b").complete({ summary: "B done" });
    await batch.result;

    assert.deepEqual(events.map((item) => item.seq), events.map((_, index) => index + 1));
    assert.equal(events[0].kind, "batch_started");
    assert.equal(events[0].taskId, null);
    assert.deepEqual(
      events.filter((item) => item.kind === "task_queued").map((item) => item.taskId),
      batch.taskIds,
    );
    assert.deepEqual(
      events.filter((item) => item.kind === "task_started").map((item) => item.taskId),
      batch.taskIds,
    );
    assert.ok(events.some((item) => (
      item.kind === "task_progress"
      && item.taskId === batch.taskIds[0]
      && item.payload.phase === "tool"
      && item.payload.toolName === "search"
    )));
    assert.deepEqual(
      events.filter((item) => item.kind === "task_completed").map((item) => item.status),
      ["completed", "completed"],
    );
    assert.equal(events.at(-1).kind, "batch_completed");
    assert.equal(events.at(-1).status, "completed");
    assert.ok(events.every((item) => !("turnId" in item)));
  });

  it("defaults to two concurrent tasks and queues the remainder", async () => {
    const harness = makeHarness();
    const batch = harness.supervisor.startBatch({
      workspace: "/repo",
      tasks: [task("a"), task("b"), task("c")],
    });

    await waitFor(() => harness.factoryCalls.length === 2);
    assert.deepStrictEqual(harness.factoryCalls.map((call) => call.task.prompt), ["a", "b"]);
    assert.deepStrictEqual(harness.factoryCalls[0].limits, {
      timeoutSeconds: 300,
      maxTurns: 20,
      maxToolCalls: 50,
    });
    assert.strictEqual(harness.supervisor.getTask(batch.taskIds[2]).status, "queued");

    harness.sessionFor("a").complete({ summary: "a done" });
    await waitFor(() => harness.factoryCalls.length === 3);
    assert.strictEqual(harness.factoryCalls[2].task.prompt, "c");

    harness.sessionFor("b").complete({ summary: "b done" });
    harness.sessionFor("c").complete({ summary: "c done" });
    const result = await batch.result;

    assert.strictEqual(result.status, "completed");
    assert.deepStrictEqual(result.tasks.map((item) => item.status), [
      "completed",
      "completed",
      "completed",
    ]);
  });

  it("clamps maxConcurrent to the inclusive range 1..30", async () => {
    const lower = makeHarness();
    const lowPrompts = ["low-a", "low-b", "low-c"];
    const lowBatch = lower.supervisor.startBatch({
      workspace: "/repo",
      maxConcurrent: 0,
      tasks: lowPrompts.map((prompt) => task(prompt)),
    });

    await waitFor(() => lower.factoryCalls.length === 1);
    await new Promise((resolve) => setImmediate(resolve));
    assert.strictEqual(lower.factoryCalls.length, 1, "values below 1 must run one task at a time");
    const lowCompletion = completeAllAsTheyStart(lower, lowPrompts);
    await Promise.all([lowCompletion, lowBatch.result]);

    const upper = makeHarness();
    const highPrompts = Array.from({ length: 31 }, (_, index) => `high-${index}`);
    const highBatch = upper.supervisor.startBatch({
      workspace: "/repo",
      maxConcurrent: 99,
      tasks: highPrompts.map((prompt) => task(prompt)),
    });

    await waitFor(() => upper.factoryCalls.length === 30);
    await new Promise((resolve) => setImmediate(resolve));
    assert.strictEqual(upper.factoryCalls.length, 30, "values above 30 must run at most thirty tasks");
    const highCompletion = completeAllAsTheyStart(upper, highPrompts);
    await Promise.all([highCompletion, highBatch.result]);
  });

  it("exposes stable batchId/taskId mappings while queued, running, and completed", async () => {
    const harness = makeHarness();
    const batch = harness.supervisor.startBatch({
      workspace: "/repo",
      maxConcurrent: 1,
      tasks: [task("mapped-a"), task("mapped-b")],
    });

    assert.ok(batch.batchId);
    assert.strictEqual(batch.taskIds.length, 2);
    assert.strictEqual(new Set(batch.taskIds).size, 2);
    assert.deepStrictEqual(harness.supervisor.getBatch(batch.batchId).taskIds, batch.taskIds);
    assert.strictEqual(harness.supervisor.getTask(batch.taskIds[0]).batchId, batch.batchId);
    assert.strictEqual(harness.supervisor.getTask(batch.taskIds[1]).batchId, batch.batchId);

    await waitFor(() => harness.factoryCalls.length === 1);
    assert.strictEqual(harness.supervisor.getTask(batch.taskIds[0]).status, "running");
    assert.strictEqual(harness.supervisor.getTask(batch.taskIds[1]).status, "queued");

    harness.sessionFor("mapped-a").complete({ summary: "first" });
    await waitFor(() => harness.factoryCalls.length === 2);
    harness.sessionFor("mapped-b").complete({ summary: "second" });
    await batch.result;

    assert.strictEqual(harness.supervisor.getTask(batch.taskIds[0]).status, "completed");
    assert.strictEqual(harness.supervisor.getTask(batch.taskIds[1]).status, "completed");
    assert.strictEqual(harness.supervisor.getBatch(batch.batchId).status, "completed");
  });

  it("snapshots queued task input before the caller can mutate it", async () => {
    const harness = makeHarness();
    const queued = task("snapshot", {
      focusPaths: ["src/original.ts"],
      model: { provider: "p", id: "original" },
    });
    const batch = harness.supervisor.startBatch({
      workspace: "/repo",
      maxConcurrent: 1,
      tasks: [task("blocker"), queued],
    });
    queued.prompt = "mutated";
    queued.focusPaths[0] = "src/mutated.ts";
    queued.model.id = "mutated";

    await waitFor(() => harness.factoryCalls.length === 1);
    harness.sessionFor("blocker").complete({ summary: "done" });
    await waitFor(() => harness.factoryCalls.length === 2);
    assert.deepStrictEqual(harness.factoryCalls[1].task, {
      profile: "explorer",
      prompt: "snapshot",
      focusPaths: ["src/original.ts"],
      deliverable: "Return findings with evidence.",
      model: { provider: "p", id: "original" },
    });
    harness.sessionFor("snapshot").complete({ summary: "done" });
    await batch.result;
  });
});

describe("SubagentSupervisor limits and cooperative cancellation", () => {
  it("clamps each task timeout to 30..3600 seconds and aborts the timed-out session", async () => {
    const harness = makeHarness();
    const low = harness.supervisor.startBatch({
      workspace: "/repo",
      timeoutSeconds: 1,
      tasks: [task("timeout-low")],
    });
    const high = harness.supervisor.startBatch({
      workspace: "/repo",
      timeoutSeconds: 99_999,
      tasks: [task("timeout-high")],
    });

    await waitFor(() => harness.factoryCalls.length === 2);
    assert.deepStrictEqual(
      harness.factoryCalls.map((call) => call.limits.timeoutSeconds),
      [30, 3600],
    );
    assert.strictEqual(harness.timers.pending(30_000).length, 1);
    assert.strictEqual(harness.timers.pending(3_600_000).length, 1);

    harness.timers.fire(harness.timers.pending(30_000)[0]);
    harness.timers.fire(harness.timers.pending(3_600_000)[0]);
    const [lowResult, highResult] = await Promise.all([low.result, high.result]);

    assert.strictEqual(harness.sessionFor("timeout-low").abortCalls, 1);
    assert.strictEqual(harness.sessionFor("timeout-high").abortCalls, 1);
    assert.strictEqual(lowResult.tasks[0].status, "timed_out");
    assert.strictEqual(highResult.tasks[0].status, "timed_out");
  });

  it("starts the timeout before asynchronous session creation", async () => {
    const timers = new ManualTimers();
    const creation = deferred();
    const session = makeFakeSession("slow-factory");
    const supervisor = new SubagentSupervisor({
      sessionFactory: () => creation.promise,
      timers: { setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout },
    });
    const batch = supervisor.startBatch({ workspace: "/repo", tasks: [task("slow-factory")] });

    assert.strictEqual(timers.pending(300_000).length, 1);
    timers.fire(timers.pending(300_000)[0]);
    creation.resolve(session);
    const result = await batch.result;

    assert.strictEqual(result.tasks[0].status, "timed_out");
    assert.strictEqual(session.prompts.length, 0);
    assert.strictEqual(session.disposeCalls, 1);
  });

  it("clamps maxTurns to 1..100 and aborts when the effective limit is reached", async () => {
    const harness = makeHarness();
    const low = harness.supervisor.startBatch({
      workspace: "/repo",
      maxTurns: 0,
      tasks: [task("turn-low")],
    });
    const high = harness.supervisor.startBatch({
      workspace: "/repo",
      maxTurns: 999,
      tasks: [task("turn-high")],
    });

    await waitFor(() => harness.factoryCalls.length === 2);
    assert.deepStrictEqual(harness.factoryCalls.map((call) => call.limits.maxTurns), [1, 100]);

    harness.sessionFor("turn-low").emit({ type: "turn_end", turnIndex: 1 });
    await waitFor(() => harness.sessionFor("turn-low").abortCalls === 1);

    for (let index = 1; index < 100; index += 1) {
      harness.sessionFor("turn-high").emit({ type: "turn_end", turnIndex: index });
    }
    assert.strictEqual(harness.sessionFor("turn-high").abortCalls, 0);
    harness.sessionFor("turn-high").emit({ type: "turn_end", turnIndex: 100 });
    await waitFor(() => harness.sessionFor("turn-high").abortCalls === 1);

    const [lowResult, highResult] = await Promise.all([low.result, high.result]);
    assert.strictEqual(lowResult.tasks[0].status, "limit_reached");
    assert.strictEqual(lowResult.tasks[0].limit, "maxTurns");
    assert.strictEqual(highResult.tasks[0].status, "limit_reached");
    assert.strictEqual(highResult.tasks[0].limit, "maxTurns");
  });

  it("does not double-count message_end and turn_end for the same turn", async () => {
    const harness = makeHarness();
    const batch = harness.supervisor.startBatch({
      workspace: "/repo",
      maxTurns: 2,
      tasks: [task("turn-events")],
    });
    await waitFor(() => harness.factoryCalls.length === 1);
    const session = harness.sessionFor("turn-events");

    session.emitAssistant({ summary: "turn one" });
    session.emit({ type: "turn_end" });
    assert.strictEqual(session.abortCalls, 0);
    session.emitAssistant({ summary: "turn two" });
    session.emit({ type: "turn_end" });
    await waitFor(() => session.abortCalls === 1);

    const result = await batch.result;
    assert.strictEqual(result.tasks[0].usage.turns, 2);
  });

  it("clamps maxToolCalls to 1..500 and aborts when the effective limit is reached", async () => {
    const harness = makeHarness();
    const low = harness.supervisor.startBatch({
      workspace: "/repo",
      maxToolCalls: -5,
      tasks: [task("tools-low")],
    });
    const high = harness.supervisor.startBatch({
      workspace: "/repo",
      maxToolCalls: 50_000,
      tasks: [task("tools-high")],
    });

    await waitFor(() => harness.factoryCalls.length === 2);
    assert.deepStrictEqual(harness.factoryCalls.map((call) => call.limits.maxToolCalls), [1, 500]);

    harness.sessionFor("tools-low").emit({
      type: "tool_execution_start",
      toolCallId: "low-1",
      toolName: "search",
      args: {},
    });
    await waitFor(() => harness.sessionFor("tools-low").abortCalls === 1);

    for (let index = 1; index < 500; index += 1) {
      harness.sessionFor("tools-high").emit({
        type: "tool_execution_start",
        toolCallId: `high-${index}`,
        toolName: "file_read",
        args: {},
      });
    }
    assert.strictEqual(harness.sessionFor("tools-high").abortCalls, 0);
    harness.sessionFor("tools-high").emit({
      type: "tool_execution_start",
      toolCallId: "high-500",
      toolName: "file_read",
      args: {},
    });
    await waitFor(() => harness.sessionFor("tools-high").abortCalls === 1);

    const [lowResult, highResult] = await Promise.all([low.result, high.result]);
    assert.strictEqual(lowResult.tasks[0].status, "limit_reached");
    assert.strictEqual(lowResult.tasks[0].limit, "maxToolCalls");
    assert.strictEqual(highResult.tasks[0].status, "limit_reached");
    assert.strictEqual(highResult.tasks[0].limit, "maxToolCalls");
  });

  it("abortTask stops only the addressed task", async () => {
    const harness = makeHarness();
    const batch = harness.supervisor.startBatch({
      workspace: "/repo",
      tasks: [task("abort-one"), task("keep-running")],
    });

    await waitFor(() => harness.factoryCalls.length === 2);
    assert.strictEqual(await harness.supervisor.abortTask(batch.taskIds[0]), true);
    assert.strictEqual(harness.sessionFor("abort-one").abortCalls, 1);
    assert.strictEqual(harness.sessionFor("keep-running").abortCalls, 0);

    harness.sessionFor("keep-running").complete({ summary: "survived" });
    const result = await batch.result;
    assert.deepStrictEqual(result.tasks.map((item) => item.status), ["aborted", "completed"]);
  });

  it("abortBatch aborts active tasks and cancels queued tasks without creating sessions", async () => {
    const harness = makeHarness();
    const batch = harness.supervisor.startBatch({
      workspace: "/repo",
      tasks: [task("batch-a"), task("batch-b"), task("batch-c"), task("batch-d")],
    });

    await waitFor(() => harness.factoryCalls.length === 2);
    assert.strictEqual(await harness.supervisor.abortBatch(batch.batchId), true);
    const result = await batch.result;

    assert.strictEqual(harness.factoryCalls.length, 2, "queued tasks must not create sessions after abort");
    assert.strictEqual(harness.sessionFor("batch-a").abortCalls, 1);
    assert.strictEqual(harness.sessionFor("batch-b").abortCalls, 1);
    assert.deepStrictEqual(result.tasks.map((item) => item.status), [
      "aborted",
      "aborted",
      "aborted",
      "aborted",
    ]);
  });
});

describe("SubagentSupervisor results and lifecycle", () => {
  it("returns every task after partial failure and aggregates usage from successful and failed tasks", async () => {
    const harness = makeHarness();
    const batch = harness.supervisor.startBatch({
      workspace: "/repo",
      tasks: [task("result-a"), task("result-b")],
    });

    await waitFor(() => harness.factoryCalls.length === 2);
    harness.sessionFor("result-a").emit({
      type: "tool_execution_start",
      toolCallId: "tool-a",
      toolName: "search",
      args: {},
    });
    harness.sessionFor("result-a").complete({
      summary: "A summary",
      findings: ["A finding"],
      evidence: ["src/a.ts:10"],
      usage: { input: 10, output: 4, cacheRead: 2, cacheWrite: 1, cost: 0.25 },
    });

    harness.sessionFor("result-b").emit({
      type: "tool_execution_start",
      toolCallId: "tool-b",
      toolName: "git-status",
      args: {},
    });
    harness.sessionFor("result-b").emitAssistant({
      summary: "B partial output",
      findings: ["B partial finding"],
      usage: { input: 3, output: 1, cost: 0.1 },
    });
    harness.sessionFor("result-b").fail(new Error("provider unavailable"));

    const result = await batch.result;
    assert.strictEqual(result.status, "partial");
    assert.strictEqual(result.tasks.length, 2);
    assert.deepStrictEqual(result.tasks.map((item) => item.taskId), batch.taskIds);
    assert.deepStrictEqual(result.tasks[0], {
      taskId: batch.taskIds[0],
      status: "completed",
      summary: "A summary",
      findings: ["A finding"],
      evidence: ["src/a.ts:10"],
      usage: {
        input: 10,
        output: 4,
        cacheRead: 2,
        cacheWrite: 1,
        cost: 0.25,
        turns: 1,
        toolCalls: 1,
      },
    });
    assert.strictEqual(result.tasks[1].status, "failed");
    assert.strictEqual(result.tasks[1].error, "provider unavailable");
    assert.strictEqual(result.tasks[1].summary, "B partial output");
    assert.deepStrictEqual(result.tasks[1].findings, ["B partial finding"]);
    assert.deepStrictEqual(result.tasks[1].evidence, []);
    assert.deepStrictEqual(result.usage, {
      input: 13,
      output: 5,
      cacheRead: 2,
      cacheWrite: 1,
      cost: 0.35,
      turns: 2,
      toolCalls: 2,
    });
  });

  it("unsubscribes and disposes each session after its task settles", async () => {
    const harness = makeHarness();
    const batch = harness.supervisor.startBatch({
      workspace: "/repo",
      tasks: [task("dispose-success"), task("dispose-failure")],
    });

    await waitFor(() => harness.factoryCalls.length === 2);
    harness.sessionFor("dispose-success").complete({ summary: "done" });
    harness.sessionFor("dispose-failure").fail(new Error("failed"));
    await batch.result;

    for (const prompt of ["dispose-success", "dispose-failure"]) {
      const session = harness.sessionFor(prompt);
      assert.strictEqual(session.unsubscribeCalls, 1);
      assert.strictEqual(session.listenerCount, 0);
      assert.strictEqual(session.disposeCalls, 1);
    }
  });

  it("releases completed batch and task mappings on request", async () => {
    const harness = makeHarness();
    const batch = harness.supervisor.startBatch({ workspace: "/repo", tasks: [task("release")] });
    await waitFor(() => harness.factoryCalls.length === 1);
    harness.sessionFor("release").complete({ summary: "done" });
    await batch.result;

    assert.strictEqual(harness.supervisor.releaseBatch(batch.batchId), true);
    assert.strictEqual(harness.supervisor.getBatch(batch.batchId), undefined);
    assert.strictEqual(harness.supervisor.getTask(batch.taskIds[0]), undefined);
    assert.strictEqual(harness.supervisor.releaseBatch(batch.batchId), false);
  });

  it("dispose aborts active work, cancels queued work, and releases all created sessions", async () => {
    const harness = makeHarness();
    const batch = harness.supervisor.startBatch({
      workspace: "/repo",
      maxConcurrent: 1,
      tasks: [task("dispose-active"), task("dispose-queued")],
    });

    await waitFor(() => harness.factoryCalls.length === 1);
    await harness.supervisor.dispose();
    const result = await batch.result;

    assert.strictEqual(harness.factoryCalls.length, 1);
    assert.strictEqual(harness.sessionFor("dispose-active").abortCalls, 1);
    assert.strictEqual(harness.sessionFor("dispose-active").disposeCalls, 1);
    assert.deepStrictEqual(result.tasks.map((item) => item.status), ["aborted", "aborted"]);
  });

  it("concurrent dispose callers wait for the same in-flight cleanup", async () => {
    const cleanup = deferred();
    const session = makeFakeSession("dispose-shared");
    session.dispose = () => cleanup.promise;
    const supervisor = new SubagentSupervisor({ sessionFactory: () => session });
    supervisor.startBatch({ workspace: "/repo", tasks: [task("dispose-shared")] });
    await waitFor(() => session.prompts.length === 1);

    const first = supervisor.dispose();
    await waitFor(() => session.abortCalls === 1);
    let secondSettled = false;
    const second = supervisor.dispose().then(() => { secondSettled = true; });
    await new Promise((resolve) => setImmediate(resolve));
    assert.strictEqual(secondSettled, false);

    cleanup.resolve();
    await Promise.all([first, second]);
  });

  it("passes an explicit read-only tool whitelist to the session factory and excludes delegation", async () => {
    const harness = makeHarness();
    const batch = harness.supervisor.startBatch({
      workspace: "/repo",
      tasks: [task("readonly")],
    });

    await waitFor(() => harness.factoryCalls.length === 1);
    const tools = harness.factoryCalls[0].tools;
    assert.deepStrictEqual(tools, READ_ONLY_SUBAGENT_TOOLS);
    assert.deepStrictEqual(tools, [
      "git-status",
      "search",
      "file_read",
      "explorer_list",
      "git_log",
      "file_outline",
    ]);

    for (const forbidden of [
      "delegate_tasks",
      "command",
      "file_write",
      "str_replace_editor",
      "write_memory",
      "write_agent_md",
      "bash",
      "edit",
      "write",
    ]) {
      assert.ok(!tools.includes(forbidden), `${forbidden} must not be delegated to a subagent`);
    }

    harness.sessionFor("readonly").complete({ summary: "read-only complete" });
    await batch.result;

    const delegatedPrompt = harness.sessionFor("readonly").prompts[0];
    assert.match(delegatedPrompt, /readonly/);
    assert.match(delegatedPrompt, /Return findings with evidence\./);
  });
});
