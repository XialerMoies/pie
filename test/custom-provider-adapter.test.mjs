import assert from "node:assert/strict"
import { existsSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { resolve } from "node:path"
import { describe, it } from "node:test"

import { InMemoryCredentialStore } from "@earendil-works/pi-ai"
import { ModelRuntime } from "@xiamol/pi-coding-agent"

import { CustomProviderValidationError } from "../src/model-provider/contracts.ts"
import { PiCustomProviderAdapter } from "../src/model-provider/pi-custom-provider-adapter.ts"
import { CustomProviderRuntimeCoordinator } from "../src/model-provider/runtime-coordinator.ts"
import { startFakeModelProvider } from "./fixtures/fake-model-provider.mjs"

const PROTOCOLS = [
  "openai-completions",
  "openai-responses",
  "anthropic-messages",
  "mistral-conversations",
  "azure-openai-responses",
  "pi-messages",
]
const KEYLESS_PROTOCOLS = PROTOCOLS
const FORMER_KEYLESS_COMPATIBILITY_SENTINEL = "my-code-agent-keyless-compatibility"
const KEYLESS_SENTINEL_PREFIX = "my-code-agent-keyless-compatibility:"
const WIRE_TEXT = "fixture text"
const WIRE_TOOL_NAME = "lookup_weather"
const WIRE_TOOL_ARGUMENTS = { city: "Shanghai" }
const FULL_USAGE = { input: 7, output: 5, cacheRead: 3, cacheWrite: 2, reasoning: 1 }
const EXPECTED_WIRE_USAGE = Object.fromEntries(PROTOCOLS.map((protocol) => [
  protocol,
  protocol === "mistral-conversations"
    ? { input: 7, output: 5, cacheRead: 3, cacheWrite: 0 }
    : FULL_USAGE,
]))

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
  refreshes = []
  refreshResponses = []

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

  async refresh(options) {
    this.refreshes.push(options)
    return this.refreshResponses.shift() ?? { aborted: false, errors: new Map() }
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

function captureTransport(captures) {
  return async (input, init) => {
    const request = new Request(input, init)
    captures.push({
      url: new URL(request.url),
      headers: request.headers,
    })
    throw new Error("captured keyless custom provider transport")
  }
}

function assertKeylessRequest({ url, headers }, label) {
  for (const name of ["authorization", "api-key", "x-api-key", "x-goog-api-key", "cf-aig-authorization"]) {
    assert.equal(headers.has(name), false, `${label} sent ${name}`)
  }
  for (const name of ["key", "api_key", "api-key", "apikey", "access_token"]) {
    assert.equal(url.searchParams.has(name), false, `${label} sent ${name} query auth`)
  }
}

function authHeaderName(protocol) {
  if (protocol === "anthropic-messages") return "x-api-key"
  if (protocol === "azure-openai-responses") return "api-key"
  return "authorization"
}

async function streamAgainstFixture(protocol, fixture, options = {}) {
  const authMode = options.authMode ?? "apiKey"
  const providerId = `wire-${protocol}`
  const apiKey = `api-secret-${protocol}`
  const literalHeaders = options.headers ?? { "X-Tenant": `tenant-${protocol}` }
  const headerDefinitions = Object.keys(literalHeaders).map((name, index) => ({
    name,
    credentialRef: `credential:wire-header-${index}`,
  }))
  const input = authMode === "apiKey"
    ? definition({
      id: providerId,
      protocol,
      baseUrl: fixture.baseUrl,
      headers: headerDefinitions,
      models: [model({ reasoning: false, input: ["text"] })],
    })
    : noAuthDefinition({
      id: providerId,
      protocol,
      baseUrl: fixture.baseUrl,
      headers: headerDefinitions,
      models: [model({ reasoning: false, input: ["text"] })],
    })
  const adapter = new PiCustomProviderAdapter()
  const runtime = await realRuntime()
  const prepared = adapter.prepare(input, {
    ...(authMode === "apiKey" ? { apiKey } : {}),
    headers: literalHeaders,
  })
  await adapter.replaceRuntimeProviders(runtime, [prepared])
  const originalFetch = globalThis.fetch
  const stream = runtime.streamSimple(prepared.models[0], {
    messages: [{ role: "user", content: "weather", timestamp: 1 }],
    tools: [{
      name: WIRE_TOOL_NAME,
      description: "Look up weather",
      parameters: {
        type: "object",
        properties: { city: { type: "string" } },
        required: ["city"],
      },
    }],
  }, {
    fetch: originalFetch,
    maxRetries: 0,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  })
  return { adapter, apiKey, originalFetch, runtime, stream }
}

async function captureConsole(operation) {
  const output = []
  const originals = new Map()
  for (const name of ["log", "warn", "error"]) {
    originals.set(name, console[name])
    console[name] = (...args) => output.push(args.map(String).join(" "))
  }
  try {
    return { value: await operation(), output }
  } finally {
    for (const [name, original] of originals) console[name] = original
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
  it("maps all six custom protocols to exact PI models and native lazy providers", async () => {
    for (const protocol of PROTOCOLS) {
      const adapter = new PiCustomProviderAdapter()
      const input = definition({ id: `custom-${protocol}`, protocol })
      const inputSecrets = { apiKey: "mapping-api-key", headers: { "X-Tenant": "tenant-value" } }
      const beforeDefinition = structuredClone(input)
      const beforeSecrets = structuredClone(inputSecrets)
      const prepared = adapter.prepare(input, inputSecrets)
      const runtime = new FakeRuntime()

      await adapter.replaceRuntimeProviders(runtime, [prepared])

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

  it("rejects Google as a typed unsupported custom protocol", () => {
    const adapter = new PiCustomProviderAdapter()

    assert.throws(
      () => adapter.prepare(definition({ protocol: "google-generative-ai" }), secrets()),
      (error) => error instanceof CustomProviderValidationError && error.fieldPath === "provider.protocol",
    )
  })

  it("does not change the official Google provider when custom providers are replaced", async () => {
    const runtime = await realRuntime()
    const officialGoogle = runtime.getProvider("google")
    const officialModel = runtime.getModel("google", "gemini-2.5-flash")
    const officialModelIds = officialGoogle.getModels().map((entry) => entry.id)
    const officialAuth = runtime.getProviderAuthStatus("google")
    const adapter = new PiCustomProviderAdapter()

    await adapter.replaceRuntimeProviders(runtime, [
      adapter.prepare(definition({ id: "unrelated-custom" }), secrets()),
    ])
    await adapter.replaceRuntimeProviders(runtime, [])

    assert.strictEqual(runtime.getProvider("google"), officialGoogle)
    assert.strictEqual(runtime.getModel("google", "gemini-2.5-flash"), officialModel)
    assert.deepEqual(runtime.getProvider("google").getModels().map((entry) => entry.id), officialModelIds)
    assert.deepEqual(runtime.getProviderAuthStatus("google"), officialAuth)
    assert.equal(officialModel.api, "google-generative-ai")
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

    await adapter.replaceRuntimeProviders(runtime, [prepared])

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
    await adapter.replaceRuntimeProviders(runtime, [prepared])
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
      await adapter.replaceRuntimeProviders(runtime, [prepared])
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

      await adapter.replaceRuntimeProviders(runtime, [prepared])
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

    await adapter.replaceRuntimeProviders(runtime, [prepared])
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

  for (const method of ["stream", "streamSimple"]) {
    it(`dispatches keyless ${method} requests for all six keyless protocols without auth material`, async () => {
      const originalFetch = globalThis.fetch
      const cases = await Promise.all(KEYLESS_PROTOCOLS.map(async (protocol, index) => {
        const adapter = new PiCustomProviderAdapter()
        const runtime = await realRuntime()
        const input = noAuthDefinition({
          id: `keyless-${method.toLowerCase()}-${index}`,
          protocol,
          ...(protocol === "pi-messages"
            ? { baseUrl: "https://api.example.test/v1?tenant=preserve-me" }
            : {}),
          headers: [{ name: "X-Tenant", credentialRef: `credential:keyless-tenant-${index}` }],
          models: [model({ reasoning: false, input: ["text"] })],
        })
        const prepared = adapter.prepare(input, { headers: { "X-Tenant": `tenant-${index}` } })
        await adapter.replaceRuntimeProviders(runtime, [prepared])
        const captures = []
        const stream = runtime[method](prepared.models[0], {
          messages: [{ role: "user", content: "ping", timestamp: 1 }],
        }, {
          fetch: captureTransport(captures),
          maxRetries: 0,
        })
        const result = await stream.result()
        return { protocol, captures, result }
      }))

      assert.equal(globalThis.fetch, originalFetch)
      const failures = []
      for (const { protocol, captures, result } of cases) {
        if (captures.length !== 1) {
          failures.push(`${protocol}: ${result.errorMessage}`)
        } else {
          assertKeylessRequest(captures[0], `${protocol} ${method}`)
          assert.equal(captures[0].headers.get("x-tenant"), `tenant-${KEYLESS_PROTOCOLS.indexOf(protocol)}`)
          if (protocol === "pi-messages") {
            assert.equal(captures[0].url.searchParams.has("tenant"), true)
          }
        }
        assert.equal(JSON.stringify(result).includes(KEYLESS_SENTINEL_PREFIX), false)
      }
      assert.deepEqual(failures, [], `${method} failed before request-local transport`)
    })

    it(`preserves explicit keyless auth headers for ${method} across concurrent providers`, async () => {
      const cases = await Promise.all(KEYLESS_PROTOCOLS.map(async (protocol, index) => {
        const adapter = new PiCustomProviderAdapter()
        const runtime = await realRuntime()
        const authorization = index === 0
          ? `Bearer ${FORMER_KEYLESS_COMPATIBILITY_SENTINEL}`
          : `Bearer literal-authorization-${index}`
        const apiKeyHeader = `literal-x-api-key-${index}`
        const tenant = `literal-tenant-${index}`
        const input = noAuthDefinition({
          id: `keyless-explicit-${method.toLowerCase()}-${index}`,
          protocol,
          ...(protocol === "pi-messages"
            ? { baseUrl: `https://api.example.test/v1?api_key=literal-query-${index}&trace=literal-trace` }
            : {}),
          headers: [
            { name: "Authorization", credentialRef: `credential:authorization-${index}` },
            { name: "X-API-Key", credentialRef: `credential:x-api-key-${index}` },
            { name: "X-Tenant", credentialRef: `credential:tenant-${index}` },
          ],
          models: [model({ reasoning: false, input: ["text"] })],
        })
        const prepared = adapter.prepare(input, {
          headers: { Authorization: authorization, "X-API-Key": apiKeyHeader, "X-Tenant": tenant },
        })
        await adapter.replaceRuntimeProviders(runtime, [prepared])
        const captures = []
        const result = await runtime[method](prepared.models[0], {
          messages: [{ role: "user", content: "ping", timestamp: 1 }],
        }, {
          fetch: captureTransport(captures),
          maxRetries: 0,
        }).result()
        return { protocol, captures, result, authorization, apiKeyHeader, tenant }
      }))

      const failures = []
      for (const { protocol, captures, result, authorization, apiKeyHeader, tenant } of cases) {
        if (captures.length !== 1) {
          failures.push(`${protocol}: ${result.errorMessage}`)
          continue
        }
        const [{ url, headers }] = captures
        assert.equal(headers.get("authorization"), authorization, `${protocol} replaced Authorization`)
        assert.equal(headers.get("x-api-key"), apiKeyHeader, `${protocol} replaced X-API-Key`)
        assert.equal(headers.get("x-tenant"), tenant, `${protocol} replaced X-Tenant`)
        assert.equal(JSON.stringify(result).includes(KEYLESS_SENTINEL_PREFIX), false)
        if (protocol === "pi-messages") {
          assert.match(url.searchParams.get("api_key") ?? "", /^literal-query-/)
          assert.equal(url.searchParams.get("trace"), "literal-trace/messages")
        }
      }
      assert.deepEqual(failures, [], `${method} failed before request-local transport`)
    })
  }

  it("isolates and redacts compatibility sentinels across concurrent providers", async () => {
    const originalRandomUUID = globalThis.crypto.randomUUID
    const randomValues = ["provider-one", "provider-two"]
    const sentinels = randomValues.map((value) => `${KEYLESS_SENTINEL_PREFIX}${value}`)
    globalThis.crypto.randomUUID = () => randomValues.shift()
    let cases
    try {
      cases = await Promise.all(sentinels.map(async (sentinel, index) => {
        const adapter = new PiCustomProviderAdapter()
        const runtime = await realRuntime()
        const input = noAuthDefinition({
          id: `keyless-error-redaction-${index}`,
          protocol: "pi-messages",
          headers: [],
          models: [model({ reasoning: false, input: ["text"] })],
        })
        const prepared = adapter.prepare(input, { headers: {} })
        await adapter.replaceRuntimeProviders(runtime, [prepared])
        return { runtime, prepared, sentinel }
      }))
    } finally {
      globalThis.crypto.randomUUID = originalRandomUUID
    }
    assert.deepEqual(randomValues, [])

    const results = await Promise.all(cases.map(({ runtime, prepared, sentinel }) => runtime.stream(
      prepared.models[0],
      { messages: [{ role: "user", content: "ping", timestamp: 1 }] },
      {
        fetch: async () => {
          throw new Error(`lower-layer failure: ${sentinel}`)
        },
        maxRetries: 0,
      },
    ).result()))

    for (const result of results) {
      const serialized = JSON.stringify(result)
      assert.equal(serialized.includes(KEYLESS_SENTINEL_PREFIX), false)
      assert.equal(serialized.includes("provider-one"), false)
      assert.equal(serialized.includes("provider-two"), false)
      assert.match(result.errorMessage, /redacted/i)
    }
  })

  it("streams normalized text, tool calls, and exact usage through all six apiKey protocols", async () => {
    for (const protocol of PROTOCOLS) {
      const fixture = await startFakeModelProvider(protocol)
      try {
        const captured = await captureConsole(async () => {
          const connection = await streamAgainstFixture(protocol, fixture)
          const events = []
          for await (const event of connection.stream) events.push(event)
          return { ...connection, events, result: await connection.stream.result() }
        })
        const { adapter, apiKey, originalFetch, result, events } = captured.value
        const request = fixture.requests[0]

        assert.equal(globalThis.fetch, originalFetch, `${protocol} replaced global fetch`)
        assert.equal(request.method, "POST")
        assert.equal(request.url.startsWith(`${fixture.baseUrl}/`), true, `${protocol} ignored Base URL`)
        assert.equal(request.headers[authHeaderName(protocol)], protocol === "anthropic-messages"
          || protocol === "azure-openai-responses"
          ? apiKey
          : `Bearer ${apiKey}`)
        assert.equal(request.headers["x-tenant"], `tenant-${protocol}`)
        assert.equal(events.some((event) => event.type === "text_delta"), true)
        assert.equal(events.some((event) => event.type === "toolcall_end"), true)
        assert.equal(events.at(-1).type, "done")
        assert.equal(result.stopReason, "toolUse")
        assert.equal(result.content.find((block) => block.type === "text")?.text, WIRE_TEXT)
        assert.equal(result.content.find((block) => block.type === "toolCall")?.name, WIRE_TOOL_NAME)
        assert.deepEqual(result.content.find((block) => block.type === "toolCall")?.arguments, WIRE_TOOL_ARGUMENTS)
        assert.deepEqual(adapter.toProviderUsage(result.usage), EXPECTED_WIRE_USAGE[protocol])
        assert.equal(JSON.stringify({ events, result, logs: captured.output }).includes(apiKey), false)
      } finally {
        await fixture.close()
      }
    }
  })

  it("keeps all six keyless protocols free of SDK auth while preserving explicit auth headers", async () => {
    for (const protocol of PROTOCOLS) {
      const fixture = await startFakeModelProvider(protocol)
      try {
        const plain = await streamAgainstFixture(protocol, fixture, { authMode: "none" })
        const plainResult = await plain.stream.result()
        assert.notEqual(plainResult.stopReason, "error", protocol)
        assertKeylessRequest({
          url: new URL(fixture.requests[0].url),
          headers: new Headers(fixture.requests[0].headers),
        }, protocol)
        assert.equal(fixture.requests[0].url.startsWith(`${fixture.baseUrl}/`), true, `${protocol} ignored Base URL`)

        const authorization = `Bearer explicit-${protocol}`
        const explicitApiKey = `explicit-key-${protocol}`
        const explicit = await streamAgainstFixture(protocol, fixture, {
          authMode: "none",
          headers: {
            Authorization: authorization,
            "X-API-Key": explicitApiKey,
            "X-Tenant": `explicit-tenant-${protocol}`,
          },
        })
        const explicitResult = await explicit.stream.result()
        assert.notEqual(explicitResult.stopReason, "error", protocol)
        const explicitRequest = fixture.requests[1]
        assert.equal(explicitRequest.url.startsWith(`${fixture.baseUrl}/`), true, `${protocol} explicit request ignored Base URL`)
        assert.equal(explicitRequest.headers.authorization, authorization)
        assert.equal(explicitRequest.headers["x-api-key"], explicitApiKey)
        assert.equal(explicitRequest.headers["x-tenant"], `explicit-tenant-${protocol}`)
        assert.equal(globalThis.fetch, explicit.originalFetch)
      } finally {
        await fixture.close()
      }
    }
  })

  it("produces an aborted terminal state and closes each protocol request", async () => {
    for (const protocol of PROTOCOLS) {
      const fixture = await startFakeModelProvider(protocol, { holdOpen: true })
      try {
        const controller = new AbortController()
        const { stream, originalFetch } = await streamAgainstFixture(protocol, fixture, {
          signal: controller.signal,
        })
        await fixture.waitForRequest()
        controller.abort(new DOMException("test abort", "AbortError"))
        const result = await stream.result()

        assert.equal(result.stopReason, "aborted", protocol)
        await fixture.waitForAbort()
        assert.equal(fixture.requests[0].aborted, true)
        assert.equal(globalThis.fetch, originalFetch)
      } finally {
        await fixture.close()
      }
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

  it("rejects duplicate prepared IDs before changing the runtime", async () => {
    const adapter = new PiCustomProviderAdapter()
    const first = adapter.prepare(definition(), secrets())
    const second = adapter.prepare(definition(), secrets())
    const runtime = new FakeRuntime()

    await assert.rejects(adapter.replaceRuntimeProviders(runtime, [first, second]), /duplicate.*acme-gateway/i)
    assert.deepEqual(runtime.calls, [])
    assert.deepEqual(runtime.reads, [])
  })

  it("rejects an unowned same-ID collision without unregistering it", async () => {
    const adapter = new PiCustomProviderAdapter()
    const runtime = new FakeRuntime()
    const unowned = { id: "acme-gateway", kind: "unowned" }
    runtime.registrations.set("acme-gateway", unowned)
    runtime.fail = { operation: "registerNativeProvider", id: "acme-gateway", phase: "before", remaining: 1 }
    const prepared = adapter.prepare(definition(), secrets())

    await assert.rejects(
      adapter.replaceRuntimeProviders(runtime, [prepared]),
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

  it("fully replaces owned providers without unregistering unowned IDs", async () => {
    const adapter = new PiCustomProviderAdapter()
    const runtime = new FakeRuntime()
    const official = { kind: "official" }
    runtime.registrations.set("openai", official)
    const first = adapter.prepare(definition({ id: "first" }), secrets())
    const second = adapter.prepare(noAuthDefinition({ id: "second" }), { headers: { "X-Tenant": "two" } })
    const third = adapter.prepare(definition({ id: "third" }), secrets())

    await adapter.replaceRuntimeProviders(runtime, [first, second])
    runtime.calls = []
    await adapter.replaceRuntimeProviders(runtime, [third])

    assert.deepEqual(runtime.calls.map(([operation, id]) => [operation, id]), [
      ["unregisterProvider", "first"],
      ["unregisterProvider", "second"],
      ["registerNativeProvider", "third"],
    ])
    assert.equal(runtime.registrations.get("openai"), official)
    assert.deepEqual([...runtime.registrations.keys()], ["openai", "third"])
  })

  it("deterministically replaces the same prepared set", async () => {
    const adapter = new PiCustomProviderAdapter()
    const runtime = new FakeRuntime()
    const first = adapter.prepare(definition({ id: "first" }), secrets())
    const second = adapter.prepare(noAuthDefinition({ id: "second" }), { headers: { "X-Tenant": "two" } })
    await adapter.replaceRuntimeProviders(runtime, [first, second])
    runtime.calls = []

    await adapter.replaceRuntimeProviders(runtime, [first, second])

    assert.deepEqual(runtime.calls.map(([operation, id]) => [operation, id]), [
      ["unregisterProvider", "first"],
      ["unregisterProvider", "second"],
      ["registerNativeProvider", "first"],
      ["registerNativeProvider", "second"],
    ])
  })

  it("does not unregister a prior ID replaced by an external native provider", async () => {
    const adapter = new PiCustomProviderAdapter()
    const runtime = new FakeRuntime()
    const prepared = adapter.prepare(definition({ id: "owned" }), secrets())
    await adapter.replaceRuntimeProviders(runtime, [prepared])
    const installed = runtime.getRegisteredNativeProvider("owned")
    const external = { id: "owned", kind: "external" }
    runtime.registrations.set("owned", { kind: "native", value: external })
    runtime.calls = []

    await adapter.replaceRuntimeProviders(runtime, [])

    assert.notEqual(installed, external)
    assert.equal(runtime.getRegisteredNativeProvider("owned"), external)
    assert.equal(runtime.calls.some(([operation, id]) => (
      operation === "unregisterProvider" && id === "owned"
    )), false)
  })

  it("does not remove an external replacement while rolling back an attempted provider", async () => {
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

    await assert.rejects(
      adapter.replaceRuntimeProviders(runtime, [next]),
      /injected registerNativeProvider failure/,
    )

    assert.equal(runtime.getRegisteredNativeProvider("next"), external)
    assert.equal(runtime.calls.some(([operation, id]) => (
      operation === "unregisterProvider" && id === "next"
    )), false)
  })

  it("rolls back to the prior set when synchronous registration fails", async () => {
    const adapter = new PiCustomProviderAdapter()
    const runtime = new FakeRuntime()
    const prior = adapter.prepare(definition({ id: "prior" }), secrets())
    const next = adapter.prepare(definition({ id: "next" }), secrets())
    const broken = adapter.prepare(noAuthDefinition({ id: "broken" }), { headers: { "X-Tenant": "broken" } })
    await adapter.replaceRuntimeProviders(runtime, [prior])
    const priorRegistration = runtime.registrations.get("prior")
    runtime.fail = { operation: "registerNativeProvider", id: "broken", phase: "after", remaining: 1 }

    await assert.rejects(
      adapter.replaceRuntimeProviders(runtime, [next, broken]),
      /injected registerNativeProvider failure/,
    )

    assert.deepEqual([...runtime.registrations.keys()], ["prior"])
    assert.equal(runtime.registrations.get("prior").value, priorRegistration.value)
    runtime.fail = undefined
    runtime.calls = []
    await adapter.replaceRuntimeProviders(runtime, [])
    assert.deepEqual(runtime.calls.map(([operation, id]) => [operation, id]), [
      ["unregisterProvider", "prior"],
    ])
  })

  it("rolls back to the prior set when synchronous unregistration fails", async () => {
    const adapter = new PiCustomProviderAdapter()
    const runtime = new FakeRuntime()
    const first = adapter.prepare(definition({ id: "first" }), secrets())
    const second = adapter.prepare(definition({ id: "second" }), secrets())
    const next = adapter.prepare(definition({ id: "next" }), secrets())
    await adapter.replaceRuntimeProviders(runtime, [first, second])
    const before = new Map(runtime.registrations)
    runtime.fail = { operation: "unregisterProvider", id: "second", phase: "after", remaining: 1 }

    await assert.rejects(adapter.replaceRuntimeProviders(runtime, [next]), /injected unregisterProvider failure/)

    assert.deepEqual([...runtime.registrations.keys()], ["first", "second"])
    assert.equal(runtime.registrations.get("first").value, before.get("first").value)
    assert.equal(runtime.registrations.get("second").value, before.get("second").value)
  })

  it("rolls back and refreshes restored availability when targeted refresh fails", async () => {
    const adapter = new PiCustomProviderAdapter()
    const runtime = new FakeRuntime()
    const prior = adapter.prepare(definition({ id: "prior" }), secrets())
    const next = adapter.prepare(definition({ id: "next" }), secrets())
    await adapter.replaceRuntimeProviders(runtime, [prior])
    runtime.refreshes = []
    runtime.refreshResponses.push({
      aborted: false,
      errors: new Map([["next", new Error("availability failed")]]),
    })

    await assert.rejects(
      adapter.replaceRuntimeProviders(runtime, [next]),
      /availability failed/,
    )

    assert.deepEqual([...runtime.registrations.keys()], ["prior"])
    assert.deepEqual(runtime.refreshes, [
      { providers: ["prior", "next"], allowNetwork: false },
      { providers: ["prior", "next"], allowNetwork: false },
    ])
  })

  it("aggregates rollback failures and retains ownership only for restored providers", async () => {
    const adapter = new PiCustomProviderAdapter()
    const runtime = new FakeRuntime()
    const first = adapter.prepare(definition({ id: "first" }), secrets())
    const second = adapter.prepare(definition({ id: "second" }), secrets())
    const next = adapter.prepare(definition({ id: "next" }), secrets())
    await adapter.replaceRuntimeProviders(runtime, [first, second])
    runtime.failures = [
      { operation: "registerNativeProvider", id: "next", phase: "after", remaining: 1 },
      { operation: "registerNativeProvider", id: "second", phase: "before", remaining: 1 },
    ]

    await assert.rejects(
      adapter.replaceRuntimeProviders(runtime, [next]),
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
    await adapter.replaceRuntimeProviders(runtime, [])
    assert.deepEqual(runtime.calls.map(([operation, id]) => [operation, id]), [
      ["unregisterProvider", "first"],
    ])
  })

  it("poisons the coordinator and reconciles every surviving adapter provider after incomplete rollback", async () => {
    const adapter = new PiCustomProviderAdapter()
    const runtime = new FakeRuntime()
    let currentSnapshot = {
      schemaVersion: 1,
      revision: 1,
      providers: [definition({ id: "prior" })],
    }
    const coordinator = new CustomProviderRuntimeCoordinator({
      store: {
        async readSnapshot() { return currentSnapshot },
        async resolveSecrets() { return secrets() },
      },
      adapter,
    })
    assert.equal(await coordinator.sync(runtime), 1)

    currentSnapshot = {
      schemaVersion: 1,
      revision: 2,
      providers: [definition({ id: "next" })],
    }
    runtime.failures = [
      { operation: "registerNativeProvider", id: "next", phase: "after", remaining: 1 },
      { operation: "unregisterProvider", id: "next", phase: "before", remaining: 1 },
    ]

    await assert.rejects(
      coordinator.sync(runtime),
      (error) => error instanceof AggregateError && error.errors.length >= 2,
    )
    assert.equal(coordinator.loadedRevision(runtime), -1)
    assert.deepEqual([...runtime.registrations.keys()], ["next", "prior"])

    runtime.failures = []
    assert.equal(await coordinator.sync(runtime), 2)
    assert.equal(coordinator.loadedRevision(runtime), 2)
    assert.deepEqual([...runtime.registrations.keys()], ["next"])
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
