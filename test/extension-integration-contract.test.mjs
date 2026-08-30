import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { assertExtensionEligible, extensionManifestFromPackage, normalizeExtensionManifest } from "../src/agent/extension-manifest.ts";
import { createExtensionApi } from "../src/agent/extension-api.ts";
import { mcpIntegrationRecord } from "../src/agent/integrations.ts";
import { handleComponents } from "../src/server/routes/components.ts";

describe("R2 extension and integration contracts", () => {
  it("validates a minimal extension without product classification fields", () => {
    const manifest = normalizeExtensionManifest({
      schemaVersion: 1,
      id: "demo.search",
      version: "1.0.0",
      contributions: ["agent-tool"],
      permissions: { capabilities: ["read"] },
      compatibility: { host: ">=1.0.0", contract: "1" },
      entry: "dist/index.js",
    });
    assert.deepEqual(manifest.contributions, ["agent-tool"]);
    assert.equal("productClass" in manifest, false);
    assert.equal("hostSurface" in manifest, false);
  });

  it("preserves extension title, icon and Agent execution configuration", () => {
    const manifest = normalizeExtensionManifest({
      schemaVersion: 1,
      id: "demo.agent",
      version: "1.0.0",
      displayName: "代码检查",
      publisher: "XialerMoies",
      icon: "#icheck",
      contributions: ["agent-tool"],
      agentConfig: { timeoutMs: 45_000, maxConcurrent: 3 },
      settings: [{ id: "result-limit", type: "number", label: "结果数量", defaultValue: 12 }],
      permissions: { capabilities: ["read"] },
      compatibility: { host: "1", contract: "1" },
    });
    assert.equal(manifest.displayName, "代码检查");
    assert.equal(manifest.publisher, "XialerMoies");
    assert.equal(manifest.icon, "#icheck");
    assert.deepEqual(manifest.agentConfig, { timeoutMs: 45_000, maxConcurrent: 3 });
    assert.deepEqual(manifest.settings, [{ id: "result-limit", type: "number", label: "结果数量", defaultValue: 12 }]);
    assert.throws(() => normalizeExtensionManifest({ ...manifest, icon: "javascript:alert(1)" }), /icon/);
    assert.throws(() => normalizeExtensionManifest({ ...manifest, settings: [{ id: "api-key", type: "string", label: "API Key" }] }), /secure storage/);
  });

  it("adapts a legacy package declaration without leaking its component taxonomy", () => {
    const manifest = extensionManifestFromPackage({
      packageId: "demo.ui",
      packageVersion: "1.0.0",
      component: { id: "ui.demo", version: "1.0.0", capability: "desktop.ui-pane", displayName: "演示面板", publisher: "XialerMoies", icon: "#ipanel" },
      entry: "dist/index.js",
      source: "workspace",
      permissions: { filesystem: ["read"], network: false, subprocess: false, secrets: [] },
      compatibility: { host: ">=1.0.0", contract: "1" },
    });
    assert.deepEqual(manifest.contributions, ["desktop-ui"]);
    assert.equal(manifest.displayName, "演示面板");
    assert.equal(manifest.publisher, "XialerMoies");
    assert.equal(manifest.icon, "#ipanel");
    assert.equal("productClass" in manifest, false);
    assert.equal("hostSurface" in manifest, false);
  });

  it("represents MCP as an opaque integration instance", () => {
    const record = mcpIntegrationRecord({
      name: "Demo Server",
      workspace: "E:\\workspace",
      trustFingerprint: "a".repeat(64),
      trusted: true,
      enabled: true,
      state: "connected",
      tools: ["lookup"],
    });
    assert.equal(record.kind, "mcp-server");
    assert.equal(record.health, "healthy");
    assert.equal(record.lifecycle, "connected");
    assert.equal("command" in record, false);
    assert.equal("url" in record, false);
    assert.deepEqual(record.capabilities, ["lookup"]);
  });

  it("serves extensions independently from the internal component catalog", async () => {
    let status = 0;
    let body = "";
    const handled = await handleComponents(
      { url: "/api/extensions", method: "GET" },
      { writeHead(code) { status = code; }, end(value) { body = String(value); } },
      { groups: { core: { runtime: { currentWorkspace: process.cwd() } }, storage: { paths: { APP_ROOT: process.cwd() } } } },
    );
    const response = JSON.parse(body);
    assert.equal(handled, true);
    assert.equal(status, 200);
    assert.ok(response.extensions.length > 0);
    assert.ok(response.extensions.every((entry) => !("productClass" in entry.manifest) && !("hostSurface" in entry.manifest)));
  });

  it("keeps host replacement surfaces out of external extensions", () => {
    assert.throws(() => normalizeExtensionManifest({
      schemaVersion: 1, id: "demo.route", version: "1.0.0", source: "user",
      contributions: ["server-route"], permissions: { capabilities: [] }, compatibility: { host: "1", contract: "1" },
    }), /not eligible/);
    assert.throws(() => assertExtensionEligible({ id: "desktop.layout", contributions: ["desktop-ui"], source: "builtin" }), /not eligible/);
  });

  it("provides only namespaced, host-adapted contribution handles", () => {
    const calls = [];
    const disposable = { dispose() {} };
    const api = createExtensionApi("demo.extension", {
      registerTool(definition) { calls.push(["tool", definition.id]); return disposable; },
      registerSetting(definition) { calls.push(["setting", definition.id]); return disposable; },
      registerUi(definition) { calls.push(["ui", definition.id]); return disposable; },
      on(event) { calls.push(["event", event]); return disposable; },
    });
    api.tools.register({ id: "lookup", description: "lookup", inputSchema: {}, execute() {} });
    api.settings.register({ id: "theme", type: "string", label: "Theme", read: () => "dark" });
    api.ui.register({ id: "panel", kind: "pane", mount() {} });
    api.events.on("workspace.changed", () => {});
    assert.deepEqual(calls, [["tool", "demo.extension.lookup"], ["setting", "demo.extension.theme"], ["ui", "demo.extension.panel"], ["event", "workspace.changed"]]);
    assert.throws(() => api.settings.register({ id: "api-key", type: "string", label: "Key", read: () => "" }), /host-owned/);
  });
});
