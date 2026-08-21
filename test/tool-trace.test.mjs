import { describe, it } from "node:test";
import assert from "node:assert";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { ToolRegistry, structuredToolError } from "../src/agent/types.ts";
import { ToolOutcomeMetrics, createToolOutcomeObserver } from "../src/server/observability.ts";

const toolsRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "agent", "tools");

describe("custom tool trace emitter", () => {
  it("requires built-in tools that use structured helpers to declare the structured result format", () => {
    const untyped = readdirSync(toolsRoot, { recursive: true })
      .filter((entry) => typeof entry === "string" && /\.ts$/u.test(entry))
      .map((entry) => join(toolsRoot, entry))
      .filter((file) => /structuredTool(?:Result|Error)/u.test(readFileSync(file, "utf8")))
      .filter((file) => !/resultFormat\s*:\s*["']structured["']/u.test(readFileSync(file, "utf8")));
    assert.deepEqual(untyped, [], `structured built-in tools must declare resultFormat: ${untyped.join(", ")}`);
  });

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
      { type: "tool_execution_end", toolCallId: "call-1", toolName: "demo-tool", result: "ok", outcome: { status: "success" }, legacy: true, isError: false },
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
      {
        type: "tool_execution_end", toolCallId: "call-2", toolName: "failing-tool", result: "boom",
        outcome: { status: "failed", failure: { kind: "execution_error", code: "tool_execution_failed", message: "boom" } },
        isError: true,
      },
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
      { type: "tool_execution_end", toolCallId: "call-3", toolName: "stream-tool", result: "done", outcome: { status: "success" }, legacy: true, isError: false },
    ]);
  });

  it("commandTool execute invokes onUpdate with stdout chunks", async () => {
    const { commandTool } = await import("../src/agent/tools/command.ts");
    const chunks = [];
    const result = await commandTool.execute(
      { command: "echo hello-stream" },
      { cwd: process.cwd(), sessionId: "", onUpdate: (chunk) => chunks.push(chunk) },
    );
    assert.ok(result.text.includes("hello-stream"), "result 应包含命令输出");
    assert.ok(chunks.length > 0, "onUpdate 应被调用");
    assert.ok(chunks.some((c) => c.includes("hello-stream")), "chunks 应包含实际输出");
  });

  it("records legacy and structured outcomes at the single PI adapter boundary", async () => {
    const registry = new ToolRegistry();
    const metrics = new ToolOutcomeMetrics();
    const observations = [];
    const observer = (observation) => { observations.push(observation); createToolOutcomeObserver(metrics)(observation); };
    registry.register({
      name: "legacy-tool",
      description: "legacy fixture",
      parameters: { type: "object", properties: {} },
      execute: async () => "legacy result",
      isReadOnly: true,
    });
    registry.register({
      name: "structured-tool",
      description: "structured fixture",
      parameters: { type: "object", properties: {} },
      execute: async () => structuredToolError("missing", { kind: "not_found", code: "missing_resource" }),
      isReadOnly: true,
      resultFormat: "structured",
    });
    const tools = registry.toPITools("/repo", undefined, { toolOutcomeObserver: observer, toolOutcomeSource: "test" });
    await tools[0].execute("legacy-call", {});
    await tools[1].execute("structured-call", {});
    assert.equal(observations.length, 2);
    assert.deepEqual(observations.map((entry) => ({ source: entry.source, toolName: entry.toolName, outcome: entry.outcome, legacy: entry.legacy, legacyReason: entry.legacyReason })), [
      { source: "test", toolName: "legacy-tool", outcome: "success", legacy: true, legacyReason: "string_result" },
      { source: "test", toolName: "structured-tool", outcome: "failed", legacy: false, legacyReason: undefined },
    ]);
    assert.deepEqual(metrics.snapshot().bySource.test, { total: 2, structured: 1, legacy: 1, missingOutcome: 0, invalidOutcome: 0, failures: 1 });
  });

  it("normalizes structured results through ToolRegistry", async () => {
    const registry = new ToolRegistry();
    const events = [];
    registry.register({
      name: "structured-tool",
      description: "demo",
      parameters: { type: "object", properties: {} },
      execute: async () => ({ text: "ok", metadata: { rows: 3 } }),
      isReadOnly: true,
    });

    const [tool] = registry.toPITools("/repo", (event) => events.push(event));
    const result = await tool.execute("call-structured", {});

    assert.deepStrictEqual(result, {
      content: [{ type: "text", text: "ok" }],
      details: { rows: 3 },
    });
    assert.deepStrictEqual(events.at(-1), {
      type: "tool_execution_end",
      toolCallId: "call-structured",
      toolName: "structured-tool",
      result: "ok",
      metadata: { rows: 3 },
      outcome: { status: "success" },
      legacy: true,
      isError: false,
    });
  });

  it("emits an explicit failure outcome for structured tool errors", async () => {
    const registry = new ToolRegistry();
    const events = [];
    registry.register({
      name: "missing-tool",
      description: "demo",
      parameters: { type: "object", properties: {} },
      execute: async () => structuredToolError("missing", {
        kind: "not_found",
        code: "resource_not_found",
        details: { path: "/missing" },
      }),
      isReadOnly: true,
      resultFormat: "structured",
    });

    const [tool] = registry.toPITools("/repo", (event) => events.push(event));
    const result = await tool.execute("call-missing", {});

    assert.equal(result.content[0].text, "missing");
    assert.equal(result.details.data, null);
    assert.deepEqual(result.details.diagnostics, [{
      code: "resource_not_found",
      severity: "error",
      message: "missing",
      details: { path: "/missing" },
    }]);
    const end = events.at(-1);
    assert.equal(end.type, "tool_execution_end");
    assert.equal(end.toolCallId, "call-missing");
    assert.equal(end.toolName, "missing-tool");
    assert.equal(end.result, "missing");
    assert.equal(end.isError, true);
    assert.deepEqual(end.outcome, {
      status: "failed",
      failure: {
        kind: "not_found",
        code: "resource_not_found",
        message: "missing",
        details: { path: "/missing" },
      },
    });
  });

  it("classifies representative HTTP, transport, and cancellation failures", () => {
    const cases = [
      ["file_read_failed", { status: 404 }, "not_found"],
      ["explorer_failed", { status: 403 }, "permission_denied"],
      ["web_fetch_failed", { cause: "fetch failed" }, "transport_error"],
      ["tool_cancelled", { reason: "aborted" }, "cancelled"],
    ];
    for (const [code, details, kind] of cases) {
      const result = structuredToolError("failure", code, details);
      assert.equal(result.outcome.status, "failed");
      assert.equal(result.outcome.failure.kind, kind);
      assert.equal(result.outcome.failure.code, code);
    }
  });

  it("fails closed when a tool supplies a malformed outcome envelope", async () => {
    const registry = new ToolRegistry();
    const events = [];
    registry.register({
      name: "malformed-tool",
      description: "demo",
      parameters: { type: "object", properties: {} },
      execute: async () => ({ text: "not evidence", outcome: { status: "failed", failure: { kind: "unknown" } } }),
      isReadOnly: true,
      resultFormat: "structured",
    });
    const [tool] = registry.toPITools("/repo", (event) => events.push(event));
    await tool.execute("call-malformed", {});
    assert.deepEqual(events.at(-1).outcome, {
      status: "failed",
      failure: {
        kind: "validation_error",
        code: "invalid_tool_outcome",
        message: "Tool returned an invalid outcome envelope",
      },
    });
    assert.equal(events.at(-1).isError, true);
  });

  it("propagates one structured authorization decision into details and trace", async () => {
    const registry = new ToolRegistry();
    const events = [];
    const decision = {
      status: "allow",
      source: "rule",
      scope: "session",
      reason: "allowed by test rule",
    };
    registry.register({
      name: "authorized-tool",
      description: "demo",
      parameters: { type: "object", properties: {} },
      execute: async (_args, ctx) => {
        assert.deepStrictEqual(ctx.authorizationDecision, decision);
        return { text: "ok", metadata: { authorization: ctx.authorizationDecision } };
      },
      isReadOnly: true,
      needsPermission: true,
    });

    const [tool] = registry.toPITools("/repo", (event) => events.push(event), {
      authorizeTool: async () => ({ allow: true, decision }),
    });
    const result = await tool.execute("call-authorized", {});

    assert.deepStrictEqual(result.details.authorization, decision);
    assert.deepStrictEqual(events.at(-1).metadata.authorization, decision);
  });

  it("records the command specialized policy outcome in the shared decision", async () => {
    const { commandTool } = await import("../src/agent/tools/command.ts");
    const result = await commandTool.execute(
      { command: "echo structured-command", readOnly: true },
      { cwd: process.cwd(), sessionId: "", permissionMode: "default" },
    );

    assert.strictEqual(result.metadata.authorization.status, "allow");
    assert.strictEqual(result.metadata.authorization.source, "specialized");
    assert.strictEqual(result.metadata.authorization.specialized.status, "allow");
  });

  it("commandTool emits waiting status and returns approval once", async () => {
    const { commandTool } = await import("../src/agent/tools/command.ts");
    const chunks = [];
    const result = await commandTool.execute(
      { command: "node --version" },
      {
        cwd: process.cwd(),
        sessionId: "",
        permissionMode: "default",
        confirmCommand: async () => true,
        onUpdate: (chunk) => chunks.push(chunk),
      },
    );
    const joined = chunks.join("");
    assert.ok(result.text.length > 0, "confirmed command should execute");
    assert.ok(result.text.includes("用户已允许命令执行"), "final result should show approval");
    assert.strictEqual(
      (result.text.match(/用户已允许命令执行/g) || []).length,
      1,
      "final result should show approval once",
    );
    assert.ok(joined.includes("等待用户确认命令执行"), "trace should show waiting for confirmation");
    assert.strictEqual(
      (joined.match(/用户已允许命令执行/g) || []).length,
      0,
      "trace should not repeat the final approval status",
    );
  });

  it("commandTool preserves quoted node -e commands", async () => {
    const { commandTool } = await import("../src/agent/tools/command.ts");
    const chunks = [];
    const result = await commandTool.execute(
      { command: 'node -e "console.log(\'quoted-ok\')"' },
      { cwd: process.cwd(), sessionId: "", permissionMode: "dontAsk", onUpdate: (chunk) => chunks.push(chunk) },
    );
    assert.ok(result.text.includes("quoted-ok"), "result 应包含 node -e 输出");
    assert.ok(chunks.join("").includes("quoted-ok"), "实时输出应包含 node -e 输出");
  });

  it("commandTool decodes Windows cmd stderr without mojibake", async () => {
    if (process.platform !== "win32") return;
    const { commandTool } = await import("../src/agent/tools/command.ts");
    const chunks = [];
    const result = await commandTool.execute(
      { command: 'node -e "process.stderr.write(Buffer.from([0xce,0xc4,0xbc,0xfe]))"' },
      { cwd: process.cwd(), sessionId: "", permissionMode: "dontAsk", onUpdate: (chunk) => chunks.push(chunk) },
    );
    assert.ok(result.text.includes("文件"), "result 应正确解码 GBK/GB18030 输出");
    assert.ok(chunks.join("").includes("文件"), "实时输出也应正确解码");
    assert.ok(!result.text.includes("�"), "result 不应包含替换字符");
  });
});
