import assert from "node:assert/strict";
import { describe, it, afterEach } from "node:test";

import {
  MODEL_PROTOCOL_COMPONENT_MANIFESTS,
  modelProtocolComponent,
  modelProtocolComponentId,
  isModelProtocolEnabled,
} from "../src/model-provider/protocol-components.ts";
import { PROVIDER_PROTOCOLS } from "../src/model-provider/contracts.ts";
import { capabilityComponentManager } from "../src/agent/capability-components.ts";
import { PiCustomProviderAdapter } from "../src/model-provider/pi-custom-provider-adapter.ts";

const protocol = "openai-responses";

function definition() {
  return {
    id: "protocol-component-test",
    name: "Protocol component test",
    protocol,
    baseUrl: "https://example.test/v1",
    authMode: "none",
    headers: [],
    models: [{
      id: "test-model",
      name: "Test model",
      contextWindow: 4096,
      maxTokens: 1024,
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    }],
  };
}

describe("model protocol optional components", () => {
  afterEach(() => {
    const state = modelProtocolComponent(protocol);
    if (state && state.status !== "active") {
      try { capabilityComponentManager.trust(state.manifest.id, true); } catch {}
      try { capabilityComponentManager.setHealth(state.manifest.id, "healthy"); } catch {}
      try { capabilityComponentManager.enable(state.manifest.id); } catch {}
    }
  });

  it("registers one optional component for every supported protocol under model-router", () => {
    assert.deepEqual(MODEL_PROTOCOL_COMPONENT_MANIFESTS.map((manifest) => manifest.id), PROVIDER_PROTOCOLS.map(modelProtocolComponentId));
    for (const manifest of MODEL_PROTOCOL_COMPONENT_MANIFESTS) {
      const state = capabilityComponentManager.require(manifest.id);
      assert.equal(state.manifest.parentId, "model-router");
      assert.equal(state.manifest.capability, "model-protocol");
      assert.equal(state.status, "active");
    }
  });

  it("fails closed when a protocol adapter is disabled, without changing model data", () => {
    const id = modelProtocolComponentId(protocol);
    capabilityComponentManager.disable(id);
    assert.equal(isModelProtocolEnabled(protocol), false);
    assert.throws(() => new PiCustomProviderAdapter().prepare(definition(), { headers: {} }), /unavailable: openai-responses/);
    assert.equal(definition().protocol, protocol);
  });

  it("restores the adapter for new providers while existing runtime state remains host-owned", () => {
    const id = modelProtocolComponentId(protocol);
    capabilityComponentManager.disable(id);
    capabilityComponentManager.enable(id);
    assert.equal(isModelProtocolEnabled(protocol), true);
    assert.doesNotThrow(() => new PiCustomProviderAdapter().prepare(definition(), { headers: {} }));
  });
});

