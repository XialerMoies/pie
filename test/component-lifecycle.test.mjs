import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  CapabilityComponentError,
  CapabilityComponentManager,
} from "../src/agent/capability-components.ts";
import { handleComponents } from "../src/server/routes/components.ts";

const required = {
  id: "permission-evaluator",
  version: "1",
  kind: "required",
  capability: "permission",
  replacementGroup: "permission",
  source: "builtin",
};

describe("CapabilityComponentManager", () => {
  it("registers built-in required components as active", () => {
    const manager = new CapabilityComponentManager([required]);
    const state = manager.require("permission-evaluator");
    assert.equal(state.manifest.kind, "required");
    assert.equal(state.trusted, true);
    assert.equal(state.enabled, true);
    assert.equal(state.health, "healthy");
    assert.equal(state.status, "active");
  });

  it("keeps optional components untrusted and disabled until explicitly enabled", () => {
    const manager = new CapabilityComponentManager();
    manager.register({ id: "github-mcp", version: "1", kind: "optional", capability: "mcp.server", source: "mcp" });
    assert.equal(manager.require("github-mcp").status, "untrusted");
    assert.throws(() => manager.enable("github-mcp"), (error) => error instanceof CapabilityComponentError && error.code === "untrusted_component");
    manager.trust("github-mcp");
    assert.throws(() => manager.enable("github-mcp"), (error) => error instanceof CapabilityComponentError && error.code === "unhealthy_component");
    manager.setHealth("github-mcp", "healthy");
    assert.equal(manager.enable("github-mcp").status, "active");
  });

  it("requires healthy enabled dependencies before activation", () => {
    const manager = new CapabilityComponentManager();
    manager.register({ id: "mcp-host", version: "1", kind: "optional", capability: "mcp-host", source: "workspace" });
    manager.register({ id: "github-mcp", version: "1", kind: "optional", capability: "mcp.server", dependencies: ["mcp-host"], source: "mcp" });
    manager.trust("mcp-host"); manager.setHealth("mcp-host", "healthy"); manager.enable("mcp-host");
    manager.trust("github-mcp"); manager.setHealth("github-mcp", "healthy");
    assert.equal(manager.enable("github-mcp").status, "active");
  });

  it("rejects disabling or uninstalling a required component without replacement", () => {
    const manager = new CapabilityComponentManager([required]);
    assert.throws(() => manager.disable("permission-evaluator"), (error) => error.code === "required_component");
    assert.throws(() => manager.uninstall("permission-evaluator"), (error) => error.code === "required_component");
    assert.ok(manager.get("permission-evaluator"));
  });

  it("allows an optional component to be disabled and uninstalled", () => {
    const manager = new CapabilityComponentManager();
    manager.register({ id: "search-pane", version: "1", kind: "optional", capability: "ui-pane", source: "workspace" }, { trusted: true, health: "healthy" });
    manager.enable("search-pane");
    assert.equal(manager.disable("search-pane").status, "disabled");
    manager.uninstall("search-pane");
    assert.equal(manager.get("search-pane"), undefined);
  });

  it("records generation and lifecycle audit events", () => {
    const manager = new CapabilityComponentManager();
    manager.register({ id: "demo-tool", version: "1", kind: "optional", capability: "tool", source: "user" });
    manager.trust("demo-tool");
    manager.setHealth("demo-tool", "healthy");
    manager.enable("demo-tool");
    const events = manager.events();
    assert.deepEqual(events.map((event) => event.action), ["registered", "trusted", "health_changed", "enabled"]);
    assert.ok(events.every((event) => Number.isInteger(event.generation) && event.timestamp));
    assert.ok(manager.catalog().fingerprint.length > 20);
  });

  it("rejects malformed manifests before they enter the catalog", () => {
    const manager = new CapabilityComponentManager();
    assert.throws(() => manager.register({ id: "Bad ID", version: "1", kind: "optional", capability: "tool" }), (error) => error.code === "invalid_manifest");
    assert.equal(manager.list().length, 0);
  });

  it("publishes a read-only host catalog without exposing management actions", async () => {
    const headers = {};
    let body = "";
    const handled = await handleComponents(
      { url: "/api/components", method: "GET" },
      { writeHead(status, values) { headers.status = status; Object.assign(headers, values); }, end(value) { body = String(value); } },
      {} ,
    );
    assert.equal(handled, true);
    assert.equal(headers.status, 200);
    const catalog = JSON.parse(body);
    assert.equal(catalog.schemaVersion, 1);
    assert.ok(catalog.components.some((component) => component.manifest.id === "security-parser"));
    assert.equal(catalog.components.some((component) => "enable" in component), false);
  });
});
