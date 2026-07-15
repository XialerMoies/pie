import { describe, it } from "node:test";
import assert from "node:assert";

import { ToolRegistry } from "../src/agent/types.ts";

describe("custom tool trace emitter", () => {
  it("emits running and success events around custom tool execution", async () => {
    const registry = new ToolRegistry();
    const events = [];
    registry.register({
      name: "demo-tool",
      description: "demo",
      parameters: { type: "object", properties: {} },
      execute: async (args, ctx) => {
        assert.strictEqual(ctx.toolCallId, "call-1");
        assert.deepStrictEqual(args, { value: 1 });
        return "ok";
      },
      isReadOnly: true,
    });

    const [tool] = registry.toPITools("/repo", (event) => events.push(event));
    const result = await tool.execute("call-1", { value: 1 });

    assert.deepStrictEqual(result, { content: [{ type: "text", text: "ok" }], details: {} });
    assert.deepStrictEqual(events, [
      { type: "tool_execution_start", toolCallId: "call-1", toolName: "demo-tool", args: { value: 1 } },
      { type: "tool_execution_end", toolCallId: "call-1", toolName: "demo-tool", result: "ok", isError: false },
    ]);
  });

  it("emits error event when custom tool throws", async () => {
    const registry = new ToolRegistry();
    const events = [];
    registry.register({
      name: "failing-tool",
      description: "demo",
      parameters: { type: "object", properties: {} },
      execute: async () => {
        throw new Error("boom");
      },
      isReadOnly: true,
    });

    const [tool] = registry.toPITools("/repo", (event) => events.push(event));
    await assert.rejects(() => tool.execute("call-2", {}), /boom/);

    assert.deepStrictEqual(events, [
      { type: "tool_execution_start", toolCallId: "call-2", toolName: "failing-tool", args: {} },
      { type: "tool_execution_end", toolCallId: "call-2", toolName: "failing-tool", result: "boom", isError: true },
    ]);
  });
});
