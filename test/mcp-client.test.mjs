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

// ─── MCP 工具生命周期测试 ─────────────────────────

it("bumpGeneration / currentGeneration 基本行为", async () => {
  const svc = await import("../src/agent/mcp/MCPClientService.ts");
  const g1 = svc.currentGeneration();
  svc.bumpGeneration();
  assert.ok(svc.currentGeneration() > g1, "bumpGeneration 应递增");
});

it("disconnectMcp 清空缓存", async () => {
  const tools = await import("../src/agent/tools/index.ts");
  // 主动断开一次确保状态干净
  await tools.disconnectMcp();
  const after = await tools.getCustomToolsAsync("/tmp");
  // 首次调用返回内置工具（无 MCP cache）
  const names = after.map((t) => t.name);
  assert.ok(names.includes("git-status"), "应有内置工具");
  assert.ok(!names.some((n) => n.startsWith("mcp__")), "首次调用不应有 MCP 工具");
});

it("getCustomToolsAsync 命中 _mcpCache 返回 MCP 工具", async () => {
  const tools = await import("../src/agent/tools/index.ts");
  const svc = await import("../src/agent/mcp/MCPClientService.ts");
  svc.reset();

  // 初始 cache 为空
  assert.strictEqual(tools._getMcpCacheLen(), 0, "初始 cache 应为空");

  // 注入已知 MCP cache
  const fakeTool = { name: "mcp__fake__tool", isReadOnly: true };
  tools._setMcpCache("/test-ws", [fakeTool]);

  // 同 workspace 调用：应命中 cache，返回内置 + MCP
  const result = await tools.getCustomToolsAsync("/test-ws");
  assert.ok(result.some((t) => t.name === "git-status"), "应有内置工具");
  assert.ok(result.some((t) => t.name === "mcp__fake__tool"), "应有缓存的 MCP 工具");

  // 不同 workspace：不应命中 cache
  const resultWs2 = await tools.getCustomToolsAsync("/other-ws");
  assert.ok(resultWs2.some((t) => t.name === "git-status"), "应有内置工具");
  assert.ok(!resultWs2.some((t) => t.name === "mcp__fake__tool"), "跨 workspace 不应有旧 cache");
});

it("不调 disconnectMcp 时 generation 不变（同 workspace 保留 MCP）", async () => {
  const svc = await import("../src/agent/mcp/MCPClientService.ts");
  svc.reset();

  const g1 = svc.currentGeneration();
  const tools = await import("../src/agent/tools/index.ts");

  // 同 workspace 切 session 等效于不调 disconnectMcp
  // 不调用 disconnectMcp，gen 应不变
  assert.strictEqual(svc.currentGeneration(), g1, "不调 disconnectMcp 时 gen 不变");

  // 调用 disconnectMcp（相当于 keepMcp=false 路径）：gen 应递增
  await tools.disconnectMcp();
  assert.ok(svc.currentGeneration() > g1, "disconnectMcp 后 gen 递增");
});

});