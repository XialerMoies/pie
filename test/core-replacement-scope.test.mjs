import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  CapabilityComponentManager,
  REQUIRED_COMPONENT_MANIFESTS,
} from "../src/agent/capability-components.ts";
import { CORE_REPLACEMENT_GROUPS } from "../src/agent/capability-component-replacement.ts";

describe("R3 core replacement scope", () => {
  it("keeps only the three production replacement slots", () => {
    assert.deepEqual(
      REQUIRED_COMPONENT_MANIFESTS.map((manifest) => manifest.replacementGroup),
      ["agent-engine", "session-store", "model-router"],
    );
    assert.deepEqual([...CORE_REPLACEMENT_GROUPS].sort(), ["agent-engine", "model-router", "session-store"]);
  });

  it("drops removed service references when reading an old session generation", () => {
    const manager = new CapabilityComponentManager(REQUIRED_COMPONENT_MANIFESTS);
    const lease = manager.acquireRequiredLease({
      generation: 42,
      providers: { permission: "permission-evaluator", "agent-engine": "agent-engine" },
    });
    assert.deepEqual(lease.ref.providers, {
      "agent-engine": "agent-engine",
      "model-router": "model-router",
      "session-store": "session-store",
    });
    lease.release();
  });
});
