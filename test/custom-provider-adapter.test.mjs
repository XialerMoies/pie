import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { PiCustomProviderAdapter } from "../src/model-provider/pi-custom-provider-adapter.ts"

const PROTOCOLS = [
  "openai-completions",
  "openai-responses",
  "anthropic-messages",
  "google-generative-ai",
  "mistral-conversations",
  "azure-openai-responses",
  "pi-messages",
]

function model(overrides = {}) {
  return {
    id: "reasoner-v1",
    name: "Reasoner v1",
    contextWindow: 128_000,
    maxTokens: 16_384,
    reasoning: true,
    input: ["text", "image"],
    cost: {
      input: 1.23456789,
      output: 5.67890123,
      cacheRead: 0.23456789,
      cacheWrite: 1.3456789,
    },
    samplingParams: { temperature: 0.7, stop: ["END"] },
    compatibility: { supportsDeveloperRole: true, nested: { mode: "strict" } },
    ...overrides,
  }
}

function definition(overrides = {}) {
  return {
    id: "acme-gateway",
    name: "Acme Gateway",
    protocol: "openai-responses",
    baseUrl: "https://api.example.test/v1",
    authMode: "apiKey",
    apiKeyRef: "credential:api-key-1",
    headers: [{ name: "X-Tenant", credentialRef: "credential:tenant-1" }],
    models: [model()],
    ...overrides,
  }
}

function secrets(overrides = {}) {
  return {
    apiKey: "api-secret-value",
    headers: { "X-Tenant": "tenant-secret-value" },
    ...overrides,
  }
}

function noAuthDefinition(overrides = {}) {
  const value = definition({ authMode: "none", ...overrides })
  delete value.apiKeyRef
  return value
}

class FakeRuntime {
  registrations = new Map()
  calls = []
  fail = undefined

  registerProvider(id, config) {
    this.#maybeFail("registerProvider", id, "before")
    this.calls.push(["registerProvider", id, config])
    this.registrations.set(id, { kind: "config", value: config })
    this.#maybeFail("registerProvider", id, "after")
  }

  registerNativeProvider(provider) {
    this.#maybeFail("registerNativeProvider", provider.id, "before")
    this.calls.push(["registerNativeProvider", provider.id, provider])
    this.registrations.set(provider.id, { kind: "native", value: provider })
    this.#maybeFail("registerNativeProvider", provider.id, "after")
  }

  unregisterProvider(id) {
    this.#maybeFail("unregisterProvider", id, "before")
    this.calls.push(["unregisterProvider", id])
    this.registrations.delete(id)
    this.#maybeFail("unregisterProvider", id, "after")
  }

  #maybeFail(operation, id, phase) {
    if (
      this.fail?.operation === operation
      && this.fail?.id === id
      && (this.fail?.phase ?? "before") === phase
      && this.fail?.remaining > 0
    ) {
      this.fail.remaining -= 1
      throw new Error(`injected ${operation} failure for ${id}`)
    }
  }
}

function expectedModel(input, provider) {
  return {
    id: input.id,
    name: input.name,
    api: provider.protocol,
    provider: provider.id,
    baseUrl: provider.baseUrl,
    reasoning: input.reasoning,
    input: input.input,
    cost: input.cost,
    contextWindow: input.contextWindow,
    maxTokens: input.maxTokens,
    samplingParams: input.samplingParams,
    compat: input.compatibility,
  }
}

