import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { InMemoryCredentialStore } from "@earendil-works/pi-ai"
import { ModelRegistry, ModelRuntime } from "@xiamol/pi-coding-agent"

import { AgentRuntime } from "../src/agent/runtime.ts"
import { PiCustomProviderAdapter } from "../src/model-provider/pi-custom-provider-adapter.ts"
import { CustomProviderRuntimeCoordinator } from "../src/model-provider/runtime-coordinator.ts"
import { handleChat } from "../src/server/routes/chat.ts"
import { makeReq, makeResWithEvents } from "./helpers/http.mjs"

function snapshot(revision, providerIds = []) {
  return {
    schemaVersion: 1,
    revision,
    providers: providerIds.map((id) => ({ id })),
  }
}

function deferred() {
  let resolve
  let reject
  const promise = new Promise((onResolve, onReject) => {
    resolve = onResolve
    reject = onReject
  })
  return { promise, resolve, reject }
}

function runtimeProvider(id = "runtime-provider") {
  return {
    id,
    name: "Runtime Provider",
    protocol: "openai-responses",
    baseUrl: "https://runtime.example.test/v1",
    authMode: "apiKey",
    apiKeyRef: `credential:${id}`,
    headers: [],
    models: [{
      id: "runtime-model",
      name: "Runtime Model",
      contextWindow: 32_000,
      maxTokens: 4_096,
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    }],
  }
}

function createHarness(snapshots = [snapshot(0)]) {
  const reads = []
  const resolutions = []
  const preparations = []
  const applications = []
  let readIndex = 0
  const store = {
    async readSnapshot() {
      reads.push(readIndex)
      return snapshots[Math.min(readIndex++, snapshots.length - 1)]
    },
    async resolveSecrets(provider) {
      resolutions.push(provider.id)
      return { apiKey: `secret:${provider.id}`, headers: {} }
    },
  }
  const adapter = {
    prepare(provider, secrets) {
      preparations.push(provider.id)
      return { providerId: provider.id, secret: secrets.apiKey }
    },
    replaceRuntimeProviders(runtime, prepared) {
      applications.push(prepared.map((provider) => provider.providerId))
      runtime.providers = prepared
    },
  }
  const coordinator = new CustomProviderRuntimeCoordinator({ store, adapter })
  const runtime = { providers: [] }
  return { coordinator, runtime, store, adapter, reads, resolutions, preparations, applications }
}

