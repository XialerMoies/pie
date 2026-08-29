import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SessionManager } from "@xiamol/pi-coding-agent";
import {
  CapabilityComponentError,
  CapabilityComponentManager,
  persistCapabilityComponentGeneration,
  readCapabilityComponentGeneration,
  validateCapabilityComponentManifest,
} from "../src/agent/capability-components.ts";
import { handleComponents } from "../src/server/routes/components.ts";
import {
  FILE_READ_COMPONENT_PACKAGE_MANIFEST,
  installFirstPartyComponentPackage,
  registerFirstPartyComponentPackages,
} from "../src/agent/component-package.ts";

const required = {
  id: "permission-evaluator",
  version: "1",
  kind: "required",
  capability: "permission",
  replacementGroup: "permission",
  source: "builtin",
};

const requiredPresentation = {
  id: "tool-presentation",
  version: "1",
  kind: "required",
  capability: "tool-presentation",
  replacementGroup: "tool-presentation",
  source: "builtin",
};

const passedPreflight = () => Promise.resolve({
  isolated: true,
  staticCheck: { status: "passed" },
  replay: { status: "passed" },
  failureMatrix: { status: "passed" },
  shadow: { status: "passed" },
});

function registerPermissionReplacement(manager, id = "permission-evaluator.v2") {
  return manager.register({ ...required, id, version: "2", source: "user" }, { trusted: true, health: "healthy" });
}

