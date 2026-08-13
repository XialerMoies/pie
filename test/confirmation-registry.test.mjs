import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { ConfirmationRegistry } from "../src/server/confirmation-registry.ts";

describe("ConfirmationRegistry", () => {
  it("settles an allowed confirmation while preserving its scope", async () => {
    const registry = new ConfirmationRegistry();
    const pending = registry.begin("command", ["chat-client"], 1000);

    assert.match(pending.id, /^cmd-/);
    assert.strictEqual(registry.resolve(pending.id, "command", { allow: true, scope: "workspace" }), true);
    assert.deepStrictEqual(await pending.result, { allow: true, scope: "workspace" });
    assert.strictEqual(registry.resolve(pending.id, "command", { allow: true }), false);
  });

  it("does not let one confirmation endpoint settle the other kind", async () => {
    const registry = new ConfirmationRegistry();
    const pending = registry.begin("permission", ["events-client"], 1000);

    assert.strictEqual(registry.resolve(pending.id, "command", { allow: true }), false);
    assert.strictEqual(registry.resolve(pending.id, "permission", { allow: false }), true);
    assert.deepStrictEqual(await pending.result, { allow: false });
  });

  it("normalizes denied decisions and timeouts to fail-closed", async () => {
    const registry = new ConfirmationRegistry();
    const denied = registry.begin("permission", ["events-client"], 1000);
    registry.resolve(denied.id, "permission", { allow: false, scope: "workspace" });
    assert.deepStrictEqual(await denied.result, { allow: false });

    const timedOut = registry.begin("permission", ["events-client"], 5);
    assert.deepStrictEqual(await timedOut.result, { allow: false });
  });

  it("fails closed only after the final response for that confirmation is removed", async () => {
    const registry = new ConfirmationRegistry();
    const pending = registry.begin("permission", ["first", "second"], 1000);
    let settled = false;
    void pending.result.then(() => { settled = true; });

    registry.removeResponse("first", "permission");
    await Promise.resolve();
    assert.strictEqual(settled, false);

    registry.removeResponse("second", "permission");
    assert.deepStrictEqual(await pending.result, { allow: false });
  });

  it("keeps command and permission transport modules free of private pending maps", () => {
    const root = resolve(import.meta.dirname, "..");
    const chat = readFileSync(resolve(root, "src/server/routes/chat.ts"), "utf8");
    const permission = readFileSync(resolve(root, "src/server/permission-confirmation.ts"), "utf8");

    assert.doesNotMatch(chat, /pendingCommandConfirmations|type PendingCommandConfirmation/);
    assert.doesNotMatch(permission, /pendingPermissionConfirmations|type PendingPermissionConfirmation/);
    assert.match(chat, /serverConfirmationRegistry/);
    assert.match(permission, /serverConfirmationRegistry/);
  });
});
