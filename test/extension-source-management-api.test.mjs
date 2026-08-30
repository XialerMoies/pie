import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { describe, it } from "node:test"
import { componentPackageManifestFingerprint, normalizeCapabilityComponentPackageManifest } from "../src/agent/component-package.ts"
import { handleComponents } from "../src/server/routes/components.ts"

const compatibility = { hostVersion: "1.0.0", contractVersion: "1.0.0", engineVersion: "1.0.0" }

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
    { groups: { core: { runtime: { currentWorkspace: process.cwd() } }, storage: { paths: { APP_ROOT: process.cwd(), DATA_DIR: process.env.PI_USER_CONFIG, PI_CONFIG_DIR: process.env.PI_USER_CONFIG } } } },
  )
  return { handled, status, body: JSON.parse(responseBody || "null") }
}

function sourceManifest() {
  return {
    schemaVersion: 1,
    packageId: "example.source.api",
    packageVersion: "1.0.0",
    component: {
      schemaVersion: 1, id: "example.source.api", version: "1.0.0", kind: "optional", capability: "agent-tool", source: "user", productClass: "third-party", hostSurface: "agent", displayName: "来源 API 示例",
      settings: [{ id: "result-limit", type: "number", label: "结果数量", defaultValue: 10 }],
    },
    entry: "dist/index.js",
    source: { kind: "registry", origin: "file:///local/example.source.api", digest: "d".repeat(64) },
    signature: { algorithm: "sha256", value: "d".repeat(64), keyId: "local" },
    compatibility: { host: "^1.0.0", contract: "1", engine: "^1.0.0" },
    permissions: { network: false, filesystem: ["read"], subprocess: false, secrets: [] },
    resources: { maxMemoryMb: 64, maxCpuMs: 1000, maxNetworkRequests: 1, maxFileBytes: 4096 },
    isolation: { mode: "worker", installRoot: "extensions/example.source.api", allowedEntry: "dist/index.js" },
  }
}

describe("extension source management API", () => {
  it("browses and installs a selected local source version without trusting it", async () => {
    const root = mkdtempSync(join(tmpdir(), "extension-source-api-"))
    const previousConfig = process.env.PI_USER_CONFIG
    process.env.PI_USER_CONFIG = root
    try {
      const manifest = sourceManifest()
      const manifestPath = join(root, "packages", "example.source.api", "manifest.json")
      mkdirSync(join(root, "packages", "example.source.api"), { recursive: true })
      const rawManifest = `${JSON.stringify(manifest, null, 2)}\n`
      writeFileSync(manifestPath, rawManifest, "utf8")
      const indexPath = join(root, "index.json")
      writeFileSync(indexPath, JSON.stringify({
        schemaVersion: 1,
        sourceId: "demo.local",
        packages: [{ packageId: manifest.packageId, versions: [{
          version: manifest.packageVersion,
          manifestPath: "packages/example.source.api/manifest.json",
          manifestDigest: createHash("sha256").update(rawManifest).digest("hex"),
          manifestFingerprint: componentPackageManifestFingerprint(normalizeCapabilityComponentPackageManifest(manifest, compatibility)),
        }] }],
      }), "utf8")

      const added = await call("POST", "/api/extension-sources", { id: "demo.local", displayName: "本地源", indexPath })
      assert.equal(added.status, 201)
      assert.equal(added.body.source.kind, "file")
      const view = await call("GET", "/api/extension-sources/demo.local")
      assert.equal(view.status, 200)
      assert.equal(view.body.packages[0].packageId, manifest.packageId)

      const installed = await call("POST", "/api/extension-sources/demo.local/install", { packageId: manifest.packageId, version: manifest.packageVersion })
      assert.equal(installed.status, 201)
      assert.equal(installed.body.lifecycle.phase, "installed")
      assert.equal(installed.body.extension.trusted, false)
      assert.equal((await call("POST", `/api/extensions/${manifest.packageId}/trust`, { trusted: true })).status, 200)
      assert.equal((await call("POST", `/api/extensions/${manifest.packageId}/enable`)).body.lifecycle.phase, "active")
      assert.equal((await call("PATCH", `/api/extensions/${manifest.packageId}/settings`, { scope: "user", values: { "result-limit": 23 } })).status, 200)

      const updatedManifest = { ...manifest, packageVersion: "1.1.0", component: { ...manifest.component, version: "1.1.0" } }
      const updatedRawManifest = `${JSON.stringify(updatedManifest, null, 2)}\n`
      writeFileSync(manifestPath, updatedRawManifest, "utf8")
      const updatedIndex = {
        schemaVersion: 1,
        sourceId: "demo.local",
        packages: [{ packageId: manifest.packageId, versions: [{
          version: "1.1.0",
          manifestPath: "packages/example.source.api/manifest.json",
          manifestDigest: createHash("sha256").update(updatedRawManifest).digest("hex"),
          manifestFingerprint: componentPackageManifestFingerprint(normalizeCapabilityComponentPackageManifest(updatedManifest, compatibility)),
        }] }],
      }
      writeFileSync(indexPath, JSON.stringify(updatedIndex), "utf8")
      const preview = await call("POST", "/api/extension-sources/demo.local/update-preview", { packageId: manifest.packageId, version: "1.1.0" })
      assert.equal(preview.status, 200)
      assert.equal(preview.body.update.fromVersion, "1.0.0")
      assert.equal(preview.body.update.toVersion, "1.1.0")
      const unconfirmed = await call("POST", "/api/extension-sources/demo.local/update", { packageId: manifest.packageId, version: "1.1.0" })
      assert.equal(unconfirmed.status, 400)
      const updated = await call("POST", "/api/extension-sources/demo.local/update", { packageId: manifest.packageId, version: "1.1.0", confirm: true })
      assert.equal(updated.status, 200)
      assert.equal(updated.body.extension.packageVersion, "1.1.0")
      assert.equal(updated.body.extension.trusted, true)
      assert.equal(updated.body.lifecycle.phase, "active")
      assert.equal((await call("GET", `/api/extensions/${manifest.packageId}/settings`)).body.values.effective["result-limit"], 23)

      updatedIndex.packages[0].versions[0].manifestDigest = "0".repeat(64)
      writeFileSync(indexPath, JSON.stringify(updatedIndex), "utf8")
      const rejectedRefresh = await call("POST", "/api/extension-sources/demo.local/refresh")
      assert.equal(rejectedRefresh.status, 400)
      assert.equal((await call("GET", `/api/extensions/${manifest.packageId}`)).body.extension.packageVersion, "1.1.0")

      const removed = await call("POST", "/api/extension-sources/demo.local/remove")
      assert.equal(removed.status, 200)
      assert.equal((await call("GET", "/api/extension-sources/demo.local")).status, 404)
      assert.equal((await call("GET", `/api/extensions/${manifest.packageId}`)).status, 200)
      await call("POST", `/api/extensions/${manifest.packageId}/uninstall`)
    } finally {
      process.env.PI_USER_CONFIG = previousConfig
      rmSync(root, { recursive: true, force: true })
    }
  })
})
