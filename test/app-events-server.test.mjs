import { describe, it } from "node:test";
import assert from "node:assert";
import { readFileSync } from "node:fs";

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
