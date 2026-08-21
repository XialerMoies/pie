import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { createTsserverSpawnOptions, TsserverManager } from "../src/server/ts-server.ts";

describe("tsserver process boundary", () => {
  it("bounds requests and rejects an unresponsive tsserver", async () => {
    const manager = new TsserverManager({ requestTimeoutMs: 20, maxPendingRequests: 1 });
    manager.process = { send() {} };

    const first = manager.sendRequest("semanticDiagnosticsSync", { file: "x.ts" });
    await assert.rejects(
      manager.sendRequest("syntacticDiagnosticsSync", { file: "x.ts" }),
      /request queue is full/,
    );
    await assert.rejects(first, /request timeout/);
  });

  it("uses the isolated tsserver environment and preserves project toolchain variables", () => {
    const previous = {
      PATH: process.env.PATH,
      CUSTOM_TOOLCHAIN: process.env.CUSTOM_TOOLCHAIN,
      OPENAI_API_KEY: process.env.OPENAI_API_KEY,
      MY_CODE_AGENT_DESKTOP_TOKEN: process.env.MY_CODE_AGENT_DESKTOP_TOKEN,
    };
    process.env.CUSTOM_TOOLCHAIN = "clang";
    process.env.OPENAI_API_KEY = "provider-secret";
    process.env.MY_CODE_AGENT_DESKTOP_TOKEN = "desktop-secret";
    try {
      const options = createTsserverSpawnOptions(
        "C:\\repo",
        "C:\\repo\\node_modules\\typescript\\lib",
      );
      assert.equal(options.cwd, "C:\\repo");
      assert.equal(options.env.CUSTOM_TOOLCHAIN, "clang");
      assert.equal(options.env.TS_INTERNAL, "C:\\repo\\node_modules\\typescript\\lib");
      assert.equal(options.env.OPENAI_API_KEY, undefined);
      assert.equal(options.env.MY_CODE_AGENT_DESKTOP_TOKEN, undefined);
      assert.deepEqual(options.stdio, ["pipe", "pipe", "pipe", "ipc"]);
    } finally {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  it("sanitizes tsserver stderr and error paths before logging", () => {
    const source = readFileSync(resolve(process.cwd(), "src/server/ts-server.ts"), "utf8");
    assert.match(source, /sanitizeProcessOutput\(chunk\.toString\(\)\)/);
    assert.match(source, /sanitizeProcessOutput\(err\)/);
    assert.match(source, /sanitizeProcessOutput\(msg\.message/);
    assert.doesNotMatch(source, /console\.error\("\[tsserver:err\]", chunk\.toString\(\)\)/);
  });
});
