import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const SERVER = resolve(ROOT, "src", "server", "server.ts");
const ROUTER = resolve(ROOT, "src", "server", "agent-event-router.ts");

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
    assert.match(routerSource, /if \(options\?\.publish !== false\) writeChatEvent/);
  });
});
