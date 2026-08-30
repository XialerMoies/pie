import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { existsSync, mkdtempSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { handleComponents } from "../src/server/routes/components.ts"
import { CapabilityComponentManager } from "../src/agent/capability-components.ts"
import { MEMORY_COMPONENT_PACKAGE_MANIFEST } from "../src/agent/component-package.ts"

function request(method, url, body) {
  const req = {
    method,
    url,
    headers: { host: "localhost", "content-type": "application/json" },
    on(event, callback) {
      if (event === "data" && body !== undefined) callback(Buffer.from(JSON.stringify(body)))
      if (event === "end") callback()
      return req
    },
  }
  return req
}

async function call(method, url, body, runtime = { currentWorkspace: process.cwd() }) {
  let status = 0
  let responseBody = ""
  const handled = await handleComponents(
    request(method, url, body),
    { writeHead(code) { status = code }, end(value) { responseBody = String(value || "") } },
    { groups: { core: { runtime }, storage: { paths: { APP_ROOT: process.cwd(), DATA_DIR: process.env.PI_USER_CONFIG || process.cwd(), PI_CONFIG_DIR: process.env.PI_USER_CONFIG || process.cwd() } } } },
  )
  return { handled, status, body: JSON.parse(responseBody || "null") }
}

const manifest = {
  schemaVersion: 1,
  packageId: "example.api.extension",
  packageVersion: "1.0.0",
  component: {
    schemaVersion: 1,
    id: "example.api.extension",
    version: "1.0.0",
    kind: "optional",
    capability: "agent-tool",
    source: "user",
    productClass: "third-party",
    hostSurface: "agent",
    displayName: "示例接口",
    icon: "#iplus",
    agentConfig: { timeoutMs: 30_000, maxConcurrent: 2 },
    settings: [
      { id: "result-limit", type: "number", label: "结果数量", defaultValue: 10 },
      { id: "safe-search", type: "boolean", label: "安全搜索", defaultValue: true },
      { id: "region", type: "select", label: "区域", choices: ["cn", "global"], defaultValue: "global" },
    ],
  },
  entry: "dist/index.js",
  source: { kind: "registry", origin: "https://registry.example.test/example-api.tgz", digest: "c".repeat(64) },
  signature: { algorithm: "sha256", value: "c".repeat(64), keyId: "registry" },
  compatibility: { host: "^1.0.0", contract: "1", engine: "^1.0.0" },
  permissions: { network: false, filesystem: ["read"], subprocess: false, secrets: [] },
  resources: { maxMemoryMb: 64, maxCpuMs: 1000, maxNetworkRequests: 1, maxFileBytes: 4096 },
  isolation: { mode: "worker", installRoot: "extensions/example-api", allowedEntry: "dist/index.js" },
}

describe("third-party extension management API", () => {
  it("manages a declaration without loading its entry point", async () => {
    const root = mkdtempSync(join(tmpdir(), "extension-api-"))
    const previousConfig = process.env.PI_USER_CONFIG
    process.env.PI_USER_CONFIG = root
    try {
      const installed = await call("POST", "/api/extensions/install", { manifest })
      assert.equal(installed.status, 201)
      assert.equal(installed.body.lifecycle.phase, "installed")
      assert.equal(installed.body.extension.trusted, false)
      assert.equal(installed.body.extension.fingerprint.length, 64)
      assert.equal(installed.body.extension.source.kind, "registry")
      assert.equal(installed.body.extension.manifest.component.displayName, "示例接口")
      assert.equal(installed.body.extension.manifest.component.icon, "#iplus")
      assert.deepEqual(installed.body.extension.manifest.component.agentConfig, { timeoutMs: 30_000, maxConcurrent: 2 })

      const initialSettings = await call("GET", "/api/extensions/example.api.extension/settings")
      assert.equal(initialSettings.status, 200)
      assert.equal(initialSettings.body.settings.length, 3)
      assert.deepEqual(initialSettings.body.values.effective, { "result-limit": 10, "safe-search": true, region: "global" })

      const userSettings = await call("PATCH", "/api/extensions/example.api.extension/settings", {
        scope: "user", values: { "result-limit": 20, "safe-search": false },
      })
      assert.equal(userSettings.status, 200)
      assert.equal(userSettings.body.values.effective["result-limit"], 20)
      const workspaceSettings = await call("PATCH", "/api/extensions/example.api.extension/settings", {
        scope: "workspace", values: { "result-limit": 5, region: "cn" },
      })
      assert.equal(workspaceSettings.status, 200)
      assert.deepEqual(workspaceSettings.body.values.effective, { "result-limit": 5, "safe-search": false, region: "cn" })
      const anotherWorkspace = { currentWorkspace: join(root, "another-workspace") }
      const otherWorkspaceSettings = await call("PATCH", "/api/extensions/example.api.extension/settings", {
        scope: "workspace", values: { "result-limit": 3, region: "global" },
      }, anotherWorkspace)
      assert.equal(otherWorkspaceSettings.status, 200)
      assert.deepEqual(otherWorkspaceSettings.body.values.effective, { "result-limit": 3, "safe-search": false, region: "global" })
      const rejectedSettings = await call("PATCH", "/api/extensions/example.api.extension/settings", {
        scope: "user", values: { "api-key": "not-allowed" },
      })
      assert.equal(rejectedSettings.status, 400)

      const listed = await call("GET", "/api/extensions")
      assert.ok(listed.body.extensions.some((entry) => entry.packageId === manifest.packageId && entry.trusted === false))

      const denied = await call("POST", "/api/extensions/example.api.extension/enable", {})
      assert.equal(denied.status, 400)
      assert.equal(denied.body.code, "untrusted_component")

      const trusted = await call("POST", "/api/extensions/example.api.extension/trust", { trusted: true })
      assert.equal(trusted.status, 200)
      assert.equal(trusted.body.extension.trusted, true)
      const enabled = await call("POST", "/api/extensions/example.api.extension/enable", {})
      assert.equal(enabled.status, 200)
      assert.equal(enabled.body.lifecycle.phase, "active")
      const disabled = await call("POST", "/api/extensions/example.api.extension/disable", {})
      assert.equal(disabled.status, 200)
      assert.equal(disabled.body.lifecycle.phase, "disposed")
      const removed = await call("POST", "/api/extensions/example.api.extension/uninstall", {})
      assert.equal(removed.status, 200)
      assert.equal(removed.body.extension, null)

      const reinstalled = await call("POST", "/api/extensions/install", { manifest })
      assert.equal(reinstalled.status, 201)
      const reinstalledSettings = await call("GET", "/api/extensions/example.api.extension/settings")
      assert.equal(reinstalledSettings.status, 200)
      assert.deepEqual(reinstalledSettings.body.values.effective, { "result-limit": 10, "safe-search": true, region: "global" })
      const reinstalledOtherWorkspaceSettings = await call("GET", "/api/extensions/example.api.extension/settings", undefined, anotherWorkspace)
      assert.equal(reinstalledOtherWorkspaceSettings.status, 200)
      assert.deepEqual(reinstalledOtherWorkspaceSettings.body.values.effective, { "result-limit": 10, "safe-search": true, region: "global" })

      const afterRestart = await call("GET", "/api/extensions/example.api.extension")
      assert.equal(afterRestart.status, 200)
      const removedAgain = await call("POST", "/api/extensions/example.api.extension/uninstall", {})
      assert.equal(removedAgain.status, 200)
      const afterSecondRestart = await call("GET", "/api/extensions/example.api.extension")
      assert.equal(afterSecondRestart.status, 404)
    } finally {
      process.env.PI_USER_CONFIG = previousConfig
      rmSync(root, { recursive: true, force: true })
    }
  })

  it("toggles only the installed built-in Agent tool collection", async () => {
    const root = mkdtempSync(join(tmpdir(), "agent-tool-collection-"))
    const previousConfig = process.env.PI_USER_CONFIG
    process.env.PI_USER_CONFIG = root
    try {
      const disabled = await call("POST", "/api/components/agent-tools/disable")
      assert.equal(disabled.status, 200)
      assert.ok(disabled.body.components.length > 0)
      assert.ok(disabled.body.components.every((component) => component.manifest.source === "builtin" && component.manifest.capability === "agent-tool"))
      assert.ok(disabled.body.components.every((component) => component.manifest.permissions && Array.isArray(component.manifest.permissions.filesystem)))
      assert.ok(disabled.body.components.every((component) => component.status === "disabled" && component.enabled === false))

      const enabled = await call("POST", "/api/components/agent-tools/enable")
      assert.equal(enabled.status, 200)
      assert.deepEqual(enabled.body.components.map((component) => component.manifest.id), disabled.body.components.map((component) => component.manifest.id))
      assert.ok(enabled.body.components.every((component) => component.status === "active" && component.enabled === true))
    } finally {
      await call("POST", "/api/components/agent-tools/enable")
      process.env.PI_USER_CONFIG = previousConfig
      rmSync(root, { recursive: true, force: true })
    }
  })

  it("refreshes the active session after Agent-tool component state changes", async () => {
    const root = mkdtempSync(join(tmpdir(), "agent-tool-refresh-"))
    const previousConfig = process.env.PI_USER_CONFIG
    process.env.PI_USER_CONFIG = root
    let refreshes = 0
    const runtime = { currentWorkspace: process.cwd(), async refreshTools() { refreshes += 1 } }
    try {
      const disabled = await call("POST", "/api/components/tool.memory/disable", undefined, runtime)
      assert.equal(disabled.status, 200)
      assert.equal(refreshes, 1)
      const enabled = await call("POST", "/api/components/tool.memory/enable", undefined, runtime)
      assert.equal(enabled.status, 200)
      assert.equal(refreshes, 2)
    } finally {
      await call("POST", "/api/components/tool.memory/enable", undefined, runtime)
      process.env.PI_USER_CONFIG = previousConfig
      rmSync(root, { recursive: true, force: true })
    }
  })

  it("persists a disabled first-party tool where server startup restores it", async () => {
    const root = mkdtempSync(join(tmpdir(), "agent-tool-persistence-"))
    const previousConfig = process.env.PI_USER_CONFIG
    process.env.PI_USER_CONFIG = root
    try {
      const disabled = await call("POST", "/api/components/tool.memory/disable")
      assert.equal(disabled.status, 200)
      const stateFile = join(root, "component-state.json")
      assert.equal(existsSync(stateFile), true)

      const restarted = new CapabilityComponentManager()
      restarted.register(MEMORY_COMPONENT_PACKAGE_MANIFEST.component, { trusted: true, enabled: true, health: "healthy" })
      await restarted.restore(stateFile)
      assert.equal(restarted.get("tool.memory")?.status, "disabled")
    } finally {
      await call("POST", "/api/components/tool.memory/enable")
      process.env.PI_USER_CONFIG = previousConfig
      rmSync(root, { recursive: true, force: true })
    }
  })
})
