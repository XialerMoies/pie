import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";

import { attachEngineEvents } from "../../src/server/agent-event-router.ts";
import { replayChatEvents } from "../../src/server/chat-stream.ts";
import { parseSessionMessages } from "../../src/server/routes/session-message-parser.ts";

const ROOT = resolve(import.meta.dirname, "../..");
const CATALOG_PATH = join(import.meta.dirname, "agent-session-replay-fixtures.json");
export const REPLAY_MODES = ["replay", "record", "refresh"];

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, entry]) => [key, stable(entry)]));
}

export function normalizeReplayValue(value) {
  if (Array.isArray(value)) return value.map(normalizeReplayValue);
  if (!value || typeof value !== "object") return value;
  const result = {};
  for (const [key, entry] of Object.entries(value)) {
    if (key === "timestamp" || key === "createdAt" || key === "updatedAt") result[key] = "<logical-time>";
    else if (key === "path" && typeof entry === "string") result[key] = entry.replaceAll(ROOT.replaceAll("\\", "/"), "<workspace>");
    else result[key] = normalizeReplayValue(entry);
  }
  return result;
}

export function loadReplayCatalog() {
  const jsonFiles = readdirSync(import.meta.dirname).filter((name) => name.endsWith(".json"));
  assert.deepEqual(jsonFiles, ["agent-behavior-baseline.json", "agent-session-replay-fixtures.json"], "replay fixture inventory contains an undeclared JSON file");
  const catalog = JSON.parse(readFileSync(CATALOG_PATH, "utf8"));
  assert.equal(catalog.version, 1, "replay catalog version must be 1");
  assert.deepEqual(catalog.normalization, { workspace: "<workspace>", timestamps: "logical-seq", ids: "fixture-stable" });
  assert.ok(Array.isArray(catalog.scenarios) && catalog.scenarios.length >= 5, "replay catalog must contain the required scenarios");
  const ids = new Set();
  for (const scenario of catalog.scenarios) {
    assert.match(scenario.id, /^[a-z0-9-]+$/u);
    assert.equal(ids.has(scenario.id), false, `duplicate replay fixture id: ${scenario.id}`);
    ids.add(scenario.id);
    assert.ok(scenario.request && typeof scenario.request.message === "string");
    assert.ok(Array.isArray(scenario.modelResponses) && scenario.modelResponses.length > 0);
    assert.equal(new Set(scenario.modelResponses.map((response) => response.requestId)).size, scenario.modelResponses.length, `${scenario.id}: model request ids must be unique`);
    assert.ok(scenario.modelResponses.every((response) => response.provider === "replay"), `${scenario.id}: non-replay provider is not allowed in default fixtures`);
    assert.ok(Array.isArray(scenario.toolCalls));
    assert.ok(Array.isArray(scenario.events) && scenario.events.length > 0);
    assert.ok(Array.isArray(scenario.sessionJsonl) && scenario.sessionJsonl.length >= 3);
    assert.ok(scenario.expected && Array.isArray(scenario.expected.blockTypes));
    const seqs = scenario.events.map((event) => event.seq);
    assert.deepEqual(seqs, [...seqs].sort((a, b) => a - b), `${scenario.id}: event seq must be monotonic`);
    assert.equal(new Set(seqs).size, seqs.length, `${scenario.id}: event seq must be unique`);
    assert.ok(scenario.events.some((event) => event.type === "turn.completed" || event.type === "turn.failed" || event.type === "turn.cancelled"), `${scenario.id}: terminal event is required`);
    const declaredToolIds = new Set(scenario.toolCalls.map((call) => call.id));
    const observedToolIds = new Set(scenario.events.filter((event) => event.type.startsWith("tool.")).map((event) => event.toolCallId));
    assert.deepEqual([...observedToolIds].sort(), [...declaredToolIds].sort(), `${scenario.id}: undeclared tool call drift`);
    const serialized = JSON.stringify(scenario);
    assert.doesNotMatch(serialized, /(?:sk-[A-Za-z0-9]{12,}|Bearer\s+|api[_-]?key)/iu, `${scenario.id}: fixture must not contain credentials`);
  }
  const required = ["task-a-skill-verification", "skill-facts-verification", "tool-failure-retry", "event-node-order", "refresh-recovery"];
  for (const id of required) assert.equal(ids.has(id), true, `missing required replay scenario: ${id}`);
  return catalog;
}

export function replayMode(value = process.env.MY_CODE_AGENT_REPLAY_MODE || "replay") {
  assert.ok(REPLAY_MODES.includes(value), `unsupported replay mode: ${value}`);
  if (value === "record" && process.env.MY_CODE_AGENT_REPLAY_RECORD !== "1") {
    throw new Error("record mode is opt-in: set MY_CODE_AGENT_REPLAY_RECORD=1");
  }
  return value;
}

