/**
 * MCP 客户端/适配器单元测试
 *
 * 测试：
 * 1. normalizeServerName — server 名规范化
 * 2. buildMcpToolName — 全限定名构造
 * 3. formatMcpContent — 响应内容格式化
 * 4. createMcpToolAdapter — 适配器工厂（schema 转换、命名）
 * 5. agentToolToPiTool — AgentTool → PI ToolDefinition 转换
 */
import { describe, it, before } from "node:test";
import assert from "node:assert";

let mod, adapter, piHelper;

before(async () => {
  adapter = await import("../src/agent/mcp/MCPToolAdapter.ts");
  piHelper = await import("../src/agent/tools/index.ts");
});

// ─── normalizeServerName ───────────────────────

describe("normalizeServerName", () => {
  it("正常名称保持不变", () => {
    assert.strictEqual(adapter.normalizeServerName("my-server"), "my_server");
    assert.strictEqual(adapter.normalizeServerName("filesystem"), "filesystem");
  });

  it("特殊字符替换为下划线", () => {
    assert.strictEqual(adapter.normalizeServerName("my server"), "my_server");
    assert.strictEqual(adapter.normalizeServerName("a.b.c"), "a_b_c");
    assert.strictEqual(adapter.normalizeServerName("foo@bar!"), "foo_bar_");
  });

  it("空字符串返回空", () => {
    assert.strictEqual(adapter.normalizeServerName(""), "");
  });
});

// ─── buildMcpToolName ─────────────────────────

describe("buildMcpToolName", () => {
  it("构造 mcp__server__tool 格式", () => {
    assert.strictEqual(
      adapter.buildMcpToolName("filesystem", "read"),
      "mcp__filesystem__read",
    );
  });

  it("server 和 tool 名中的特殊字符都被替换", () => {
    assert.strictEqual(
      adapter.buildMcpToolName("my-server", "list-files"),
      "mcp__my_server__list_files",
    );
  });
});

// ─── formatMcpContent ─────────────────────────

describe("formatMcpContent", () => {
  it("文本内容直接拼接", () => {
    const result = adapter.formatMcpContent([
      { type: "text", text: "Hello" },
      { type: "text", text: "World" },
    ]);
    assert.strictEqual(result, "Hello\nWorld");
  });

  it("空数组返回空字符串", () => {
    assert.strictEqual(adapter.formatMcpContent([]), "");
  });

  it("image 内容标记为 [Image: ...]", () => {
    const result = adapter.formatMcpContent([
      { type: "image", mimeType: "image/png" },
    ]);
    assert.ok(result.includes("[Image: image/png]"));
  });

  it("resource 内容标记为 [Resource: ...]", () => {
    const result = adapter.formatMcpContent([
      { type: "resource", uri: "file:///data.txt", text: "file content" },
    ]);
    assert.ok(result.includes("[Resource: file:///data.txt]"));
  });

  it("未知类型降级为 [<type> content]", () => {
    const result = adapter.formatMcpContent([
      { type: "unknown-type" },
    ]);
    assert.ok(result.includes("[unknown-type content]"));
  });
});

// ─── createMcpToolAdapter ─────────────────────