describe("CustomProviderRuntimeCoordinator", () => {
  it("skips unconfigured API-key providers and restores them after reconfiguration", async () => {
    const configured = runtimeProvider("api-key-custom")
    const unconfigured = structuredClone(configured)
    delete unconfigured.apiKeyRef
    let current = { schemaVersion: 1, revision: 1, providers: [unconfigured] }
    const applications = []
    const coordinator = new CustomProviderRuntimeCoordinator({
      store: {
        async readSnapshot() { return current },
        async resolveSecrets(provider) {
          return { apiKey: provider.apiKeyRef ? "provider-secret" : undefined, headers: {} }
        },
      },
      adapter: {
        prepare(provider) { return { providerId: provider.id } },
        replaceRuntimeProviders(_runtime, prepared) {
          applications.push(prepared.map((provider) => provider.providerId))
        },
      },
    })
    const runtime = {}

    assert.equal(await coordinator.sync(runtime), 1)
    current = { schemaVersion: 1, revision: 2, providers: [configured] }
    assert.equal(await coordinator.sync(runtime), 2)
    current = { schemaVersion: 1, revision: 3, providers: [unconfigured] }
    assert.equal(await coordinator.sync(runtime), 3)

    assert.deepEqual(applications, [[], ["api-key-custom"], []])
  })

  it("loads revision zero once and skips an unchanged revision", async () => {
    const harness = createHarness([snapshot(0)])

    assert.equal(await harness.coordinator.sync(harness.runtime), 0)
    assert.equal(await harness.coordinator.sync(harness.runtime), 0)

    assert.equal(harness.coordinator.loadedRevision(harness.runtime), 0)
    assert.equal(harness.reads.length, 2)
    assert.deepEqual(harness.applications, [[]])
  })

  it("does not resolve or prepare providers for an unchanged revision", async () => {
    const harness = createHarness([snapshot(4, ["first"]), snapshot(4, ["changed-but-stale"])])

    assert.equal(await harness.coordinator.sync(harness.runtime), 4)
    assert.equal(await harness.coordinator.sync(harness.runtime), 4)

    assert.deepEqual(harness.resolutions, ["first"])
    assert.deepEqual(harness.preparations, ["first"])
    assert.deepEqual(harness.applications, [["first"]])
  })

  it("shares one promise, store read, and apply across concurrent calls", async () => {
    let releaseRead
    let readCount = 0
    const pendingSnapshot = new Promise((resolve) => { releaseRead = resolve })
    const applications = []
    const store = {
      readSnapshot() {
        readCount += 1
        return pendingSnapshot
      },
      async resolveSecrets(provider) {
        return { apiKey: `secret:${provider.id}`, headers: {} }
      },
    }
    const adapter = {
      prepare(provider) { return { providerId: provider.id } },
      replaceRuntimeProviders(_runtime, prepared) {
        applications.push(prepared.map((provider) => provider.providerId))
      },
    }
    const coordinator = new CustomProviderRuntimeCoordinator({ store, adapter })
    const runtime = {}

    const first = coordinator.sync(runtime)
    const second = coordinator.sync(runtime)
    const third = coordinator.sync(runtime)
    assert.strictEqual(first, second)
    assert.strictEqual(second, third)

    releaseRead(snapshot(3, ["shared"]))
    assert.deepEqual(await Promise.all([first, second, third]), [3, 3, 3])
    assert.equal(readCount, 1)
    assert.deepEqual(applications, [["shared"]])
  })

  it("drains a boundary request that arrives after the current generation was captured", async () => {
    let currentSnapshot = snapshot(1, ["revision-one"])
    const firstSecretsStarted = deferred()
    const releaseFirstSecrets = deferred()
    const trailingReadStarted = deferred()
    const releaseTrailingRead = deferred()
    const applications = []
    let reads = 0
    const coordinator = new CustomProviderRuntimeCoordinator({
      store: {
        async readSnapshot() {
          reads += 1
          if (reads === 1) return currentSnapshot
          trailingReadStarted.resolve()
          await releaseTrailingRead.promise
          return currentSnapshot
        },
        async resolveSecrets(provider) {
          if (provider.id === "revision-one") {
            firstSecretsStarted.resolve()
            await releaseFirstSecrets.promise
          }
          return { apiKey: `secret:${provider.id}`, headers: {} }
        },
      },
      adapter: {
        prepare(provider) { return { providerId: provider.id } },
        replaceRuntimeProviders(runtime, prepared) {
          applications.push(prepared.map((provider) => provider.providerId))
          runtime.providers = prepared
        },
      },
    })
    const runtime = { providers: [] }

    const first = coordinator.sync(runtime)
    await firstSecretsStarted.promise
    currentSnapshot = snapshot(2, ["revision-two"])
    const second = coordinator.sync(runtime)
    assert.strictEqual(second, first)
    let resolved = false
    first.then(() => { resolved = true })

    releaseFirstSecrets.resolve()
    assert.equal(await Promise.race([
      trailingReadStarted.promise.then(() => "trailing-read"),
      first.then(() => "resolved"),
    ]), "trailing-read")
    await Promise.resolve()
    assert.equal(resolved, false)

    releaseTrailingRead.resolve()
    assert.deepEqual(await Promise.all([first, second]), [2, 2])
    assert.equal(reads, 2)
    assert.equal(coordinator.loadedRevision(runtime), 2)
    assert.deepEqual(runtime.providers.map((provider) => provider.providerId), ["revision-two"])
    assert.deepEqual(applications, [["revision-two"]])
  })

  it("performs a trailing inspection when the requested revision is unchanged", async () => {
    let reads = 0
    let blockRead = false
    const capturedRead = deferred()
    const releaseRead = deferred()
    const applications = []
    const coordinator = new CustomProviderRuntimeCoordinator({
      store: {
        async readSnapshot() {
          reads += 1
          if (blockRead && reads === 2) {
            capturedRead.resolve()
            await releaseRead.promise
          }
          return snapshot(1, ["stable"])
        },
        async resolveSecrets(provider) {
          return { apiKey: `secret:${provider.id}`, headers: {} }
        },
      },
      adapter: {
        prepare(provider) { return { providerId: provider.id } },
        replaceRuntimeProviders(_runtime, prepared) {
          applications.push(prepared.map((provider) => provider.providerId))
        },
      },
    })
    const runtime = {}
    assert.equal(await coordinator.sync(runtime), 1)

    blockRead = true
    const first = coordinator.sync(runtime)
    await capturedRead.promise
    const second = coordinator.sync(runtime)
    assert.strictEqual(second, first)
    releaseRead.resolve()

    assert.deepEqual(await Promise.all([first, second]), [1, 1])
    assert.equal(reads, 3)
    assert.deepEqual(applications, [["stable"]])
  })

  it("cleans up after a trailing failure and retries the requested revision", async () => {
    let currentSnapshot = snapshot(1, ["revision-one"])
    const firstSecretsStarted = deferred()
    const releaseFirstSecrets = deferred()
    let failRevisionTwo = true
    let reads = 0
    const applications = []
    const coordinator = new CustomProviderRuntimeCoordinator({
      store: {
        async readSnapshot() {
          reads += 1
          return currentSnapshot
        },
        async resolveSecrets(provider) {
          if (provider.id === "revision-one") {
            firstSecretsStarted.resolve()
            await releaseFirstSecrets.promise
          }
          return { apiKey: `secret:${provider.id}`, headers: {} }
        },
      },
      adapter: {
        prepare(provider) { return { providerId: provider.id } },
        replaceRuntimeProviders(runtime, prepared) {
          const ids = prepared.map((provider) => provider.providerId)
          applications.push(ids)
          if (ids.includes("revision-two") && failRevisionTwo) {
            failRevisionTwo = false
            throw new Error("trailing apply failed")
          }
          runtime.providers = prepared
        },
      },
    })
    const runtime = { providers: [] }

    const first = coordinator.sync(runtime)
    await firstSecretsStarted.promise
    currentSnapshot = snapshot(2, ["revision-two"])
    const second = coordinator.sync(runtime)
    assert.strictEqual(second, first)
    releaseFirstSecrets.resolve()

    await assert.rejects(first, /trailing apply failed/)
    await assert.rejects(second, /trailing apply failed/)
    assert.equal(coordinator.loadedRevision(runtime), -1)
    assert.deepEqual(runtime.providers, [])

    assert.equal(await coordinator.sync(runtime), 2)
    assert.equal(reads, 3)
    assert.equal(coordinator.loadedRevision(runtime), 2)
    assert.deepEqual(runtime.providers.map((provider) => provider.providerId), ["revision-two"])
  })

  it("does not let an older reentrant load overwrite a newer generation", async () => {
    let coordinator
    let runtime
    let nestedSync
    let releaseOlder
    let reads = 0
    const olderSnapshot = new Promise((resolve) => { releaseOlder = resolve })
    const applications = []
    const store = {
      readSnapshot() {
        reads += 1
        if (reads === 1) {
          nestedSync = coordinator.sync(runtime)
          return olderSnapshot
        }
        return Promise.resolve(snapshot(2, ["newer"]))
      },
      async resolveSecrets(provider) {
        return { apiKey: `secret:${provider.id}`, headers: {} }
      },
    }
    const adapter = {
      prepare(provider) { return { providerId: provider.id } },
      replaceRuntimeProviders(target, prepared) {
        const ids = prepared.map((provider) => provider.providerId)
        applications.push(ids)
        target.providers = ids
      },
    }
    coordinator = new CustomProviderRuntimeCoordinator({ store, adapter })
    runtime = { providers: [] }

    const olderSync = coordinator.sync(runtime)
    await Promise.resolve()
    assert.strictEqual(nestedSync, olderSync)
    releaseOlder(snapshot(1, ["older"]))

    assert.deepEqual(await Promise.all([olderSync, nestedSync]), [2, 2])
    assert.equal(coordinator.loadedRevision(runtime), 2)
    assert.deepEqual(runtime.providers, ["newer"])
    assert.deepEqual(applications, [["newer"]])
  })

  it("keeps the loaded revision and prior providers when apply fails, then retries", async () => {
    const harness = createHarness([
      snapshot(1, ["stable"]),
      snapshot(2, ["replacement"]),
      snapshot(2, ["replacement"]),
    ])

    assert.equal(await harness.coordinator.sync(harness.runtime), 1)
    const stableProviders = harness.runtime.providers
    const replace = harness.adapter.replaceRuntimeProviders
    let failNext = true
    harness.adapter.replaceRuntimeProviders = (runtime, prepared) => {
      if (failNext) {
        failNext = false
        throw new Error("apply failed")
      }
      replace(runtime, prepared)
    }

    await assert.rejects(harness.coordinator.sync(harness.runtime), /apply failed/)
    assert.equal(harness.coordinator.loadedRevision(harness.runtime), 1)
    assert.strictEqual(harness.runtime.providers, stableProviders)

    assert.equal(await harness.coordinator.sync(harness.runtime), 2)
    assert.equal(harness.coordinator.loadedRevision(harness.runtime), 2)
    assert.deepEqual(harness.runtime.providers.map((provider) => provider.providerId), ["replacement"])
  })

  it("preserves the loaded revision after an aggregate apply failure with complete rollback", async () => {
    const harness = createHarness([
      snapshot(1, ["stable"]),
      snapshot(2, ["replacement"]),
    ])
    assert.equal(await harness.coordinator.sync(harness.runtime), 1)
    const stableProviders = harness.runtime.providers
    harness.adapter.replaceRuntimeProviders = (runtime) => {
      runtime.providers = stableProviders
      throw new AggregateError([new Error("provider one"), new Error("provider two")], "apply failed")
    }

    await assert.rejects(harness.coordinator.sync(harness.runtime), /apply failed/)

    assert.equal(harness.coordinator.loadedRevision(harness.runtime), 1)
    assert.strictEqual(harness.runtime.providers, stableProviders)
  })

  it("resolves only after real PI model availability is refreshed", async () => {
    const provider = runtimeProvider()
    const runtime = await ModelRuntime.create({
      credentials: new InMemoryCredentialStore(),
      modelsPath: null,
      refreshOnCreate: false,
    })
    const coordinator = new CustomProviderRuntimeCoordinator({
      store: {
        async readSnapshot() { return { schemaVersion: 1, revision: 1, providers: [provider] } },
        async resolveSecrets() { return { apiKey: "runtime-secret", headers: {} } },
      },
      adapter: new PiCustomProviderAdapter(),
    })
    const registry = new ModelRegistry(runtime)

    assert.equal(await coordinator.sync(runtime), 1)
    assert.equal(coordinator.loadedRevision(runtime), 1)
    assert.ok(registry.getAvailable().some((model) => (
      model.provider === provider.id && model.id === provider.models[0].id
    )))
  })
})

