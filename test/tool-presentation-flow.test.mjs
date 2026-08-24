import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { resolveAgentProfile } from "../src/agent/agent-profile.ts";
import { nativeToolPresentation, resolveToolPresentation } from "../src/agent/tool-presentation.ts";
import { getCustomTools, toolRegistry } from "../src/agent/tools/index.ts";
import { structuredToolResult } from "../src/agent/types.ts";

function tool(overrides = {}) {
  return {
    name: "native_probe",
    description: "presentation probe",
    parameters: { type: "object", properties: { value: { type: "string" } }, required: ["value"] },
    isReadOnly: true,
    resultFormat: "structured",
    execute: async (args) => structuredToolResult(`value=${args.value}`, { value: args.value }, [], { evidenceFields: ["content"] }),
    ...overrides,
  };
}

describe("AP-03 native ToolPresentation cross-layer boundary", () => {
  it("resolves only the native presentation and keeps profile projection deterministic", () => {
    assert.strictEqual(resolveToolPresentation("native"), nativeToolPresentation);
    assert.strictEqual(resolveToolPresentation(undefined), nativeToolPresentation);
    assert.throws(() => resolveToolPresentation("ptc"), /Unsupported tool presentation/);

    const standard = resolveAgentProfile("standard");
    const fact = resolveAgentProfile("fact-verification");
    assert.equal(standard.presentation, "native");
    assert.equal(fact.presentation, "native");
    assert.deepStrictEqual(
      getCustomTools("/workspace", undefined, undefined, fact).map((entry) => entry.name),
      toolRegistry.project(fact.toolNames).map((entry) => entry.name),
    );
  });

  it("presents a host tool as one native PI definition without changing execution semantics", async () => {
    const traces = [];
    const presented = nativeToolPresentation.present([tool()], { workspace: "/workspace", emitTrace: (event) => traces.push(event) });
    assert.equal(presented.length, 1);
    assert.equal(presented[0].name, "native_probe");
    assert.deepStrictEqual(presented[0].parameters.required, ["value"]);

    const result = await presented[0].execute("call-1", { value: "current" });
    assert.equal(result.content[0].text, "value=current");
    assert.deepStrictEqual(result.details.data, { value: "current" });
    assert.deepStrictEqual(traces.map((event) => event.type), ["tool_execution_start", "tool_execution_end"]);
    assert.equal(traces[1].outcome.status, "success");
  });

  it("keeps permission failure in the host pipeline and emits one terminal trace", async () => {
    const traces = [];
    const presented = nativeToolPresentation.present([tool({ name: "permission_probe", needsPermission: true })], {
      workspace: "/workspace",
      emitTrace: (event) => traces.push(event),
      extraCtx: {
        authorizeTool: async () => ({
          allow: false,
          reason: "confirmation required",
          failure: {
            code: "permission_denied",
            category: "permission",
            decision: "deny",
            message: "confirmation required",
            reason: "confirmation required",
            recoverable: true,
            suggestions: [],
          },
        }),
      },
    });

    let thrown;
    try {
      await presented[0].execute("call-2", { value: "blocked" });
    } catch (error) {
      thrown = error;
    }
    assert.match(thrown.message, /confirmation required/);
    assert.equal(thrown.metadata.permissionFailure.code, "permission_denied");
    assert.deepStrictEqual(traces.map((event) => event.type), ["tool_execution_start", "tool_execution_end"]);
    assert.equal(traces.at(-1).outcome.status, "failed");
    assert.equal(traces.at(-1).outcome.failure.kind, "execution_error");
  });
});
