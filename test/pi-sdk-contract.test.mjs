import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { resolve } from "node:path"
import { test } from "node:test"

import * as piAI from "@earendil-works/pi-ai"
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

test("type-checks model provider production modules from the root config", async () => {
  const tsconfig = JSON.parse(await readFile(resolve("tsconfig.json"), "utf8"))
  assert.equal(tsconfig.include.includes("src/model-provider/**/*.ts"), true)
})

test("wires main and subagent sessions through ModelRuntime", async () => {
  const runtimeSource = await readFile(resolve("src/agent/runtime.ts"), "utf8")
  const subagentSource = await readFile(resolve("src/server/subagent-session.ts"), "utf8")

  assert.match(runtimeSource, /ModelRuntime\.create\(/)
  assert.match(runtimeSource, /modelRuntime:\s*this\.modelRuntime/)
  assert.doesNotMatch(runtimeSource, /\bAuthStorage\b/)
  assert.match(subagentSource, /modelRuntime:\s*runtime\.modelRuntime/)
  assert.doesNotMatch(subagentSource, /authStorage:\s*runtime\.authStorage/)
})
