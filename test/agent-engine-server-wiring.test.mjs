import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");

function source(file) {
  return readFileSync(resolve(ROOT, file), "utf8");
}

describe("AgentEngine server and CLI wiring", () => {
  it("keeps PI session access behind the adapter", () => {
    for (const file of [
      "src/server/routes/chat.ts",
      "src/server/routes/sessions.ts",
      "src/server/routes/dashboard.ts",
      "src/server/routes/settings/models.ts",
      "src/server/routes/settings/thinking.ts",
      "src/server/routes/workspace-authorization.ts",
      "src/server/main.ts",
    ]) {
      const text = source(file);
      assert.doesNotMatch(text, /runtime\.session|ctx\.runtime\.session/, file);
      assert.doesNotMatch(text, /createAgentSession|AgentSession/, file);
    }
  });

  it("initializes desktop and CLI through the AgentEngine boundary", () => {
    const server = source("src/server/server.ts");
    const cli = source("src/server/main.ts");
    assert.match(server, /initAgentHost/);
    assert.match(server, /engine,/);
    assert.match(cli, /initEngine/);
    assert.match(cli, /engine\.subscribe/);
    assert.match(cli, /engine\.prompt/);
    assert.doesNotMatch(cli, /initAgent|session\.subscribe|session\.prompt/);
  });

  it("uses one shared host factory for both public initialization boundaries", () => {
    const agent = source("src/agent/index.ts");
    assert.match(agent, /async function createAgentHost\(config: RuntimeConfig\)/);
    assert.equal((agent.match(/AgentRuntime\.create\(config\)/g) || []).length, 1);
    assert.equal((agent.match(/new PiAgentEngineAdapter\(runtime\)/g) || []).length, 1);
    assert.doesNotMatch(agent, /export async function initAgent\(/);
    assert.match(agent, /return \(await createAgentHost\(config\)\)\.engine/);
    assert.match(agent, /return createAgentHost\(config\)/);
  });

  it("disables PI built-in tools so evidence reads use governed custom tools", () => {
    const runtime = source("src/agent/runtime.ts");
    assert.match(runtime, /noTools:\s*["']builtin["']/);
    assert.match(runtime, /customTools,/);
    assert.match(runtime, /excludeTools:\s*\[\s*["']read["']\s*,\s*["']bash["']\s*,\s*["']edit["']\s*,\s*["']write["']\s*,\s*["']grep["']\s*,\s*["']find["']\s*,\s*["']ls["']/);
  });
});
