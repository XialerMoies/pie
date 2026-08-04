import { describe, it } from "node:test";
import assert from "node:assert";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { AppEventHub } from "../src/server/app-events.ts";
import {
  cancelPermissionConfirmationsForResponse,
  createPermissionConfirmCallback,
} from "../src/server/permission-confirmation.ts";
import * as serverModule from "../src/server/server.ts";
import * as mcpService from "../src/agent/mcp/MCPClientService.ts";

const { attachSessionEvents, openAppEventStream } = serverModule;

function makeResponse({ destroyed = false, writableEnded = false, writeError } = {}) {
  return {
    destroyed,
    writableEnded,
    status: 0,
    headers: {},
    writeError,
    writes: [],
    writeHead(status, headers) {
      this.status = status;
      this.headers = headers;
      return this;
    },
    write(frame) {
      if (this.writeError) throw this.writeError;
      this.writes.push(frame);
      return true;
    },
  };
}

function makeRequest() {
  const handlers = new Map();
  return {
    on(event, handler) {
      handlers.set(event, handler);
      return this;
    },
    emitClose() {
      handlers.get("close")?.();
    },
  };
}

describe("AppEventHub", () => {
  it("registers each client once and returns an isolated snapshot", () => {
    const hub = new AppEventHub();
    const client = makeResponse();

    hub.addClient(client);
    hub.addClient(client);

    const snapshot = hub.clientsSnapshot();
    assert.deepStrictEqual(snapshot, [client]);
    snapshot.length = 0;
    assert.deepStrictEqual(hub.clientsSnapshot(), [client]);
  });

  it("publishes one identical frame with a new revision to every client", () => {
    const hub = new AppEventHub();
    const first = makeResponse();
    const second = makeResponse();
    hub.addClient(first);
    hub.addClient(second);

    hub.publish("dashboard.changed", { source: "test" });

    const frame = 'data: {"type":"dashboard.changed","revision":1,"payload":{"source":"test"}}\n\n';
    assert.deepStrictEqual(first.writes, [frame]);
    assert.deepStrictEqual(second.writes, [frame]);
    assert.strictEqual(first.writes[0], second.writes[0]);
    assert.strictEqual(hub.revision(), 1);
  });

  it("omits an absent payload and increments the revision per publish", () => {
    const hub = new AppEventHub();
    const client = makeResponse();
    hub.addClient(client);

    hub.publish("usage.changed");
    hub.publish("mcp.changed");

    assert.deepStrictEqual(client.writes, [
      'data: {"type":"usage.changed","revision":1}\n\n',
      'data: {"type":"mcp.changed","revision":2}\n\n',
    ]);
    assert.strictEqual(hub.revision(), 2);
  });

  it("does not write to a removed client", () => {
    const hub = new AppEventHub();
    const client = makeResponse();
    const removed = [];
    const unsubscribe = hub.subscribeClientRemoved((response) => removed.push(response));
    hub.addClient(client);

    hub.removeClient(client);
    hub.removeClient(client);
    hub.publish("explorer.changed", { path: "src" });

    assert.deepStrictEqual(client.writes, []);
    assert.deepStrictEqual(hub.clientsSnapshot(), []);
    assert.deepStrictEqual(removed, [client]);

    unsubscribe();
    hub.addClient(client);
    hub.removeClient(client);
    assert.deepStrictEqual(removed, [client]);
  });

  it("cleans up destroyed and ended clients without writing to them", () => {
    const hub = new AppEventHub();
    const destroyed = makeResponse();
    const ended = makeResponse();
    const active = makeResponse();
    const removed = [];
    hub.subscribeClientRemoved((response) => removed.push(response));
    hub.addClient(destroyed);
    hub.addClient(ended);
    hub.addClient(active);
    destroyed.destroyed = true;
    ended.writableEnded = true;

    hub.publish("permission.confirm", { id: "perm-1" });

    assert.deepStrictEqual(destroyed.writes, []);
    assert.deepStrictEqual(ended.writes, []);
    assert.strictEqual(active.writes.length, 1);
    assert.deepStrictEqual(hub.clientsSnapshot(), [active]);
    assert.deepStrictEqual(removed, [destroyed, ended]);

    hub.clientsSnapshot();
    assert.deepStrictEqual(removed, [destroyed, ended]);
  });

  it("cleans up a client whose write throws and continues with other clients", () => {
    const hub = new AppEventHub();
    const broken = makeResponse({ writeError: new Error("closed") });
    const active = makeResponse();
    const removed = [];
    hub.subscribeClientRemoved((response) => removed.push(response));
    hub.addClient(broken);
    hub.addClient(active);

    assert.doesNotThrow(() => hub.publish("dashboard.changed", { source: "write-error" }));

    assert.deepStrictEqual(active.writes, [
      'data: {"type":"dashboard.changed","revision":1,"payload":{"source":"write-error"}}\n\n',
    ]);
    assert.deepStrictEqual(hub.clientsSnapshot(), [active]);
    assert.deepStrictEqual(removed, [broken]);

    hub.publish("dashboard.changed", { source: "after-removal" });
    assert.deepStrictEqual(removed, [broken]);
  });

  it("sendTo writes only to selected clients that are registered and valid", () => {
    const hub = new AppEventHub();
    const selected = makeResponse();
    const notSelected = makeResponse();
    const unregistered = makeResponse();
    const ended = makeResponse();
    const removed = [];
    hub.subscribeClientRemoved((response) => removed.push(response));
    hub.addClient(selected);
    hub.addClient(notSelected);
    hub.addClient(ended);
    ended.writableEnded = true;

    hub.sendTo([selected, unregistered, ended], "permission.confirm", { id: "perm-2" });

    assert.deepStrictEqual(selected.writes, [
      'data: {"type":"permission.confirm","revision":1,"payload":{"id":"perm-2"}}\n\n',
    ]);
    assert.deepStrictEqual(notSelected.writes, []);
    assert.deepStrictEqual(unregistered.writes, []);
    assert.deepStrictEqual(ended.writes, []);
    assert.deepStrictEqual(hub.clientsSnapshot(), [selected, notSelected]);
    assert.deepStrictEqual(removed, [ended]);

    hub.clientsSnapshot();
    assert.deepStrictEqual(removed, [ended]);
  });

  it("sendTo creates one revision even when no client is eligible", () => {
    const hub = new AppEventHub();

    hub.sendTo([], "explorer.changed");

    assert.strictEqual(hub.revision(), 1);
  });

  it("routes production application events exclusively through AppEventHub", () => {
    const source = readFileSync(new URL("../src/server/server.ts", import.meta.url), "utf8");
    const watcherStart = source.indexOf("watch(APP_ROOT");
    const watcherEnd = source.indexOf('console.log("[watcher] watching', watcherStart);
    assert.notStrictEqual(watcherStart, -1, "watcher callback should exist");
    assert.notStrictEqual(watcherEnd, -1, "watcher callback block should be bounded");
    const watcherBlock = source.slice(watcherStart, watcherEnd);

    assert.match(source, /const appEvents = new AppEventHub\(\)/);
    assert.match(source, /appEvents\.subscribeClientRemoved\(cancelPermissionConfirmationsForResponse\)/);
    assert.doesNotMatch(source, /const sseClients:/);
    assert.doesNotMatch(source, /type: "refresh", file: filename/);
    assert.doesNotMatch(source, /function publishExplorerChanged/);
    assert.match(watcherBlock, /appEvents\.publish\("explorer\.changed", \{ file: filename \}\)/);
    assert.match(watcherBlock, /}, 500\);/);
  });

  it("opens the events stream with the current revision and removes the client on close", async () => {
    const hub = new AppEventHub();
    hub.publish("dashboard.changed", { source: "before-connect" });
    const request = makeRequest();
    const response = makeResponse();

    openAppEventStream(request, response, hub, { "Access-Control-Allow-Origin": "*" });

    assert.strictEqual(response.status, 200);
    assert.deepStrictEqual(response.headers, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "Access-Control-Allow-Origin": "*",
    });
    assert.deepStrictEqual(response.writes, [
      'data: {"type":"connected","revision":1}\n\n',
    ]);
    assert.deepStrictEqual(hub.clientsSnapshot(), [response]);

    hub.subscribeClientRemoved(cancelPermissionConfirmationsForResponse);
    const confirmPermission = createPermissionConfirmCallback(hub, { timeoutMs: 1000 });
    const pending = confirmPermission({
      source: "file.write",
      operation: "write",
      root: process.cwd(),
      path: "outside.txt",
      reason: "Write path requires confirmation",
      permissionSuggestions: [],
    });

    request.emitClose();

    assert.deepStrictEqual(hub.clientsSnapshot(), []);
    assert.deepStrictEqual(await pending, { allow: false });
  });

  it("fails a pending permission confirmation closed when a later publish evicts its client", async () => {
    const hub = new AppEventHub();
    const response = makeResponse();
    hub.addClient(response);
    hub.subscribeClientRemoved(cancelPermissionConfirmationsForResponse);
    const confirmPermission = createPermissionConfirmCallback(hub, { timeoutMs: 1000 });
    const pending = confirmPermission({
      source: "file.write",
      operation: "write",
      root: process.cwd(),
      path: "outside.txt",
      reason: "Write path requires confirmation",
      permissionSuggestions: [],
    });
    response.writeError = new Error("connection closed");

    hub.publish("dashboard.changed", { source: "after-confirmation" });

    const outcome = await Promise.race([
      pending,
      new Promise((resolve) => setTimeout(() => resolve("still-pending"), 20)),
    ]);
    if (outcome === "still-pending") cancelPermissionConfirmationsForResponse(response);
    assert.deepStrictEqual(outcome, { allow: false });
  });
});

