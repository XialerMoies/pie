import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildTestManifest, validateTestManifest } from "../scripts/test-manifest.mjs";

describe("test manifest", () => {
  it("classifies every test file exactly once with a layer and flow tag", () => {
    const manifest = buildTestManifest();
    assert.deepEqual(validateTestManifest(manifest), []);
    assert.equal(new Set(manifest.entries.map((entry) => entry.file)).size, manifest.entries.length);
    assert.ok(manifest.entries.length >= 150);
    assert.ok(manifest.entries.some((entry) => entry.layer === "integration" && entry.flow));
    assert.ok(manifest.entries.some((entry) => entry.layer === "system"));
  });

  it("keeps default, build, and live suites explicit", () => {
    const manifest = buildTestManifest();
    assert.ok(manifest.suites.unit.length > 0);
    assert.ok(manifest.suites.routes.length > 0);
    assert.ok(manifest.suites.frontend.length > 0);
    assert.deepEqual(manifest.suites.build, ["test/dist-agent-event-flow.test.mjs", "test/dist-chat-event-flow.test.mjs"].sort());
    assert.deepEqual(manifest.suites.live, ["test/provider-live-matrix.test.mjs"]);
    const defaultFiles = new Set([
      ...manifest.suites.unit,
      ...manifest.suites.unitSerial,
      ...manifest.suites.routes,
      ...manifest.suites.routesSerial,
      ...manifest.suites.frontend,
    ]);
    assert.equal(defaultFiles.size, manifest.entries.filter((entry) => entry.default).length);
  });
});
