import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, it } from "node:test";

import { readLockedJson } from "../src/data/locked-json-store.ts";
import { defaultGlobalConfigPath } from "../src/agent/mcp/config.ts";
import { defaultTrustStorePath } from "../src/agent/mcp/trust-store.ts";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const lockedStoreUrl = pathToFileURL(resolve(repositoryRoot, "src/data/locked-json-store.ts")).href;
const ruleStoreUrl = pathToFileURL(resolve(repositoryRoot, "src/server/permission-rule-store.ts")).href;
const auditStoreUrl = pathToFileURL(resolve(repositoryRoot, "src/server/permission-audit-store.ts")).href;
const trustStoreUrl = pathToFileURL(resolve(repositoryRoot, "src/agent/mcp/trust-store.ts")).href;

const workerSource = `
import { updateLockedJson } from ${JSON.stringify(lockedStoreUrl)};
import { FileWorkspacePermissionRuleStore } from ${JSON.stringify(ruleStoreUrl)};
import { FilePermissionAuditStore } from ${JSON.stringify(auditStoreUrl)};
import { TrustStore } from ${JSON.stringify(trustStoreUrl)};

const [mode, filePath, key] = process.argv.slice(2);
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

if (mode === "object") {
  await updateLockedJson(filePath, () => ({}), async (document) => {
    await delay(80);
    document[key] = { value: key };
    return document;
  });
} else if (mode === "mcp") {
  await updateLockedJson(filePath, () => ({ servers: {} }), async (document) => {
    await delay(80);
    document.servers ||= {};
    document.servers[key] = { command: "node", args: [key], enabled: false };
    return document;
  });
} else if (mode === "rules") {
  const store = new FileWorkspacePermissionRuleStore(filePath);
  await store.save(key, {
    alwaysAllowRules: [{ toolName: "Read", ruleContent: key, match: "exact" }],
    alwaysDenyRules: [],
    alwaysAskRules: [],
  });
} else if (mode === "audit") {
  const store = new FilePermissionAuditStore(filePath, { maxEntries: 20 });
  await store.append({
    id: 1,
    timestamp: new Date().toISOString(),
    source: key,
    operation: "tool",
    root: key,
    decision: "allow",
  });
} else if (mode === "trust") {
  const store = new TrustStore({ filePath });
  await store.addTrust(key, "hash-" + key, key);
} else {
  throw new Error("Unknown mode: " + mode);
}
`;

function runWriter(workerPath, mode, filePath, key) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", workerPath, mode, filePath, key], {
      cwd: repositoryRoot,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolvePromise();
      else reject(new Error(`writer ${mode}/${key} exited ${code}\n${stdout}\n${stderr}`));
    });
  });
}

async function contend(root, mode, fileName, firstKey, secondKey) {
  const workerPath = resolve(root, "writer.mjs");
  const filePath = resolve(root, fileName);
  writeFileSync(workerPath, workerSource, "utf8");
  await Promise.all([
    runWriter(workerPath, mode, filePath, firstKey),
    runWriter(workerPath, mode, filePath, secondKey),
  ]);
  const parsed = JSON.parse(readFileSync(filePath, "utf8"));
  const leftovers = readdirSync(root).filter((name) => name.endsWith(".tmp") || name === `${fileName}.lock`);
  assert.deepEqual(leftovers, [], `temporary lock/write files leaked for ${fileName}`);
  return parsed;
}

