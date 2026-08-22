import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const SERVER = resolve(ROOT, "src", "server", "server.ts");
const ROUTER = resolve(ROOT, "src", "server", "agent-event-router.ts");
const SSE_CONTROLLER = resolve(ROOT, "src", "frontend", "chat", "chat-sse-controller.ts");
const TOOLS = resolve(ROOT, "src", "agent", "tools", "index.ts");
const RUNTIME = resolve(ROOT, "src", "agent", "runtime.ts");
const TYPES = resolve(ROOT, "src", "agent", "types.ts");

describe("server agent event router structure", () => {
  it("keeps runtime session event handling outside the server bootstrap file", () => {
    assert.ok(existsSync(ROUTER), "agent-event-router.ts should own runtime event handling");

    const serverSource = readFileSync(SERVER, "utf8");
    const routerSource = readFileSync(ROUTER, "utf8");

    assert.doesNotMatch(serverSource, /attachSessionEvents/);
    assert.doesNotMatch(serverSource, /attachReplayEvents/);
    assert.doesNotMatch(serverSource, /runtime\.onEvent\(\(event: any, sourceSession\) =>/);
    assert.doesNotMatch(routerSource, /attachSessionEvents/);
    assert.doesNotMatch(routerSource, /attachReplayEvents/);
    assert.equal(
      existsSync(resolve(ROOT, "src", "server", "replay-event-adapter.ts")),
      false,
      "legacy replay adapter must be removed when old session compatibility is unsupported",
    );
  });

  it("keeps the canonical engine bridge on the presentation boundary", () => {
    const routerSource = readFileSync(ROUTER, "utf8");
    const engineBridge = routerSource.slice(routerSource.indexOf("export function attachEngineEvents("));
    assert.match(engineBridge, /writePresentationEvent\(chatStream/);
    assert.doesNotMatch(engineBridge, /writeChatEvent\(chatStream/);
    assert.match(routerSource, /reduceEngineEvent\(event\)/);
    assert.doesNotMatch(routerSource, /publish\?: boolean/);
  });

  it("keeps legacy raw delta/thinking frames out of the production frontend", () => {
    const controllerSource = readFileSync(SSE_CONTROLLER, "utf8");
    assert.doesNotMatch(controllerSource, /data\.type\s*===\s*['"]delta['"]/);
    assert.doesNotMatch(controllerSource, /data\.type\s*===\s*['"]thinking['"]/);
    assert.doesNotMatch(controllerSource, /handleDelta\s*\(/);
  });

  it("keeps test-only cache hooks and duplicate context aliases out of production", () => {
    const toolsSource = readFileSync(TOOLS, "utf8");
    const runtimeSource = readFileSync(RUNTIME, "utf8");
    assert.doesNotMatch(toolsSource, /_getMcpCacheLen|_setMcpCache|type ExtraCtx\s*=/);
    assert.doesNotMatch(runtimeSource, /type RuntimeToolExtraContext\s*=\s*Pick/);
    assert.match(toolsSource, /ToolExecutionExtraContext/);
    assert.match(runtimeSource, /ToolExecutionExtraContext/);
    const typesSource = readFileSync(TYPES, "utf8");
    assert.match(typesSource, /export type ToolHostContext = Omit<ToolContext/);
    assert.match(typesSource, /export type ToolExecutionExtraContext = Partial<ToolHostContext>/);
    assert.doesNotMatch(runtimeSource, /type RuntimeToolExtraContext\s*=/);
    assert.match(runtimeSource, /RuntimeConfig extends ToolHostContext/);
    for (const file of ["test/mcp-client.test.mjs", "test/mcp-client-service.test.mjs"]) {
      assert.doesNotMatch(readFileSync(resolve(ROOT, file), "utf8"), /_getMcpCacheLen|_setMcpCache/);
    }
  });
});
