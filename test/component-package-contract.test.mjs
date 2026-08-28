import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { mkdtempSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import {
  CapabilityComponentPackageError,
  CAPABILITY_COMPONENT_PACKAGE_SCHEMA,
  componentPackageManifestFingerprint,
  FILE_READ_COMPONENT_PACKAGE_MANIFEST,
  EXPLORER_LIST_COMPONENT_PACKAGE_MANIFEST,
  SEARCH_COMPONENT_PACKAGE_MANIFEST,
  GIT_STATUS_COMPONENT_PACKAGE_MANIFEST,
  GIT_LOG_COMPONENT_PACKAGE_MANIFEST,
  FILE_OUTLINE_COMPONENT_PACKAGE_MANIFEST,
  FIRST_PARTY_COMPONENT_PACKAGES,
  firstPartyComponentPackage,
  installFirstPartyComponentPackage,
  capabilityComponentIdForTool,
  normalizeCapabilityComponentPackageManifest,
  assertCapabilityComponentPackageCompatible,
} from "../src/agent/component-package.ts"
import { CapabilityComponentManager } from "../src/agent/capability-components.ts"
import { ToolPool } from "../src/agent/tool-pool.ts"
import { fileReadTool } from "../src/agent/tools/file-read.ts"

const basePackage = (overrides = {}) => ({
  schemaVersion: 1,
  packageId: "demo.search",
  packageVersion: "1.2.0",
  component: {
    schemaVersion: 1,
    id: "demo.search",
    version: "1.2.0",
    kind: "optional",
    capability: "search",
  },
  entry: "dist/index.js",
  source: { kind: "workspace", origin: "file:///workspace/demo-search", digest: "a".repeat(64) },
  signature: { algorithm: "sha256", value: "b".repeat(64), keyId: "workspace-key" },
  compatibility: { host: ">=1.0.0", contract: "1", engine: "^1.0.0" },
  permissions: { network: false, filesystem: ["read"], subprocess: false, secrets: [] },
  resources: { maxMemoryMb: 128, maxCpuMs: 5000, maxNetworkRequests: 20, maxFileBytes: 1000000 },
  isolation: { mode: "worker", installRoot: "components/demo.search", allowedEntry: "dist/index.js" },
  ...overrides,
})

describe("capability component package contract", () => {
  it("normalizes a valid package and produces a stable fingerprint", () => {
    const normalized = normalizeCapabilityComponentPackageManifest(basePackage(), { hostVersion: "1.4.0", contractVersion: "1.0.0", engineVersion: "1.2.0" })
    assert.equal(normalized.packageId, "demo.search")
    assert.equal(normalized.component.providedBy, "demo.search")
    assert.deepEqual(normalized.permissions.filesystem, ["read"])
    assert.equal(componentPackageManifestFingerprint(normalized).length, 64)
    assert.deepEqual(normalized, normalizeCapabilityComponentPackageManifest({ ...basePackage(), permissions: { ...basePackage().permissions, filesystem: ["read"] } }))
  })

  it("exposes a JSON schema descriptor without making it an execution loader", () => {
    assert.equal(CAPABILITY_COMPONENT_PACKAGE_SCHEMA.$schema, "https://json-schema.org/draft/2020-12/schema")
    assert.ok(CAPABILITY_COMPONENT_PACKAGE_SCHEMA.required.includes("isolation"))
  })

  it("rejects identity, source and signature gaps fail-closed", () => {
    assert.throws(() => normalizeCapabilityComponentPackageManifest(basePackage({ packageId: "Bad ID" })), (error) => error instanceof CapabilityComponentPackageError && error.code === "invalid_identity")
    assert.throws(() => normalizeCapabilityComponentPackageManifest(basePackage({ source: { kind: "workspace", origin: "local" } })), (error) => error.code === "invalid_source")
    assert.throws(() => normalizeCapabilityComponentPackageManifest(basePackage({ signature: undefined })), (error) => error.code === "missing_signature")
    assert.throws(() => normalizeCapabilityComponentPackageManifest(basePackage({ component: { ...basePackage().component, version: "2.0.0" } })), (error) => error.code === "identity_mismatch")
  })

  it("requires safe relative isolation paths and aligned entry", () => {
    assert.throws(() => normalizeCapabilityComponentPackageManifest(basePackage({ isolation: { mode: "worker", installRoot: "../outside", allowedEntry: "dist/index.js" } })), (error) => error.code === "invalid_isolation")
    assert.throws(() => normalizeCapabilityComponentPackageManifest(basePackage({ entry: "other.js" })), (error) => error.code === "invalid_isolation")
    assert.throws(() => normalizeCapabilityComponentPackageManifest(basePackage({ isolation: { mode: "worker", installRoot: "components/demo.search", allowedEntry: "C:/outside.js" } })), (error) => error.code === "invalid_isolation")
  })

  it("rejects malformed permissions and resource limits", () => {
    assert.throws(() => normalizeCapabilityComponentPackageManifest(basePackage({ permissions: { ...basePackage().permissions, filesystem: ["execute"] } })), (error) => error.code === "invalid_permissions")
    assert.throws(() => normalizeCapabilityComponentPackageManifest(basePackage({ resources: { maxMemoryMb: 0 } })), (error) => error.code === "invalid_resources")
    assert.throws(() => normalizeCapabilityComponentPackageManifest(basePackage({ resources: { maxMemoryMb: 5000 } })), (error) => error.code === "invalid_resources")
  })

  it("checks compatibility separately and does not auto-enable a package", () => {
    const normalized = normalizeCapabilityComponentPackageManifest(basePackage())
    assert.throws(() => assertCapabilityComponentPackageCompatible(normalized, { hostVersion: "0.9.0", contractVersion: "1.0.0", engineVersion: "1.0.0" }), (error) => error.code === "incompatible_host")
    const manager = new CapabilityComponentManager()
    assert.equal(manager.get("demo.search"), undefined)
  })

  it("projects the package-backed file reader only while its optional component is active", () => {
    assert.equal(capabilityComponentIdForTool("file-read"), "tool.file-read")
    assert.equal(FILE_READ_COMPONENT_PACKAGE_MANIFEST.component.id, "tool.file-read")
    const manager = new CapabilityComponentManager()
    manager.register(FILE_READ_COMPONENT_PACKAGE_MANIFEST.component, { trusted: true, enabled: true, health: "healthy" })
    const pool = new ToolPool().addNative([fileReadTool])
    assert.deepEqual(pool.project({ audience: "main", componentManager: manager }).map((tool) => tool.name), ["file_read"])
    manager.disable("tool.file-read")
    assert.deepEqual(pool.project({ audience: "main", componentManager: manager }), [])
    manager.enable("tool.file-read")
    assert.deepEqual(pool.project({ audience: "main", componentManager: manager }).map((tool) => tool.name), ["file_read"])
    manager.uninstall("tool.file-read")
    assert.deepEqual(pool.project({ audience: "main", componentManager: manager }), [])
    assert.equal(firstPartyComponentPackage(FILE_READ_COMPONENT_PACKAGE_MANIFEST.packageId), FILE_READ_COMPONENT_PACKAGE_MANIFEST)
    assert.equal(FIRST_PARTY_COMPONENT_PACKAGES.length, 6)
    installFirstPartyComponentPackage(manager, FILE_READ_COMPONENT_PACKAGE_MANIFEST.packageId)
    assert.deepEqual(pool.project({ audience: "main", componentManager: manager }).map((tool) => tool.name), ["file_read"])
  })

  it("registers the low-risk first-party tools through one package contract", () => {
    const manifests = [
      FILE_READ_COMPONENT_PACKAGE_MANIFEST,
      EXPLORER_LIST_COMPONENT_PACKAGE_MANIFEST,
      SEARCH_COMPONENT_PACKAGE_MANIFEST,
      GIT_STATUS_COMPONENT_PACKAGE_MANIFEST,
      GIT_LOG_COMPONENT_PACKAGE_MANIFEST,
      FILE_OUTLINE_COMPONENT_PACKAGE_MANIFEST,
    ]
    assert.deepEqual(
      manifests.map((manifest) => manifest.component.id),
      ["tool.file-read", "tool.explorer-list", "tool.search", "tool.git-status", "tool.git-log", "tool.file-outline"],
    )
    assert.equal(new Set(manifests.map((manifest) => manifest.packageId)).size, manifests.length)
    assert.ok(manifests.every((manifest) => manifest.component.kind === "optional" && manifest.component.source === "builtin"))
    assert.ok(manifests.every((manifest) => manifest.permissions.filesystem.join(",") === "read"))
  })

  it("projects all migrated tools across disable, uninstall, restart, and reinstall", async () => {
    const manifests = [
      FILE_READ_COMPONENT_PACKAGE_MANIFEST,
      EXPLORER_LIST_COMPONENT_PACKAGE_MANIFEST,
      SEARCH_COMPONENT_PACKAGE_MANIFEST,
      GIT_STATUS_COMPONENT_PACKAGE_MANIFEST,
      GIT_LOG_COMPONENT_PACKAGE_MANIFEST,
      FILE_OUTLINE_COMPONENT_PACKAGE_MANIFEST,
    ]
    const tools = [
      fileReadTool,
      (await import("../src/agent/tools/explorer-list.ts")).explorerListTool,
      (await import("../src/agent/tools/search.ts")).searchTool,
      (await import("../src/agent/tools/git-status.ts")).gitStatusTool,
      (await import("../src/agent/tools/git-log.ts")).gitLogTool,
      (await import("../src/agent/tools/file-outline.ts")).fileOutlineTool,
    ]
    const root = mkdtempSync(join(tmpdir(), "first-party-tools-"))
    try {
      const stateFile = join(root, "component-state.json")
      const manager = new CapabilityComponentManager()
      for (const manifest of manifests) manager.register(manifest.component, { trusted: true, enabled: true, health: "healthy" })
      const pool = new ToolPool().addNative(tools)
      assert.deepEqual(pool.project({ audience: "main", componentManager: manager }).map((tool) => tool.name), tools.map((tool) => tool.name))
      for (const manifest of manifests) manager.disable(manifest.component.id)
      assert.deepEqual(pool.project({ audience: "main", componentManager: manager }), [])
      for (const manifest of manifests) manager.enable(manifest.component.id)
      for (const manifest of manifests) manager.uninstall(manifest.component.id)
      await manager.save(stateFile)
      assert.deepEqual(pool.project({ audience: "main", componentManager: manager }), [])

      const restarted = new CapabilityComponentManager(manifests.map((manifest) => manifest.component))
      await restarted.restore(stateFile)
      assert.deepEqual(pool.project({ audience: "main", componentManager: restarted }), [])
      for (const manifest of manifests) assert.equal(restarted.get(manifest.component.id), undefined)
      for (const manifest of manifests) installFirstPartyComponentPackage(restarted, manifest.packageId)
      assert.deepEqual(pool.project({ audience: "main", componentManager: restarted }).map((tool) => tool.name), tools.map((tool) => tool.name))
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
