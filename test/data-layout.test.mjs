import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";

import {
  canonicalWorkspacePath,
  resolveDataLayout,
  workspaceKey,
} from "../src/data/data-layout.ts";

describe("multi-instance data layout", () => {
  it("canonicalizes equivalent Windows workspace spellings", () => {
    const first = canonicalWorkspacePath("C:\\Users\\ASUS\\Project\\");
    const second = canonicalWorkspacePath("c:/users/asus/project");

    assert.strictEqual(first, second);
  });

  it("uses the full canonical path so equal basenames cannot collide", () => {
    const first = workspaceKey("C:\\work\\alpha\\app");
    const second = workspaceKey("D:\\clients\\beta\\app");

    assert.match(first, /^[a-f0-9]{24}$/);
    assert.match(second, /^[a-f0-9]{24}$/);
    assert.notStrictEqual(first, second);
    assert.strictEqual(first, workspaceKey("c:/work/alpha/app/"));
  });

  it("keeps workspace persistence stable while instance state stays unique", () => {
    const dataRoot = resolve("E:/agent-data");
    const workspace = resolve("E:/projects/sample");
    const first = resolveDataLayout({ dataRoot, workspace, instanceId: "instance-a" });
    const second = resolveDataLayout({ dataRoot, workspace, instanceId: "instance-b" });

    assert.strictEqual(first.workspaceRoot, second.workspaceRoot);
    assert.strictEqual(first.sessionsDir, second.sessionsDir);
    assert.strictEqual(first.usageIndexFile, second.usageIndexFile);
    assert.strictEqual(first.workspaceLockFile, second.workspaceLockFile);
    assert.strictEqual(first.customProvidersFile, second.customProvidersFile);
    assert.strictEqual(first.customProviderSecretsFile, second.customProviderSecretsFile);
    assert.notStrictEqual(first.instanceRoot, second.instanceRoot);
    assert.notStrictEqual(first.portFile, second.portFile);
    assert.notStrictEqual(first.desktopTokenFile, second.desktopTokenFile);
  });

  it("places large persistent data outside the OS bootstrap directory", () => {
    const dataRoot = resolve("E:/agent-data");
    const layout = resolveDataLayout({
      dataRoot,
      workspace: resolve("E:/projects/sample"),
      instanceId: "instance-a",
    });

    assert.strictEqual(layout.dataRoot, dataRoot);
    assert.strictEqual(layout.userRoot, resolve(dataRoot, "user"));
    assert.strictEqual(layout.subagentsFile, resolve(layout.userRoot, "subagents.json"));
    assert.strictEqual(layout.customProvidersFile, resolve(layout.userRoot, "custom-providers.json"));
    assert.strictEqual(layout.customProviderSecretsFile, resolve(layout.userRoot, "custom-provider-secrets.json"));
    assert.strictEqual(layout.sessionsDir, resolve(layout.workspaceRoot, "sessions"));
    assert.strictEqual(layout.cacheDir, resolve(layout.instanceRoot, "cache"));
    assert.strictEqual(layout.workspaceLockFile, resolve(layout.workspaceRoot, "workspace.lock"));
  });

  it("rejects relative roots, empty workspaces and unsafe instance ids", () => {
    assert.throws(
      () => resolveDataLayout({ dataRoot: "relative-data", workspace: resolve("E:/projects/sample"), instanceId: "a" }),
      /dataRoot must be absolute/,
    );
    assert.throws(
      () => resolveDataLayout({ dataRoot: resolve("E:/agent-data"), workspace: "", instanceId: "a" }),
      /workspace must be an absolute path/,
    );
    assert.throws(
      () => resolveDataLayout({ dataRoot: resolve("E:/agent-data"), workspace: resolve("E:/projects/sample"), instanceId: "../escape" }),
      /instanceId is invalid/,
    );
  });
});
