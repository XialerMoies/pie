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
});