describe("server lifecycle publishers", () => {
  it("publishes dashboard and usage changes only after agent end reaches idle", async () => {
    let eventHandler;
    let resolveIdle;
    const session = {
      sessionFile: "",
      sessionManager: { getSessionId: () => "session-1" },
      isStreaming: true,
      agent: {
        waitForIdle() {
          return new Promise((resolve) => {
            resolveIdle = () => {
              session.isStreaming = false;
              resolve();
            };
          });
        },
      },
    };
    const runtime = {
      session,
      onEvent(handler) { eventHandler = handler; return () => {}; },
    };
    const chatStream = {
      textBuffer: "",
      thinkingBuffer: "",
      currentTextSnapshot: "",
      currentThinkingSnapshot: "",
      response: null,
      turnId: "turn-1",
      traceSeq: 0,
      emittedTraces: new Set(),
      blocks: [],
      blockSeq: 0,
      eventSeq: 0,
      eventHistory: [],
      currentWorkspace: "",
    };
    const published = [];
    const ctx = { appEvents: { publish(type) { published.push({ type, isStreaming: session.isStreaming }); } } };

    attachSessionEvents(runtime, chatStream, ctx);
    eventHandler({ type: "agent_start" });
    const listenerResult = eventHandler({ type: "agent_end", messages: [] });

    assert.strictEqual(listenerResult, undefined, "listener must not await the idle boundary");
    assert.deepStrictEqual(published.map((event) => event.type), [
      "dashboard.changed", "usage.changed",
    ]);
    assert.strictEqual(chatStream.turnId, "", "agent end state is reset before publishing");
    resolveIdle();
    await new Promise((resolveImmediate) => setImmediate(resolveImmediate));
    assert.deepStrictEqual(published.map((event) => event.type), [
      "dashboard.changed", "usage.changed", "dashboard.changed", "usage.changed",
    ]);
    assert.deepStrictEqual(published.slice(-2).map((event) => event.isStreaming), [false, false]);
  });

  it("keeps agent lifecycle and idle handling fail-open", async () => {
    let eventHandler;
    const runtime = {
      session: {
        sessionFile: "",
        sessionManager: { getSessionId: () => "session-1" },
        isCompacting: true,
        agent: { waitForIdle: async () => { throw new Error("idle failed"); } },
      },
      onEvent(handler) { eventHandler = handler; return () => {}; },
    };
    const chatStream = {
      textBuffer: "", thinkingBuffer: "", currentTextSnapshot: "", currentThinkingSnapshot: "",
      response: null, turnId: "turn-1", traceSeq: 0, emittedTraces: new Set(), blocks: [], blockSeq: 0,
      eventSeq: 0, eventHistory: [], currentWorkspace: "",
    };
    attachSessionEvents(runtime, chatStream, { appEvents: { publish() { throw new Error("UI failed"); } } });

    assert.doesNotThrow(() => eventHandler({ type: "agent_start" }));
    assert.doesNotThrow(() => eventHandler({ type: "agent_end", messages: [] }));
    assert.doesNotThrow(() => eventHandler({ type: "compaction_start", reason: "manual" }));
    assert.doesNotThrow(() => eventHandler({ type: "compaction_end", reason: "manual", aborted: false }));
    await new Promise((resolveImmediate) => setImmediate(resolveImmediate));
  });

  it("publishes agent end changes after idle even without an active chat turn", async () => {
    let eventHandler;
    const session = {
      sessionFile: "",
      sessionManager: { getSessionId: () => "session-1" },
      isStreaming: true,
      agent: { waitForIdle: async () => { session.isStreaming = false; } },
    };
    const runtime = {
      session,
      onEvent(handler) { eventHandler = handler; return () => {}; },
    };
    const published = [];
    attachSessionEvents(runtime, {
      textBuffer: "", thinkingBuffer: "", response: null, turnId: "",
    }, { appEvents: { publish(type) { published.push(type); } } });

    eventHandler({ type: "agent_end", messages: [] });

    assert.deepStrictEqual(published, []);
    await new Promise((resolveImmediate) => setImmediate(resolveImmediate));
    assert.deepStrictEqual(published, ["dashboard.changed", "usage.changed"]);
    assert.strictEqual(session.isStreaming, false);
  });

  it("publishes the end state when waitForIdle rejects", async () => {
    let eventHandler;
    let rejectIdle;
    const session = {
      sessionFile: "",
      sessionManager: { getSessionId: () => "session-reject" },
      isStreaming: true,
      agent: {
        waitForIdle() {
          return new Promise((_, reject) => {
            rejectIdle = () => {
              session.isStreaming = false;
              reject(new Error("idle failed"));
            };
          });
        },
      },
    };
    const runtime = {
      session,
      onEvent(handler) { eventHandler = handler; return () => {}; },
    };
    const published = [];
    attachSessionEvents(runtime, { textBuffer: "", thinkingBuffer: "", response: null, turnId: "" }, {
      appEvents: { publish(type) { published.push({ type, isStreaming: session.isStreaming }); } },
    });

    eventHandler({ type: "agent_end", messages: [] });
    assert.deepStrictEqual(published, []);
    rejectIdle();
    await new Promise((resolveImmediate) => setImmediate(resolveImmediate));

    assert.deepStrictEqual(published.map((event) => event.type), ["dashboard.changed", "usage.changed"]);
    assert.deepStrictEqual(published.map((event) => event.isStreaming), [false, false]);
  });

  it("publishes the end state when waitForIdle throws synchronously", async () => {
    let eventHandler;
    const session = {
      sessionFile: "",
      sessionManager: { getSessionId: () => "session-throw" },
      isStreaming: false,
      agent: { waitForIdle() { throw new Error("idle threw"); } },
    };
    const runtime = {
      session,
      onEvent(handler) { eventHandler = handler; return () => {}; },
    };
    const published = [];
    attachSessionEvents(runtime, { textBuffer: "", thinkingBuffer: "", response: null, turnId: "" }, {
      appEvents: { publish(type) { published.push(type); } },
    });

    eventHandler({ type: "agent_end", messages: [] });
    assert.deepStrictEqual(published, []);
    await new Promise((resolveImmediate) => setImmediate(resolveImmediate));
    assert.deepStrictEqual(published, ["dashboard.changed", "usage.changed"]);
  });

  it("does not publish an old session end after the runtime switches sessions", async () => {
    let eventHandler;
    let resolveIdle;
    const oldSession = {
      sessionFile: "old.jsonl",
      sessionManager: { getSessionId: () => "old-session" },
      agent: {
        waitForIdle() {
          return new Promise((resolve) => { resolveIdle = resolve; });
        },
      },
    };
    const nextSession = {
      sessionFile: "new.jsonl",
      sessionManager: { getSessionId: () => "new-session" },
      agent: { waitForIdle: async () => {} },
    };
    const runtime = {
      session: oldSession,
      onEvent(handler) { eventHandler = handler; return () => {}; },
    };
    const published = [];
    attachSessionEvents(runtime, { textBuffer: "", thinkingBuffer: "", response: null, turnId: "" }, {
      appEvents: { publish(type) { published.push(type); } },
    });

    eventHandler({ type: "agent_end", messages: [] });
    runtime.session = nextSession;
    resolveIdle();
    await new Promise((resolveImmediate) => setImmediate(resolveImmediate));

    assert.deepStrictEqual(published, []);
  });

  it("ignores an old agent_end delivered after switching and still publishes the new session", async () => {
    let eventHandler;
    const oldSession = {
      sessionFile: "old.jsonl",
      sessionManager: { getSessionId: () => "old-session" },
      agent: { waitForIdle: async () => {} },
    };
    const newSession = {
      sessionFile: "new.jsonl",
      sessionManager: { getSessionId: () => "new-session" },
      agent: { waitForIdle: async () => {} },
    };
    const runtime = {
      session: oldSession,
      onEvent(handler) { eventHandler = handler; return () => {}; },
    };
    const published = [];
    attachSessionEvents(runtime, { textBuffer: "", thinkingBuffer: "", response: null, turnId: "" }, {
      appEvents: { publish(type) { published.push(type); } },
    });

    runtime.session = newSession;
    eventHandler({ type: "agent_end", messages: [] }, oldSession);
    await new Promise((resolveImmediate) => setImmediate(resolveImmediate));
    assert.deepStrictEqual(published, []);

    eventHandler({ type: "agent_end", messages: [] }, newSession);
    await new Promise((resolveImmediate) => setImmediate(resolveImmediate));
    assert.deepStrictEqual(published, ["dashboard.changed", "usage.changed"]);
  });

  it("drops every delayed old-session event before touching lifecycle or chat state", async () => {
    let eventHandler;
    const oldSession = {
      sessionFile: "old.jsonl",
      sessionManager: { getSessionId: () => "old-session" },
      isCompacting: true,
    };
    const currentSession = {
      sessionFile: "",
      sessionManager: { getSessionId: () => "current-session" },
      isCompacting: true,
    };
    const runtime = {
      session: currentSession,
      onEvent(handler) { eventHandler = handler; return () => {}; },
    };
    const chatStream = {
      textBuffer: "",
      thinkingBuffer: "",
      currentTextSnapshot: "",
      currentThinkingSnapshot: "",
      response: null,
      turnId: "turn-current",
      traceSeq: 0,
      emittedTraces: new Set(),
      blocks: [],
      blockSeq: 0,
      eventSeq: 0,
      eventHistory: [],
      currentWorkspace: "",
    };
    const published = [];
    attachSessionEvents(runtime, chatStream, {
      appEvents: { publish(type) { published.push(type); } },
    });

    eventHandler({ type: "agent_start" }, oldSession);
    eventHandler({ type: "compaction_start", reason: "threshold" }, oldSession);
    eventHandler({ type: "compaction_end", reason: "threshold" }, oldSession);
    eventHandler({
      type: "tool_execution_start",
      toolCallId: "old-tool",
      toolName: "old_tool",
      args: { value: "old" },
    }, oldSession);
    eventHandler({ type: "message_start", message: { role: "assistant" } }, oldSession);
    eventHandler({ type: "turn_end", turnIndex: 1 }, oldSession);
    await new Promise((resolveImmediate) => setImmediate(resolveImmediate));

    assert.deepStrictEqual(published, []);
    assert.strictEqual(chatStream.messageSeq, undefined);
    assert.strictEqual(chatStream.emittedTraces.size, 0);
    assert.deepStrictEqual(chatStream.blocks, []);
    assert.deepStrictEqual(chatStream.eventHistory, []);

    eventHandler({ type: "agent_start" }, currentSession);
    eventHandler({ type: "compaction_start", reason: "threshold" }, currentSession);
    eventHandler({ type: "tool_execution_start", toolCallId: "current-tool", toolName: "current_tool", args: {} }, currentSession);
    eventHandler({ type: "message_start", message: { role: "assistant" } }, currentSession);
    await new Promise((resolveImmediate) => setImmediate(resolveImmediate));

    assert.ok(published.includes("dashboard.changed"));
    assert.ok(published.includes("usage.changed"));
    assert.strictEqual(chatStream.messageSeq, 1);
    assert.strictEqual(chatStream.emittedTraces.size, 1);
    assert.strictEqual(chatStream.blocks.length, 1);
    assert.ok(chatStream.eventHistory.length > 0);
  });

  it("drops a delayed custom-tool trace bound to the session that created it", async () => {
    const { AgentRuntime } = await import("../src/agent/runtime.ts");
    const oldSession = { id: "old", subscribe() { return () => {}; } };
    const currentSession = { id: "current", sessionFile: "", subscribe() { return () => {}; } };
    const runtime = Object.create(AgentRuntime.prototype);
    runtime.session = oldSession;
    runtime._eventSubscriptions = [];
    const chatStream = {
      textBuffer: "", thinkingBuffer: "", currentTextSnapshot: "", currentThinkingSnapshot: "",
      response: null, turnId: "turn-current", traceSeq: 0, emittedTraces: new Set(), blocks: [], blockSeq: 0,
      eventSeq: 0, eventHistory: [], currentWorkspace: "",
    };
    const published = [];
    attachSessionEvents(runtime, chatStream, { appEvents: { publish(type) { published.push(type); } } });
    const oldToolTrace = runtime._createToolTraceEmitter();
    oldToolTrace.bindSource(oldSession);

    runtime.session = currentSession;
    oldToolTrace.emit({
      type: "tool_execution_update",
      toolCallId: "late-old-tool",
      toolName: "old_tool",
      args: { secret: "old" },
      partialResult: "late update",
    });
    oldToolTrace.emit({
      type: "tool_execution_end",
      toolCallId: "late-old-tool",
      toolName: "old_tool",
      result: "late result",
      isError: false,
    });

    assert.deepStrictEqual(published, []);
    assert.strictEqual(chatStream.emittedTraces.size, 0);
    assert.deepStrictEqual(chatStream.blocks, []);
    assert.deepStrictEqual(chatStream.eventHistory, []);
  });

  it("rebinds cached MCP tools to each created or opened session without reconnecting", async () => {
    const { AgentRuntime } = await import("../src/agent/runtime.ts");
    const tools = await import("../src/agent/tools/index.ts");
    const workspace = mkdtempSync(resolve(tmpdir(), "mcp-session-trace-"));
    const sessionFile = (name) => resolve(workspace, `${name}.jsonl`);
    const makeSession = (id) => ({
      id,
      sessionFile: sessionFile(id),
      sessionManager: { flushed: true, getSessionId: () => id },
      subscribe() { return () => {}; },
      abort() {},
      dispose() {},
    });
    const readRecords = (session) => readFileSync(session.sessionFile, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));

    try {
      await tools.disconnectMcp();
      const generation = mcpService.currentGeneration();
      const rawMcpTool = {
        name: "mcp__cached__echo",
        description: "cached MCP test tool",
        parameters: { type: "object", properties: { value: { type: "string" } } },
        isReadOnly: true,
        needsPermission: false,
        operations: ["read"],
        riskLevel: "low",
        workspaceBounded: false,
        execute: async ({ value }) => ({ text: `echo:${value}` }),
      };
      tools._setMcpCache(workspace, [rawMcpTool]);

      const oldSession = makeSession("old");
      const createdSession = makeSession("created");
      const openedSession = makeSession("opened");
      for (const session of [oldSession, createdSession, openedSession]) {
        writeFileSync(session.sessionFile, JSON.stringify({ type: "session", id: session.id }) + "\n");
      }

      const runtime = Object.create(AgentRuntime.prototype);
      runtime.config = {};
      runtime.currentWorkspace = workspace;
      runtime.session = oldSession;
      runtime._eventSubscriptions = [];
      const chatStream = {
        textBuffer: "", thinkingBuffer: "", currentTextSnapshot: "", currentThinkingSnapshot: "",
        response: null, turnId: "turn-current", traceSeq: 0, emittedTraces: new Set(), blocks: [], blockSeq: 0,
        eventSeq: 0, eventHistory: [], currentWorkspace: workspace,
      };
      attachSessionEvents(runtime, chatStream);

      const bindTools = async (session) => {
        const toolTrace = runtime._createToolTraceEmitter();
        const sessionTools = await tools.getCustomToolsAsync(workspace, toolTrace.emit);
        toolTrace.bindSource(session);
        return sessionTools;
      };
      const oldTools = await bindTools(oldSession);
      const wrappers = [];
      const pendingSessions = [createdSession, openedSession];
      runtime._initSession = async () => {
        const nextSession = pendingSessions.shift();
        wrappers.push(await bindTools(nextSession));
        runtime.session = nextSession;
      };

      await runtime.createNewSession();
      const createdTool = wrappers[0].find((tool) => tool.name === rawMcpTool.name);
      await createdTool.execute("call-created", { value: "created-value" });

      await runtime.openSession(openedSession.sessionFile, workspace);
      const openedTool = wrappers[1].find((tool) => tool.name === rawMcpTool.name);
      await openedTool.execute("call-opened", { value: "opened-value" });

      const oldTool = oldTools.find((tool) => tool.name === rawMcpTool.name);
      const blockCount = chatStream.blocks.length;
      const eventCount = chatStream.eventHistory.length;
      await oldTool.execute("call-stale", { value: "stale-value" });

      assert.notStrictEqual(createdTool, oldTool, "create must rebuild the cached MCP PI wrapper");
      assert.notStrictEqual(openedTool, createdTool, "open must rebuild the cached MCP PI wrapper");
      assert.strictEqual(mcpService.currentGeneration(), generation, "same-workspace transitions must not reconnect MCP");
      assert.strictEqual(tools._getMcpCacheLen(), 1, "raw MCP discovery cache must be reused");
      assert.strictEqual(chatStream.blocks.length, blockCount, "stale wrapper events must still be dropped");
      assert.strictEqual(chatStream.eventHistory.length, eventCount, "stale wrapper events must not enter SSE history");

      const createdRecords = readRecords(createdSession);
      const openedRecords = readRecords(openedSession);
      assert.ok(createdRecords.some((entry) => entry.type === "trace" && entry.event?.output === "echo:created-value"));
      assert.ok(createdRecords.some((entry) => entry.type === "assistant_block" && entry.block?.output === "echo:created-value"));
      assert.ok(openedRecords.some((entry) => entry.type === "trace" && entry.event?.output === "echo:opened-value"));
      assert.ok(openedRecords.some((entry) => entry.type === "assistant_block" && entry.block?.output === "echo:opened-value"));
      assert.ok(!readFileSync(openedSession.sessionFile, "utf8").includes("stale-value"));
    } finally {
      await tools.disconnectMcp();
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it("publishes compaction usage changes after busy state starts and after every reset path", async () => {
    let eventHandler;
    const session = {
      sessionFile: "",
      sessionManager: { getSessionId: () => "session-1" },
      isCompacting: false,
      agent: { waitForIdle: async () => {} },
    };
    const runtime = {
      session,
      onEvent(handler) { eventHandler = handler; return () => {}; },
    };
    const states = [];
    attachSessionEvents(runtime, {
      textBuffer: "", thinkingBuffer: "", response: null, turnId: "",
    }, { appEvents: { publish(type) { if (type === "usage.changed") states.push(session.isCompacting); } } });

    const runCompaction = async (reason, end) => {
      if (reason === "manual") session.isCompacting = true;
      eventHandler({ type: "compaction_start", reason });
      if (reason !== "manual") session.isCompacting = true;
      await Promise.resolve();
      try {
        await Promise.resolve();
      } finally {
        eventHandler({ type: "compaction_end", reason, willRetry: false, ...end });
        session.isCompacting = false;
      }
      await Promise.resolve();
    };
    const cases = [
      { reason: "manual", end: { result: { summary: "done" }, aborted: false } },
      { reason: "threshold", end: { result: undefined, aborted: false, errorMessage: "failed" } },
      { reason: "overflow", end: { result: undefined, aborted: true } },
    ];
    for (const { reason, end } of cases) {
      await runCompaction(reason, end);
    }

    assert.deepStrictEqual(states, [true, false, true, false, true, false]);
  });

  it("notifies MCP subscribers only when the externally visible snapshot changes", () => {
    assert.strictEqual(typeof mcpService.subscribeStatusChanges, "function");
    assert.strictEqual(typeof mcpService._setStatus, "function");
    mcpService.reset();
    const snapshots = [];
    const unsubscribe = mcpService.subscribeStatusChanges((snapshot) => snapshots.push(snapshot));
    try {
      mcpService._setStatus("docs", "connecting", undefined, { command: "node", enabled: true }, []);
      mcpService._setStatus("docs", "connecting", undefined, { command: "node", enabled: true }, []);
      assert.strictEqual(snapshots.length, 1, "identical state is deduplicated");

      mcpService._setStatus("docs", "error", "first", { command: "node", enabled: true }, []);
      mcpService._setStatus("docs", "error", "second", { command: "node", enabled: true }, []);
      mcpService._setStatus("docs", "error", "second", { command: "node", enabled: true }, ["mcp__docs__read"]);
      mcpService._setStatus("docs", "error", "second", { command: "node2", enabled: true }, ["mcp__docs__read"]);
      mcpService._setStatus("docs", "error", "second", { command: "node2", enabled: false }, ["mcp__docs__read"]);

      assert.strictEqual(snapshots.length, 6, "state, error, tools, config and enabled each notify once");
      assert.strictEqual(snapshots.at(-1)[0].config.enabled, false);
    } finally {
      unsubscribe();
      mcpService.reset();
    }
  });

  it("isolates MCP listeners and wires server changes to mcp.changed", () => {
    assert.strictEqual(typeof serverModule.attachMcpEvents, "function");
    assert.strictEqual(typeof mcpService.subscribeStatusChanges, "function");
    assert.strictEqual(typeof mcpService._setStatus, "function");
    mcpService.reset();
    const published = [];
    const detach = serverModule.attachMcpEvents({ publish(type) { published.push(type); } });
    const unsubscribeBroken = mcpService.subscribeStatusChanges(() => { throw new Error("listener failed"); });
    try {
      assert.doesNotThrow(() => {
        mcpService._setStatus("server", "connected", undefined, { command: "node" }, ["tool"]);
      });
      assert.deepStrictEqual(published, ["mcp.changed", "dashboard.changed"]);
    } finally {
      unsubscribeBroken();
      detach();
      mcpService.reset();
    }
  });
});
