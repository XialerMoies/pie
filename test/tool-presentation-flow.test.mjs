import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { resolveAgentProfile } from "../src/agent/agent-profile.ts";
import { CapabilityComponentManager } from "../src/agent/capability-components.ts";
import { nativeToolPresentation, resolveToolPresentation } from "../src/agent/tool-presentation.ts";
import { getCustomTools, registerTool, toolRegistry } from "../src/agent/tools/index.ts";
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
    assert.equal(standard.presentation, "native");
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

  it("executes old and new sessions through their pinned required provider bindings", async () => {
    const requiredPresentation = {
      id: "tool-presentation",
      version: "1",
      kind: "required",
      capability: "tool-presentation",
      replacementGroup: "tool-presentation",
      source: "builtin",
    };
    const manager = new CapabilityComponentManager([requiredPresentation]);
    manager.bindRequiredProvider("tool-presentation", nativeToolPresentation);
    manager.register({ ...requiredPresentation, id: "tool-presentation.v2", version: "2", source: "user" }, { trusted: true, health: "healthy" });

    let v2Presentations = 0;
    const v2Presentation = {
      mode: "native",
      present(tools, request) {
        v2Presentations += 1;
        return nativeToolPresentation.present(tools, request).map((definition) => ({
          ...definition,
          description: `[v2] ${definition.description}`,
          execute: async () => { throw new Error("replacement execute must not own the host pipeline"); },
        }));
      },
    };
    manager.bindRequiredProvider("tool-presentation.v2", v2Presentation);
    const oldLease = manager.acquireRequiredLease();
    await manager.replaceRequired("tool-presentation", "tool-presentation.v2", {
      preflight: async () => ({
        isolated: true,
        staticCheck: { status: "passed" },
        replay: { status: "passed" },
        failureMatrix: { status: "passed" },
        shadow: { status: "passed" },
      }),
      verify: async () => {
        const verificationLease = manager.acquireRequiredLease();
        try {
          const profile = resolveAgentProfile("standard");
          getCustomTools("/workspace", undefined, undefined, profile, verificationLease);
        } finally {
          verificationLease.release();
        }
      },
    });
    const newLease = manager.acquireRequiredLease();

    registerTool(tool({ name: "required_binding_probe" }));
    const profile = resolveAgentProfile("standard");
    const oldTool = getCustomTools("/workspace", undefined, undefined, profile, oldLease).find((entry) => entry.name === "required_binding_probe");
    const newTool = getCustomTools("/workspace", undefined, undefined, profile, newLease).find((entry) => entry.name === "required_binding_probe");
    assert.ok(oldTool && newTool);
    assert.equal(oldTool.description, "presentation probe");
    assert.equal(newTool.description, "[v2] presentation probe");

    const oldResult = await oldTool.execute("old-binding-call", { value: "old" });
    const newResult = await newTool.execute("new-binding-call", { value: "new" });
    assert.equal(oldResult.content[0].text, "value=old");
    assert.equal(newResult.content[0].text, "value=new");
    assert.equal(v2Presentations, 2, "verification and new-session assembly must use the candidate provider");
    assert.equal(oldLease.resolve("tool-presentation"), "tool-presentation");
    assert.equal(newLease.resolve("tool-presentation"), "tool-presentation.v2");
    oldLease.release();
    newLease.release();
  });
});
