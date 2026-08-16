import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { resolve } from "node:path"
import { test } from "node:test"

import { InMemoryCredentialStore } from "@earendil-works/pi-ai"
import { ModelRuntime } from "@xiamol/pi-coding-agent"

import { CustomProviderRevisionConflict, CustomProviderStore } from "../src/model-provider/custom-provider-store.ts"
import { CustomProviderService } from "../src/model-provider/custom-provider-service.ts"
import { PiCustomProviderAdapter } from "../src/model-provider/pi-custom-provider-adapter.ts"
import { FileProviderReferenceMutationLock } from "../src/model-provider/provider-reference-lock.ts"
import { CustomProviderReferenceConflict, ProviderReferenceChecker } from "../src/model-provider/provider-reference-checker.ts"
import { CustomProviderRuntimeCoordinator } from "../src/model-provider/runtime-coordinator.ts"

function descriptor(id, name = id) {
  return {
    id,
    name,
    contextWindow: 32_000,
    maxTokens: 4_096,
    reasoning: false,
    input: ["text"],
    cost: { input: 1, output: 2, cacheRead: 0.25, cacheWrite: 1.25 },
  }
}

function providerDraft(overrides = {}) {
  return {
    id: "acme-relay",
    name: "Acme Relay",
    protocol: "openai-completions",
    baseUrl: "http://127.0.0.1:9/v1",
    authMode: "apiKey",
    apiKey: "shared-test-key",
    headers: [],
    models: [descriptor("reasoner-v1"), descriptor("reasoner-v2")],
    ...overrides,
  }
}

async function runtime() {
  return ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsPath: null,
    refreshOnCreate: false,
  })
}

function server(root, name, references, adapter = new PiCustomProviderAdapter()) {
  const store = new CustomProviderStore({
    configFile: resolve(root, "custom-providers.json"),
    secretsFile: resolve(root, "custom-provider-secrets.json"),
  })
  const coordinator = new CustomProviderRuntimeCoordinator({ store, adapter })
  const service = new CustomProviderService({
    store,
    coordinator,
    referenceChecker: new ProviderReferenceChecker({
      currentModel: () => references.current,
      defaultModel: () => references.default,
      customAgents: () => references.agents,
    }),
    referenceLock: new FileProviderReferenceMutationLock(resolve(root, "provider-references.lock")),
  })
  return { name, store, service, coordinator, adapter }
}

test("independent servers synchronize shared custom providers only at safe boundaries", async () => {
  const root = mkdtempSync(resolve(tmpdir(), "custom-provider-multi-server-"))
  const referencesA = { current: undefined, default: undefined, agents: [] }
  const referencesB = { current: undefined, default: undefined, agents: [] }
  let failNextReload = false
  const adapterB = new PiCustomProviderAdapter()
  const reloadControlledAdapter = {
    prepare: (...args) => adapterB.prepare(...args),
    async replaceRuntimeProviders(...args) {
      if (failNextReload) {
        failNextReload = false
        throw new Error("injected runtime reload failure")
      }
      return adapterB.replaceRuntimeProviders(...args)
    },
  }

  try {
    const serverA = server(root, "A", referencesA)
    const serverB = server(root, "B", referencesB, reloadControlledAdapter)
    const runtimeA = await runtime()
    const runtimeB = await runtime()

    assert.equal(await serverA.coordinator.sync(runtimeA), 0)
    assert.equal(await serverB.coordinator.sync(runtimeB), 0)

    const revision1 = await serverA.service.create({
      expectedRevision: 0,
      provider: providerDraft(),
    }, runtimeA)
    assert.equal(revision1.revision, 1)
    assert.equal(serverB.coordinator.loadedRevision(runtimeB), 0)
    assert.equal(runtimeB.getModel("acme-relay", "reasoner-v1"), undefined)

    assert.equal(await serverB.service.syncRuntime(runtimeB), 1)
    assert.ok(runtimeB.getModel("acme-relay", "reasoner-v1"))
    assert.equal(serverB.coordinator.loadedRevision(runtimeB), 1)

    const writes = await Promise.allSettled([
      serverA.service.update("acme-relay", {
        expectedRevision: 1,
        provider: providerDraft({ name: "Acme Relay A", apiKey: undefined }),
      }, runtimeA),
      serverB.service.update("acme-relay", {
        expectedRevision: 1,
        provider: providerDraft({ name: "Acme Relay B", apiKey: undefined }),
      }, runtimeB),
    ])
    const fulfilled = writes.filter((result) => result.status === "fulfilled")
    const rejected = writes.filter((result) => result.status === "rejected")
    assert.equal(fulfilled.length, 1)
    assert.equal(fulfilled[0].value.revision, 2)
    assert.equal(rejected.length, 1)
    assert.ok(rejected[0].reason instanceof CustomProviderRevisionConflict)
    assert.equal(rejected[0].reason.expectedRevision, 1)
    assert.equal(rejected[0].reason.currentRevision, 2)

    assert.equal(await serverB.service.syncRuntime(runtimeB), 2)
    const usableBeforeRejectedDelete = runtimeB.getModel("acme-relay", "reasoner-v1")
    referencesB.current = { provider: "acme-relay", id: "reasoner-v1" }
    await assert.rejects(
      serverB.service.update("acme-relay", {
        expectedRevision: 2,
        provider: providerDraft({
          name: fulfilled[0].value.providers[0].name,
          apiKey: undefined,
          models: [descriptor("reasoner-v2")],
        }),
      }, runtimeB),
      (error) => error instanceof CustomProviderReferenceConflict
        && error.references.some((reference) => reference.kind === "currentModel"),
    )
    assert.equal((await serverB.store.readSnapshot()).revision, 2)
    assert.equal(runtimeB.getModel("acme-relay", "reasoner-v1"), usableBeforeRejectedDelete)
    referencesB.current = undefined

    const revision3 = await serverA.service.update("acme-relay", {
      expectedRevision: 2,
      provider: providerDraft({
        name: fulfilled[0].value.providers[0].name,
        apiKey: undefined,
        models: [descriptor("reasoner-v3")],
      }),
    }, runtimeA)
    assert.equal(revision3.revision, 3)
    failNextReload = true
    await assert.rejects(serverB.service.syncRuntime(runtimeB), /injected runtime reload failure/)
    assert.equal((await serverB.store.readSnapshot()).revision, 3)
    assert.equal(serverB.coordinator.loadedRevision(runtimeB), 2)
    assert.equal(runtimeB.getModel("acme-relay", "reasoner-v1"), usableBeforeRejectedDelete)
    assert.equal(runtimeB.getModel("acme-relay", "reasoner-v3"), undefined)

    assert.equal(await serverB.coordinator.sync(runtimeB), 3)
    assert.ok(runtimeB.getModel("acme-relay", "reasoner-v3"))
    assert.equal(runtimeB.getModel("acme-relay", "reasoner-v1"), undefined)

    const serverSource = await readFile(resolve("src/server/server.ts"), "utf8")
    assert.doesNotMatch(serverSource, /setInterval\(|fs\.watch\(/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
