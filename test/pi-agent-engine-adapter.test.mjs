import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { PiAgentEngineAdapter } from "../src/agent-engine/pi-adapter.ts";

function createRuntime() {
  let listener;
  let aborts = 0;
  let prompts = [];
  let usage = {
    tokens: 20,
    contextWindow: 100,
    percent: 20,
    source: "exact",
    exactTokens: 20,
    estimatedTokens: 0,
  };
  const session = {
    sessionFile: "E:\\sessions\\session-1.jsonl",
    sessionManager: { getSessionId: () => "session-1" },
    model: { provider: "openai", id: "gpt-test", name: "GPT Test", contextWindow: 100, maxTokens: 20, reasoning: true, input: ["text"] },
    isStreaming: false,
    isCompacting: false,
    async prompt(message) { prompts.push(message); },
    async steer() {},
    async followUp() {},
    abort() { aborts += 1; },
    async compact() {},
    async setModel(model) { this.model = model; },
    setThinkingLevel() {},
  };
  const runtime = {
    currentWorkspace: "E:\\workspace",
    session,
    modelRegistry: { find: () => session.model },
    onEvent(callback) { listener = callback; return () => { listener = undefined; }; },
    emit(event, source = session) { listener?.(event, source); },
    getContextUsageSnapshot() { return usage; },
    setUsage(next) { usage = next; },
    async runWithStableSession(operation) { return operation(); },
    async switchWorkspace(workspace) { this.currentWorkspace = workspace; },
    async openSession(_file, workspace) { this.currentWorkspace = workspace; },
    async createNewSession() { return "session-2"; },
    async syncModelProviders() { return 3; },
    dispose() {},
    get aborts() { return aborts; },
    get prompts() { return prompts; },
  };
  return runtime;
}

function adapter(runtime) {
  let now = 1_700_000_000_000;
  return new PiAgentEngineAdapter(runtime, {
    id: "engine-1",
    clock: () => now++,
    turnId: () => "generated-turn",
  });
}

