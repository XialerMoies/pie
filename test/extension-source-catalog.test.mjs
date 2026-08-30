import assert from "node:assert/strict"
import { createHash, generateKeyPairSync, sign } from "node:crypto"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { describe, it } from "node:test"
import { componentPackageManifestFingerprint, normalizeCapabilityComponentPackageManifest } from "../src/agent/component-package.ts"
import { ExtensionSourceCatalog, extensionSourceIndexSigningPayload } from "../src/agent/extension-source-catalog.ts"
import { ExtensionSourceError } from "../src/agent/extension-source-store.ts"

const compatibility = { hostVersion: "1.0.0", contractVersion: "1.0.0", engineVersion: "1.0.0" }
const digest = (raw) => createHash("sha256").update(raw).digest("hex")

function manifest(version = "1.0.0") {
  return {
    schemaVersion: 1,
    packageId: "example.source.extension",
    packageVersion: version,
    component: {
      schemaVersion: 1,
      id: "example.source.extension",
      version,
      kind: "optional",
      capability: "agent-tool",
      source: "user",
      productClass: "third-party",
      hostSurface: "agent",
      displayName: "来源示例扩展",
    },
    entry: "dist/index.js",
    source: { kind: "registry", origin: "file:///local/example.source.extension", digest: "a".repeat(64) },
    signature: { algorithm: "sha256", value: "a".repeat(64), keyId: "local" },
    compatibility: { host: "^1.0.0", contract: "1", engine: "^1.0.0" },
    permissions: { network: false, filesystem: ["read"], subprocess: false, secrets: [] },
    resources: { maxMemoryMb: 64, maxCpuMs: 1000, maxNetworkRequests: 1, maxFileBytes: 4096 },
    isolation: { mode: "worker", installRoot: "extensions/example.source.extension", allowedEntry: "dist/index.js" },
  }
}

function writeSource(root, versions = ["1.0.0", "1.1.0"]) {
  const records = versions.map((version) => {
    const value = manifest(version)
    const relativePath = `packages/example.source.extension/${version}/manifest.json`
    const filePath = join(root, ...relativePath.split("/"))
    mkdirSync(join(filePath, ".."), { recursive: true })
    const raw = `${JSON.stringify(value, null, 2)}\n`
    writeFileSync(filePath, raw, "utf8")
    return {
      version,
      manifestPath: relativePath,
      manifestDigest: digest(raw),
      manifestFingerprint: componentPackageManifestFingerprint(normalizeCapabilityComponentPackageManifest(value, compatibility)),
    }
  })
  const indexPath = join(root, "index.json")
  writeFileSync(indexPath, JSON.stringify({
    schemaVersion: 1,
    sourceId: "demo.local",
    packages: [{ packageId: "example.source.extension", displayName: "本地示例", publisher: "Example", versions: records }],
  }, null, 2), "utf8")
  return { indexPath, records }
}

describe("extension source catalog", () => {
  it("lists validated local package versions without loading their entry", async () => {
    const root = mkdtempSync(join(tmpdir(), "extension-source-catalog-"))
    try {
      const { indexPath } = writeSource(root)
      const catalog = new ExtensionSourceCatalog(compatibility)
      const packages = await catalog.list({ schemaVersion: 1, id: "demo.local", displayName: "Demo", kind: "file", indexPath })
      assert.deepEqual(packages.map((entry) => `${entry.packageId}@${entry.version}`), ["example.source.extension@1.0.0", "example.source.extension@1.1.0"])
      assert.equal(packages[0].displayName, "本地示例")
      assert.equal(packages[0].manifest.component.id, "example.source.extension")
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it("rejects a digest mismatch and path traversal before package installation", async () => {
    const root = mkdtempSync(join(tmpdir(), "extension-source-tamper-"))
    try {
      const { indexPath, records } = writeSource(root, ["1.0.0"])
      const source = { schemaVersion: 1, id: "demo.local", displayName: "Demo", kind: "file", indexPath }
      const catalog = new ExtensionSourceCatalog(compatibility)
      const index = JSON.parse(readFileSync(indexPath, "utf8"))
      index.packages[0].versions[0].manifestDigest = "0".repeat(64)
      writeFileSync(indexPath, JSON.stringify(index), "utf8")
      await assert.rejects(() => catalog.list(source), (error) => error instanceof ExtensionSourceError && error.code === "manifest_digest_mismatch")

      index.packages[0].versions[0].manifestDigest = "a".repeat(64)
      index.packages[0].versions[0].manifestPath = "../outside.json"
      writeFileSync(indexPath, JSON.stringify(index), "utf8")
      await assert.rejects(() => catalog.list(source), (error) => error instanceof ExtensionSourceError && error.code === "unsafe_manifest_path")

      index.packages[0].versions[0].manifestPath = records[0].manifestPath
      index.packages[0].versions[0].manifestDigest = records[0].manifestDigest
      index.packages[0].versions[0].manifestFingerprint = "0".repeat(64)
      writeFileSync(indexPath, JSON.stringify(index), "utf8")
      await assert.rejects(() => catalog.list(source), (error) => error instanceof ExtensionSourceError && error.code === "manifest_fingerprint_mismatch")
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it("fetches only a signed HTTPS index and refuses a signature mismatch", async () => {
    const root = mkdtempSync(join(tmpdir(), "extension-source-https-"))
    try {
      const { records } = writeSource(root, ["1.0.0"])
      const rawManifest = readFileSync(join(root, ...records[0].manifestPath.split("/")), "utf8")
      const { privateKey, publicKey } = generateKeyPairSync("ed25519")
      const unsigned = {
        schemaVersion: 1,
        sourceId: "team.remote",
        packages: [{ packageId: "example.source.extension", versions: [{ ...records[0], manifestPath: "packages/example.source.extension/1.0.0/manifest.json" }] }],
      }
      const index = {
        ...unsigned,
        signature: { algorithm: "ed25519", keyId: "team-key", value: sign(null, extensionSourceIndexSigningPayload(unsigned), privateKey).toString("base64") },
      }
      let remoteIndex = JSON.stringify(index)
      const fetch = async (url) => ({
        ok: true,
        status: 200,
        headers: { get: () => null },
        text: async () => url.endsWith("index.json") ? remoteIndex : rawManifest,
      })
      const source = {
        schemaVersion: 1,
        id: "team.remote",
        displayName: "Team remote",
        kind: "https",
        indexUrl: "https://extensions.example.test/catalog/index.json",
        keyId: "team-key",
        publicKey: publicKey.export({ type: "spki", format: "pem" }).toString(),
      }
      const catalog = new ExtensionSourceCatalog(compatibility, { fetch })
      assert.equal((await catalog.list(source)).length, 1)
      index.signature.value = "A".repeat(86) + "=="
      remoteIndex = JSON.stringify(index)
      await assert.rejects(() => catalog.list(source), (error) => error instanceof ExtensionSourceError && error.code === "invalid_source_signature")
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

export { writeSource }
