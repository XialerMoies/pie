import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
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

  it("supports parent components and version/capability dependency contracts", () => {
    const manager = new CapabilityComponentManager();
    manager.register({ id: "plugin-a", version: "1.2.0", kind: "optional", capability: "plugin", source: "user" }, { trusted: true, health: "healthy" });
    manager.register({
      id: "plugin-a.search", version: "1", kind: "optional", capability: "tool", source: "user", parentId: "plugin-a",
      dependencies: [{ id: "plugin-a", version: "^1.0.0", capability: "plugin" }],
    }, { trusted: true, health: "healthy" });
    assert.throws(() => manager.enable("plugin-a.search"), (error) => error.code === "missing_dependency" && error.dependencyChain?.includes("plugin-a"));
    manager.enable("plugin-a");
    assert.equal(manager.enable("plugin-a.search").status, "active");
    assert.equal(manager.require("plugin-a.search").manifest.parentId, "plugin-a");
  });

  it("rejects dependency cycles and uninstalling an enabled dependency", () => {
    const manager = new CapabilityComponentManager();
    manager.register({ id: "plugin-a", version: "1", kind: "optional", capability: "plugin", dependencies: ["plugin-b"], source: "user" }, { trusted: true, health: "healthy" });
    assert.throws(() => manager.register({ id: "plugin-b", version: "1", kind: "optional", capability: "plugin", dependencies: ["plugin-a"], source: "user" }), (error) => error.code === "dependency_cycle");
    manager.register({ id: "plugin-b", version: "1", kind: "optional", capability: "plugin", source: "user" }, { trusted: true, health: "healthy" });
    manager.enable("plugin-b");
    manager.enable("plugin-a");
    assert.throws(() => manager.uninstall("plugin-b"), (error) => error.code === "dependency_in_use" && error.dependencyChain?.join(">") === "plugin-b>plugin-a");
  });

  it("allows absent optional dependencies while enforcing required version ranges", () => {
    const manager = new CapabilityComponentManager();
    manager.register({ id: "plugin-a", version: "2.1.0", kind: "optional", capability: "plugin", source: "user" }, { trusted: true, health: "healthy" });
    manager.register({ id: "plugin-b", version: "1", kind: "optional", capability: "plugin", dependencies: [{ id: "missing", optional: true }, { id: "plugin-a", version: ">=2.0.0" }], source: "user" }, { trusted: true, health: "healthy" });
    manager.enable("plugin-a");
    assert.equal(manager.enable("plugin-b").status, "active");
    manager.register({ id: "plugin-c", version: "1", kind: "optional", capability: "plugin", dependencies: [{ id: "plugin-a", version: "^3.0.0" }], source: "user" }, { trusted: true, health: "healthy" });
    assert.throws(() => manager.enable("plugin-c"), (error) => error.code === "missing_dependency");
  });

  it("starts dependencies first and stops enabled dependents first", () => {
    const manager = new CapabilityComponentManager();
    manager.register({ id: "plugin-a", version: "1", kind: "optional", capability: "plugin", source: "user" }, { trusted: true, health: "healthy" });
    manager.register({ id: "plugin-a.search", version: "1", kind: "optional", capability: "tool", parentId: "plugin-a", source: "user" }, { trusted: true, health: "healthy" });
    manager.register({ id: "plugin-b", version: "1", kind: "optional", capability: "plugin", dependencies: ["plugin-a.search"], source: "user" }, { trusted: true, health: "healthy" });
    assert.deepEqual(manager.enableTree("plugin-b").order, ["plugin-a", "plugin-a.search", "plugin-b"]);
    assert.throws(() => manager.disable("plugin-a"), (error) => error.code === "dependency_in_use");
    const stopped = manager.disableTree("plugin-a");
    assert.deepEqual(stopped.order, ["plugin-b", "plugin-a.search", "plugin-a"]);
    assert.ok(stopped.states.every((state) => state.enabled === false));
  });

  it("removes downstream components from the Agent projection when a dependency becomes unhealthy", () => {
    const manager = new CapabilityComponentManager();
    manager.register({ id: "plugin-a", version: "1", kind: "optional", capability: "plugin", source: "user" }, { trusted: true, health: "healthy" });
    manager.register({ id: "plugin-b", version: "1", kind: "optional", capability: "tool", dependencies: ["plugin-a"], source: "user" }, { trusted: true, health: "healthy" });
    manager.enableTree("plugin-b");
    assert.deepEqual(manager.agentProjection().map((entry) => entry.id), ["plugin-a", "plugin-b"]);
    manager.setHealth("plugin-a", "broken");
    assert.deepEqual(manager.agentProjection(), []);
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
      { groups: { core: { runtime: { currentWorkspace: process.cwd() } }, storage: { paths: { APP_ROOT: process.cwd() } } } },
    );
    assert.equal(handled, true);
    assert.equal(headers.status, 200);
    const catalog = JSON.parse(body);
    assert.equal(catalog.schemaVersion, 1);
    assert.ok(catalog.components.some((component) => component.manifest.id === "security-parser"));
    assert.equal(catalog.components.some((component) => "enable" in component), false);
  });

  it("does not create a new generation when an external status is unchanged", () => {
    const manager = new CapabilityComponentManager();
    const options = { version: "1", kind: "optional", capability: "mcp.server", source: "mcp", trusted: true, enabled: true, health: "healthy" };
    const first = manager.sync("mcp-server.demo", options);
    const second = manager.sync("mcp-server.demo", options);
    assert.equal(second.generation, first.generation);
    assert.equal(manager.catalog().generation, first.generation);
  });

  it("persists and restores optional component state without exposing management data", async () => {
    const root = mkdtempSync(join(tmpdir(), "components-"));
    try {
      const filePath = join(root, "component-state.json");
      const manager = new CapabilityComponentManager();
      manager.register({ id: "demo-tool", version: "1", kind: "optional", capability: "tool", source: "user" });
      manager.trust("demo-tool");
      manager.setHealth("demo-tool", "healthy");
      manager.enable("demo-tool");
      await manager.save(filePath);
      assert.match(readFileSync(filePath, "utf8"), /demo-tool/);

      const restored = new CapabilityComponentManager();
      await restored.restore(filePath);
      assert.equal(restored.require("demo-tool").status, "active");
      assert.deepEqual(restored.agentProjection(), [{ id: "demo-tool", capability: "tool", version: "1" }]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("restores active dependency trees independently of persisted catalog order", async () => {
    const root = mkdtempSync(join(tmpdir(), "component-tree-"));
    try {
      const filePath = join(root, "component-state.json");
      const manager = new CapabilityComponentManager();
      manager.register({ id: "z-parent", version: "1", kind: "optional", capability: "plugin", source: "user" }, { trusted: true, health: "healthy" });
      manager.register({ id: "a-child", version: "1", kind: "optional", capability: "tool", parentId: "z-parent", source: "user" }, { trusted: true, health: "healthy" });
      manager.enableTree("a-child");
      await manager.save(filePath);

      const restored = new CapabilityComponentManager();
      await restored.restore(filePath);
      assert.equal(restored.require("z-parent").status, "active");
      assert.equal(restored.require("a-child").status, "active");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
