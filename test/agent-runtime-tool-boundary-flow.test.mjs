import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { buildToolContextExtra } from "../src/agent/runtime-config.ts";
import { ToolRegistry } from "../src/agent/tool-registry.ts";
import { structuredToolResult, structuredToolError } from "../src/agent/tool-outcomes.ts";

describe("agent runtime/tool boundary flow", () => {
  it("forwards host capabilities through runtime config, registry, PI adapter, and trace", async () => {
    const observations = [];
    const traces = [];
    const permissionState = {
      additionalWorkingDirectories: new Map(),
      alwaysAllowRules: { session: [], workspace: [] },
      alwaysDenyRules: { session: [], workspace: [] },
      alwaysAskRules: { session: [], workspace: [] },
    };
    const extra = buildToolContextExtra({
      agentDir: "/agent",
      cwd: "/workspace",
      sessionsDir: "/sessions",
      authFile: "/auth",
      modelsFile: "/models",
      sessionPermissionState: permissionState,
      permissionMode: "standard",
      toolOutcomeObserver: (entry) => observations.push(entry),
    });
    assert.equal(extra?.permissionMode, "standard");
    assert.equal(extra?.additionalWorkingDirectories, permissionState.additionalWorkingDirectories);

    const registry = new ToolRegistry();
    registry.register({
      name: "boundary_tool",
      description: "boundary fixture",
      parameters: { type: "object", properties: {} },
      isReadOnly: true,
      resultFormat: "structured",
      execute: async () => structuredToolResult("ok", { source: "runtime" }),
    });
    const piTool = registry.toPITools("/workspace", (event) => traces.push(event), extra).at(0);
    const result = await piTool.execute("call-1", {});
    assert.equal(result.content[0].text, "ok");
    assert.deepEqual(traces.map((event) => event.type), ["tool_execution_start", "tool_execution_end"]);
    assert.equal(traces.at(-1).outcome.status, "success");
    assert.equal(observations.at(-1).complete, true);
  });

  it("keeps structured failures terminal across the extracted adapter boundary", async () => {
    const traces = [];
    const registry = new ToolRegistry();
    registry.register({
      name: "failing_boundary_tool",
      description: "failure fixture",
      parameters: { type: "object", properties: {} },
      isReadOnly: true,
      resultFormat: "structured",
      execute: async () => structuredToolError("missing", { kind: "not_found", code: "fixture_not_found" }),
    });
    const piTool = registry.toPITools("/workspace", (event) => traces.push(event)).at(0);
    const result = await piTool.execute("call-2", {});
    assert.equal(result.details.toolOutcome, "failed");
    assert.equal(traces.at(-1).isError, true);
    assert.equal(traces.at(-1).outcome.failure.kind, "not_found");
  });

  it("fails closed for string, missing-outcome, and malformed live results", async () => {
    const cases = [
      { name: "string_result", resultFormat: "structured", execute: async () => "legacy text" },
      { name: "missing_outcome", resultFormat: "structured", execute: async () => ({ text: "not evidence" }) },
      { name: "undeclared", execute: async () => structuredToolResult("should not run", null) },
    ];
    for (const fixture of cases) {
      const traces = [];
      const registry = new ToolRegistry();
      registry.register({
        name: `contract_${fixture.name}`,
        description: "contract fixture",
        parameters: { type: "object", properties: {} },
        isReadOnly: true,
        ...(fixture.resultFormat ? { resultFormat: fixture.resultFormat } : {}),
        execute: fixture.execute,
      });
      const piTool = registry.toPITools("/workspace", (event) => traces.push(event)).at(0);
      await assert.rejects(() => piTool.execute(`call-${fixture.name}`, {}), (error) => error.code === "tool_result_contract_required");
      assert.equal(traces.at(-1).outcome.failure.code, "tool_result_contract_required");
      assert.equal(traces.at(-1).isError, true);
    }
  });
});
