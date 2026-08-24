import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  fixturePath,
  fixturePaths,
  loadReplayCatalog,
  replayMode,
  runReplayScenario,
} from "./fixtures/agent-session-replay.mjs";

describe("T-01 replay-first Agent/Session flow", () => {
  it("keeps the fixture catalog declared, deterministic and drift-checked", () => {
    const catalog = loadReplayCatalog();
    assert.equal(replayMode("replay"), "replay");
    assert.match(fixturePath(), /agent-session-replay-fixtures\.json$/u);
    assert.deepEqual(fixturePaths().map((path) => path.split(/[\\/]/u).at(-1)), ["agent-session-replay-fixtures.json", "agent-engineering-task-recordings.json"]);
    assert.equal(catalog.scenarios.length, 9);
    for (const scenario of catalog.scenarios) {
      assert.equal(scenario.events[0].timestamp, 1, `${scenario.id}: logical timestamps must start at one`);
      assert.equal(scenario.events.at(-1).type, "turn.completed", `${scenario.id}: replay fixtures must have a successful terminal for this gate`);
      assert.ok(scenario.modelResponses.every((response) => response.provider === "replay"));
      assert.ok(scenario.toolCalls.every((call) => typeof call.id === "string" && typeof call.name === "string"));
    }
  });

  it("replays every required scenario through runtime events, SSE, persistence and refresh", () => {
    const catalog = loadReplayCatalog();
    for (const scenario of catalog.scenarios) {
      const result = runReplayScenario(scenario, "replay");
      assert.equal(result.mode, "replay");
      assert.equal(result.live.text, result.replay.text, `${scenario.id}: live and replay text must converge`);
      assert.equal(result.replay.text, result.refresh.text, `${scenario.id}: replay and refresh text must converge`);
      assert.deepEqual(result.live.blocks, result.replay.blocks, `${scenario.id}: live and replay blocks must converge`);
      assert.deepEqual(result.replay.blocks, result.refresh.blocks, `${scenario.id}: replay and refresh blocks must converge`);
      assert.ok(result.reconnect.length > 0, `${scenario.id}: reconnect must replay a suffix`);
      assert.ok(result.intermediate.length === scenario.events.length, `${scenario.id}: every event must be observed`);
    }
  });

  it("supports refresh as a persistence-only path without re-running model or tool calls", () => {
    const catalog = loadReplayCatalog();
    const scenario = catalog.scenarios.find((entry) => entry.id === "refresh-recovery");
    assert.ok(scenario);
    const result = runReplayScenario(scenario, "refresh");
    assert.equal(result.mode, "refresh");
    assert.equal(result.live.text, "Recovered answer");
    assert.equal(result.refresh.text, "Recovered answer");
  });

  it("rejects record mode unless recording is explicitly enabled", () => {
    const previous = process.env.MY_CODE_AGENT_REPLAY_RECORD;
    delete process.env.MY_CODE_AGENT_REPLAY_RECORD;
    try {
      assert.throws(() => replayMode("record"), /record mode is opt-in/u);
    } finally {
      if (previous === undefined) delete process.env.MY_CODE_AGENT_REPLAY_RECORD;
      else process.env.MY_CODE_AGENT_REPLAY_RECORD = previous;
    }
  });

  it("writes an explicit record artifact only when both record guards are enabled", () => {
    const previousRecord = process.env.MY_CODE_AGENT_REPLAY_RECORD;
    const previousDir = process.env.MY_CODE_AGENT_REPLAY_RECORD_DIR;
    const outputDir = mkdtempSync(join(tmpdir(), "agent-replay-record-"));
    process.env.MY_CODE_AGENT_REPLAY_RECORD = "1";
    process.env.MY_CODE_AGENT_REPLAY_RECORD_DIR = outputDir;
    try {
      const scenario = loadReplayCatalog().scenarios[0];
      const result = runReplayScenario(scenario, "record");
      assert.equal(result.mode, "record");
      assert.deepEqual(readdirSync(outputDir), [`${scenario.id}.json`]);
    } finally {
      if (previousRecord === undefined) delete process.env.MY_CODE_AGENT_REPLAY_RECORD;
      else process.env.MY_CODE_AGENT_REPLAY_RECORD = previousRecord;
      if (previousDir === undefined) delete process.env.MY_CODE_AGENT_REPLAY_RECORD_DIR;
      else process.env.MY_CODE_AGENT_REPLAY_RECORD_DIR = previousDir;
      rmSync(outputDir, { recursive: true, force: true });
    }
  });
});
