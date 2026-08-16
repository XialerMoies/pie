import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, it } from "node:test";

import {
  PROVIDER_PROTOCOLS,
  PROVIDER_PROTOCOL_AUTH_MODES,
  CustomProviderInvalidRequestError,
  CustomProviderValidationError,
} from "../src/model-provider/contracts.ts";
import {
  CustomProviderRevisionConflict,
  CustomProviderStore,
} from "../src/model-provider/custom-provider-store.ts";
import {
  CustomProviderIdConflict,
  CustomProviderNotFoundError,
  CustomProviderService,
} from "../src/model-provider/custom-provider-service.ts";
import {
  CustomProviderReferenceConflict,
  ProviderReferenceChecker,
} from "../src/model-provider/provider-reference-checker.ts";
import { FileProviderReferenceMutationLock } from "../src/model-provider/provider-reference-lock.ts";

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

async function fixture(options = {}) {
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
  const referenceLock = options.referenceLock ?? new FileProviderReferenceMutationLock(resolve(root, "provider-references.lock"));
  return {
    root,
    store,
    sourceState,
    syncs,
    referenceLock,
    service: new CustomProviderService({
      store,
      coordinator,
      referenceChecker: checker,
      referenceLock,
      ...(options.networkClient === undefined ? {} : { networkClient: options.networkClient }),
    }),
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

async function createAcme(env, modelRuntime = runtime()) {
  return env.service.create({ expectedRevision: 0, provider: draft() }, modelRuntime);
}

describe("custom provider service", () => {
  it("consumes project-owned mutation contracts without redeclaring them", () => {
    const root = resolve(import.meta.dirname, "..");
    const contracts = readFileSync(resolve(root, "src/model-provider/contracts.ts"), "utf8");
    const serviceSource = readFileSync(resolve(root, "src/model-provider/custom-provider-service.ts"), "utf8");
    const routeSource = readFileSync(resolve(root, "src/server/routes/settings/custom-providers.ts"), "utf8");

    assert.match(contracts, /export interface CustomProviderMutationInput\s*\{/);
    assert.match(contracts, /export interface CustomProviderDeleteInput\s*\{/);
    assert.doesNotMatch(serviceSource, /export interface CustomProvider(?:Mutation|Delete)Input\s*\{/);
    assert.match(serviceSource, /type CustomProviderMutationInput,/);
    assert.match(serviceSource, /type CustomProviderDeleteInput,/);
    const routeContractImport = routeSource.match(
      /import type \{(?<imports>[\s\S]*?)\} from "\.\.\/\.\.\/\.\.\/model-provider\/contracts\.js";/,
    );
    assert.ok(routeContractImport);
    assert.match(routeContractImport.groups.imports, /\bCustomProviderMutationInput\b/);
    assert.match(routeContractImport.groups.imports, /\bCustomProviderDeleteInput\b/);
    assert.match(routeSource, /function mutationInput\([^)]*\): CustomProviderMutationInput/);
    assert.match(routeSource, /function deleteInput\([^)]*\): CustomProviderDeleteInput/);
  });

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
      assert.equal(capabilities.protocols.some((entry) => entry.id === "google-generative-ai"), false);
    } finally {
      await env.cleanup();
    }
  });

  it("passes a relative model discovery reference through the service without persisting it", async () => {
    let received;
    const env = await fixture({
      networkClient: {
        testConnection: async () => assert.fail("connection test was not requested"),
        async discoverModels(input) {
          received = input;
          return { ids: ["relative-model"] };
        },
      },
    });
    try {
      const result = await env.service.discoverModels(draft({ modelDiscovery: "../models" }));

      assert.deepEqual(result, { ids: ["relative-model"] });
      assert.equal(received.provider.modelDiscovery, "../models");
      assert.equal((await env.store.readSnapshot()).revision, 0);
    } finally {
      await env.cleanup();
    }
  });

  it("rejects URL userinfo before service network operations or persistence", async () => {
    let networkCalls = 0;
    const env = await fixture({
      networkClient: {
        testConnection: async () => { networkCalls += 1; return { ok: false }; },
        discoverModels: async () => { networkCalls += 1; return { ids: [] }; },
      },
    });
    try {
      await assert.rejects(
        () => env.service.testConnection(draft({ baseUrl: "https://user:password@api.example.test/v1" })),
        (error) => error instanceof CustomProviderValidationError && error.fieldPath === "provider.baseUrl",
      );
      await assert.rejects(
        () => env.service.discoverModels(draft({
          modelDiscovery: "https://user:password@api.example.test/models",
        })),
        (error) => error instanceof CustomProviderValidationError && error.fieldPath === "provider.modelDiscovery",
      );
      assert.equal(networkCalls, 0);
      assert.equal((await env.store.readSnapshot()).revision, 0);
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

  it("validates direct service inputs and returns typed request and not-found errors", async () => {
    const env = await fixture();
    try {
      await assert.rejects(
        () => env.service.create({
          expectedRevision: 0,
          provider: { ...draft(), unknownSecretField: "fixture-secret" },
        }, runtime()),
        (error) => error instanceof CustomProviderValidationError
          && error.fieldPath === "provider"
          && !error.message.includes("fixture-secret"),
      );
      await assert.rejects(
        () => env.service.create({ expectedRevision: -1, provider: draft() }, runtime()),
        (error) => error instanceof CustomProviderInvalidRequestError
          && error.fieldPath === "expectedRevision",
      );
      await assert.rejects(
        () => env.service.update("missing", {
          expectedRevision: 0,
          provider: draft({ id: "missing" }),
        }, runtime()),
        (error) => error instanceof CustomProviderNotFoundError && error.providerId === "missing",
      );
      await assert.rejects(
        () => env.service.delete("missing", { expectedRevision: 0 }, runtime()),
        (error) => error instanceof CustomProviderNotFoundError && error.providerId === "missing",
      );
    } finally {
      await env.cleanup();
    }
  });

  it("keeps a cleared API-key provider redacted and unconfigured until a key is restored", async () => {
    const env = await fixture();
    try {
      const apiKeyProvider = draft({
        id: "api-key-custom",
        name: "API Key Custom",
        headers: [],
        models: [model("keyed-model", "Keyed Model")],
      });
      await env.service.create({ expectedRevision: 0, provider: apiKeyProvider }, runtime());
      const cleared = await env.service.update("api-key-custom", {
        expectedRevision: 1,
        provider: { ...apiKeyProvider, apiKey: null },
      }, runtime());
      assert.equal(cleared.providers[0].apiKeyConfigured, false);
      assert.equal((await env.service.list(runtime())).custom[0].apiKeyConfigured, false);

      const restored = await env.service.update("api-key-custom", {
        expectedRevision: 2,
        provider: { ...apiKeyProvider, apiKey: "restored-api-key" },
      }, runtime());
      assert.equal(restored.providers[0].apiKeyConfigured, true);
      assert.equal(await env.service.revealApiKey("api-key-custom"), "restored-api-key");
    } finally {
      await env.cleanup();
    }
  });

  it("rejects Google custom drafts with a typed protocol error before persistence", async () => {
    const env = await fixture();
    try {
      await assert.rejects(
        () => env.service.create({
          expectedRevision: 0,
          provider: draft({ protocol: "google-generative-ai" }),
        }, runtime()),
        (error) => error instanceof CustomProviderValidationError
          && error.fieldPath === "provider.protocol",
      );
      assert.equal((await env.store.readSnapshot()).revision, 0);
    } finally {
      await env.cleanup();
    }
  });

  it("does not reclassify a stale deleted custom runtime provider as official", async () => {
    const env = await fixture();
    try {
      const official = providerSummary("openai", "OpenAI", true);
      await createAcme(env, runtime([official]));
      const delayedRuntime = runtime([official, providerSummary("acme", "Stale Acme", true)]);
      assert.deepEqual((await env.service.list(delayedRuntime)).official.map((provider) => provider.id), ["openai"]);

      await env.service.delete("acme", { expectedRevision: 1 }, delayedRuntime);
      assert.deepEqual((await env.service.list(delayedRuntime)).official.map((provider) => provider.id), ["openai"]);

      const recreated = await env.service.create({ expectedRevision: 2, provider: draft() }, delayedRuntime);
      assert.equal(recreated.revision, 3);
      assert.equal(recreated.providers[0].id, "acme");
    } finally {
      await env.cleanup();
    }
  });

  it("remembers a preexisting custom ID when delete is the service's first snapshot mutation", async () => {
    const env = await fixture();
    try {
      await env.store.commit({
        expectedRevision: 0,
        provider: {
          id: "external-custom",
          name: "External Custom",
          protocol: "openai-completions",
          baseUrl: "https://external.example.test/v1",
          authMode: "apiKey",
          headers: [],
          models: [model()],
        },
        secretPatch: { apiKey: "external-secret", headers: [] },
      });
      const delayedRuntime = runtime([
        providerSummary("openai", "OpenAI", true),
        providerSummary("external-custom", "Stale External Custom", true),
      ]);

      await env.service.delete("external-custom", { expectedRevision: 1 }, delayedRuntime);

      assert.deepEqual((await env.service.list(delayedRuntime)).official.map((provider) => provider.id), ["openai"]);
      const recreated = await env.service.create({
        expectedRevision: 2,
        provider: draft({ id: "external-custom", name: "External Custom" }),
      }, delayedRuntime);
      assert.equal(recreated.providers[0].id, "external-custom");
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

  it("holds the shared outer reference lock through provider and model removal commits", async () => {
    for (const removal of ["provider", "model"]) {
      const root = await mkdtemp(resolve(tmpdir(), `custom-provider-${removal}-race-`));
      const baseStore = new CustomProviderStore({
        configFile: resolve(root, "custom-providers.json"),
        secretsFile: resolve(root, "custom-provider-secrets.json"),
      });
      const referenceLock = new FileProviderReferenceMutationLock(resolve(root, "provider-references.lock"));
      let reference;
      let signalCommitEntered;
      let releaseCommit;
      const commitEntered = new Promise((resolveEntered) => { signalCommitEntered = resolveEntered; });
      const commitRelease = new Promise((resolveRelease) => { releaseCommit = resolveRelease; });
      const store = {
        readSnapshot: () => baseStore.readSnapshot(),
        readRedacted: () => baseStore.readRedacted(),
        revealApiKey: (id) => baseStore.revealApiKey(id),
        async commit(mutation) {
          const destructive = mutation.removeProviderId
            || (mutation.provider && mutation.provider.models.every((candidate) => candidate.id !== "model-a"));
          if (destructive) {
            signalCommitEntered();
            await commitRelease;
          }
          return baseStore.commit(mutation);
        },
      };
      const checker = new ProviderReferenceChecker({
        currentModel: () => reference,
        defaultModel: () => undefined,
        customAgents: () => [],
      });
      const service = new CustomProviderService({
        store,
        coordinator: { sync: async () => 0 },
        referenceChecker: checker,
        referenceLock,
      });
      try {
        const provider = draft({ models: [model("model-a"), model("model-b")] });
        await service.create({ expectedRevision: 0, provider }, runtime());
        const destructiveMutation = removal === "provider"
          ? service.delete("acme", { expectedRevision: 1 }, runtime())
          : service.update("acme", {
            expectedRevision: 1,
            provider: { ...provider, models: [model("model-b")] },
          }, runtime());
        await commitEntered;

        let writerEntered = false;
        let writerCommitted = false;
        const writer = referenceLock.runExclusive(async () => {
          writerEntered = true;
          const snapshot = await baseStore.readSnapshot();
          const target = snapshot.providers.find((candidate) => candidate.id === "acme");
          if (target?.models.some((candidate) => candidate.id === "model-a")) {
            reference = { provider: "acme", id: "model-a" };
            writerCommitted = true;
          }
        });
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 20));
        assert.equal(writerEntered, false, removal);

        releaseCommit();
        await destructiveMutation;
        await writer;
        assert.equal(writerEntered, true, removal);
        assert.equal(writerCommitted, false, removal);
        assert.equal(reference, undefined, removal);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }
  });
});
