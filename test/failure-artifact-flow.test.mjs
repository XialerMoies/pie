import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { describe, it } from "node:test";

import {
  FAILURE_ARTIFACT_FILES,
  readArtifactJson,
  validateFailureArtifact,
  writeFailureArtifact,
} from "./helpers/failure-artifact.mjs";

const PNG = Buffer.from("89504e470d0a1a0a", "hex");

function syntheticEvidence() {
  return {
    failure: { code: "e2e_timeout", message: "failed at C:\\private\\workspace token=super-secret" },
    testConfig: { workspace: process.cwd(), memoryLimitMb: 2048, provider: "keyless-replay" },
    eventTrace: [{ type: "tool", blockId: "tool-1", status: "failed", input: { command: "rm -rf C:\\private" }, thinking: "hidden chain" }],
    requestCorrelation: { records: [{ traceId: "trace-1", stage: "presentation.emitted", details: { token: "secret-token" } }] },
    session: [{ type: "assistant_block", block: { type: "tool", blockId: "tool-1", status: "failed", output: "private result" } }],
    domAria: { nodes: [{ id: "chat-stop", role: "button", ariaBusy: "false" }], text: "private answer" },
    consoleNetwork: { console: ["Authorization: Bearer secret-bearer"], requests: [{ name: "sessions", status: 500 }] },
    process: { peakRssMb: 512, memoryLimitMb: 2048, processes: [{ pid: 1, command: "secret command" }] },
    screenshot: PNG,
    replay: { driver: "validate" },
  };
}

describe("T-04 unified failure artifact", () => {
  it("keeps the settled golden inventory explicit", () => {
    const goldenDir = resolve("test/fixtures/golden");
    assert.deepEqual(readdirSync(goldenDir), ["packaged-electron-settled-v1.json"]);
    const golden = JSON.parse(readFileSync(join(goldenDir, "packaged-electron-settled-v1.json"), "utf8"));
    assert.equal(golden.version, 1);
    assert.deepEqual(golden.replayProvider.blockIds, ["replay-thought", "replay-tool", "replay-text"]);
  });

  it("writes one declared, hashed and redacted cross-layer artifact", () => {
    const directory = mkdtempSync(join(tmpdir(), "failure-artifact-"));
    try {
      writeFailureArtifact(directory, syntheticEvidence());
      const manifest = validateFailureArtifact(directory);
      assert.deepEqual(FAILURE_ARTIFACT_FILES, [...FAILURE_ARTIFACT_FILES].sort());
      assert.equal(manifest.files.length, FAILURE_ARTIFACT_FILES.length - 1);
      const failure = readArtifactJson(directory, "failure.json");
      assert.equal(failure.code, "e2e_timeout");
      assert.match(failure.message, /^failed at <absolute-path>/u);
      assert.doesNotMatch(failure.message, /private|super-secret/iu);
      const serialized = FAILURE_ARTIFACT_FILES.filter((name) => name !== "screenshot.png").map((name) => readFileSync(join(directory, name), "utf8")).join("\n");
      assert.doesNotMatch(serialized, /super-secret|secret-token|secret-bearer|hidden chain|private result|rm -rf/iu);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("fails closed for undeclared files and modified evidence", () => {
    const directory = mkdtempSync(join(tmpdir(), "failure-artifact-drift-"));
    try {
      writeFailureArtifact(directory, syntheticEvidence());
      writeFileSync(join(directory, "undeclared.json"), "{}\n");
      assert.throws(() => validateFailureArtifact(directory), /inventory drift/u);
      rmSync(join(directory, "undeclared.json"));
      writeFileSync(join(directory, "failure.json"), "{}\n");
      assert.throws(() => validateFailureArtifact(directory), /hash mismatch/u);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("replays an artifact through one public command", () => {
    const directory = mkdtempSync(join(tmpdir(), "failure-artifact-replay-"));
    try {
      writeFailureArtifact(directory, syntheticEvidence());
      const result = spawnSync(process.execPath, [resolve("scripts/replay-failure-artifact.mjs"), directory, "--validate-only"], { encoding: "utf8" });
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /artifact-replay.*validated/u);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
