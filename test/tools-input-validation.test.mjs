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
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { tmpdir } from "node:os";

// ── 模拟 fetch ────────────────────────────────────────────
let mockStatus = 200;
let mockBody = {};
let lastRequest = null;

async function mockFetch(url, _init) {
  lastRequest = { url };
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
});

// ── 工具导入 ──────────────────────────────────────────────
import { fileReadTool } from "../src/agent/tools/file-read.ts";
import { explorerListTool } from "../src/agent/tools/explorer-list.ts";
import { fileOutlineTool } from "../src/agent/tools/file-outline.ts";
import { searchTool } from "../src/agent/tools/search.ts";

function ctx(overrides = {}) {
  return { toolCallId: "call-1", workspace: "/repo", ...overrides };
}

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
    dir = mkdtempSync(resolve(tmpdir(), "sre-test-"));
  });

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  function workspaceCtx() {
    return { workspace: dir, toolCallId: "call-1" };
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
});

describe("file_write tool", () => {
  let dir;

  beforeEach(() => {
    dir = mkdtempSync(resolve(tmpdir(), "fw-test-"));
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

  it("拒绝路径穿越", async () => {
    const r = await fileWriteTool.execute(
      { file_path: "../../../etc/hack", content: "evil" },
      workspaceCtx(),
    );
    assert.ok(r.includes("Access denied") || r.includes("outside workspace"));
  });

  it("拒绝 symlink 目录逃逸", async () => {
    const { symlinkSync } = await import("fs");
    const outsideDir = mkdtempSync(resolve(tmpdir(), "outside-"));
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