describe("shared user store cross-process locking", () => {
  it("recovers only missing or syntactically invalid JSON and propagates I/O errors", async () => {
    const root = mkdtempSync(resolve(tmpdir(), "locked-json-errors-"));
    try {
      const malformedPath = resolve(root, "malformed.json");
      writeFileSync(malformedPath, "{broken", "utf8");
      assert.deepEqual(
        await readLockedJson(malformedPath, { recovered: true }, { recoverInvalidJson: true }),
        { recovered: true },
      );

      const directoryPath = resolve(root, "directory.json");
      mkdirSync(directoryPath);
      await assert.rejects(
        () => readLockedJson(directoryPath, { recovered: true }, { recoverInvalidJson: true }),
        (error) => error?.code === "EISDIR" || error?.code === "EACCES" || error?.code === "EPERM",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("preserves concurrent settings and auth record updates", async () => {
    const root = mkdtempSync(resolve(tmpdir(), "shared-store-object-"));
    try {
      for (const fileName of ["settings.json", "auth.json"]) {
        const document = await contend(root, "object", fileName, "instance-a", "instance-b");
        assert.equal(document["instance-a"].value, "instance-a");
        assert.equal(document["instance-b"].value, "instance-b");
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("preserves concurrent global MCP server updates", async () => {
    const root = mkdtempSync(resolve(tmpdir(), "shared-store-mcp-"));
    try {
      const document = await contend(root, "mcp", "mcp.json", "server-a", "server-b");
      assert.equal(document.servers["server-a"].args[0], "server-a");
      assert.equal(document.servers["server-b"].args[0], "server-b");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("preserves concurrent workspace permission rule updates", async () => {
    const root = mkdtempSync(resolve(tmpdir(), "shared-store-rules-"));
    try {
      const document = await contend(root, "rules", "permission-rules.json", "C:/workspace-a", "C:/workspace-b");
      const entries = Object.values(document.workspaces);
      assert.equal(entries.length, 2);
      assert.deepEqual(new Set(entries.map((entry) => entry.workspacePath)), new Set(["C:/workspace-a", "C:/workspace-b"]));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("preserves concurrent permission audit entries", async () => {
    const root = mkdtempSync(resolve(tmpdir(), "shared-store-audit-"));
    try {
      const document = await contend(root, "audit", "permission-audit.json", "instance-a", "instance-b");
      assert.deepEqual(new Set(document.map((entry) => entry.source)), new Set(["instance-a", "instance-b"]));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("preserves concurrent MCP trust records", async () => {
    const root = mkdtempSync(resolve(tmpdir(), "shared-store-trust-"));
    try {
      const document = await contend(root, "trust", "mcp-trust.json", "C:/workspace-a", "C:/workspace-b");
      assert.deepEqual(new Set(document.records.map((entry) => entry.workspacePath)), new Set(["C:/workspace-a", "C:/workspace-b"]));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("uses PI_USER_CONFIG for both global MCP config and trust paths", () => {
    const originalUserConfig = process.env.PI_USER_CONFIG;
    const originalPiConfig = process.env.PI_CONFIG_DIR;
    const originalHome = process.env.HOME;
    const root = mkdtempSync(resolve(tmpdir(), "shared-store-paths-"));
    try {
      process.env.PI_USER_CONFIG = resolve(root, "user");
      process.env.PI_CONFIG_DIR = resolve(root, "wrong-pi-config");
      process.env.HOME = resolve(root, "wrong-home");
      assert.equal(defaultGlobalConfigPath(), resolve(root, "user", "mcp.json"));
      assert.equal(defaultTrustStorePath(), resolve(root, "user", "mcp-trust.json"));
    } finally {
      if (originalUserConfig === undefined) delete process.env.PI_USER_CONFIG;
      else process.env.PI_USER_CONFIG = originalUserConfig;
      if (originalPiConfig === undefined) delete process.env.PI_CONFIG_DIR;
      else process.env.PI_CONFIG_DIR = originalPiConfig;
      if (originalHome === undefined) delete process.env.HOME;
      else process.env.HOME = originalHome;
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("initializes auth files with exclusive create in both processes", () => {
    const serverSource = readFileSync(resolve(repositoryRoot, "src/server/server.ts"), "utf8");
    const electronSource = readFileSync(resolve(repositoryRoot, "src/electron/server-binding.ts"), "utf8");
    assert.match(serverSource, /STARTUP\.layout\.authFile[\s\S]{0,160}flag:\s*"wx"/);
    assert.match(electronSource, /spec\.layout\.authFile[\s\S]{0,160}flag:\s*"wx"/);
  });

  it("flushes permission audit writes before normal server shutdown exits", () => {
    const lifecycleSource = readFileSync(resolve(repositoryRoot, "src/server/server-lifecycle.ts"), "utf8");
    const releaseResourcesIndex = lifecycleSource.indexOf("const release =");
    const releaseResourcesEnd = lifecycleSource.indexOf("options.server.on(\"close\"", releaseResourcesIndex);
    const releaseResourcesSource = lifecycleSource.slice(releaseResourcesIndex, releaseResourcesEnd);
    const shutdownSource = lifecycleSource.slice(lifecycleSource.indexOf("const shutdown ="), lifecycleSource.indexOf("process.once(\"SIGINT\""));
    const flushIndex = releaseResourcesSource.indexOf("await options.flushPermissionAudit()");
    const releaseIndex = releaseResourcesSource.indexOf("await options.releaseWorkspaceLock()");
    const exitIndex = shutdownSource.indexOf("process.exit(0)");
    assert.ok(flushIndex >= 0, "normal shutdown must await permission audit flush");
    assert.ok(releaseIndex > flushIndex, "workspace lock release must follow audit flush");
    assert.ok(shutdownSource.indexOf("release(true)") >= 0, "normal shutdown must release instance resources");
    assert.ok(exitIndex >= 0, "normal shutdown must exit after resource release");
  });
});
