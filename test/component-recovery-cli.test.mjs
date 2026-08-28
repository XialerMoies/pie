import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, it } from "node:test";
import { CapabilityComponentManager } from "../src/agent/capability-components.ts";
import { parseComponentRecoveryArgs, runComponentRecovery } from "../scripts/component-recovery.mjs";
import { FILE_READ_COMPONENT_PACKAGE_MANIFEST } from "../src/agent/component-package.ts";

const optional = { id: "demo-tool", version: "1", kind: "optional", capability: "tool", source: "user" };
const required = { id: "demo-parser", version: "1", kind: "required", capability: "security-parser", replacementGroup: "security-parser", source: "builtin" };
const replacement = { ...required, id: "demo-parser-v2", version: "2", source: "user" };
const provider = () => ({ kind: "security-parser", parse() {}, parseLegacy() {}, parseTreeSitter() {} });
const passedPreflight = async () => ({ isolated: true, staticCheck: { status: "passed" }, replay: { status: "passed" }, failureMatrix: { status: "passed" }, shadow: { status: "passed" } });

describe("component recovery CLI", () => {
  it("parses list and targeted recovery actions without a desktop dependency", () => {
    const list = parseComponentRecoveryArgs(["--components", "list"]);
    assert.deepEqual(parseComponentRecoveryArgs(["--components", "disable", "--component-id", "demo-tool"]), {
      action: "disable", stateFile: list.stateFile, target: "demo-tool",
    });
    assert.equal(parseComponentRecoveryArgs(["--components=health"]).action, "health");
    assert.deepEqual(parseComponentRecoveryArgs(["disable", "demo-tool"]), {
      action: "disable", stateFile: list.stateFile, target: "demo-tool",
    });
    assert.equal(parseComponentRecoveryArgs(["install", FILE_READ_COMPONENT_PACKAGE_MANIFEST.packageId]).action, "install");
    assert.equal(parseComponentRecoveryArgs(["uninstall", "tool.file-read"]).action, "uninstall");
  });

  it("uninstalls and reinstalls a shipped first-party package through persisted state", async () => {
    const root = mkdtempSync(join(tmpdir(), "component-package-cli-"));
    try {
      const filePath = join(root, "component-state.json");
      const manager = new CapabilityComponentManager();
      await runComponentRecovery({ argv: ["uninstall", FILE_READ_COMPONENT_PACKAGE_MANIFEST.packageId], manager, stateFile: filePath });
      assert.equal(manager.get(FILE_READ_COMPONENT_PACKAGE_MANIFEST.component.id), undefined);

      const restarted = new CapabilityComponentManager();
      await runComponentRecovery({ argv: ["list"], manager: restarted, stateFile: filePath });
      assert.equal(restarted.get(FILE_READ_COMPONENT_PACKAGE_MANIFEST.component.id), undefined);

      await runComponentRecovery({ argv: ["install", FILE_READ_COMPONENT_PACKAGE_MANIFEST.packageId], manager: restarted, stateFile: filePath });
      assert.equal(restarted.require(FILE_READ_COMPONENT_PACKAGE_MANIFEST.component.id).status, "active");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("lists and disables optional components through the persisted state file", async () => {
    const root = mkdtempSync(join(tmpdir(), "component-recovery-"));
    try {
      const filePath = join(root, "component-state.json");
      const manager = new CapabilityComponentManager();
      manager.register(optional, { trusted: true, enabled: true, health: "healthy" });
      await manager.save(filePath);
      assert.equal(await runComponentRecovery({ argv: ["--components", "list"], manager, stateFile: filePath }), true);
      await runComponentRecovery({ argv: ["--components", "disable", "--component-id", "demo-tool"], manager, stateFile: filePath });
      assert.equal(manager.require("demo-tool").status, "disabled");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rolls back a required provider and rejects migration failure before commit", async () => {
    const manager = new CapabilityComponentManager([required]);
    manager.bindRequiredProvider("demo-parser", provider());
    manager.register(replacement, { trusted: true, enabled: false, health: "healthy" });
    manager.bindRequiredProvider("demo-parser-v2", provider());
    await assert.rejects(() => manager.replaceRequired("demo-parser", "demo-parser-v2", {
      approved: true, preflight: passedPreflight, verify: async () => {}, migrateState: async () => { throw new Error("migration failed"); },
    }), /migration failed/u);
    assert.equal(manager.activeRequiredProvider("security-parser").manifest.id, "demo-parser");
    await manager.replaceRequired("demo-parser", "demo-parser-v2", { approved: true, preflight: passedPreflight, verify: async () => {} });
    manager.rollbackRequired("security-parser");
    assert.equal(manager.activeRequiredProvider("security-parser").manifest.id, "demo-parser");
  });
});
