import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { tmpdir } from "node:os";

import { ENGINE_EVENT_TYPES } from "../src/agent-engine/contracts.ts";
import { APP_EVENT_TYPES } from "../src/server/app-events.ts";
import { PERMISSION_MODES, isPermissionMode } from "../src/server/permission-mode.ts";
import {
  buildCapabilityCatalog,
  serializeCapabilityCatalog,
  checkCapabilityCatalog,
} from "../scripts/generate-capability-catalog.mjs";
import { buildTestManifest } from "../scripts/test-manifest.mjs";

describe("capability catalog source facts", () => {
  it("exports stable engine, application, and permission facts", () => {
    assert.deepStrictEqual([...ENGINE_EVENT_TYPES], [
      "engine.ready",
      "session.changed",
      "plan.changed",
      "turn.started",
      "content.delta",
      "thinking.delta",
      "tool.started",
      "tool.updated",
      "tool.completed",
      "tool.failed",
      "usage.updated",
      "turn.completed",
      "turn.failed",
      "turn.cancelled",
      "compaction.started",
      "compaction.completed",
      "compaction.failed",
      "queue.updated",
      "diagnostic",
    ]);
    assert.deepStrictEqual([...APP_EVENT_TYPES], [
      "dashboard.changed",
      "usage.changed",
      "mcp.changed",
      "explorer.changed",
      "permission.confirm",
    ]);
    assert.deepStrictEqual([...PERMISSION_MODES], ["standard", "plan", "dontAsk", "yes"]);
    assert.ok(PERMISSION_MODES.every(isPermissionMode));
  });
});

