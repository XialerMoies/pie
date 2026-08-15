import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { resolve } from "node:path"
import { test } from "node:test"

import * as pi from "@xiamol/pi-coding-agent"

test("uses the PI 0.84 model runtime SDK contract", () => {
  assert.equal(pi.VERSION, "0.84.2-xiamol.0")

  for (const name of [
    "createAgentSession",
    "ModelRuntime",
    "ModelRegistry",
    "SessionManager",
    "DefaultResourceLoader",
    "SettingsManager",
  ]) {
    assert.equal(typeof pi[name], "function", `${name} must be exported`)
  }

  assert.equal("AuthStorage" in pi, false)
})

test("wires main and subagent sessions through ModelRuntime", async () => {
  const runtimeSource = await readFile(resolve("src/agent/runtime.ts"), "utf8")
  const subagentSource = await readFile(resolve("src/server/subagent-session.ts"), "utf8")

  assert.match(runtimeSource, /ModelRuntime\.create\(/)
  assert.match(runtimeSource, /modelRuntime:\s*this\.modelRuntime/)
  assert.doesNotMatch(runtimeSource, /\bAuthStorage\b/)
  assert.match(subagentSource, /modelRuntime:\s*runtime\.modelRuntime/)
  assert.doesNotMatch(subagentSource, /authStorage:\s*runtime\.authStorage/)
})
