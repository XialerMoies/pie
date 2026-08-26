import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { AgentProfileRegistry, resolveAgentProfile } from "../src/agent/agent-profile.ts";
import { mapPiEvent } from "../src/agent-engine/event-normalizer.ts";
import { ToolPool, COORDINATOR_TOOL_NAMES, READ_ONLY_SUBAGENT_TOOL_NAMES } from "../src/agent/tool-pool.ts";
import { nativeToolPresentation } from "../src/agent/tool-presentation.ts";
import { toolRegistry } from "../src/agent/tools/index.ts";
import { structuredToolResult } from "../src/agent/types.ts";
import { attachEngineEvents } from "../src/server/agent-event-router.ts";
import { replayChatEvents } from "../src/server/chat-stream.ts";

function fixture(name, overrides = {}) {
  return {
    name,
    description: `${name} fixture`,
    parameters: { type: "object", properties: {} },
    isReadOnly: true,
    resultFormat: "structured",
    execute: async () => structuredToolResult("ok", { name }),
    ...overrides,
  };
}

function serverFlow() {
  let listener;
  const sessionId = "tool-pool-session";
  const turnId = "tool-pool-turn";
  const liveFrames = [];
  const engine = {
    session: { id: sessionId, workspace: process.cwd(), isStreaming: true, isCompacting: false },
    subscribe(next) { listener = next; return () => { listener = undefined; }; },
    emit(event) { listener?.(event); },
    getContextUsage() { return undefined; },
    getSessionStats() { return undefined; },
  };
  const chat = {
    textBuffer: "",
    thinkingBuffer: "",
    response: { write(frame) { liveFrames.push(String(frame)); return true; }, end() {} },
    turnId,
    traceSeq: 0,
    eventSeq: 0,
    eventHistory: [],
    blocks: [],
    emittedTraces: new Set(),
    blockSeq: 0,
  };
  const runtime = {
    session: {
      sessionFile: undefined,
      sessionManager: { flushed: false, getSessionId: () => sessionId },
    },
  };
  attachEngineEvents(engine, runtime, chat);
  engine.emit({ version: 1, type: "turn.started", sessionId, turnId, seq: 1, timestamp: 1 });
  return { engine, chat, liveFrames, sessionId, turnId };
}

describe("AP-10/AP-11 Profile, host, and ToolPool cross-layer flow", () => {
  it("fails closed on duplicate native/MCP identities and invalid feature declarations", () => {
    assert.throws(
      () => new ToolPool().addNative([fixture("file_read")]).addMcp([fixture("file-read")]),
      /duplicate identity: file_read/,
    );

    const registry = new AgentProfileRegistry();
    const base = {
      id: "feature-probe",
      revision: 1,
      description: "feature probe",
      toolNames: [],
      presentation: "native",
      promptSections: [],
      includeSkills: false,
    };
    assert.throws(
      () => registry.register({ ...base, featureGates: ["unknown"], allowMcp: false }),
      /unknown feature gate/,
    );
    assert.throws(
      () => registry.register({ ...base, featureGates: ["web", "web"], allowMcp: false }),
      /duplicate feature gates/,
    );
    assert.throws(
      () => registry.register({ ...base, featureGates: [], allowMcp: true }),
      /inconsistent allowMcp/,
    );
  });

  it("projects exact main, coordinator, and subagent audiences from one native/MCP pool", () => {
    const mcp = fixture("mcp_probe");
    const pool = new ToolPool().addNative(toolRegistry.getAll()).addMcp([mcp]);
    const coordinator = pool.project({ audience: "coordinator", names: "*", featureGates: "*" }).map((tool) => tool.name);
    const subagent = pool.project({ audience: "subagent", names: "*", featureGates: "*" }).map((tool) => tool.name);
    const main = pool.project({ audience: "main", names: "*", featureGates: "*" }).map((tool) => tool.name);

    assert.deepStrictEqual(coordinator, [...COORDINATOR_TOOL_NAMES]);
    assert.deepStrictEqual(subagent, [...READ_ONLY_SUBAGENT_TOOL_NAMES]);
    assert.ok(main.includes("command"));
    assert.ok(main.includes("delegate_tasks"));
    assert.ok(main.includes("mcp_probe"));
    assert.ok(!coordinator.includes("mcp_probe"));
    assert.ok(!subagent.includes("delegate_tasks"));
    assert.ok(!subagent.includes("command"));
  });

  it("uses Feature Gates only for visibility and still requires host authorization", async () => {
    let executed = false;
    const gated = fixture("web-search", {
      needsPermission: true,
      execute: async () => {
        executed = true;
        return structuredToolResult("unexpected", null);
      },
    });
    const pool = new ToolPool().addNative([gated]).addMcp([fixture("mcp_probe")]);
    assert.deepStrictEqual(pool.project({ audience: "main", names: "*", featureGates: [] }), []);
    assert.deepStrictEqual(
      pool.project({ audience: "main", names: "*", featureGates: ["web"] }).map((tool) => tool.name),
      ["web-search"],
    );

    const traces = [];
    const [presented] = nativeToolPresentation.present(
      pool.project({ audience: "main", names: "*", featureGates: ["web"] }),
      {
        workspace: process.cwd(),
        emitTrace: (event) => traces.push(event),
        extraCtx: { authorizeTool: async () => ({ allow: false, reason: "host denied" }) },
      },
    );
    await assert.rejects(() => presented.execute("gated-denied", {}), /host denied/);
    assert.equal(executed, false, "a visible feature must not bypass host permission");
    assert.deepStrictEqual(traces.map((event) => event.type), ["tool_execution_start", "tool_execution_end"]);
    assert.equal(traces.at(-1).outcome.status, "failed");
  });

  it("keeps a denied projected tool terminal across presentation, SSE, and reconnect replay", async () => {
    const flow = serverFlow();
    let seq = 2;
    const pool = new ToolPool().addNative([fixture("web-search", { needsPermission: true })]);
    const [presented] = nativeToolPresentation.present(
      pool.project({ audience: "main", names: ["web-search"], featureGates: ["web"] }),
      {
        workspace: process.cwd(),
        emitTrace(trace) {
          const mapped = mapPiEvent(trace, {
            base: {
              version: 1,
              sessionId: flow.sessionId,
              turnId: flow.turnId,
              seq: seq++,
              timestamp: seq,
            },
          });
          for (const event of mapped.events) flow.engine.emit(event);
        },
        extraCtx: { authorizeTool: async () => ({ allow: false, reason: "profile tool denied" }) },
      },
    );

    await assert.rejects(() => presented.execute("tool-pool-denied", {}), /profile tool denied/);
    const toolBlock = flow.chat.blocks.find((block) => block.type === "tool");
    assert.equal(toolBlock?.status, "error");
    assert.ok(flow.chat.eventHistory.some((frame) => frame.data.includes('"type":"block"')));

    const replayFrames = [];
    const replayed = replayChatEvents(flow.chat, { write(frame) { replayFrames.push(String(frame)); return true; } }, 0);
    assert.equal(replayed, flow.chat.eventHistory.length);
    assert.deepStrictEqual(replayFrames, flow.chat.eventHistory.map((frame) => frame.data));
  });

  it("keeps builtin profiles independent while standard retains the open host surface", () => {
    const standard = resolveAgentProfile("standard");
    const minimal = resolveAgentProfile("minimal");
    assert.equal(standard.featureGates, "*");
    assert.deepStrictEqual(minimal.featureGates, ["planning"]);
    assert.equal(standard.allowMcp, true);
    assert.equal(minimal.allowMcp, false);
  });
});
