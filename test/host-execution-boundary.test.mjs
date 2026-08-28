import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { presentNativeTool } from "../src/agent/tool-presentation.ts"
import { toolRegistry } from "../src/agent/tools/index.ts"
import { HOST_EXECUTION_CHAIN } from "../src/agent/types.ts"

describe("host execution boundary", () => {
  it("injects the canonical chain and protects host-owned controls from extra context", async () => {
    let captured
    const abortController = new AbortController()
    const hostAuthorize = async () => ({ allow: true })
    const tool = {
      name: "boundary-probe",
      description: "boundary probe",
      parameters: { type: "object", properties: {} },
      isReadOnly: true,
      resultFormat: "structured",
      execute: async (_args, context) => {
        captured = context
        return { text: "ok", diagnostics: [], outcome: { status: "success" } }
      },
    }
    const definition = presentNativeTool(tool, {
      workspace: "/workspace",
      extraCtx: {
        authorizeTool: hostAuthorize,
        signal: new AbortController().signal,
        executionBoundary: { version: 999, stages: [] },
      },
    })
    const result = await definition.execute("probe", {}, abortController.signal)
    assert.equal(result.content[0].text, "ok")
    assert.equal(captured.signal, abortController.signal)
    assert.equal(captured.authorizeTool, hostAuthorize)
    assert.deepEqual(captured.executionBoundary, { version: 1, stages: HOST_EXECUTION_CHAIN })
    assert.deepEqual(captured.executionBoundary.stages, ["permission", "security", "pathGuard", "trace", "abort", "terminal"])
  })

  it("projects every registered tool through the same native execute boundary", () => {
    const tools = toolRegistry.getAll()
    assert.ok(tools.length >= 20)
    for (const tool of tools) {
      const definition = presentNativeTool(tool, { workspace: "/workspace" })
      assert.equal(typeof definition.execute, "function", tool.name)
      assert.equal(tool.resultFormat, "structured", tool.name)
    }
  })
})
