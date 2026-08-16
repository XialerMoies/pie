import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, it } from "node:test";

import {
  PROVIDER_PROTOCOLS,
  PROVIDER_PROTOCOL_AUTH_MODES,
} from "../src/model-provider/contracts.ts";
import {
  CustomProviderRevisionConflict,
  CustomProviderStore,
} from "../src/model-provider/custom-provider-store.ts";
import {
  CustomProviderIdConflict,
  CustomProviderService,
} from "../src/model-provider/custom-provider-service.ts";
import {
  CustomProviderReferenceConflict,
  ProviderReferenceChecker,
} from "../src/model-provider/provider-reference-checker.ts";

function model(id = "model-a", name = id) {
  return {
    id,
    name,
    contextWindow: 16_384,
    maxTokens: 4_096,
    reasoning: false,
    input: ["text"],
    cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0.2 },
  };
}

function draft(overrides = {}) {
  return {
    id: "acme",
    name: "Acme",
    protocol: "openai-responses",
    baseUrl: "https://api.example.test/v1",
    authMode: "apiKey",
    apiKey: "api-secret-fixture",
    headers: [{ name: "X-Tenant", value: "header-secret-fixture" }],
    models: [model("model-a", "Model A"), model("model-b", "Model B")],
    ...overrides,
  };
}

function providerSummary(id, name = id, configured = true) {
  return {
    id,
    name,
    getModels: () => [],
    configured,
  };
}

function runtime(providers = [providerSummary("openai", "OpenAI", true)]) {
  return {
    getProviders: () => providers,
    getProviderAuthStatus: (id) => ({
      configured: providers.find((provider) => provider.id === id)?.configured ?? false,
    }),
  };
}

