import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { CapabilityComponentManager } from "../src/agent/capability-components.ts";
import {
  ModelRouterContractError,
  createModelRouterSession,
} from "../src/model-provider/model-router.ts";

const requiredModelRouter = {
  id: "model-router",
  version: "1",
  kind: "required",
  capability: "model-router",
  replacementGroup: "model-router",
  source: "builtin",
};

const passedPreflight = async () => ({
  isolated: true,
  staticCheck: { status: "passed" },
  replay: { status: "passed" },
  failureMatrix: { status: "passed" },
  shadow: { status: "passed" },
});

function routerProvider(name, calls) {
  return {
    kind: "model-router",
    async createSession(options) {
      calls.push({ name, options });
      let disposed = false;
      const model = { provider: name, id: `${name}-model` };
      const providerRuntime = { name };
      const modelRegistry = {
        getAvailable: () => [model],
        find: (provider, id) => provider === model.provider && id === model.id ? model : undefined,
      };
      return {
        providerRuntime,
        modelRegistry,
        async syncProviders() { return name === "v2" ? 2 : 1; },
        listModels() { return modelRegistry.getAvailable(); },
        findModel(provider, id) { return modelRegistry.find(provider, id); },
        providerAuthStatus(provider) { return { configured: provider === name, source: name }; },
        async refreshProviders() { return { errors: new Map() }; },
        dispose() { disposed = true; },
        get disposed() { return disposed; },
      };
    },
  };
}

describe("model-router Required Component flow", () => {
  it("fails closed when the active binding does not implement the host contract", async () => {
    const manager = new CapabilityComponentManager([requiredModelRouter]);
    manager.bindRequiredProvider("model-router", { kind: "not-a-router" });
    const lease = manager.acquireRequiredLease();
    await assert.rejects(
      createModelRouterSession(lease, { authFile: "auth.json", modelsFile: "models.json" }),
      (error) => error instanceof ModelRouterContractError
        && error.code === "invalid_model_router_provider",
    );
    lease.release();
  });

  it("pins old and new sessions to their model-router provider generations", async () => {
    const calls = [];
    const manager = new CapabilityComponentManager([requiredModelRouter]);
    manager.bindRequiredProvider("model-router", routerProvider("v1", calls));
    manager.register(
      { ...requiredModelRouter, id: "model-router.v2", version: "2", source: "user" },
      { trusted: true, health: "healthy" },
    );
    manager.bindRequiredProvider("model-router.v2", routerProvider("v2", calls));

    const oldLease = manager.acquireRequiredLease();
    const result = await manager.replaceRequired("model-router", "model-router.v2", {
      preflight: passedPreflight,
      verify: async () => {
        const verificationLease = manager.acquireRequiredLease();
        try {
          const session = await createModelRouterSession(verificationLease, {
            authFile: "verify-auth.json",
            modelsFile: "verify-models.json",
          });
          assert.equal(session.findModel("v2", "v2-model")?.id, "v2-model");
          session.dispose();
        } finally {
          verificationLease.release();
        }
      },
    });
    assert.equal(result.status, "committed");

    const newLease = manager.acquireRequiredLease();
    const oldSession = await createModelRouterSession(oldLease, {
      authFile: "old-auth.json",
      modelsFile: "old-models.json",
    });
    const newSession = await createModelRouterSession(newLease, {
      authFile: "new-auth.json",
      modelsFile: "new-models.json",
    });

    assert.equal(oldLease.resolve("model-router"), "model-router");
    assert.equal(newLease.resolve("model-router"), "model-router.v2");
    assert.deepEqual(oldSession.listModels().map((model) => model.provider), ["v1"]);
    assert.deepEqual(newSession.listModels().map((model) => model.provider), ["v2"]);
    assert.equal(await oldSession.syncProviders(), 1);
    assert.equal(await newSession.syncProviders(), 2);
    assert.deepEqual(calls.map((call) => call.name), ["v2", "v1", "v2"]);

    oldSession.dispose();
    newSession.dispose();
    oldLease.release();
    newLease.release();
  });

  it("rolls back a candidate that fails post-switch verification", async () => {
    const manager = new CapabilityComponentManager([requiredModelRouter]);
    manager.bindRequiredProvider("model-router", routerProvider("v1", []));
    manager.register(
      { ...requiredModelRouter, id: "model-router.bad", version: "2", source: "user" },
      { trusted: true, health: "healthy" },
    );
    manager.bindRequiredProvider("model-router.bad", routerProvider("bad", []));

    const result = await manager.replaceRequired("model-router", "model-router.bad", {
      preflight: passedPreflight,
      verify: async () => { throw new Error("model lookup probe failed"); },
    });
    assert.equal(result.status, "rolled_back");
    const lease = manager.acquireRequiredLease();
    assert.equal(lease.resolve("model-router"), "model-router");
    lease.release();
  });
});
