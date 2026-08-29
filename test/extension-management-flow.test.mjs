import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { mkdtempSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { handleComponents } from "../src/server/routes/components.ts"

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

async function call(method, url, body) {
  let status = 0
  let responseBody = ""
  const handled = await handleComponents(
    request(method, url, body),
    { writeHead(code) { status = code }, end(value) { responseBody = String(value || "") } },
    { groups: { core: { runtime: { currentWorkspace: process.cwd() } }, storage: { paths: { APP_ROOT: process.cwd() } } } },
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
      const afterRestart = await call("GET", "/api/extensions/example.api.extension")
      assert.equal(afterRestart.status, 404)
    } finally {
      process.env.PI_USER_CONFIG = previousConfig
      rmSync(root, { recursive: true, force: true })
    }
  })
})
