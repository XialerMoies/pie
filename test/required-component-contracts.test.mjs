import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  assertRequiredProviderContract,
  createPermissionEvaluatorProvider,
} from "../src/agent/capability-contracts.ts";
import { CapabilityComponentManager } from "../src/agent/capability-components.ts";
import { securityParserProvider } from "../src/agent/tools/command/security-parser.ts";
import { mcpHostIntegrationProvider } from "../src/agent/mcp/MCPClientService.ts";
import { piSessionStoreProvider } from "../src/agent-engine/pi-required-components.ts";

const manifest = (id, capability, replacementGroup = capability) => ({
  id,
  version: "1",
  kind: "required",
  capability,
  replacementGroup,
  source: "builtin",
});

describe("Required Component host contracts", () => {
  it("rejects an incomplete provider before it can be bound", () => {
    assert.throws(
      () => assertRequiredProviderContract("security-parser", { kind: "security-parser" }),
      /missing parse\(\)/,
    );
  });

  it("accepts the existing parser, MCP host, and PI session adapters", () => {
    assert.doesNotThrow(() => assertRequiredProviderContract("security-parser", securityParserProvider));
    assert.doesNotThrow(() => assertRequiredProviderContract("mcp-host-integration", mcpHostIntegrationProvider));
    assert.doesNotThrow(() => assertRequiredProviderContract("session-store", piSessionStoreProvider));
  });

  it("keeps permission implementation details behind a narrow adapter", async () => {
    const calls = [];
    const service = {
      authorizeTool: async (request) => { calls.push(["tool", request.toolName]); return { allow: true }; },
      authorizePath: async (root, target) => ({ root, path: target, relativePath: target }),
      authorizePathSync: (root, target) => ({ root, path: target, relativePath: target }),
      authorizeWorkspaceRoot: async (workspace) => workspace,
      getAuditTrail: () => [{ leaked: false }],
    };
    const provider = createPermissionEvaluatorProvider(service);
    const manager = new CapabilityComponentManager([manifest("permission-evaluator", "permission", "permission")]);
    manager.bindRequiredProvider("permission-evaluator", provider);
    assert.deepEqual(await provider.authorizeTool({ toolName: "search" }), { allow: true });
    assert.deepEqual(calls, [["tool", "search"]]);
    assert.equal(provider.getAuditTrail, undefined);
    assert.equal(manager.acquireRequiredLease().resolveBinding("permission").implementation.kind, "permission-evaluator");
  });
});