describe("createMcpToolAdapter", () => {
  /** 创建一个最简单的 mock client */
  function mockClient(resultText = "ok") {
    return {
      callTool: async () => ({
        content: [{ type: "text", text: resultText }],
        isError: false,
      }),
    };
  }

  it("工具名使用 mcp__server__tool 格式", () => {
    const tool = adapter.createMcpToolAdapter({
      serverName: "test-server",
      tool: { name: "greet", description: "Says hello" },
      client: mockClient(),
    });
    assert.strictEqual(tool.name, "mcp__test_server__greet");
  });

  it("description 透传", () => {
    const tool = adapter.createMcpToolAdapter({
      serverName: "s",
      tool: { name: "t", description: "my desc" },
      client: mockClient(),
    });
    assert.strictEqual(tool.description, "my desc");
  });

  it("description 缺失时空字符串", () => {
    const tool = adapter.createMcpToolAdapter({
      serverName: "s",
      tool: { name: "t" },
      client: mockClient(),
    });
    assert.strictEqual(tool.description, "");
  });

  it("parameters 转换 inputSchema", () => {
    const tool = adapter.createMcpToolAdapter({
      serverName: "s",
      tool: {
        name: "t",
        inputSchema: {
          type: "object",
          properties: { path: { type: "string" } },
          required: ["path"],
        },
      },
      client: mockClient(),
    });
    assert.deepStrictEqual(tool.parameters.properties, { path: { type: "string" } });
    assert.deepStrictEqual(tool.parameters.required, ["path"]);
  });

  it("无 inputSchema 时使用空对象", () => {
    const tool = adapter.createMcpToolAdapter({
      serverName: "s",
      tool: { name: "t" },
      client: mockClient("hello"),
    });
    assert.deepStrictEqual(tool.parameters, { type: "object", properties: {} });
  });

  it("execute 返回 client.callTool 结果文本", async () => {
    const tool = adapter.createMcpToolAdapter({
      serverName: "s",
      tool: { name: "t" },
      client: mockClient("result data"),
    });
    const text = await tool.execute({}, { cwd: "", sessionId: "" });
    assert.strictEqual(text, "result data");
  });

  it("execute 传递 arguments", async () => {
    const calls = [];
    const tool = adapter.createMcpToolAdapter({
      serverName: "s",
      tool: { name: "t" },
      client: {
        callTool: async (params) => {
          calls.push(params);
          return { content: [{ type: "text", text: "ok" }], isError: false };
        },
      },
    });
    await tool.execute({ path: "/tmp" }, { cwd: "", sessionId: "" });
    assert.strictEqual(calls.length, 1);
    assert.deepStrictEqual(calls[0].arguments, { path: "/tmp" });
  });

  it("execute 在 isError 时抛出", async () => {
    const tool = adapter.createMcpToolAdapter({
      serverName: "s",
      tool: { name: "t" },
      client: {
        callTool: async () => ({
          content: [{ type: "text", text: "error detail" }],
          isError: true,
        }),
      },
    });
    await assert.rejects(
      () => tool.execute({}, { cwd: "", sessionId: "" }),
      /error detail/,
    );
  });

  it("isConcurrencySafe 默认为 true", () => {
    const tool = adapter.createMcpToolAdapter({
      serverName: "s",
      tool: { name: "t" },
      client: mockClient(),
    });
    assert.strictEqual(tool.isConcurrencySafe, true);
  });
});

// ─── agentToolToPiTool ─────────────────────────

describe("agentToolToPiTool", () => {
  it("转换 AgentTool 为 PI ToolDefinition 格式", () => {
    const agentTool = {
      name: "mcp__test__greet",
      description: "A greeting tool",
      parameters: { type: "object", properties: { name: { type: "string" } } },
      isReadOnly: true,
      isConcurrencySafe: true,
      execute: async (args) => `Hello ${args.name}`,
    };

    const piTool = piHelper.agentToolToPiTool(agentTool);
    assert.strictEqual(piTool.name, "mcp__test__greet");
    assert.strictEqual(piTool.label, "mcp__test__greet");
    assert.strictEqual(piTool.description, "A greeting tool");
    assert.deepStrictEqual(piTool.parameters.properties, { name: { type: "string" } });
  });

  it("转换后的 execute 返回 PI 格式 { content, details }", async () => {
    const agentTool = {
      name: "t",
      description: "",
      parameters: { type: "object", properties: {} },
      isReadOnly: true,
      execute: async () => "result text",
    };
    const piTool = piHelper.agentToolToPiTool(agentTool);
    const result = await piTool.execute("call1", {});
    assert.ok(Array.isArray(result.content));
    assert.strictEqual(result.content[0].text, "result text");
  });

  it("execute 异常时透传错误", async () => {
    const agentTool = {
      name: "t",
      description: "",
      parameters: { type: "object", properties: {} },
      isReadOnly: true,
      execute: async () => { throw new Error("tool failed"); },
    };
    const piTool = piHelper.agentToolToPiTool(agentTool);
    await assert.rejects(
      () => piTool.execute("call1", {}),
      /tool failed/,
    );
  });
});
