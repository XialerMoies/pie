import assert from "node:assert/strict"
import { existsSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { resolve } from "node:path"
import { describe, it } from "node:test"

import { InMemoryCredentialStore } from "@earendil-works/pi-ai"
import { ModelRuntime } from "@xiamol/pi-coding-agent"

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
  reads = []
  fail = undefined
  failures = []

  getProvider(id) {
    this.reads.push(id)
    const registration = this.registrations.get(id)
    return registration?.value ?? registration
  }

  getRegisteredNativeProvider(id) {
    const registration = this.registrations.get(id)
    return registration?.kind === "native" ? registration.value : undefined
  }

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
    for (const failure of [this.fail, ...this.failures]) {
      if (
        failure?.operation === operation
        && failure?.id === id
        && (failure?.phase ?? "before") === phase
        && failure?.remaining > 0
      ) {
        failure.remaining -= 1
        if (failure.replaceWith !== undefined) {
          this.registrations.set(id, { kind: "native", value: failure.replaceWith })
        }
        throw new Error(`injected ${operation} failure for ${id}`)
      }
    }
  }
}

async function realRuntime() {
  return ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsPath: null,
    refreshOnCreate: false,
  })
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

  it("registers apiKey providers natively with secrets only in auth resolution", async () => {
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

    assert.equal(runtime.calls[0][0], "registerNativeProvider")
    assert.equal(runtime.calls.some(([operation]) => operation === "registerProvider"), false)
    const provider = runtime.calls[0][2]
    assert.equal(provider.headers, undefined)
    const resolution = await provider.auth.apiKey.resolve()
    assert.equal(Object.getPrototypeOf(resolution.auth.headers), null)
    assert.deepEqual(Object.entries(resolution.auth.headers), [
      ["__proto__", "proto-secret"],
      ["constructor", "constructor-secret"],
      ["prototype", "prototype-secret"],
    ])
    assert.deepEqual({ ...resolution.auth, headers: Object.fromEntries(Object.entries(resolution.auth.headers)) }, {
      apiKey: "api-secret",
      headers: Object.fromEntries([
        ["__proto__", "proto-secret"],
        ["constructor", "constructor-secret"],
        ["prototype", "prototype-secret"],
      ]),
    })
    assert.equal(JSON.stringify(provider).includes("api-secret"), false)
    assert.equal(JSON.stringify(provider).includes("proto-secret"), false)
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

  it("rejects Authorization headers in apiKey mode without exposing the value", () => {
    const adapter = new PiCustomProviderAdapter()
    const input = definition({
      headers: [{ name: "authorization", credentialRef: "credential:authorization" }],
    })
    const authorization = "Bearer must-not-leak"

    assert.throws(
      () => adapter.prepare(input, { apiKey: "api-secret", headers: { authorization } }),
      (error) => {
        assert.match(error.message, /authorization.*apiKey|apiKey.*authorization/i)
        assert.equal(error.message.includes(authorization), false)
        return true
      },
    )
  })

  it("validates definitions before credential mapping", () => {
    const adapter = new PiCustomProviderAdapter()
    assert.throws(
      () => adapter.prepare({ ...definition(), id: "INVALID" }, { headers: {} }),
      /provider\.id/,
    )
  })

  it("uses keyless native auth with headers only in auth resolution", async () => {
    const adapter = new PiCustomProviderAdapter()
    const input = noAuthDefinition()
    const prepared = adapter.prepare(input, {
      apiKey: "must-not-be-used",
      headers: { "X-Tenant": "tenant-value" },
    })
    const runtime = new FakeRuntime()
    adapter.replaceRuntimeProviders(runtime, [prepared])
    const provider = runtime.registrations.get(input.id).value

    assert.equal(provider.headers, undefined)
    assert.deepEqual(await provider.auth.apiKey.check(), {
      type: "api_key",
      source: "custom-provider",
    })
    const resolution = await provider.auth.apiKey.resolve()
    assert.deepEqual({
      ...resolution,
      auth: {
        ...resolution.auth,
        headers: Object.fromEntries(Object.entries(resolution.auth.headers)),
      },
    }, {
      auth: { headers: { "X-Tenant": "tenant-value" } },
      source: "custom-provider",
    })
    assert.equal("apiKey" in resolution.auth, false)
    assert.equal(JSON.stringify(provider).includes("tenant-value"), false)
    assert.equal(JSON.stringify(provider).includes("must-not-be-used"), false)
    assert.equal(JSON.stringify(provider).includes("Authorization"), false)
  })

  it("returns an explicit empty literal Header dictionary for both auth modes", async () => {
    for (const [authMode, inputSecrets, expectedAuth] of [
      ["apiKey", { apiKey: "literal-key", headers: {} }, { apiKey: "literal-key", headers: {} }],
      ["none", { headers: {} }, { headers: {} }],
    ]) {
      const adapter = new PiCustomProviderAdapter()
      const input = authMode === "apiKey"
        ? definition({ id: "empty-api-key-headers", headers: [] })
        : noAuthDefinition({ id: "empty-none-headers", headers: [] })
      const prepared = adapter.prepare(input, inputSecrets)
      const runtime = new FakeRuntime()
      adapter.replaceRuntimeProviders(runtime, [prepared])
      const provider = runtime.getRegisteredNativeProvider(input.id)

      const resolution = await provider.auth.apiKey.resolve()

      assert.equal(Object.getPrototypeOf(resolution.auth.headers), null)
      assert.deepEqual({
        ...resolution.auth,
        headers: Object.fromEntries(Object.entries(resolution.auth.headers)),
      }, expectedAuth)
    }
  })

  it("keeps apiKey and Header expressions literal through real ModelRuntime auth", async () => {
    const root = mkdtempSync(resolve(tmpdir(), "pi-custom-provider-literal-"))
    const marker = resolve(root, "executed.txt")
    const literalApiKey = `!node -e 'require("node:fs").writeFileSync(${JSON.stringify(marker)},"ran")'`
    const literalHeader = "$NAME:${NAME}"
    try {
      const adapter = new PiCustomProviderAdapter()
      const runtime = await realRuntime()
      const input = definition({
        id: "literal-api-key",
        headers: [{ name: "X-Template", credentialRef: "credential:template" }],
      })
      const prepared = adapter.prepare(input, {
        apiKey: literalApiKey,
        headers: { "X-Template": literalHeader },
      })

      adapter.replaceRuntimeProviders(runtime, [prepared])
      const provider = runtime.getRegisteredNativeProvider(input.id)
      const resolution = await runtime.getAuth(input.id, { env: { NAME: "expanded" } })

      assert.ok(provider)
      assert.equal(provider.headers, undefined)
      assert.deepEqual({
        ...resolution,
        auth: {
          ...resolution.auth,
          headers: Object.fromEntries(Object.entries(resolution.auth.headers)),
        },
      }, {
        auth: { apiKey: literalApiKey, headers: { "X-Template": literalHeader } },
        source: "custom-provider",
      })
      assert.equal(existsSync(marker), false)
      assert.equal(JSON.stringify(provider).includes(literalApiKey), false)
      assert.equal(JSON.stringify(provider).includes(literalHeader), false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it("returns none-mode literal headers from real ModelRuntime without provider leakage", async () => {
    const adapter = new PiCustomProviderAdapter()
    const runtime = await realRuntime()
    const input = noAuthDefinition({
      id: "literal-none",
      headers: [
        { name: "Authorization", credentialRef: "credential:authorization" },
        { name: "X-Template", credentialRef: "credential:template" },
      ],
    })
    const literalHeaders = {
      Authorization: "!Bearer literal-token",
      "X-Template": "$NAME:${NAME}",
    }
    const prepared = adapter.prepare(input, { headers: literalHeaders })

    adapter.replaceRuntimeProviders(runtime, [prepared])
    const provider = runtime.getRegisteredNativeProvider(input.id)
    const resolution = await runtime.getAuth(input.id, { env: { NAME: "expanded" } })

    assert.ok(provider)
    assert.equal(provider.headers, undefined)
    assert.deepEqual(Object.fromEntries(Object.entries(resolution.auth.headers)), literalHeaders)
    assert.equal("apiKey" in resolution.auth, false)
    assert.equal(resolution.source, "custom-provider")
    for (const value of Object.values(literalHeaders)) {
      assert.equal(JSON.stringify(provider).includes(value), false)
    }
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
    assert.deepEqual(runtime.reads, [])
  })

  it("rejects an unowned same-ID collision without unregistering it", () => {
    const adapter = new PiCustomProviderAdapter()
    const runtime = new FakeRuntime()
    const unowned = { id: "acme-gateway", kind: "unowned" }
    runtime.registrations.set("acme-gateway", unowned)
    runtime.fail = { operation: "registerNativeProvider", id: "acme-gateway", phase: "before", remaining: 1 }
    const prepared = adapter.prepare(definition(), secrets())

    assert.throws(
      () => adapter.replaceRuntimeProviders(runtime, [prepared]),
      (error) => {
        assert.match(error.message, /collision.*acme-gateway|acme-gateway.*already registered/i)
        return true
      },
    )

    assert.equal(runtime.registrations.get("acme-gateway"), unowned)
    assert.deepEqual(runtime.reads, ["acme-gateway"])
    assert.equal(runtime.calls.some(([operation, id]) => (
      operation === "unregisterProvider" && id === "acme-gateway"
    )), false)
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
      ["registerNativeProvider", "third"],
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
      ["registerNativeProvider", "first"],
      ["registerNativeProvider", "second"],
    ])
  })

  it("does not unregister a prior ID replaced by an external native provider", () => {
    const adapter = new PiCustomProviderAdapter()
    const runtime = new FakeRuntime()
    const prepared = adapter.prepare(definition({ id: "owned" }), secrets())
    adapter.replaceRuntimeProviders(runtime, [prepared])
    const installed = runtime.getRegisteredNativeProvider("owned")
    const external = { id: "owned", kind: "external" }
    runtime.registrations.set("owned", { kind: "native", value: external })
    runtime.calls = []

    adapter.replaceRuntimeProviders(runtime, [])

    assert.notEqual(installed, external)
    assert.equal(runtime.getRegisteredNativeProvider("owned"), external)
    assert.equal(runtime.calls.some(([operation, id]) => (
      operation === "unregisterProvider" && id === "owned"
    )), false)
  })

  it("does not remove an external replacement while rolling back an attempted provider", () => {
    const adapter = new PiCustomProviderAdapter()
    const runtime = new FakeRuntime()
    const external = { id: "next", kind: "external" }
    const next = adapter.prepare(definition({ id: "next" }), secrets())
    runtime.fail = {
      operation: "registerNativeProvider",
      id: "next",
      phase: "after",
      remaining: 1,
      replaceWith: external,
    }

    assert.throws(
      () => adapter.replaceRuntimeProviders(runtime, [next]),
      /injected registerNativeProvider failure/,
    )

    assert.equal(runtime.getRegisteredNativeProvider("next"), external)
    assert.equal(runtime.calls.some(([operation, id]) => (
      operation === "unregisterProvider" && id === "next"
    )), false)
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
    runtime.fail = { operation: "unregisterProvider", id: "second", phase: "after", remaining: 1 }

    assert.throws(() => adapter.replaceRuntimeProviders(runtime, [next]), /injected unregisterProvider failure/)

    assert.deepEqual([...runtime.registrations.keys()], ["first", "second"])
    assert.equal(runtime.registrations.get("first").value, before.get("first").value)
    assert.equal(runtime.registrations.get("second").value, before.get("second").value)
  })

  it("aggregates rollback failures and retains ownership only for restored providers", () => {
    const adapter = new PiCustomProviderAdapter()
    const runtime = new FakeRuntime()
    const first = adapter.prepare(definition({ id: "first" }), secrets())
    const second = adapter.prepare(definition({ id: "second" }), secrets())
    const next = adapter.prepare(definition({ id: "next" }), secrets())
    adapter.replaceRuntimeProviders(runtime, [first, second])
    runtime.failures = [
      { operation: "registerNativeProvider", id: "next", phase: "after", remaining: 1 },
      { operation: "registerNativeProvider", id: "second", phase: "before", remaining: 1 },
    ]

    assert.throws(
      () => adapter.replaceRuntimeProviders(runtime, [next]),
      (error) => {
        assert.equal(error instanceof AggregateError, true)
        assert.equal(error.errors.length, 2)
        assert.match(error.errors[0].message, /injected registerNativeProvider failure for next/)
        assert.match(error.errors[1].message, /injected registerNativeProvider failure for second/)
        return true
      },
    )

    assert.deepEqual([...runtime.registrations.keys()], ["first"])
    runtime.failures = []
    runtime.calls = []
    adapter.replaceRuntimeProviders(runtime, [])
    assert.deepEqual(runtime.calls.map(([operation, id]) => [operation, id]), [
      ["unregisterProvider", "first"],
    ])
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