describe("PiAgentEngineAdapter", () => {
  it("exposes an AgentEngine initializer from the agent boundary", async () => {
    const agent = await import("../src/agent/index.ts");
    assert.equal(typeof agent.initEngine, "function");
  });

  it("maps PI lifecycle, content, tool, usage, and completion events", () => {
    const runtime = createRuntime();
    const engine = adapter(runtime);
    const events = [];
    engine.subscribe((event) => events.push(event));

    runtime.emit({ type: "agent_start" });
    runtime.emit({
      type: "message_update",
      message: { role: "assistant", content: [{ type: "text", text: "hello" }] },
      assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "hello" },
    });
    runtime.emit({ type: "tool_execution_start", toolCallId: "call-1", toolName: "search", args: { query: "x" } });
    runtime.emit({ type: "tool_execution_update", toolCallId: "call-1", toolName: "search", partialResult: "working" });
    runtime.emit({ type: "tool_execution_end", toolCallId: "call-1", toolName: "search", result: "done", isError: false });
    runtime.emit({
      type: "agent_end",
      messages: [{
        role: "assistant",
        stopReason: "stop",
        usage: { input: 10, output: 5, cacheRead: 2, cacheWrite: 1, reasoning: 3, cost: { total: 0.25 } },
      }],
    });

    assert.deepEqual(events.map((event) => event.type), [
      "turn.started",
      "content.delta",
      "tool.started",
      "tool.updated",
      "tool.completed",
      "usage.updated",
      "turn.completed",
    ]);
    assert.equal(events.every((event, index) => event.seq === index + 1), true);
    assert.equal(events.at(-1).usage.cost.amount, 0.25);
    assert.equal(events.at(-1).usage.source, "exact");
  });

  it("preserves assistant message/content boundaries for node reconstruction", () => {
    const runtime = createRuntime();
    const engine = adapter(runtime);
    const events = [];
    engine.subscribe((event) => events.push(event));

    runtime.emit({ type: "agent_start" });
    runtime.emit({ type: "message_start", message: { role: "assistant" } });
    runtime.emit({
      type: "message_update",
      message: { role: "assistant", content: [{ type: "thinking", thinking: "first" }] },
      assistantMessageEvent: { type: "thinking_start", contentIndex: 0 },
    });
    runtime.emit({
      type: "message_update",
      message: { role: "assistant", content: [{ type: "thinking", thinking: "first" }] },
      assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "first" },
    });
    runtime.emit({ type: "message_start", message: { role: "assistant" } });
    runtime.emit({
      type: "message_update",
      message: { role: "assistant", content: [{ type: "thinking", thinking: "second" }] },
      assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "second" },
    });

    const thinking = events.filter((event) => event.type === "thinking.delta");
    assert.deepEqual(thinking.map((event) => ({ messageSeq: event.messageSeq, contentIndex: event.contentIndex, phase: event.phase })), [
      { messageSeq: 1, contentIndex: 0, phase: "start" },
      { messageSeq: 1, contentIndex: 0, phase: "delta" },
      { messageSeq: 2, contentIndex: 0, phase: "start" },
    ]);
  });

  it("makes cancellation idempotent and suppresses a later completed terminal", async () => {
    const runtime = createRuntime();
    const engine = adapter(runtime);
    const events = [];
    engine.subscribe((event) => events.push(event));
    await engine.prompt({ message: "cancel me", turnId: "turn-cancel" });
    runtime.emit({ type: "agent_start" });

    assert.equal(await engine.cancel("turn-cancel"), true);
    assert.equal(await engine.cancel("turn-cancel"), false);
    runtime.emit({ type: "agent_end", messages: [{ role: "assistant", stopReason: "stop" }] });

    assert.equal(runtime.aborts, 1);
    assert.deepEqual(events.filter((event) => event.type.startsWith("turn.")).map((event) => event.type), [
      "turn.started",
      "turn.cancelled",
    ]);
  });

  it("preserves the runtime receiver for prompt steering and follow-up", async () => {
    const runtime = createRuntime();
    const receivers = [];
    runtime.runWithStableSession = async function (operation) {
      receivers.push(this);
      return operation();
    };
    const engine = adapter(runtime);
    await engine.prompt({ message: "receiver check" });
    await engine.steer("steer check");
    await engine.followUp("follow-up check");
    assert.deepEqual(receivers, [runtime, runtime, runtime]);
  });

  it("pairs compaction usage and ignores stale session events", () => {
    const runtime = createRuntime();
    const engine = adapter(runtime);
    const events = [];
    engine.subscribe((event) => events.push(event));
    runtime.emit({ type: "compaction_start" });
    runtime.setUsage({ tokens: 8, contextWindow: 100, percent: 8, source: "estimated", exactTokens: 0, estimatedTokens: 8 });
    runtime.emit({ type: "compaction_end" });
    runtime.emit({ type: "agent_start" }, { sessionManager: { getSessionId: () => "stale" } });

    const started = events.find((event) => event.type === "compaction.started");
    const completed = events.find((event) => event.type === "compaction.completed");
    assert.equal(started.before.input, 20);
    assert.equal(completed.before.input, 20);
    assert.equal(completed.after.input, 8);
    assert.equal(events.some((event) => event.sessionId === "stale"), false);
  });

  it("turns unknown PI events into bounded diagnostics", () => {
    const runtime = createRuntime();
    const engine = adapter(runtime);
    const events = [];
    engine.subscribe((event) => events.push(event));
    runtime.emit({ type: "future_pi_event", secret: "must-not-leak" });
    assert.deepEqual(events.map((event) => ({ type: event.type, code: event.code, message: event.message })), [{
      type: "diagnostic",
      code: "pi_event_ignored",
      message: "忽略未识别的 PI 事件: future_pi_event",
    }]);
    assert.equal(JSON.stringify(events).includes("must-not-leak"), false);
  });

  it("rejects a second prompt while the current turn is still running", async () => {
    const runtime = createRuntime();
    let release;
    runtime.session.prompt = () => new Promise((resolve) => { release = resolve; });
    const engine = adapter(runtime);

    const first = engine.prompt({ message: "first", turnId: "turn-first" });
    await new Promise((resolve) => setImmediate(resolve));

    await assert.rejects(
      engine.prompt({ message: "duplicate", turnId: "turn-duplicate" }),
      (error) => error?.code === "turn_in_progress",
    );

    release();
    await first;
  });

  it("aborts a turn when the parent tool-call budget is exhausted", async () => {
    const runtime = createRuntime();
    let release;
    runtime.session.prompt = () => new Promise((resolve) => { release = resolve; });
    const originalAbort = runtime.session.abort;
    runtime.session.abort = () => { originalAbort(); release?.(); };
    const engine = new PiAgentEngineAdapter(runtime, {
      id: "engine-budget",
      maxToolCalls: 2,
      turnId: () => "generated-turn",
    });

    const prompt = engine.prompt({ message: "loop", turnId: "turn-budget" });
    runtime.emit({ type: "agent_start" });
    runtime.emit({ type: "tool_execution_start", toolCallId: "call-1", toolName: "search", args: { query: "same" } });
    runtime.emit({ type: "tool_execution_start", toolCallId: "call-2", toolName: "search", args: { query: "same" } });

    await assert.rejects(
      prompt,
      (error) => error?.code === "turn_tool_limit",
    );
    assert.equal(runtime.aborts, 1);
    release();
  });

  it("aborts repeated identical tool calls even when other tools are interleaved", async () => {
    const runtime = createRuntime();
    let release;
    runtime.session.prompt = () => new Promise((resolve) => { release = resolve; });
    const originalAbort = runtime.session.abort;
    runtime.session.abort = () => { originalAbort(); release?.(); };
    const engine = new PiAgentEngineAdapter(runtime, {
      id: "engine-repeat",
      maxToolCalls: 10,
      maxRepeatedToolCalls: 3,
      turnId: () => "generated-turn",
    });

    const prompt = engine.prompt({ message: "loop", turnId: "turn-repeat" });
    runtime.emit({ type: "agent_start" });
    runtime.emit({ type: "tool_execution_start", toolCallId: "call-1", toolName: "search", args: { query: "same" } });
    runtime.emit({ type: "tool_execution_start", toolCallId: "call-2", toolName: "file_read", args: { path: "other" } });
    runtime.emit({ type: "tool_execution_start", toolCallId: "call-3", toolName: "search", args: { query: "same" } });
    runtime.emit({ type: "tool_execution_start", toolCallId: "call-4", toolName: "file_read", args: { path: "other" } });
    runtime.emit({ type: "tool_execution_start", toolCallId: "call-5", toolName: "search", args: { query: "same" } });

    await assert.rejects(prompt, (error) => error?.code === "turn_repeated_tool");
    assert.equal(runtime.aborts, 1);
  });
});
