/**
 * Agent tool 层输入验证与错误传播测试
 *
 * 工具都是 HTTP 委托型，路径穿越已在 route 层覆盖。
 * tool 层测试的重点：
 *   1. 空/非法参数处理
 *   2. 错误状态码（403 Access denied）友好传播
 *   3. 路径特殊字符（空格、Unicode）保持原样
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { resolve } from "node:path";

// ── 模拟 fetch ────────────────────────────────────────────
let mockStatus = 200;
let mockBody = {};
let lastRequest = null;
const originalPiConfigDir = process.env.PI_CONFIG_DIR;
const originalAnthropicApiKey = process.env.ANTHROPIC_API_KEY;

function restoreEnv(name, value) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

async function mockFetch(url, init) {
  lastRequest = { url, init };
  const body = mockStatus >= 400 ? { error: mockBody.error || "mock error" } : mockBody;
  return {
    ok: mockStatus < 400,
    status: mockStatus,
    json: async () => body,
  };
}

beforeEach(() => {
  mockStatus = 200;
  mockBody = {};
  lastRequest = null;
  global.fetch = mockFetch;
  process.env.SERVER_PORT = "3099";
  setSearchBackend("auto");
});

afterEach(() => {
  restoreEnv("PI_CONFIG_DIR", originalPiConfigDir);
  restoreEnv("ANTHROPIC_API_KEY", originalAnthropicApiKey);
});

// ── 工具导入 ──────────────────────────────────────────────
import { fileReadTool } from "../src/agent/tools/file-read.ts";
import { explorerListTool } from "../src/agent/tools/explorer-list.ts";
import { fileOutlineTool } from "../src/agent/tools/file-outline.ts";
import { gitLogTool } from "../src/agent/tools/git-log.ts";
import { gitStatusTool } from "../src/agent/tools/git-status.ts";
import { searchTool } from "../src/agent/tools/search.ts";
import { setSearchBackend, webSearchTool } from "../src/agent/tools/web-search.ts";
import { toolRegistry } from "../src/agent/tools/index.ts";

function ctx(overrides = {}) {
  return { toolCallId: "call-1", workspace: "/repo", ...overrides };
}

describe("builtin tool governance metadata", () => {
  const expectedMetadata = new Map([
    ["git-status", { operations: ["read"], riskLevel: "low", needsPermission: false, workspaceBounded: true }],
    ["search", { operations: ["read"], riskLevel: "low", needsPermission: false, workspaceBounded: true }],
    ["file_read", { operations: ["read"], riskLevel: "low", needsPermission: false, workspaceBounded: true }],
    ["explorer_list", { operations: ["read"], riskLevel: "low", needsPermission: false, workspaceBounded: true }],
    ["git_log", { operations: ["read"], riskLevel: "low", needsPermission: false, workspaceBounded: true }],
    ["file_outline", { operations: ["read"], riskLevel: "low", needsPermission: false, workspaceBounded: true }],
    ["web-search", { operations: ["execute"], riskLevel: "medium", needsPermission: false, workspaceBounded: false }],
    ["web-fetch", { operations: ["execute"], riskLevel: "medium", needsPermission: false, workspaceBounded: false }],
    ["command", { operations: ["execute"], riskLevel: "high", needsPermission: false, workspaceBounded: false, authorizationMode: "specialized" }],
    ["write_agent_md", { operations: ["create", "write"], riskLevel: "medium", needsPermission: false, workspaceBounded: true }],
    ["read_memory", { operations: ["read"], riskLevel: "low", needsPermission: false, workspaceBounded: false }],
    ["write_memory", { operations: ["read", "create", "write"], riskLevel: "medium", needsPermission: false, workspaceBounded: false }],
    ["str_replace_editor", { operations: ["read", "create", "write"], riskLevel: "high", needsPermission: false, workspaceBounded: true }],
    ["file_write", { operations: ["create", "write"], riskLevel: "high", needsPermission: false, workspaceBounded: true }],
  ]);

  it("every registered builtin tool declares the permission contract fields", () => {
    const validOperations = new Set(["read", "write", "create", "remove", "execute"]);
    const validRiskLevels = new Set(["low", "medium", "high"]);

    for (const tool of toolRegistry.getAll()) {
      assert.ok(Array.isArray(tool.operations), `${tool.name} should declare operations`);
      assert.ok(tool.operations.length > 0, `${tool.name} should declare at least one operation`);
      for (const operation of tool.operations) {
        assert.ok(validOperations.has(operation), `${tool.name} declares unknown operation: ${operation}`);
      }
      assert.ok(validRiskLevels.has(tool.riskLevel), `${tool.name} should declare riskLevel`);
      assert.strictEqual(typeof tool.needsPermission, "boolean", `${tool.name} should declare needsPermission`);
      assert.strictEqual(typeof tool.workspaceBounded, "boolean", `${tool.name} should declare workspaceBounded`);
    }
  });

  it("tracks the expected operations and risk for registered builtin tools", () => {
    const toolsByName = new Map(toolRegistry.getAll().map((tool) => [tool.name, tool]));

    for (const [name, expected] of expectedMetadata) {
      const tool = toolsByName.get(name);
      assert.ok(tool, `${name} should be registered`);
      assert.deepStrictEqual(tool.operations, expected.operations, `${name} operations drifted`);
      assert.strictEqual(tool.riskLevel, expected.riskLevel, `${name} riskLevel drifted`);
      assert.strictEqual(tool.needsPermission, expected.needsPermission, `${name} needsPermission drifted`);
      assert.strictEqual(tool.workspaceBounded, expected.workspaceBounded, `${name} workspaceBounded drifted`);
      if (expected.authorizationMode) {
        assert.strictEqual(tool.authorizationMode, expected.authorizationMode, `${name} authorizationMode drifted`);
      }
    }
  });
});

describe("tool execution authorization gateway", () => {
  it("direct local API tool calls use the same authorizer as registry calls", async () => {
    const cases = [
      [gitStatusTool, {}],
      [searchTool, { query: "needle" }],
      [fileReadTool, { path: "src/index.ts" }],
      [explorerListTool, { path: "." }],
      [gitLogTool, {}],
      [fileOutlineTool, { path: "src/index.ts" }],
    ];
    const authorized = [];
    const authorizeTool = async (request) => {
      authorized.push(request.toolName);
      return { allow: true };
    };

    for (const [tool, args] of cases) {
      try {
        await tool.execute(args, ctx({ authorizeTool }));
      } catch {
        // The mock response is intentionally minimal; authorization is the assertion here.
      }
    }

    assert.deepStrictEqual(new Set(authorized), new Set(cases.map(([tool]) => tool.name)));

    const registryTool = toolRegistry.get("file_read");
    assert.ok(registryTool);
    let registryCalls = 0;
    try {
      await registryTool.execute({ path: "src/index.ts" }, ctx({
        authorizeTool: async () => {
          registryCalls++;
          return { allow: true };
        },
      }));
    } catch {}
    assert.strictEqual(registryCalls, 1);
  });

  it("denied direct tool calls stop before the local API", async () => {
    let fetchCalls = 0;
    global.fetch = async () => {
      fetchCalls++;
      throw new Error("fetch should not run");
    };

    await assert.rejects(
      () => fileReadTool.execute({ path: "secret.txt" }, ctx({
        authorizeTool: async () => ({ allow: false, reason: "denied by test" }),
      })),
      /denied by test/,
    );
    assert.strictEqual(fetchCalls, 0);
  });
});

describe("file_read tool", () => {
  it("空路径返回友好提示", async () => {
    const r = await fileReadTool.execute({ path: "" }, ctx());
    assert.ok(r.includes("不能为空"));
  });

  it("undefined path 返回友好提示", async () => {
    const r = await fileReadTool.execute({}, ctx());
    assert.ok(r.includes("不能为空"));
  });

  it("Access denied 映射为无权限提示", async () => {
    mockStatus = 403;
    mockBody = { error: "Access denied" };
    const r = await fileReadTool.execute({ path: "../secret.txt" }, ctx());
    assert.ok(r.includes("无权限"));
    assert.ok(r.includes("../secret.txt"));
  });

  it("路径含空格和特殊字符保持原样", async () => {
    mockBody = { content: "ok", size: 10, mtime: "2026-01-01T00:00:00.000Z" };
    const r = await fileReadTool.execute({ path: "my file (1).ts" }, ctx());
    // URLSearchParams 编码：空格→+, 括号→%28%29
    assert.ok(lastRequest?.url.includes("path=my+file+%281%29.ts") || lastRequest?.url.includes("path=my%20file%20(1).ts"), "路径特殊字符经 URL 编码");
    assert.ok(r.includes("ok"));
  });

  it("startLine 负值向下取整到 1", async () => {
    mockBody = { content: "line1\nline2\nline3", size: 15 };
    const r = await fileReadTool.execute({ path: "f.ts", startLine: -5 }, ctx());
    assert.ok(lastRequest?.url.includes("path=f.ts"));
    assert.ok(r.includes("line1"));
  });
});

describe("file_read tool local API security", () => {
  it("desktop API token is forwarded as a local API header", async () => {
    mockBody = { content: "ok", size: 10, mtime: "2026-01-01T00:00:00.000Z" };
    await fileReadTool.execute({ path: "secure.txt" }, ctx({ desktopApiToken: "tool-token" }));
    assert.strictEqual(lastRequest?.init?.headers?.["X-My-Code-Agent-Token"], "tool-token");
  });
});

describe("explorer_list tool", () => {
  it("空路径列出根目录", async () => {
    mockBody = { items: [{ path: "src", isDir: true }] };
    const r = await explorerListTool.execute({}, ctx());
    assert.ok(r.includes("src"));
    assert.ok(lastRequest?.url.includes("/api/explorer"));
  });

  it("filter 默认开启", async () => {
    mockBody = { items: [] };
    await explorerListTool.execute({ path: "src" }, ctx());
    assert.ok(lastRequest?.url.includes("filter=1"), "filter 默认开启");
  });

  it("filter=false 不传 filter 参数", async () => {
    mockBody = { items: [{ path: "a", isDir: false, size: 10 }] };
    await explorerListTool.execute({ path: "src", filter: false }, ctx());
    assert.ok(!lastRequest?.url.includes("filter"), "filter=false 时无 filter 参数");
  });

  it("API 错误返回友好提示", async () => {
    mockStatus = 500;
    mockBody = { error: "internal error" };
    const r = await explorerListTool.execute({}, ctx());
    assert.ok(r.includes("列出目录失败"), "错误友好提示");
  });
});

describe("search tool", () => {
  it("空查询返回友好提示", async () => {
    const r = await searchTool.execute({ query: "" }, ctx());
    assert.ok(r.includes("不能为空"));
  });

  it("undefined query 返回友好提示", async () => {
    const r = await searchTool.execute({}, ctx());
    assert.ok(r.includes("不能为空"));
  });

  it("搜索模式默认 text", async () => {
    mockBody = { results: [] };
    await searchTool.execute({ query: "foo" }, ctx());
    assert.ok(lastRequest?.url.includes("type=text"), "默认 text 模式");
  });

  it("maxResults 被限制在 1~100", async () => {
    mockBody = { results: [] };
    await searchTool.execute({ query: "foo", maxResults: 999 }, ctx());
    assert.ok(lastRequest?.url.includes("maxResults=100"), "超出上限被截断");
    await searchTool.execute({ query: "foo", maxResults: -1 }, ctx());
    assert.ok(lastRequest?.url.includes("maxResults=1"), "低于下限被截断");
  });

  it("搜索结果按代码/文档/其他分组", async () => {
    mockBody = {
      results: [
        { file: "a.ts", matches: [{ line: 1, column: 1, text: "x" }] },
        { file: "b.md", matches: [{ line: 2, column: 1, text: "y" }] },
        { file: "c.csv", matches: [{ line: 3, column: 1, text: "z" }] },
      ],
    };
    const r = await searchTool.execute({ query: "test" }, ctx());
    assert.ok(r.includes("[代码"), "代码分组");
    assert.ok(r.includes("[文档/配置"), "文档分组");
    assert.ok(r.includes("[其他"), "其他分组");
  });
});

describe("web-search tool", () => {
  it("authorizes provider auth config reads through the shared path hook", async () => {
    const tmp = mkdtempSync(resolve(process.cwd(), ".tmp-web-search-auth-"));
    try {
      const configDir = resolve(tmp, "pi");
      mkdirSync(configDir, { recursive: true });
      writeFileSync(resolve(configDir, "auth.json"), JSON.stringify({
        deepseek: { apiKey: "sk-test-web-search" },
      }));
      process.env.PI_CONFIG_DIR = configDir;
      mockBody = {
        content: [
          {
            type: "text",
            text: "provider result",
          },
        ],
      };
      setSearchBackend("provider");
      const calls = [];
      const ctxForAuth = {
        toolCallId: "call-1",
        workspace: tmp,
        authorizePath: async (root, target, operation, source) => {
          calls.push({ root, target, operation, source });
          return { operation, root, path: target, relativePath: target };
        },
      };

      const result = await webSearchTool.execute({ query: "codex" }, ctxForAuth);

      assert.ok(result.includes("provider result"));
      assert.deepStrictEqual(calls.map((call) => [call.operation, call.source]), [
        ["read", "agent.web_search.auth"],
      ]);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("does not call the provider when auth config read is denied", async () => {
    const tmp = mkdtempSync(resolve(process.cwd(), ".tmp-web-search-auth-deny-"));
    try {
      const configDir = resolve(tmp, "pi");
      mkdirSync(configDir, { recursive: true });
      writeFileSync(resolve(configDir, "auth.json"), JSON.stringify({
        deepseek: { apiKey: "sk-denied-web-search" },
      }));
      process.env.PI_CONFIG_DIR = configDir;
      mockBody = {
        content: [
          {
            type: "text",
            text: "provider result",
          },
        ],
      };
      setSearchBackend("provider");

      const result = await webSearchTool.execute({ query: "codex" }, {
        toolCallId: "call-1",
        workspace: tmp,
        authorizePath: async () => {
          throw new Error("permission denied for web-search auth");
        },
      });

      assert.ok(result.includes("permission denied for web-search auth"));
      assert.strictEqual(lastRequest, null);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("file_outline tool", () => {
  it("空路径返回友好提示", async () => {
    const r = await fileOutlineTool.execute({ path: "" }, ctx());
    assert.ok(r.includes("不能为空"));
  });

  it("Access denied 映射为无权限提示", async () => {
    mockStatus = 403;
    mockBody = { error: "Access denied" };
    const r = await fileOutlineTool.execute({ path: "../secret.ts" }, ctx());
    assert.ok(r.includes("无权限"));
  });
});

// ── 新工具导入 ───────────────────────────────────────────
import { strReplaceEditorTool } from "../src/agent/tools/str-replace-editor.ts";
import { fileWriteTool } from "../src/agent/tools/file-write.ts";

describe("str_replace_editor tool", () => {
  let dir;

  beforeEach(() => {
    dir = mkdtempSync(resolve(process.cwd(), ".tmp-sre-test-"));
  });

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  function workspaceCtx() {
    return { workspace: dir, toolCallId: "call-1" };
  }

  function authorizedWorkspaceCtx(calls, authorizePath) {
    return {
      workspace: dir,
      toolCallId: "call-1",
      authorizePath: authorizePath || (async (root, target, operation, source) => {
        calls.push({ root, target, operation, source });
        return { operation, root, path: target, relativePath: target };
      }),
    };
  }

  it("找不到 old_string 返回友好提示", async () => {
    writeFileSync(resolve(dir, "test.txt"), "hello world", "utf-8");
    const r = await strReplaceEditorTool.execute(
      { file_path: "test.txt", old_string: "notfound", new_string: "replaced" },
      workspaceCtx(),
    );
    assert.ok(r.includes("未找到匹配文本"));
  });

  it("old_string === new_string 拒绝", async () => {
    writeFileSync(resolve(dir, "test.txt"), "hello", "utf-8");
    const r = await strReplaceEditorTool.execute(
      { file_path: "test.txt", old_string: "hello", new_string: "hello" },
      workspaceCtx(),
    );
    assert.ok(r.includes("相同"));
  });

  it("成功替换并返回结果", async () => {
    writeFileSync(resolve(dir, "test.txt"), "hello world", "utf-8");
    const r = await strReplaceEditorTool.execute(
      { file_path: "test.txt", old_string: "world", new_string: "there" },
      workspaceCtx(),
    );
    assert.ok(r.includes("已替换"));
    const content = readFileSync(resolve(dir, "test.txt"), "utf-8");
    assert.strictEqual(content, "hello there");
  });

  it("existing edits go through read/write path authorization", async () => {
    const calls = [];
    writeFileSync(resolve(dir, "guarded.txt"), "hello world", "utf-8");

    const r = await strReplaceEditorTool.execute(
      { file_path: "guarded.txt", old_string: "world", new_string: "there" },
      authorizedWorkspaceCtx(calls),
    );

    assert.ok(r.length > 0);
    assert.deepStrictEqual(calls.map((call) => [call.operation, call.source]), [
      ["read", "agent.str_replace.read"],
      ["write", "agent.str_replace.write"],
    ]);
    assert.strictEqual(readFileSync(resolve(dir, "guarded.txt"), "utf-8"), "hello there");
  });

  it("replace_all 替换所有匹配", async () => {
    writeFileSync(resolve(dir, "test.txt"), "a b a b", "utf-8");
    const r = await strReplaceEditorTool.execute(
      { file_path: "test.txt", old_string: "a", new_string: "x", replace_all: true },
      workspaceCtx(),
    );
    assert.ok(r.includes("全部"));
    const content = readFileSync(resolve(dir, "test.txt"), "utf-8");
    assert.strictEqual(content, "x b x b");
  });

  it("单项 edits 遇到多处匹配且未开启 replace_all 时拒绝", async () => {
    writeFileSync(resolve(dir, "test.txt"), "a a a", "utf-8");
    const r = await strReplaceEditorTool.execute(
      { file_path: "test.txt", edits: [{ old_string: "a", new_string: "x" }] },
      workspaceCtx(),
    );
    assert.ok(r.includes("replace_all"));
    const content = readFileSync(resolve(dir, "test.txt"), "utf-8");
    assert.strictEqual(content, "a a a");
  });

  it("单项 edits 的 replace_all 回显准确计数", async () => {
    writeFileSync(resolve(dir, "test.txt"), "a a a", "utf-8");
    const r = await strReplaceEditorTool.execute(
      { file_path: "test.txt", edits: [{ old_string: "a", new_string: "x", replace_all: true }] },
      workspaceCtx(),
    );
    assert.ok(r.includes("3 处替换"));
    const content = readFileSync(resolve(dir, "test.txt"), "utf-8");
    assert.strictEqual(content, "x x x");
  });

  it("拒绝路径穿越", async () => {
    writeFileSync(resolve(dir, "test.txt"), "hello", "utf-8");
    const r = await strReplaceEditorTool.execute(
      { file_path: "../../../etc/passwd", old_string: "hello", new_string: "x" },
      workspaceCtx(),
    );
    assert.ok(r.includes("Access denied") || r.includes("outside workspace"));
  });

  it("拒绝不存在的文件", async () => {
    const r = await strReplaceEditorTool.execute(
      { file_path: "nonexistent.txt", old_string: "hello", new_string: "x" },
      workspaceCtx(),
    );
    assert.ok(r.includes("不存在"));
  });

  it("批量 edits 替换多个位置", async () => {
    writeFileSync(resolve(dir, "test.txt"), "a b c", "utf-8");
    const r = await strReplaceEditorTool.execute(
      { file_path: "test.txt", edits: [{ old_string: "a", new_string: "x" }, { old_string: "c", new_string: "z" }] },
      workspaceCtx(),
    );
    assert.ok(r.includes("已替换"));
    const content = readFileSync(resolve(dir, "test.txt"), "utf-8");
    assert.strictEqual(content, "x b z");
  });

  it("批量 edits 反向偏移正确", async () => {
    // 从后往前替换，前面的偏移不应受影响
    writeFileSync(resolve(dir, "test.txt"), "111 222 333", "utf-8");
    const r = await strReplaceEditorTool.execute(
      { file_path: "test.txt", edits: [{ old_string: "111", new_string: "aaa" }, { old_string: "333", new_string: "ccc" }] },
      workspaceCtx(),
    );
    assert.ok(r.includes("已替换"));
    const content = readFileSync(resolve(dir, "test.txt"), "utf-8");
    assert.strictEqual(content, "aaa 222 ccc");
  });

  it("old_string: '' 创建新文件", async () => {
    const r = await strReplaceEditorTool.execute(
      { file_path: "newfile.txt", old_string: "", new_string: "hello" },
      workspaceCtx(),
    );
    assert.ok(r.includes("已创建"));
    const content = readFileSync(resolve(dir, "newfile.txt"), "utf-8");
    assert.strictEqual(content, "hello");
  });

  it("new-file edits go through create path authorization", async () => {
    const calls = [];
    const r = await strReplaceEditorTool.execute(
      { file_path: "guarded-new.txt", old_string: "", new_string: "hello" },
      authorizedWorkspaceCtx(calls),
    );

    assert.ok(r.length > 0);
    assert.deepStrictEqual(calls.map((call) => [call.operation, call.source]), [
      ["create", "agent.str_replace.create"],
    ]);
    assert.strictEqual(readFileSync(resolve(dir, "guarded-new.txt"), "utf-8"), "hello");
  });

  it("反转义 <fnr> → <function_results>", async () => {
    // 反转义在 findActualString 之前执行，所以文件内容用直引号
    writeFileSync(resolve(dir, "test.txt"), "some <function_results> here", "utf-8");
    const r = await strReplaceEditorTool.execute(
      { file_path: "test.txt", old_string: "<fnr>", new_string: "<x>" },
      workspaceCtx(),
    );
    assert.ok(r.includes("已替换"));
    const content = readFileSync(resolve(dir, "test.txt"), "utf-8");
    assert.strictEqual(content, "some <x> here");
  });
});

describe("file_write tool", () => {
  let dir;

  beforeEach(() => {
    dir = mkdtempSync(resolve(process.cwd(), ".tmp-fw-test-"));
  });

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  function workspaceCtx() {
    return { workspace: dir, toolCallId: "call-1" };
  }

  it("创建新文件返回'已创建'", async () => {
    const r = await fileWriteTool.execute(
      { file_path: "new.txt", content: "hello" },
      workspaceCtx(),
    );
    assert.ok(r.includes("已创建"));
    const content = readFileSync(resolve(dir, "new.txt"), "utf-8");
    assert.strictEqual(content, "hello");
  });

  it("new files go through create path authorization", async () => {
    const calls = [];
    const ctx = {
      workspace: dir,
      toolCallId: "call-1",
      authorizePath: async (root, target, operation, source) => {
        calls.push({ root, target, operation, source });
        return { operation, root, path: target, relativePath: target };
      },
    };

    await fileWriteTool.execute({ file_path: "authorized-new.txt", content: "hello" }, ctx);

    assert.deepStrictEqual(calls.map((call) => [call.operation, call.source]), [
      ["create", "agent.file_write.create"],
    ]);
    assert.strictEqual(readFileSync(resolve(dir, "authorized-new.txt"), "utf-8"), "hello");
  });

  it("覆盖已有文件返回'已覆盖'", async () => {
    writeFileSync(resolve(dir, "exist.txt"), "old", "utf-8");
    const r = await fileWriteTool.execute(
      { file_path: "exist.txt", content: "new" },
      workspaceCtx(),
    );
    assert.ok(r.includes("已覆盖"));
    const content = readFileSync(resolve(dir, "exist.txt"), "utf-8");
    assert.strictEqual(content, "new");
  });

  it("existing files go through write path authorization", async () => {
    const calls = [];
    writeFileSync(resolve(dir, "authorized-existing.txt"), "old", "utf-8");
    const ctx = {
      workspace: dir,
      toolCallId: "call-1",
      authorizePath: async (root, target, operation, source) => {
        calls.push({ root, target, operation, source });
        return { operation, root, path: target, relativePath: target };
      },
    };

    await fileWriteTool.execute({ file_path: "authorized-existing.txt", content: "new" }, ctx);

    assert.deepStrictEqual(calls.map((call) => [call.operation, call.source]), [
      ["write", "agent.file_write.write"],
    ]);
    assert.strictEqual(readFileSync(resolve(dir, "authorized-existing.txt"), "utf-8"), "new");
  });

  it("does not write when path authorization rejects", async () => {
    const ctx = {
      workspace: dir,
      toolCallId: "call-1",
      authorizePath: async () => { throw new Error("permission denied for test"); },
    };

    const r = await fileWriteTool.execute({ file_path: "denied.txt", content: "blocked" }, ctx);

    assert.ok(r.includes("permission denied for test"));
    assert.throws(() => readFileSync(resolve(dir, "denied.txt"), "utf-8"));
  });

  it("拒绝路径穿越", async () => {
    const r = await fileWriteTool.execute(
      { file_path: "../../../etc/hack", content: "evil" },
      workspaceCtx(),
    );
    assert.ok(r.includes("Access denied") || r.includes("outside workspace"));
  });

  it("拒绝 symlink 目录逃逸", async () => {
    const { symlinkSync } = await import("fs");
    const outsideDir = mkdtempSync(resolve(process.cwd(), ".tmp-outside-test-"));
    const linkPath = resolve(dir, "escape-link");
    try {
      symlinkSync(outsideDir, linkPath, "junction");
    } catch {
      rmSync(outsideDir, { recursive: true, force: true });
      return; // 没有 symlink 权限时跳过
    }
    // 通过 symlink 目录新建文件
    const r = await fileWriteTool.execute(
      { file_path: "escape-link/evil.txt", content: "oops" },
      workspaceCtx(),
    );
    assert.ok(r.includes("Access denied") || r.includes("outside workspace"),
      "通过 symlink 写外部应被拒绝");
    rmSync(outsideDir, { recursive: true, force: true });
  });
});
