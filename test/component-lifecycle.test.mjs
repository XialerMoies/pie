import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  CapabilityComponentManager,
  persistCapabilityComponentGeneration,
  readCapabilityComponentGeneration,
  validateCapabilityComponentManifest,
} from "../src/agent/capability-components.ts";
import { handleComponents } from "../src/server/routes/components.ts";

const modelRouter = {
  id: "model-router", version: "1", kind: "required", capability: "model-router",
  replacementGroup: "model-router", source: "builtin",
};
const passedPreflight = () => Promise.resolve({
  isolated: true, staticCheck: { status: "passed" }, replay: { status: "passed" },
  failureMatrix: { status: "passed" }, shadow: { status: "passed" },
});

describe("CapabilityComponentManager", () => {
  it("keeps product classification validation fail-closed", () => {
    assert.throws(() => validateCapabilityComponentManifest({ id: "bad-system", version: "1", kind: "optional", capability: "runtime", productClass: "system" }), /must be required/);
    const normalized = validateCapabilityComponentManifest({ id: "good-mcp", version: "1", kind: "optional", capability: "mcp.server", source: "mcp", productClass: "mcp", hostSurface: "mcp-service" });
    assert.equal(normalized.productClass, "mcp");
  });

  it("registers core providers as active", () => {
    const manager = new CapabilityComponentManager([modelRouter]);
    assert.equal(manager.require("model-router").status, "active");
  });

  it("keeps optional components removable", () => {
    const manager = new CapabilityComponentManager();
    manager.register({ id: "search-pane", version: "1", kind: "optional", capability: "ui-pane", source: "workspace" }, { trusted: true, health: "healthy" });
    manager.enable("search-pane");
    assert.equal(manager.disable("search-pane").status, "disabled");
    manager.uninstall("search-pane");
    assert.equal(manager.get("search-pane"), undefined);
  });

  it("rejects replacing a host service outside the three core slots", async () => {
    const permission = { id: "permission-evaluator", version: "1", kind: "required", capability: "permission", replacementGroup: "permission", source: "builtin" };
    const manager = new CapabilityComponentManager([permission]);
    manager.register({ ...permission, id: "permission-evaluator.v2", version: "2", source: "user" }, { trusted: true, health: "healthy" });
    await assert.rejects(manager.replaceRequired("permission-evaluator", "permission-evaluator.v2", { approved: true, preflight: passedPreflight }), (error) => error.code === "core_replacement_only");
  });

  it("pins old and new sessions to a core provider generation", async () => {
    const manager = new CapabilityComponentManager([modelRouter]);
    const v1 = { kind: "model-router", createSession() {} };
    const v2 = { kind: "model-router", createSession() {} };
    manager.bindRequiredProvider("model-router", v1);
    manager.register({ ...modelRouter, id: "model-router.v2", version: "2", source: "user" }, { trusted: true, health: "healthy" });
    manager.bindRequiredProvider("model-router.v2", v2);
    const oldLease = manager.acquireRequiredLease();
    const result = await manager.replaceRequired("model-router", "model-router.v2", { approved: true, preflight: passedPreflight, verify: async () => {} });
    assert.equal(result.status, "committed");
    assert.equal(oldLease.resolve("model-router"), "model-router");
    const newLease = manager.acquireRequiredLease();
    assert.equal(newLease.resolve("model-router"), "model-router.v2");
    oldLease.release();
    newLease.release();
  });

  it("migrates removed provider references to the current core baseline", () => {
    const manager = new CapabilityComponentManager([modelRouter]);
    const lease = manager.acquireRequiredLease({ generation: 4, providers: { permission: "permission-evaluator", "model-router": "model-router" } });
    assert.deepEqual(lease.ref.providers, { "model-router": "model-router" });
    lease.release();
  });

  it("publishes a catalog without host-service replacement entries", async () => {
    let body = "";
    const handled = await handleComponents(
      { url: "/api/components", method: "GET" },
      { writeHead(status) { assert.equal(status, 200); }, end(value) { body = String(value); } },
      { groups: { core: { runtime: { currentWorkspace: process.cwd() } }, storage: { paths: { APP_ROOT: process.cwd() } } } },
    );
    assert.equal(handled, true);
    const catalog = JSON.parse(body);
    assert.equal(catalog.components.some((component) => component.manifest.id === "security-parser"), false);
    assert.ok(catalog.components.some((component) => component.manifest.id === "ui.pane.search"));
  });

  it("round-trips a session generation fact", () => {
    const entries = [];
    persistCapabilityComponentGeneration({ appendCustomEntry(type, data) { entries.push({ type: "custom", customType: type, data }); } }, { generation: 2, providers: { "model-router": "model-router" } });
    assert.deepEqual(readCapabilityComponentGeneration(entries), { generation: 2, providers: { "model-router": "model-router" } });
  });
});