async function fixture() {
  const root = await mkdtemp(resolve(tmpdir(), "custom-provider-service-"));
  const store = new CustomProviderStore({
    configFile: resolve(root, "custom-providers.json"),
    secretsFile: resolve(root, "custom-provider-secrets.json"),
  });
  const sourceState = {
    current: undefined,
    default: undefined,
    agents: [],
  };
  const checker = new ProviderReferenceChecker({
    currentModel: () => sourceState.current,
    defaultModel: () => sourceState.default,
    customAgents: () => sourceState.agents,
  });
  const syncs = [];
  const coordinator = {
    async sync(modelRuntime) {
      syncs.push(modelRuntime);
      return (await store.readSnapshot()).revision;
    },
  };
  return {
    root,
    store,
    sourceState,
    syncs,
    service: new CustomProviderService({ store, coordinator, referenceChecker: checker }),
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

async function createAcme(env, modelRuntime = runtime()) {
  return env.service.create({ expectedRevision: 0, provider: draft() }, modelRuntime);
}

describe("custom provider service", () => {
  it("reports all project protocols, protocol auth modes, compatibility, and USD pricing units", async () => {
    const env = await fixture();
    try {
      const capabilities = env.service.capabilities();
      assert.deepEqual(capabilities.protocols.map((entry) => entry.id), [...PROVIDER_PROTOCOLS]);
      for (const entry of capabilities.protocols) {
        assert.deepEqual(entry.authModes, PROVIDER_PROTOCOL_AUTH_MODES[entry.id]);
        assert.equal(entry.supportsCompatibility, true);
      }
      assert.deepEqual(capabilities.price, { currency: "USD", unit: "millionTokens" });
      assert.deepEqual(
        capabilities.protocols.find((entry) => entry.id === "google-generative-ai").authModes,
        ["apiKey"],
      );
    } finally {
      await env.cleanup();
    }
  });

  it("creates, lists, updates, deletes, reveals only API keys, and syncs a model runtime", async () => {
    const env = await fixture();
    try {
      const createRuntime = runtime([
        providerSummary("openai", "OpenAI", true),
        providerSummary("local", "Local", false),
      ]);
      const syncedRuntime = runtime([
        providerSummary("openai", "OpenAI", true),
        providerSummary("acme", "Acme Runtime", true),
        providerSummary("local", "Local", false),
      ]);
      const created = await createAcme(env, createRuntime);
      assert.equal(created.revision, 1);
      assert.equal(created.providers[0].apiKeyConfigured, true);
      assert.deepEqual(created.providers[0].headers, [{ name: "X-Tenant", configured: true }]);
      assert.equal(JSON.stringify(created).includes("secret-fixture"), false);

      const listed = await env.service.list(syncedRuntime);
      assert.deepEqual(listed.official, [
        { id: "openai", name: "OpenAI", configured: true },
        { id: "local", name: "Local", configured: false },
      ]);
      assert.deepEqual(listed.custom, created.providers);
      assert.equal(listed.revision, 1);

      const updated = await env.service.update("acme", {
        expectedRevision: 1,
        provider: draft({
          name: "Acme Renamed",
          baseUrl: "https://renamed.example.test/v1",
          apiKey: undefined,
          headers: [{ name: "X-Tenant" }],
        }),
      }, syncedRuntime);
      assert.equal(updated.revision, 2);
      assert.equal(updated.providers[0].name, "Acme Renamed");
      assert.equal(await env.service.revealApiKey("acme"), "api-secret-fixture");
      assert.equal("revealHeader" in env.service, false);

      assert.equal(await env.service.syncRuntime(syncedRuntime), 2);
      assert.deepEqual(env.syncs, [syncedRuntime]);

      const deleted = await env.service.delete("acme", { expectedRevision: 2 }, syncedRuntime);
      assert.deepEqual(deleted, { schemaVersion: 1, revision: 3, providers: [] });
    } finally {
      await env.cleanup();
    }
  });

  it("rejects official collisions, duplicate custom IDs, stale revisions, and mutable update IDs", async () => {
    const env = await fixture();
    try {
      const officialRuntime = runtime([providerSummary("openai", "OpenAI")]);
      await assert.rejects(
        () => env.service.create({ expectedRevision: 0, provider: draft({ id: "openai" }) }, officialRuntime),
        (error) => error instanceof CustomProviderIdConflict && error.providerId === "openai" && error.source === "official",
      );

      await createAcme(env, officialRuntime);
      await assert.rejects(
        () => env.service.create({ expectedRevision: 1, provider: draft() }, officialRuntime),
        (error) => error instanceof CustomProviderIdConflict && error.providerId === "acme" && error.source === "custom",
      );
      await assert.rejects(
        () => env.service.update("acme", { expectedRevision: 0, provider: draft() }, officialRuntime),
        (error) => error instanceof CustomProviderRevisionConflict
          && error.expectedRevision === 0
          && error.currentRevision === 1,
      );
      await assert.rejects(
        () => env.service.update("acme", {
          expectedRevision: 1,
          provider: draft({ id: "renamed-id" }),
        }, officialRuntime),
        /provider ID is immutable/i,
      );
      assert.equal((await env.store.readSnapshot()).revision, 1);
    } finally {
      await env.cleanup();
    }
  });

  it("returns every current, default, and custom-agent reference when an update removes a model", async () => {
    const env = await fixture();
    try {
      await createAcme(env);
      env.sourceState.current = { provider: "acme", id: "model-b" };
      env.sourceState.default = { provider: "acme", id: "model-b" };
      env.sourceState.agents = [
        { id: "reviewer", name: "Reviewer", model: { provider: "acme", id: "model-b" } },
        { id: "planner", name: "Planner", model: { provider: "acme", id: "model-b" } },
        { id: "other", name: "Other", model: { provider: "openai", id: "model-b" } },
      ];

      await assert.rejects(
        () => env.service.update("acme", {
          expectedRevision: 1,
          provider: draft({ models: [model("model-a", "Model A")] }),
        }, runtime()),
        (error) => {
          assert.ok(error instanceof CustomProviderReferenceConflict);
          assert.equal(error.message, "Custom provider is still in use");
          assert.deepEqual(error.references, [
            { kind: "currentModel", providerId: "acme", modelId: "model-b" },
            { kind: "defaultModel", providerId: "acme", modelId: "model-b" },
            { kind: "customAgent", providerId: "acme", modelId: "model-b", agentId: "reviewer", agentName: "Reviewer" },
            { kind: "customAgent", providerId: "acme", modelId: "model-b", agentId: "planner", agentName: "Planner" },
          ]);
          return true;
        },
      );
      assert.equal((await env.store.readSnapshot()).revision, 1);
    } finally {
      await env.cleanup();
    }
  });

  it("allows metadata-only edits without treating unchanged models as removed", async () => {
    const env = await fixture();
    try {
      await createAcme(env);
      env.sourceState.current = { provider: "acme", id: "model-a" };
      env.sourceState.default = { provider: "acme", id: "model-b" };
      env.sourceState.agents = [
        { id: "reviewer", name: "Reviewer", model: { provider: "acme", id: "model-a" } },
      ];

      const updated = await env.service.update("acme", {
        expectedRevision: 1,
        provider: draft({
          name: "Metadata Only",
          baseUrl: "https://metadata.example.test/v1",
          apiKey: undefined,
          headers: [{ name: "X-Tenant" }],
        }),
      }, runtime());
      assert.equal(updated.revision, 2);
    } finally {
      await env.cleanup();
    }
  });

  it("returns every provider reference when deleting the provider", async () => {
    const env = await fixture();
    try {
      await createAcme(env);
      env.sourceState.current = { provider: "acme", id: "model-a" };
      env.sourceState.default = { provider: "acme", id: "model-b" };
      env.sourceState.agents = [
        { id: "reviewer", name: "Reviewer", model: { provider: "acme", id: "model-b" } },
      ];

      await assert.rejects(
        () => env.service.delete("acme", { expectedRevision: 1 }, runtime()),
        (error) => {
          assert.ok(error instanceof CustomProviderReferenceConflict);
          assert.deepEqual(error.references, [
            { kind: "currentModel", providerId: "acme", modelId: "model-a" },
            { kind: "defaultModel", providerId: "acme", modelId: "model-b" },
            { kind: "customAgent", providerId: "acme", modelId: "model-b", agentId: "reviewer", agentName: "Reviewer" },
          ]);
          return true;
        },
      );
      assert.equal((await env.store.readSnapshot()).revision, 1);
    } finally {
      await env.cleanup();
    }
  });
});