describe("CapabilityComponentManager", () => {
  it("requires product-facing classification to keep system and MCP boundaries explicit", () => {
    assert.throws(() => validateCapabilityComponentManifest({ id: "bad-system", version: "1", kind: "optional", capability: "runtime", productClass: "system" }), /must be required/);
    assert.throws(() => validateCapabilityComponentManifest({ id: "bad-system-source", version: "1", kind: "required", capability: "runtime", replacementGroup: "runtime", productClass: "system" }), /must come from builtin/);
    assert.throws(() => validateCapabilityComponentManifest({ id: "bad-mcp", version: "1", kind: "optional", capability: "mcp.server", source: "workspace", productClass: "mcp" }), /source=mcp/);
    const normalized = validateCapabilityComponentManifest({ id: "good-mcp", version: "1", kind: "optional", capability: "mcp.server", source: "mcp", productClass: "mcp", hostSurface: "mcp-service" });
    assert.equal(normalized.productClass, "mcp");
    assert.equal(normalized.hostSurface, "mcp-service");
  });
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

  it("binds one immutable runtime implementation to a required provider lease", () => {
    const manager = new CapabilityComponentManager([requiredPresentation]);
    const implementation = { present() { return []; } };
    manager.bindRequiredProvider("tool-presentation", implementation);
    assert.strictEqual(manager.bindRequiredProvider("tool-presentation", implementation).implementation, implementation);
    assert.throws(
      () => manager.bindRequiredProvider("tool-presentation", { present() { return []; } }),
      (error) => error.code === "provider_binding_conflict",
    );
    const lease = manager.acquireRequiredLease();
    const binding = lease.resolveBinding("tool-presentation");
    assert.equal(binding.componentId, "tool-presentation");
    assert.strictEqual(binding.implementation, implementation);
    assert.deepEqual(manager.catalog().boundRequiredProviders, ["tool-presentation"]);
    lease.release();
  });

  it("rejects replacing a runtime-bound provider with a manifest-only candidate", async () => {
    const manager = new CapabilityComponentManager([requiredPresentation]);
    manager.bindRequiredProvider("tool-presentation", { present() { return []; } });
    manager.register({ ...requiredPresentation, id: "tool-presentation.v2", version: "2", source: "user" }, { trusted: true, health: "healthy" });
    await assert.rejects(
      manager.replaceRequired("tool-presentation", "tool-presentation.v2", { preflight: passedPreflight }),
      (error) => error.code === "unbound_replacement",
    );
    assert.equal(manager.activeRequiredProvider("tool-presentation").manifest.id, "tool-presentation");
  });

  it("requires verification for bound providers and restores the old binding after failure", async () => {
    const manager = new CapabilityComponentManager([requiredPresentation]);
    const currentImplementation = { present() { return []; } };
    const candidateImplementation = { present() { return []; } };
    manager.bindRequiredProvider("tool-presentation", currentImplementation);
    manager.register({ ...requiredPresentation, id: "tool-presentation.v2", version: "2", source: "user" }, { trusted: true, health: "healthy" });
    manager.bindRequiredProvider("tool-presentation.v2", candidateImplementation);

    await assert.rejects(
      manager.replaceRequired("tool-presentation", "tool-presentation.v2", { preflight: passedPreflight }),
      (error) => error.code === "replacement_verification_required",
    );
    const result = await manager.replaceRequired("tool-presentation", "tool-presentation.v2", {
      preflight: passedPreflight,
      verify: async () => { throw new Error("provider probe failed"); },
    });
    assert.equal(result.status, "rolled_back");
    const lease = manager.acquireRequiredLease();
    assert.equal(lease.resolve("tool-presentation"), "tool-presentation");
    assert.strictEqual(lease.resolveBinding("tool-presentation").implementation, currentImplementation);
    lease.release();
  });

  it("requires approval and a complete isolated preflight for high-risk replacement", async () => {
    const manager = new CapabilityComponentManager([required]);
    registerPermissionReplacement(manager);
    await assert.rejects(manager.replaceRequired("permission-evaluator", "permission-evaluator.v2", { preflight: passedPreflight }), (error) => error.code === "replacement_approval_required");
    await assert.rejects(manager.replaceRequired("permission-evaluator", "permission-evaluator.v2", {
      approved: true,
      preflight: async () => ({ ...(await passedPreflight()), replay: { status: "failed", detail: "fixture mismatch" } }),
    }), (error) => error.code === "replacement_preflight_failed");
    assert.equal(manager.activeRequiredProvider("permission").manifest.id, "permission-evaluator");
  });

  it("atomically replaces a required provider while old sessions retain their lease", async () => {
    const manager = new CapabilityComponentManager([required]);
    registerPermissionReplacement(manager);
    const oldLease = manager.acquireRequiredLease();
    const result = await manager.replaceRequired("permission-evaluator", "permission-evaluator.v2", { approved: true, preflight: passedPreflight });
    assert.equal(result.status, "committed");
    assert.equal(manager.require("permission-evaluator").generation, result.generation);
    assert.equal(manager.require("permission-evaluator.v2").generation, result.generation);
    assert.equal(oldLease.resolve("permission"), "permission-evaluator");
    const newLease = manager.acquireRequiredLease();
    assert.equal(newLease.resolve("permission"), "permission-evaluator.v2");
    await assert.rejects(manager.disposeRetiredRequired("permission-evaluator", () => {}), (error) => error.code === "component_in_use");
    oldLease.release();
    let disposed = "";
    await manager.disposeRetiredRequired("permission-evaluator", (state) => { disposed = state.manifest.id; });
    assert.equal(disposed, "permission-evaluator");
    assert.equal(manager.get("permission-evaluator"), undefined);
    newLease.release();
  });

  it("blocks new leases while a retired provider is being disposed", async () => {
    const manager = new CapabilityComponentManager([required]);
    registerPermissionReplacement(manager);
    const retiredRef = manager.requiredGeneration();
    await manager.replaceRequired("permission-evaluator", "permission-evaluator.v2", { approved: true, preflight: passedPreflight });

    let finishDispose;
    const disposing = manager.disposeRetiredRequired("permission-evaluator", () => new Promise((resolve) => { finishDispose = resolve; }));
    await new Promise((resolve) => setImmediate(resolve));
    assert.throws(
      () => manager.acquireRequiredLease(retiredRef),
      (error) => error.code === "unavailable_component_generation",
    );
    await assert.rejects(
      manager.replaceRequired("permission-evaluator.v2", "permission-evaluator", { approved: true, preflight: passedPreflight }),
      (error) => error.code === "component_disposing",
    );
    finishDispose();
    await disposing;
    assert.equal(manager.get("permission-evaluator"), undefined);
  });

  it("rolls back atomically when post-switch verification fails", async () => {
    const manager = new CapabilityComponentManager([required]);
    registerPermissionReplacement(manager);
    const result = await manager.replaceRequired("permission-evaluator", "permission-evaluator.v2", {
      approved: true,
      preflight: passedPreflight,
      verify: async () => { throw new Error("live probe failed"); },
    });
    assert.equal(result.status, "rolled_back");
    assert.equal(result.activeId, "permission-evaluator");
    assert.equal(manager.activeRequiredProvider("permission").manifest.id, "permission-evaluator");
    assert.equal(manager.require("permission-evaluator.v2").enabled, false);
  });

  it("rolls back when replacement persistence fails", async () => {
    const manager = new CapabilityComponentManager([required]);
    registerPermissionReplacement(manager);
    let writes = 0;
    const result = await manager.replaceRequired("permission-evaluator", "permission-evaluator.v2", {
      approved: true,
      preflight: passedPreflight,
      persist: async () => { writes += 1; if (writes === 1) throw new Error("disk full"); },
    });
    assert.equal(result.status, "rolled_back");
    assert.equal(writes, 2);
    assert.equal(manager.activeRequiredProvider("permission").manifest.id, "permission-evaluator");
  });

  it("rolls back to the previous healthy provider when the replacement becomes unhealthy", async () => {
    const manager = new CapabilityComponentManager([required]);
    registerPermissionReplacement(manager);
    await manager.replaceRequired("permission-evaluator", "permission-evaluator.v2", { approved: true, preflight: passedPreflight });
    manager.setHealth("permission-evaluator.v2", "broken");
    assert.equal(manager.activeRequiredProvider("permission").manifest.id, "permission-evaluator");
    assert.equal(manager.require("permission-evaluator.v2").enabled, false);
  });

  it("rejects replacement contract drift before preflight", async () => {
    const manager = new CapabilityComponentManager([required]);
    manager.register({ ...required, id: "permission-evaluator.v2", source: "user", requiredContract: { version: "2", permissionBoundary: "host", resourceProfile: "default" } }, { trusted: true, health: "healthy" });
    let called = false;
    await assert.rejects(manager.replaceRequired("permission-evaluator", "permission-evaluator.v2", {
      approved: true,
      preflight: async () => { called = true; return passedPreflight(); },
    }), (error) => error.code === "incompatible_replacement");
    assert.equal(called, false);
  });

  it("rejects a stale candidate changed while isolated preflight is running", async () => {
    const manager = new CapabilityComponentManager([required]);
    registerPermissionReplacement(manager);
    let finishPreflight;
    const replacing = manager.replaceRequired("permission-evaluator", "permission-evaluator.v2", {
      approved: true,
      preflight: () => new Promise((resolve) => { finishPreflight = resolve; }),
    });
    await new Promise((resolve) => setImmediate(resolve));
    manager.setHealth("permission-evaluator.v2", "broken");
    finishPreflight(await passedPreflight());
    await assert.rejects(replacing, (error) => error.code === "stale_replacement");
    assert.equal(manager.activeRequiredProvider("permission").manifest.id, "permission-evaluator");
  });

  it("aborts a timed-out preflight without changing the active provider", async () => {
    const manager = new CapabilityComponentManager([required]);
    registerPermissionReplacement(manager);
    let preflightSignal;
    await assert.rejects(manager.replaceRequired("permission-evaluator", "permission-evaluator.v2", {
      approved: true,
      preflightTimeoutMs: 10,
      preflight: ({ signal }) => {
        preflightSignal = signal;
        return new Promise(() => {});
      },
    }), (error) => error.code === "replacement_preflight_failed" && /timed out/u.test(error.message));
    assert.equal(preflightSignal?.aborted, true);
    assert.equal(manager.activeRequiredProvider("permission").manifest.id, "permission-evaluator");
    assert.equal(manager.require("permission-evaluator.v2").enabled, false);
  });

  it("aborts timed-out verification and persists the rollback generation", async () => {
    const manager = new CapabilityComponentManager([required]);
    registerPermissionReplacement(manager);
    let verificationSignal;
    const writes = [];
    const result = await manager.replaceRequired("permission-evaluator", "permission-evaluator.v2", {
      approved: true,
      preflight: passedPreflight,
      verificationTimeoutMs: 10,
      persist: async (ref) => { writes.push(structuredClone(ref)); },
      verify: ({ signal }) => {
        verificationSignal = signal;
        return new Promise(() => {});
      },
    });
    assert.equal(result.status, "rolled_back");
    assert.match(result.reason, /timed out/u);
    assert.equal(verificationSignal?.aborted, true);
    assert.equal(writes.length, 2);
    assert.equal(writes[0].providers.permission, "permission-evaluator.v2");
    assert.equal(writes[1].providers.permission, "permission-evaluator");
    assert.equal(manager.activeRequiredProvider("permission").manifest.id, "permission-evaluator");
  });

  it("runs bounded provider health checks and marks a timed-out provider unavailable", async () => {
    const manager = new CapabilityComponentManager([required]);
    let healthSignal;
    manager.bindRequiredProvider("permission-evaluator", {
      kind: "permission-evaluator",
      authorizeTool: async () => ({ allowed: true }),
      authorizePath: async () => ({ operation: "read", root: ".", path: ".", relativePath: "." }),
      authorizePathSync: () => ({ operation: "read", root: ".", path: ".", relativePath: "." }),
      authorizeWorkspaceRoot: async (workspace) => workspace,
      health: (signal) => {
        healthSignal = signal;
        return new Promise(() => {});
      },
    });
    const state = await manager.healthCheckRequired("permission-evaluator", { timeoutMs: 10 });
    assert.equal(state.health, "unavailable");
    assert.equal(healthSignal?.aborted, true);
  });

  it("uses the bound provider dispose hook after references are released", async () => {
    const manager = new CapabilityComponentManager([required]);
    let disposed = 0;
    manager.bindRequiredProvider("permission-evaluator", {
      kind: "permission-evaluator",
      authorizeTool: async () => ({ allowed: true }),
      authorizePath: async () => ({ operation: "read", root: ".", path: ".", relativePath: "." }),
      authorizePathSync: () => ({ operation: "read", root: ".", path: ".", relativePath: "." }),
      authorizeWorkspaceRoot: async (workspace) => workspace,
      dispose: async () => { disposed += 1; },
    });
    manager.register({ ...required, id: "permission-evaluator.v2", version: "2", source: "user" }, { trusted: true, health: "healthy" });
    manager.bindRequiredProvider("permission-evaluator.v2", {
      kind: "permission-evaluator",
      authorizeTool: async () => ({ allowed: true }),
      authorizePath: async () => ({ operation: "read", root: ".", path: ".", relativePath: "." }),
      authorizePathSync: () => ({ operation: "read", root: ".", path: ".", relativePath: "." }),
      authorizeWorkspaceRoot: async (workspace) => workspace,
    });
    await manager.replaceRequired("permission-evaluator", "permission-evaluator.v2", { approved: true, preflight: passedPreflight, verify: async () => {} });
    await manager.disposeRetiredRequired("permission-evaluator");
    assert.equal(disposed, 1);
  });

  it("fails closed when provider state migration exceeds its bound", async () => {
    const manager = new CapabilityComponentManager([required]);
    registerPermissionReplacement(manager);
    let migrationSignal;
    await assert.rejects(manager.replaceRequired("permission-evaluator", "permission-evaluator.v2", {
      approved: true,
      migrationTimeoutMs: 10,
      preflight: passedPreflight,
      migrateState: ({ signal }) => {
        migrationSignal = signal;
        return new Promise(() => {});
      },
    }), (error) => error.code === "replacement_migration_failed" && /timed out/u.test(error.message));
    assert.equal(migrationSignal?.aborted, true);
    assert.equal(manager.activeRequiredProvider("permission").manifest.id, "permission-evaluator");
  });

  it("persists an automatic health rollback raised during verification", async () => {
    const manager = new CapabilityComponentManager([required]);
    registerPermissionReplacement(manager);
    const writes = [];
    const result = await manager.replaceRequired("permission-evaluator", "permission-evaluator.v2", {
      approved: true,
      preflight: passedPreflight,
      persist: async (ref) => { writes.push(structuredClone(ref)); },
      verify: async () => { manager.setHealth("permission-evaluator.v2", "broken"); },
    });
    assert.equal(result.status, "rolled_back");
    assert.equal(writes.length, 2);
    assert.equal(writes[1].providers.permission, "permission-evaluator");
    assert.equal(manager.activeRequiredProvider("permission").manifest.id, "permission-evaluator");
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

  it("publishes a catalog without exposing management functions", async () => {
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
    assert.ok(catalog.components.some((component) => component.manifest.id === "ui.pane.search"));
    assert.ok(catalog.components.some((component) => component.manifest.id === "language-service.typescript"));
    assert.equal(catalog.components.some((component) => "enable" in component), false);
  });

  it("projects a user management catalog without exposing kernel components", async () => {
    const headers = {};
    let body = "";
    const handled = await handleComponents(
      { url: "/api/components?view=management", method: "GET" },
      { writeHead(status, values) { headers.status = status; Object.assign(headers, values); }, end(value) { body = String(value); } },
      { groups: { core: { runtime: { currentWorkspace: process.cwd() } }, storage: { paths: { APP_ROOT: process.cwd() } } } },
    );
    assert.equal(handled, true);
    assert.equal(headers.status, 200);
    const projection = JSON.parse(body);
    assert.ok(Array.isArray(projection.extensions));
    assert.ok(Array.isArray(projection.integrations));
    assert.ok(projection.extensions.some((component) => component.manifest.id === "ui.pane.search"));
    assert.equal(projection.extensions.some((component) => component.manifest.id === "security-parser"), false);
    assert.equal(projection.extensions.some((component) => component.manifest.kind === "required"), false);
    assert.equal(projection.integrations.every((component) => component.manifest.source === "mcp" || component.manifest.hostSurface === "mcp-service"), true);
  });

  it("allows only shipped optional packages to be toggled from the desktop component route", async () => {
    const root = mkdtempSync(join(tmpdir(), "components-route-"));
    const previousConfig = process.env.PI_USER_CONFIG;
    const responseFor = async (url) => {
      const headers = {};
      let body = "";
      const handled = await handleComponents(
        { url, method: "POST" },
        { writeHead(status, values) { headers.status = status; Object.assign(headers, values); }, end(value) { body = String(value); } },
        { groups: { core: { runtime: { currentWorkspace: process.cwd() } }, storage: { paths: { APP_ROOT: process.cwd() } } } },
      );
      return { handled, headers, body: JSON.parse(body) };
    };
    try {
      process.env.PI_USER_CONFIG = root;
      const disabled = await responseFor("/api/components/ui.pane.search/disable");
      assert.equal(disabled.handled, true);
      assert.equal(disabled.headers.status, 200);
      assert.equal(disabled.body.component.status, "disabled");
      const enabled = await responseFor("/api/components/ui.pane.search/enable");
      assert.equal(enabled.headers.status, 200);
      assert.equal(enabled.body.component.status, "active");
      const rejected = await responseFor("/api/components/security-parser/disable");
      assert.equal(rejected.headers.status, 404);
      assert.equal(rejected.body.code, "component_not_managed");
    } finally {
      if (previousConfig === undefined) delete process.env.PI_USER_CONFIG;
      else process.env.PI_USER_CONFIG = previousConfig;
      rmSync(root, { recursive: true, force: true });
    }
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

  it("keeps a first-party package uninstalled across restart until explicitly reinstalled", async () => {
    const root = mkdtempSync(join(tmpdir(), "first-party-package-state-"));
    try {
      const filePath = join(root, "component-state.json");
      const manager = new CapabilityComponentManager([FILE_READ_COMPONENT_PACKAGE_MANIFEST.component]);
      manager.uninstall(FILE_READ_COMPONENT_PACKAGE_MANIFEST.component.id);
      await manager.save(filePath);
      const saved = JSON.parse(readFileSync(filePath, "utf8"));
      assert.deepEqual(saved.uninstalledFirstPartyPackages, [FILE_READ_COMPONENT_PACKAGE_MANIFEST.packageId]);

      const restarted = new CapabilityComponentManager([FILE_READ_COMPONENT_PACKAGE_MANIFEST.component]);
      await restarted.restore(filePath);
      assert.equal(restarted.get(FILE_READ_COMPONENT_PACKAGE_MANIFEST.component.id), undefined);
      registerFirstPartyComponentPackages(restarted);
      assert.equal(restarted.get(FILE_READ_COMPONENT_PACKAGE_MANIFEST.component.id), undefined, "catalog seeding preserves the uninstall tombstone");

      installFirstPartyComponentPackage(restarted, FILE_READ_COMPONENT_PACKAGE_MANIFEST.packageId);
      await restarted.save(filePath);
      const reinstalled = new CapabilityComponentManager([FILE_READ_COMPONENT_PACKAGE_MANIFEST.component]);
      await reinstalled.restore(filePath);
      assert.equal(reinstalled.require(FILE_READ_COMPONENT_PACKAGE_MANIFEST.component.id).status, "active");
      assert.deepEqual(reinstalled.catalog().uninstalledFirstPartyPackages, []);
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

  it("persists the active required provider and restores the committed generation", async () => {
    const root = mkdtempSync(join(tmpdir(), "component-replacement-"));
    try {
      const filePath = join(root, "component-state.json");
      const manager = new CapabilityComponentManager([required]);
      registerPermissionReplacement(manager);
      await manager.replaceRequired("permission-evaluator", "permission-evaluator.v2", { approved: true, preflight: passedPreflight });
      await manager.save(filePath);

      const restored = new CapabilityComponentManager([required]);
      await restored.restore(filePath);
      assert.equal(restored.activeRequiredProvider("permission").manifest.id, "permission-evaluator.v2");
      assert.equal(restored.require("permission-evaluator").enabled, false);
      assert.equal(restored.acquireRequiredLease().resolve("permission"), "permission-evaluator.v2");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not restore a runtime-bound provider when its executable binding is unavailable", async () => {
    const root = mkdtempSync(join(tmpdir(), "component-binding-restore-"));
    try {
      const filePath = join(root, "component-state.json");
      const manager = new CapabilityComponentManager([requiredPresentation]);
      manager.bindRequiredProvider("tool-presentation", { present() { return []; } });
      manager.register({ ...requiredPresentation, id: "tool-presentation.v2", version: "2", source: "user" }, { trusted: true, health: "healthy" });
      manager.bindRequiredProvider("tool-presentation.v2", { present() { return []; } });
      await manager.replaceRequired("tool-presentation", "tool-presentation.v2", { preflight: passedPreflight, verify: async () => {} });
      await manager.save(filePath);

      const restored = new CapabilityComponentManager([requiredPresentation]);
      restored.bindRequiredProvider("tool-presentation", { present() { return []; } });
      await restored.restore(filePath);
      assert.equal(restored.activeRequiredProvider("tool-presentation").manifest.id, "tool-presentation");
      assert.equal(restored.require("tool-presentation.v2").enabled, false);
      assert.equal(restored.hasRequiredProviderBinding("tool-presentation.v2"), false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("round-trips a session required-provider generation fact", () => {
    const entries = [];
    persistCapabilityComponentGeneration({ appendCustomEntry(customType, data) { entries.push({ type: "custom", customType, data }); } }, {
      generation: 42,
      providers: { permission: "permission-evaluator.v2" },
    });
    assert.deepEqual(readCapabilityComponentGeneration(entries), {
      generation: 42,
      providers: { permission: "permission-evaluator.v2" },
    });
  });

  it("keeps a reopened session pinned to its old required provider after replacement", async () => {
    const root = mkdtempSync(join(tmpdir(), "component-session-pin-"));
    try {
      const manager = new CapabilityComponentManager([required]);
      registerPermissionReplacement(manager);
      const sessionManager = SessionManager.create(root, root);
      persistCapabilityComponentGeneration(sessionManager, manager.requiredGeneration());
      sessionManager.appendMessage({ role: "assistant", content: [], timestamp: Date.now() });
      const sessionFile = sessionManager.getSessionFile();

      await manager.replaceRequired("permission-evaluator", "permission-evaluator.v2", { approved: true, preflight: passedPreflight });
      const reopened = SessionManager.open(sessionFile, undefined, root);
      const persisted = readCapabilityComponentGeneration(reopened.getEntries());
      const oldLease = manager.acquireRequiredLease(persisted);
      assert.equal(oldLease.resolve("permission"), "permission-evaluator");
      const newLease = manager.acquireRequiredLease();
      assert.equal(newLease.resolve("permission"), "permission-evaluator.v2");
      oldLease.release();
      newLease.release();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