describe("AgentRuntime custom provider synchronization", () => {
  it("returns zero when no synchronization hook is configured", async () => {
    const runtime = Object.create(AgentRuntime.prototype)
    runtime.config = {}

    assert.equal(await runtime.syncModelProviders(), 0)
  })

  it("deduplicates a streaming refresh and rebinds a changed active model", async () => {
    let releaseIdle
    const idle = new Promise((resolve) => { releaseIdle = resolve })
    const activeModel = { provider: "custom", id: "active" }
    const refreshedModel = { provider: "custom", id: "active" }
    const events = []
    const session = {
      isStreaming: true,
      model: activeModel,
      async waitForIdle() {
        events.push("wait")
        await idle
        this.isStreaming = false
      },
      async setModel(model) {
        events.push("set")
        this.model = model
      },
    }
    const runtime = Object.create(AgentRuntime.prototype)
    runtime.session = session
    runtime.modelRuntime = { kind: "runtime" }
    runtime.modelRegistry = {
      find(provider, id) {
        events.push(`find:${provider}/${id}`)
        return refreshedModel
      },
    }
    runtime.config = {
      async syncModelProviders(modelRuntime) {
        events.push("sync")
        assert.strictEqual(modelRuntime, runtime.modelRuntime)
        return 7
      },
    }

    const background = runtime.syncModelProviders()
    const foreground = runtime.syncModelProviders()
    assert.strictEqual(background, foreground)
    await Promise.resolve()
    assert.deepEqual(events, ["wait"])

    releaseIdle()
    assert.deepEqual(await Promise.all([background, foreground]), [7, 7])
    assert.deepEqual(events, ["wait", "sync", "find:custom/active", "set"])
    assert.strictEqual(session.model, refreshedModel)
  })

  it("notifies and drains the coordinator when a newer save arrives during an outer sync", async () => {
    let currentSnapshot = snapshot(1, ["revision-one"])
    const firstPreparationStarted = deferred()
    const releaseFirstPreparation = deferred()
    const applications = []
    const coordinator = new CustomProviderRuntimeCoordinator({
      store: {
        async readSnapshot() { return currentSnapshot },
        async resolveSecrets(provider) {
          if (provider.id === "revision-one") {
            firstPreparationStarted.resolve()
            await releaseFirstPreparation.promise
          }
          return { apiKey: `secret:${provider.id}`, headers: {} }
        },
      },
      adapter: {
        prepare(provider) { return { providerId: provider.id } },
        replaceRuntimeProviders(_runtime, prepared) {
          applications.push(prepared.map((provider) => provider.providerId))
        },
      },
    })
    const runtime = Object.create(AgentRuntime.prototype)
    runtime.session = { isStreaming: false, model: undefined }
    runtime.modelRuntime = {}
    runtime.modelRegistry = { find: () => undefined }
    runtime.config = { syncModelProviders: (modelRuntime) => coordinator.sync(modelRuntime) }

    const first = runtime.syncModelProviders()
    await firstPreparationStarted.promise
    currentSnapshot = snapshot(2, ["revision-two"])
    const second = runtime.syncModelProviders()
    assert.strictEqual(second, first)
    releaseFirstPreparation.resolve()

    assert.deepEqual(await Promise.all([first, second]), [2, 2])
    assert.deepEqual(applications, [["revision-two"]])
  })

  it("drains a newer save that arrives while the active model is being rebound", async () => {
    let revision = 1
    const firstRebindStarted = deferred()
    const releaseFirstRebind = deferred()
    const rebound = []
    const activeModel = { provider: "custom", id: "active", revision: 0 }
    const session = {
      isStreaming: false,
      model: activeModel,
      async setModel(model) {
        rebound.push(model.revision)
        if (model.revision === 1) {
          firstRebindStarted.resolve()
          await releaseFirstRebind.promise
        }
        this.model = model
      },
    }
    const runtime = Object.create(AgentRuntime.prototype)
    runtime.session = session
    runtime.modelRuntime = {}
    runtime.modelRegistry = {
      find: () => ({ provider: "custom", id: "active", revision }),
    }
    runtime.config = { async syncModelProviders() { return revision } }

    const first = runtime.syncModelProviders()
    await firstRebindStarted.promise
    revision = 2
    const second = runtime.syncModelProviders()
    assert.strictEqual(second, first)
    releaseFirstRebind.resolve()

    assert.deepEqual(await Promise.all([first, second]), [2, 2])
    assert.deepEqual(rebound, [1, 2])
    assert.equal(session.model.revision, 2)
  })

  it("makes foreground chat await an in-flight background refresh", async () => {
    let releaseIdle
    const idle = new Promise((resolve) => { releaseIdle = resolve })
    const model = { provider: "custom", id: "active" }
    const events = []
    const session = {
      isStreaming: true,
      model,
      async waitForIdle() {
        events.push("wait")
        await idle
        this.isStreaming = false
      },
      async prompt(message) {
        events.push(`prompt:${message}`)
      },
    }
    const runtime = Object.create(AgentRuntime.prototype)
    runtime.session = session
    runtime.currentWorkspace = process.cwd()
    runtime.modelRuntime = {}
    runtime.modelRegistry = { find: () => model }
    runtime.config = {
      async syncModelProviders() {
        events.push("sync")
        return 5
      },
    }
    const chatStream = {}
    const response = makeResWithEvents()

    const background = runtime.syncModelProviders()
    const handled = await handleChat(
      makeReq("POST", "/api/chat", { message: "hello" }),
      response,
      { runtime, chatStream, paths: { APP_ROOT: process.cwd() } },
    )
    assert.equal(handled, true)
    await new Promise((resolve) => setTimeout(resolve, 0))
    assert.deepEqual(events, ["wait"])

    releaseIdle()
    await background
    await new Promise((resolve) => setTimeout(resolve, 0))
    assert.deepEqual(events, ["wait", "sync", "prompt:hello"])
    assert.equal(response._status, 200)
  })
})
