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

  it("emits tool_execution_update when tool calls ctx.onUpdate", async () => {
    const registry = new ToolRegistry();
    const events = [];
    registry.register({
      name: "stream-tool",
      description: "demo",
      parameters: { type: "object", properties: {} },
      execute: async (args, ctx) => {
        ctx.onUpdate?.("step1\n");
        ctx.onUpdate?.("step2\n");
        return "done";
      },
      isReadOnly: true,
    });

    const [tool] = registry.toPITools("/repo", (event) => events.push(event));
    await tool.execute("call-3", {});

    assert.deepStrictEqual(events, [
      { type: "tool_execution_start", toolCallId: "call-3", toolName: "stream-tool", args: {} },
      { type: "tool_execution_update", toolCallId: "call-3", toolName: "stream-tool", partialResult: "step1\n" },
      { type: "tool_execution_update", toolCallId: "call-3", toolName: "stream-tool", partialResult: "step2\n" },
      { type: "tool_execution_end", toolCallId: "call-3", toolName: "stream-tool", result: "done", isError: false },
    ]);
  });

  it("commandTool execute invokes onUpdate with stdout chunks", async () => {
    const { commandTool } = await import("../src/agent/tools/command.ts");
    const chunks = [];
    const result = await commandTool.execute(
      { command: "echo hello-stream" },
      { cwd: process.cwd(), sessionId: "", onUpdate: (chunk) => chunks.push(chunk) },
    );
    assert.ok(result.includes("hello-stream"), "result 应包含命令输出");
    assert.ok(chunks.length > 0, "onUpdate 应被调用");
    assert.ok(chunks.some((c) => c.includes("hello-stream")), "chunks 应包含实际输出");
  });

  it("commandTool preserves quoted node -e commands", async () => {
    const { commandTool } = await import("../src/agent/tools/command.ts");
    const chunks = [];
    const result = await commandTool.execute(
      { command: 'node -e "console.log(\'quoted-ok\')"' },
      { cwd: process.cwd(), sessionId: "", onUpdate: (chunk) => chunks.push(chunk) },
    );
    assert.ok(result.includes("quoted-ok"), "result 应包含 node -e 输出");
    assert.ok(chunks.join("").includes("quoted-ok"), "实时输出应包含 node -e 输出");
  });

  it("commandTool decodes Windows cmd stderr without mojibake", async () => {
    if (process.platform !== "win32") return;
    const { commandTool } = await import("../src/agent/tools/command.ts");
    const chunks = [];
    const result = await commandTool.execute(
      { command: 'node -e "process.stderr.write(Buffer.from([0xce,0xc4,0xbc,0xfe]))"' },
      { cwd: process.cwd(), sessionId: "", onUpdate: (chunk) => chunks.push(chunk) },
    );
    assert.ok(result.includes("文件"), "result 应正确解码 GBK/GB18030 输出");
    assert.ok(chunks.join("").includes("文件"), "实时输出也应正确解码");
    assert.ok(!result.includes("�"), "result 不应包含替换字符");
  });
});