describe("PiCustomProviderAdapter", () => {
  it("maps all seven protocols to exact PI models and native lazy providers", () => {
    for (const protocol of PROTOCOLS) {
      const adapter = new PiCustomProviderAdapter()
      const input = noAuthDefinition({ id: `custom-${protocol}`, protocol })
      const inputSecrets = { apiKey: "must-not-be-used", headers: { "X-Tenant": "tenant-value" } }
      const beforeDefinition = structuredClone(input)
      const beforeSecrets = structuredClone(inputSecrets)
      const prepared = adapter.prepare(input, inputSecrets)
      const runtime = new FakeRuntime()

      adapter.replaceRuntimeProviders(runtime, [prepared])

      assert.equal(prepared.providerId, input.id)
      assert.deepEqual(prepared.models, [expectedModel(input.models[0], input)])
      assert.deepEqual(input, beforeDefinition)
      assert.deepEqual(inputSecrets, beforeSecrets)
      assert.deepEqual(runtime.calls.map(([operation, id]) => [operation, id]), [
        ["registerNativeProvider", input.id],
      ])
      const provider = runtime.registrations.get(input.id).value
      assert.equal(provider.id, input.id)
      assert.equal(provider.name, input.name)
      assert.equal(provider.baseUrl, input.baseUrl)
      assert.deepEqual(provider.getModels(), [expectedModel(input.models[0], input)])
    }
  })

  it("registers apiKey providers with an exact prototype-safe config", () => {
    const adapter = new PiCustomProviderAdapter()
    const input = definition({
      headers: [
        { name: "__proto__", credentialRef: "credential:proto" },
        { name: "constructor", credentialRef: "credential:constructor" },
        { name: "prototype", credentialRef: "credential:prototype" },
      ],
    })
    const headerSecrets = Object.create(null)
    headerSecrets.__proto__ = "proto-secret"
    headerSecrets.constructor = "constructor-secret"
    headerSecrets.prototype = "prototype-secret"
    const prepared = adapter.prepare(input, { apiKey: "api-secret", headers: headerSecrets })
    const runtime = new FakeRuntime()

    adapter.replaceRuntimeProviders(runtime, [prepared])

    assert.equal(runtime.calls[0][0], "registerProvider")
    assert.equal(runtime.calls.some(([operation]) => operation === "registerNativeProvider"), false)
    const config = runtime.calls[0][2]
    assert.equal(Object.getPrototypeOf(config.headers), null)
    assert.deepEqual(Object.entries(config.headers), [
      ["__proto__", "proto-secret"],
      ["constructor", "constructor-secret"],
      ["prototype", "prototype-secret"],
    ])
    assert.deepEqual({ ...config, headers: Object.fromEntries(Object.entries(config.headers)) }, {
      name: input.name,
      baseUrl: input.baseUrl,
      api: input.protocol,
      apiKey: "api-secret",
      headers: Object.fromEntries([
        ["__proto__", "proto-secret"],
        ["constructor", "constructor-secret"],
        ["prototype", "prototype-secret"],
      ]),
      authHeader: true,
      models: [expectedModel(input.models[0], input)],
    })
  })

  it("requires only declared resolved credentials", () => {
    const adapter = new PiCustomProviderAdapter()

    assert.throws(() => adapter.prepare(definition(), secrets({ apiKey: undefined })), /api key/i)
    assert.throws(
      () => adapter.prepare(definition(), secrets({ headers: {} })),
      /X-Tenant.*resolved|resolved.*X-Tenant/i,
    )
    assert.throws(
      () => adapter.prepare(definition(), secrets({ headers: { "X-Tenant": "ok", "X-Extra": "no" } })),
      /X-Extra.*not configured|not configured.*X-Extra/i,
    )
  })

  it("validates definitions before credential mapping", () => {
    const adapter = new PiCustomProviderAdapter()
    assert.throws(
      () => adapter.prepare({ ...definition(), id: "INVALID" }, { headers: {} }),
      /provider\.id/,
    )
  })

  it("uses keyless native auth without Authorization while preserving custom headers", async () => {
    const adapter = new PiCustomProviderAdapter()
    const input = noAuthDefinition()
    const prepared = adapter.prepare(input, {
      apiKey: "must-not-be-used",
      headers: { "X-Tenant": "tenant-value" },
    })
    const runtime = new FakeRuntime()
    adapter.replaceRuntimeProviders(runtime, [prepared])
    const provider = runtime.registrations.get(input.id).value

    assert.equal(Object.getPrototypeOf(provider.headers), null)
    assert.deepEqual(Object.entries(provider.headers), [["X-Tenant", "tenant-value"]])
    assert.equal("Authorization" in provider.headers, false)
    assert.deepEqual(await provider.auth.apiKey.check(), {
      type: "api_key",
      source: "custom-provider",
    })
    const resolution = await provider.auth.apiKey.resolve()
    assert.deepEqual(resolution, {
      auth: {},
      source: "custom-provider",
    })
    assert.equal("apiKey" in resolution.auth, false)
    assert.equal(JSON.stringify(provider).includes("must-not-be-used"), false)
    assert.equal(JSON.stringify(provider).includes("Authorization"), false)
  })

  it("keeps credentials and credential references out of prepared serialization", () => {
    const adapter = new PiCustomProviderAdapter()
    const prepared = adapter.prepare(definition(), secrets())
    const serialized = JSON.stringify(prepared)

    assert.deepEqual(Object.keys(prepared), ["providerId", "models"])
    for (const secret of ["api-secret-value", "tenant-secret-value", "credential:api-key-1", "credential:tenant-1"]) {
      assert.equal(serialized.includes(secret), false, `${secret} leaked from prepared provider`)
    }
  })

  it("rejects duplicate prepared IDs before changing the runtime", () => {
    const adapter = new PiCustomProviderAdapter()
    const first = adapter.prepare(definition(), secrets())
    const second = adapter.prepare(definition(), secrets())
    const runtime = new FakeRuntime()

    assert.throws(() => adapter.replaceRuntimeProviders(runtime, [first, second]), /duplicate.*acme-gateway/i)
    assert.deepEqual(runtime.calls, [])
  })

  it("fully replaces owned providers without unregistering unowned IDs", () => {
    const adapter = new PiCustomProviderAdapter()
    const runtime = new FakeRuntime()
    const official = { kind: "official" }
    runtime.registrations.set("openai", official)
    const first = adapter.prepare(definition({ id: "first" }), secrets())
    const second = adapter.prepare(noAuthDefinition({ id: "second" }), { headers: { "X-Tenant": "two" } })
    const third = adapter.prepare(definition({ id: "third" }), secrets())

    adapter.replaceRuntimeProviders(runtime, [first, second])
    runtime.calls = []
    adapter.replaceRuntimeProviders(runtime, [third])

    assert.deepEqual(runtime.calls.map(([operation, id]) => [operation, id]), [
      ["unregisterProvider", "first"],
      ["unregisterProvider", "second"],
      ["registerProvider", "third"],
    ])
    assert.equal(runtime.registrations.get("openai"), official)
    assert.deepEqual([...runtime.registrations.keys()], ["openai", "third"])
  })

  it("deterministically replaces the same prepared set", () => {
    const adapter = new PiCustomProviderAdapter()
    const runtime = new FakeRuntime()
    const first = adapter.prepare(definition({ id: "first" }), secrets())
    const second = adapter.prepare(noAuthDefinition({ id: "second" }), { headers: { "X-Tenant": "two" } })
    adapter.replaceRuntimeProviders(runtime, [first, second])
    runtime.calls = []

    adapter.replaceRuntimeProviders(runtime, [first, second])

    assert.deepEqual(runtime.calls.map(([operation, id]) => [operation, id]), [
      ["unregisterProvider", "first"],
      ["unregisterProvider", "second"],
      ["registerProvider", "first"],
      ["registerNativeProvider", "second"],
    ])
  })

  it("rolls back to the prior set when synchronous registration fails", () => {
    const adapter = new PiCustomProviderAdapter()
    const runtime = new FakeRuntime()
    const prior = adapter.prepare(definition({ id: "prior" }), secrets())
    const next = adapter.prepare(definition({ id: "next" }), secrets())
    const broken = adapter.prepare(noAuthDefinition({ id: "broken" }), { headers: { "X-Tenant": "broken" } })
    adapter.replaceRuntimeProviders(runtime, [prior])
    const priorRegistration = runtime.registrations.get("prior")
    runtime.fail = { operation: "registerNativeProvider", id: "broken", phase: "after", remaining: 1 }

    assert.throws(
      () => adapter.replaceRuntimeProviders(runtime, [next, broken]),
      /injected registerNativeProvider failure/,
    )

    assert.deepEqual([...runtime.registrations.keys()], ["prior"])
    assert.equal(runtime.registrations.get("prior").value, priorRegistration.value)
    runtime.fail = undefined
    runtime.calls = []
    adapter.replaceRuntimeProviders(runtime, [])
    assert.deepEqual(runtime.calls.map(([operation, id]) => [operation, id]), [
      ["unregisterProvider", "prior"],
    ])
  })

  it("rolls back to the prior set when synchronous unregistration fails", () => {
    const adapter = new PiCustomProviderAdapter()
    const runtime = new FakeRuntime()
    const first = adapter.prepare(definition({ id: "first" }), secrets())
    const second = adapter.prepare(definition({ id: "second" }), secrets())
    const next = adapter.prepare(definition({ id: "next" }), secrets())
    adapter.replaceRuntimeProviders(runtime, [first, second])
    const before = new Map(runtime.registrations)
    runtime.fail = { operation: "unregisterProvider", id: "second", remaining: 1 }

    assert.throws(() => adapter.replaceRuntimeProviders(runtime, [next]), /injected unregisterProvider failure/)

    assert.deepEqual([...runtime.registrations.keys()], ["first", "second"])
    assert.equal(runtime.registrations.get("first").value, before.get("first").value)
    assert.equal(runtime.registrations.get("second").value, before.get("second").value)
  })

  it("converts PI usage without double-counting reasoning", () => {
    const adapter = new PiCustomProviderAdapter()
    assert.deepEqual(adapter.toProviderUsage({
      input: 11,
      output: 17,
      cacheRead: 3,
      cacheWrite: 5,
      reasoning: 7,
      totalTokens: 36,
      cost: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, total: 10 },
    }), {
      input: 11,
      output: 17,
      cacheRead: 3,
      cacheWrite: 5,
      reasoning: 7,
    })
    assert.deepEqual(adapter.toProviderUsage({
      input: 1,
      output: 2,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 3,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    }), {
      input: 1,
      output: 2,
      cacheRead: 0,
      cacheWrite: 0,
    })
  })
})