describe("capability catalog generator", () => {
  it("builds deterministic code-derived facts with a static skills contract", async () => {
    const first = await buildCapabilityCatalog();
    const second = await buildCapabilityCatalog();
    assert.strictEqual(serializeCapabilityCatalog(first), serializeCapabilityCatalog(second));
    assert.strictEqual(first.schemaVersion, 1);
    assert.strictEqual(first.generatedAt, "deterministic");
    assert.deepStrictEqual(first.skills, {
      schemaVersion: 1,
      runtimeSource: "src/agent/skills/skill-service.ts",
      roots: ["<PI_USER_CONFIG>/skills", "<workspace-root>/agent/skills"],
      summaryFields: ["id", "name", "description", "source", "path", "trust", "enabled", "parse", "declaredTools"],
    });
    assert.strictEqual(first.sources.skills, "src/agent/skills/skill-service.ts");
    assert.doesNotMatch(serializeCapabilityCatalog(first), /SKILL\.md body/i);
    assert.ok(first.tools.some((tool) => tool.name === "command" && tool.source === "src/agent/tools/command.ts"));
    const fileReader = first.tools.find((tool) => tool.name === "file_read");
    assert.match(fileReader?.component?.fingerprint ?? "", /^[a-f0-9]{64}$/);
    assert.deepStrictEqual(fileReader?.component && {
      id: fileReader.component.id,
      packageId: fileReader.component.packageId,
      packageVersion: fileReader.component.packageVersion,
      fingerprint: fileReader.component.fingerprint,
    }, {
      id: "tool.file-read",
      packageId: "my-code-agent.tool.file-read",
      packageVersion: "1.0.0",
      fingerprint: fileReader?.component.fingerprint,
    });
    assert.ok(first.events.engine.includes("turn.cancelled"));
    assert.ok(first.events.application.includes("permission.confirm"));
    assert.ok(first.routes.some((route) => route.path === "/api/chat" && route.method === "POST"));
    assert.ok(first.routes.some((route) => route.pathPattern === "/api/custom-providers/:providerId"));
    assert.ok(first.spawnPoints.some((point) => point.file === "src/agent/tools/command.ts" && point.category === "user-command"));
    assert.ok(first.spawnPoints.some((point) =>
      point.file === "src/agent/mcp/MCPClientService.ts"
      && point.api === "StdioClientTransport"
      && point.category === "mcp"
      && point.owner === "mcp-client"
      && point.indirect === true
    ));
    assert.ok(first.spawnPoints.some((point) =>
      point.file === "src/server/routes/git.ts"
      && point.category === "server"
      && point.owner === "server"
    ));
    assert.ok(first.spawnPoints.every((point) => point.owner && point.owner !== "unassigned"));
    assert.ok(first.spawnPoints.some((point) => point.file === "src/server/ts-server.ts" && point.category === "tsserver"));
    assert.deepStrictEqual(first.permissionModes, ["standard", "plan", "dontAsk", "yes"]);
  });

  it("derives TypeScript route methods from the handler guard", async () => {
    const catalog = await buildCapabilityCatalog();
    const routes = catalog.routes.filter((route) => route.source === "src/server/routes/typescript.ts");
    assert.ok(routes.length > 0);
    for (const route of routes) {
      const expected = route.path === "/api/ts/diagnostics*" ? "GET" : "POST";
      assert.strictEqual(route.method, expected, `${route.path} must be ${expected}`);
    }
  });

  it("records only explicitly imported child-process calls", async () => {
    const catalog = await buildCapabilityCatalog();
    assert.ok(catalog.spawnPoints.some((point) =>
      point.file === "src/electron/cli-terminal.ts" && point.api === "spawn"
    ));
    assert.equal(catalog.spawnPoints.some((point) => point.api === "exec" && [
      "scripts/compile-frontend-ts.mjs",
      "src/agent/tools/web-search.ts",
      "src/frontend/marked.umd.js",
      "src/server/routes/search-core.ts",
      "src/server/routes/settings/custom-providers.ts",
    ].includes(point.file)), false);
  });

  it("normalizes wildcard route categories", async () => {
    const catalog = await buildCapabilityCatalog();
    assert.ok(catalog.routes.every((route) => !route.category.includes("*")));
  });

  it("checks a catalog byte-for-byte without modifying it", async () => {
    const root = mkdtempSync(resolve(tmpdir(), "capability-catalog-"));
    const output = resolve(root, "catalog.json");
    try {
      const expected = serializeCapabilityCatalog(await buildCapabilityCatalog());
      writeFileSync(output, expected);
      assert.deepStrictEqual(await checkCapabilityCatalog(output), { ok: true });
      writeFileSync(output, expected.replace('"schemaVersion": 1', '"schemaVersion": 2'));
      const before = readFileSync(output, "utf8");
      const mismatch = await checkCapabilityCatalog(output);
      assert.strictEqual(mismatch.ok, false);
      assert.strictEqual(readFileSync(output, "utf8"), before);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("publishes generate/check commands and keeps the committed catalog synchronized", async () => {
    const packageJson = JSON.parse(readFileSync(resolve("package.json"), "utf8"));
    assert.strictEqual(packageJson.scripts["capabilities:generate"], "node --import tsx scripts/generate-capability-catalog.mjs");
    assert.strictEqual(packageJson.scripts["capabilities:check"], "node --import tsx scripts/generate-capability-catalog.mjs --check");
    const committed = readFileSync(resolve("docs/generated/capability-catalog.json"), "utf8");
    assert.strictEqual(committed, serializeCapabilityCatalog(await buildCapabilityCatalog()));
  });

  it("runs capability synchronization in CI and the unit suite", () => {
    const packageJson = JSON.parse(readFileSync(resolve("package.json"), "utf8"));
    const workflow = readFileSync(resolve(".github/workflows/windows-governance.yml"), "utf8");
    assert.match(workflow, /npm run capabilities:check/);
    assert.strictEqual(packageJson.scripts["test:unit"], "node scripts/test-suite.mjs unit");
    assert.ok(buildTestManifest().suites.unit.includes("test/capability-catalog.test.mjs"));
  });
});
