import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, it } from "node:test";
import { CapabilityComponentManager } from "../src/agent/capability-components.ts";
import { parseComponentRecoveryArgs, runComponentRecovery } from "../scripts/component-recovery.mjs";
import { FILE_READ_COMPONENT_PACKAGE_MANIFEST } from "../src/agent/component-package.ts";

const optional = { id: "demo-tool", version: "1", kind: "optional", capability: "tool", source: "user" };

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

});
