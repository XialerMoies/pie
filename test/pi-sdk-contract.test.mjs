import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { resolve } from "node:path"
import { test } from "node:test"

import * as piAI from "@earendil-works/pi-ai"
import { InMemoryCredentialStore } from "@earendil-works/pi-ai"
import { anthropicMessagesApi } from "@earendil-works/pi-ai/api/anthropic-messages.lazy"
import { azureOpenAIResponsesApi } from "@earendil-works/pi-ai/api/azure-openai-responses.lazy"
import { googleGenerativeAIApi } from "@earendil-works/pi-ai/api/google-generative-ai.lazy"
import { mistralConversationsApi } from "@earendil-works/pi-ai/api/mistral-conversations.lazy"
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy"
import { openAIResponsesApi } from "@earendil-works/pi-ai/api/openai-responses.lazy"
import { piMessagesApi } from "@earendil-works/pi-ai/api/pi-messages.lazy"
import * as pi from "@xiamol/pi-coding-agent"

test("uses the PI 0.84 model runtime SDK contract", () => {
  assert.equal(pi.VERSION, "0.84.2-xiamol.0")

  for (const name of [
    "createAgentSession",
    "ModelRuntime",
    "ModelRegistry",
    "SessionManager",
    "DefaultResourceLoader",
    "SettingsManager",
    "calculateContextTokens",
    "estimateTokens",
  ]) {
    assert.equal(typeof pi[name], "function", `${name} must be exported`)
  }

  assert.equal("AuthStorage" in pi, false)
})

test("exposes the direct PI AI provider construction contract", () => {
  assert.equal(typeof piAI.createProvider, "function")
  assert.equal(typeof piAI.lazyApi, "function")

  for (const [name, factory] of [
    ["openAICompletionsApi", openAICompletionsApi],
    ["openAIResponsesApi", openAIResponsesApi],
    ["anthropicMessagesApi", anthropicMessagesApi],
    ["googleGenerativeAIApi", googleGenerativeAIApi],
    ["mistralConversationsApi", mistralConversationsApi],
    ["azureOpenAIResponsesApi", azureOpenAIResponsesApi],
    ["piMessagesApi", piMessagesApi],
  ]) {
    assert.equal(typeof factory, "function", `${name} must be exported`)
  }
})

test("exposes ModelRuntime provider replacement methods", () => {
  for (const name of ["registerNativeProvider", "registerProvider", "unregisterProvider"]) {
    assert.equal(typeof pi.ModelRuntime.prototype[name], "function", `${name} must exist`)
  }
})

test("keeps the official Google provider and Gemini model contract", async () => {
  const runtime = await pi.ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsPath: null,
    refreshOnCreate: false,
  })
  const google = runtime.getProvider("google")
  const model = runtime.getModel("google", "gemini-2.5-flash")

  assert.equal(google.name, "Google")
  assert.deepEqual(Object.keys(google.auth), ["apiKey"])
  assert.ok(google.getModels().some((entry) => entry.id === "gemini-2.5-flash"))
  assert.deepEqual(runtime.getProviderAuthStatus("google"), { configured: false })
  assert.equal(model.provider, "google")
  assert.equal(model.api, "google-generative-ai")
})

test("type-checks model provider production modules from the root config", async () => {
  const tsconfig = JSON.parse(await readFile(resolve("tsconfig.json"), "utf8"))
  assert.equal(tsconfig.include.includes("src/model-provider/**/*.ts"), true)
})

test("wires main and subagent sessions through ModelRuntime", async () => {
  const runtimeSource = await readFile(resolve("src/agent/runtime.ts"), "utf8")
  const subagentSource = await readFile(resolve("src/server/subagent-session.ts"), "utf8")
  const chatSource = await readFile(resolve("src/server/routes/chat.ts"), "utf8")
  const modelsSource = await readFile(resolve("src/server/routes/settings/models.ts"), "utf8")

  assert.match(runtimeSource, /ModelRuntime\.create\(/)
  assert.match(runtimeSource, /modelRuntime:\s*this\.modelRuntime/)
  assert.doesNotMatch(runtimeSource, /\bAuthStorage\b/)
  assert.match(subagentSource, /modelRuntime:\s*runtime\.modelRuntime/)
  assert.doesNotMatch(subagentSource, /authStorage:\s*runtime\.authStorage/)

  const createRuntime = runtimeSource.indexOf("ModelRuntime.create(")
  const initSync = runtimeSource.indexOf("syncModelProviders?.(this.modelRuntime)", createRuntime)
  const createRegistry = runtimeSource.indexOf("new ModelRegistry(this.modelRuntime)", createRuntime)
  const createMainSession = runtimeSource.indexOf("createAgentSession({", createRuntime)
  assert.ok(createRuntime >= 0 && initSync > createRuntime)
  assert.ok(createRegistry > initSync && createMainSession > initSync)

  const subagentSync = subagentSource.indexOf("await runtime.syncModelProvidersForSubagent()")
  assert.ok(subagentSync >= 0)
  assert.ok(subagentSource.indexOf("resolveModel(", subagentSync) > subagentSync)
  assert.ok(subagentSource.indexOf("createSession({", subagentSync) > subagentSync)

  const chatRoute = chatSource.indexOf('url === "/api/chat"')
  const chatSync = chatSource.indexOf("await runtime.syncModelProviders", chatRoute)
  const captureChatSession = chatSource.indexOf("const session = runtime.session", chatRoute)
  const prompt = chatSource.indexOf("session.prompt(", chatRoute)
  assert.ok(chatSync > chatRoute && captureChatSession > chatSync && prompt > captureChatSession)

  const listRoute = modelsSource.indexOf('url === "/api/models"')
  const listSync = modelsSource.indexOf("await runtime.syncModelProviders", listRoute)
  const listRegistry = modelsSource.indexOf("runtime.modelRegistry", listRoute)
  assert.ok(listSync > listRoute && listRegistry > listSync)

  const switchRoute = modelsSource.indexOf('url === "/api/model/switch"')
  const switchSync = modelsSource.indexOf("await runtime.syncModelProviders", switchRoute)
  const switchFind = modelsSource.indexOf(".find(provider, modelId)", switchRoute)
  assert.ok(switchSync > switchRoute && switchFind > switchSync)
})