function createEngine(sessionId) {
  let listener;
  return {
    session: { id: sessionId, workspace: ROOT, isStreaming: true, isCompacting: false },
    subscribe(next) { listener = next; return () => { listener = undefined; }; },
    emit(event) { listener?.(event); },
    getContextUsage() { return undefined; },
    getSessionStats() { return undefined; },
  };
}

function createStream() {
  return {
    textBuffer: "", thinkingBuffer: "", response: { write() {}, end() {} },
    turnId: "", traceId: "", traceSeq: 0, eventSeq: 0, eventHistory: [], blocks: [], blockSeq: 0,
    emittedTraces: new Set(), textSegments: [], thinkingBlockGenerations: {}, textBlockGenerations: {},
  };
}

function runtime(sessionFile, sessionId) {
  return { session: { sessionFile, sessionManager: { flushed: true, getSessionId: () => sessionId } } };
}

function payloads(stream) {
  return stream.eventHistory.map((entry) => JSON.parse(entry.data.split("data: ")[1]));
}

function logicalBlocks(blocks) {
  return blocks.map((block) => Object.fromEntries(Object.entries({
    type: block.type, blockId: block.blockId, seq: block.seq, status: block.status,
    text: block.text, toolCallId: block.toolCallId, output: block.output, error: block.error,
  }).filter(([, value]) => value !== undefined)));
}

function writeSessionFixture(scenario, file) {
  writeFileSync(file, `${scenario.sessionJsonl.map((entry) => JSON.stringify(entry)).join("\n")}\n`, "utf8");
}

function replaySse(stream, cursor = 0) {
  const frames = [];
  replayChatEvents(stream, { write: (chunk) => frames.push(String(chunk)) }, cursor);
  return frames.map((frame) => JSON.parse(frame.split("data: ")[1]));
}

export function runReplayScenario(scenario, mode = replayMode()) {
  const normalizedMode = replayMode(mode);
  const temp = mkdtempSync(join(tmpdir(), `agent-replay-${scenario.id}-`));
  const sessionFile = join(temp, "session.jsonl");
  writeSessionFixture(scenario, sessionFile);
  try {
    const engine = createEngine(scenario.events[0].sessionId);
    const stream = createStream();
    attachEngineEvents(engine, runtime(sessionFile, scenario.events[0].sessionId), stream);
    const intermediate = [];
    for (const event of scenario.events) {
      engine.emit({ ...event, ...(event.type === "tool.started" && event.input ? { input: normalizeReplayValue(event.input) } : {}) });
      intermediate.push(logicalBlocks(stream.blocks));
    }
    const live = payloads(stream);
    const done = live.find((event) => event.type === "done");
    assert.ok(done, `${scenario.id}: live replay must emit done`);
    assert.equal(live.filter((event) => event.type === "done").length, 1, `${scenario.id}: terminal presentation must be single-shot`);
    assert.equal(done.text, scenario.expected.text, `${scenario.id}: terminal text drift`);
    assert.deepEqual(done.blocks.map((block) => block.type), scenario.expected.blockTypes, `${scenario.id}: presentation block type drift`);
    assert.deepEqual(replaySse(stream, 0), live, `${scenario.id}: SSE replay drift`);
    const persisted = parseSessionMessages(readFileSync(sessionFile, "utf8"));
    const terminalTurnId = scenario.events.findLast((event) => event.type === "turn.completed" || event.type === "turn.failed" || event.type === "turn.cancelled")?.turnId;
    const refreshed = persisted.find((message) => message.role === "assistant" && message.turnId === terminalTurnId)
      || persisted.filter((message) => message.role === "assistant" && Array.isArray(message.blocks) && message.blocks.length > 0).at(-1);
    assert.ok(refreshed, `${scenario.id}: persisted assistant message missing`);
    const refreshText = refreshed.blocks.filter((block) => block.type === "text").map((block) => block.text || "").join("");
    assert.equal(refreshText, scenario.expected.text, `${scenario.id}: refresh text drift`);
    assert.deepEqual(refreshed.blocks.map((block) => block.type), scenario.expected.blockTypes, `${scenario.id}: refresh block drift`);
    const result = {
      id: scenario.id,
      mode: normalizedMode,
      live: { text: done.text, blocks: logicalBlocks(done.blocks), events: live.length, presentation: live },
      refresh: { text: refreshText, blocks: logicalBlocks(refreshed.blocks) },
      reconnect: replaySse(stream, Math.max(0, live.length - 2)),
      intermediate,
      fixture: stable(normalizeReplayValue(scenario)),
    };
    if (normalizedMode === "record") {
      const outputDir = process.env.MY_CODE_AGENT_REPLAY_RECORD_DIR;
      assert.ok(outputDir, "record mode requires MY_CODE_AGENT_REPLAY_RECORD_DIR");
      mkdirSync(outputDir, { recursive: true });
      writeFileSync(join(outputDir, `${scenario.id}.json`), `${JSON.stringify(result, null, 2)}\n`, "utf8");
    }
    return result;
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

export function fixturePath() { return CATALOG_PATH; }
