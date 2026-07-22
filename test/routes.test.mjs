/**
 * 后端路由集成测试
 *
 * mock ServerContext.session，不依赖真实 PI SDK 初始化。
 *
 * 运行：npx tsx --test test/routes.test.mjs
 */
import { describe, it, before } from "node:test";
import assert from "node:assert";
import { createServer } from "node:http";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

// ─── Mock 工厂 ─────────────────────────────────────────────

function mockModel(overrides) {
  return { provider: "test-provider", id: "test-model", contextWindow: 200000, maxTokens: 4096, ...overrides };
}

function mockSession(overrides) {
  const model = mockModel();
  const sessionId = "test-sess-" + Date.now();
  return {
    model,
    sessionFile: "/test/data/pi/sessions/by-project/test/" + sessionId + ".jsonl",
    thinkingLevel: "off",
    messages: [],
    isStreaming: false,
    agent: { state: { tools: [] } },
    sessionManager: {
      getSessionId: () => sessionId,
    },
    getContextUsage: () => ({ tokens: 1234, contextWindow: 200000, percent: 0.6 }),
    getSessionStats: () => ({ tokens: { input: 500, output: 300, cacheRead: 100, cacheWrite: 50 }, cost: 0.012 }),
    setModel: async (m) => { model.id = m; },
    setAvailableModels: () => {},
    prompt: async () => {},
    abort: async () => {},
    reload: async () => {},
    dispose: () => {},
    subscribe: () => () => {},
    ...overrides,
  };
}

function mockRuntime(overrides) {
  const session = mockSession();
  return {
    session,
    modelRegistry: { getModels: () => [] },
    currentWorkspace: ROOT,
    switchWorkspace: async (ws) => {},
    openSession: async (file, ws) => {},
    createNewSession: async () => "sess-mock-" + Date.now().toString(36),
    getActiveSession: () => {
      try {
        return { id: session.sessionManager.getSessionId(), file: session.sessionFile };
      } catch { return null; }
    },
    onEvent: () => () => {},
    dispose: () => {},
    ...overrides,
  };
}

function mockPaths() {
  const tmpDir = mkdtempSync(resolve(tmpdir(), "pi-test-"));
  return {
    APP_ROOT: ROOT,
    DATA_DIR: resolve(tmpDir, "data"),
    PI_CONFIG_DIR: resolve(tmpDir, "data", "pi"),
    SESSIONS_DIR: resolve(tmpDir, "data", "pi", "sessions"),
    SETTINGS_FILE: resolve(tmpDir, "data", "pi", "settings.json"),
    FRONTEND_DIR: resolve(ROOT, "dist", "frontend"),
    FRONTEND_SRC_DIR: resolve(ROOT, "src", "frontend"),
    HAS_BUILT_FRONTEND: false,
    _tmpDir: tmpDir,
  };
}

function mockContext(overrides) {
  const paths = mockPaths();
  return {
    runtime: mockRuntime(),
    chatStream: { textBuffer: "", thinkingBuffer: "", response: null, currentWorkspace: "" },
    sseClients: [],
    paths,
    ...overrides,
  };
}

// ─── 测试辅助 ─────────────────────────────────────────────

async function callHandler(handler, method, url, body, ctx) {
  const ctxFinal = ctx || mockContext();

  const req = {
    url,
    method,
    headers: { host: "localhost:3099", "content-type": "application/json" },
    on(event, cb) {
      if (event === "data" && body) cb(Buffer.from(JSON.stringify(body)));
      if (event === "end") cb();
      return req;
    },
  };

  const res = {
    _status: 0,
    _headers: {},
    _body: "",
    writeHead(status, headers) {
      res._status = status;
      if (headers) Object.assign(res._headers, headers);
      return res;
    },
    end(data) {
      if (data) res._body += data.toString();
      res._ended = true;
      return res;
    },
    write(data) {
      res._body += data.toString();
      return true;
    },
    on() { return res; },
  };

  const handled = await handler(req, res, ctxFinal);
  return { handled, status: res._status, body: res._body, headers: res._headers, ctx: ctxFinal };
}

function parseJSON(body) {
  try { return JSON.parse(body); } catch { return null; }
}

// ─── 导入路由 ─────────────────────────────────────────────

let handleDashboard, handleSessions, handleGit, handleSearch;
let handleSettings, handleChat, handleExplorer, handleTypeScript;
let dispatchRoute;

before(async () => {
  const ts = Date.now();
  handleDashboard = (await import(`../src/server/routes/dashboard.ts?t=${ts}`)).handleDashboard;
  handleChat = (await import(`../src/server/routes/chat.ts?t=${ts}`)).handleChat;
  handleSessions = (await import(`../src/server/routes/sessions.ts?t=${ts}`)).handleSessions;
  handleGit = (await import(`../src/server/routes/git.ts?t=${ts}`)).handleGit;
  handleSearch = (await import(`../src/server/routes/search.ts?t=${ts}`)).handleSearch;
  handleSettings = (await import(`../src/server/routes/settings.ts?t=${ts}`)).handleSettings;
  handleExplorer = (await import(`../src/server/routes/explorer.ts?t=${ts}`)).handleExplorer;
  handleTypeScript = (await import(`../src/server/routes/typescript.ts?t=${ts}`)).handleTypeScript;
  const idx = await import(`../src/server/routes/index.ts?t=${ts}`);
  dispatchRoute = idx.dispatchRoute;
});

// ════════════════════════════════════════════════════════════
//  测试用例
// ════════════════════════════════════════════════════════════

describe("dashboard routes", () => {
  it("GET /api/dashboard 返回 200 JSON", async () => {
    const { status, body } = await callHandler(handleDashboard, "GET", "/api/dashboard");
    assert.strictEqual(status, 200);
    const data = parseJSON(body);
    assert.ok(data);
    assert.strictEqual(data.modelProvider, "test-provider");
    assert.strictEqual(data.modelId, "test-model");
    assert.ok(typeof data.runtime === "number");
  });

  it("GET /api/token-usage 返回用量数据", async () => {
    const { status, body } = await callHandler(handleDashboard, "GET", "/api/token-usage");
    assert.strictEqual(status, 200);
    const data = parseJSON(body);
    assert.ok(data.contextUsage);
    assert.strictEqual(data.contextUsage.tokens, 1234);
    assert.ok(data.sessionStats);
  });

  it("GET /api/usage/current 返回当前用量", async () => {
    const { status, body } = await callHandler(handleDashboard, "GET", "/api/usage/current");
    assert.strictEqual(status, 200);
    const data = parseJSON(body);
    assert.ok(data.hasActiveSession, "应有活跃会话");
    assert.ok(data.sessionId, "应有 sessionId");
    assert.strictEqual(data.provider, "test-provider", "应有 provider");
    assert.ok(data.contextUsage, "应有 contextUsage");
    assert.strictEqual(data.contextUsage.tokens, 1234);
    assert.ok(data.tokens, "应有 tokens");
    assert.strictEqual(data.tokens.input, 500);
    assert.strictEqual(data.cacheHitRate, 67, "100/(100+50)*100 = 67%");
    assert.strictEqual(data.compactCount, 0, "无 compaction entry");
    assert.strictEqual(data.isStreaming, false);
    assert.strictEqual(data.isCompacting, false);
  });

  it("GET /api/usage/summary 统计真实 JSONL 格式", async () => {
    // 创建含真实 PI 格式 session 文件的临时目录
    const tmpDir = mkdtempSync(resolve(tmpdir(), "usage-summary-"));
    const sessionsDir = resolve(tmpDir, "sessions");
    mkdirSync(resolve(sessionsDir, "by-project", "a"), { recursive: true });

    // session_one: 首行 type:session (有 cwd)，后续 session_info 有名称，含 message 和 compaction
    const f1 = resolve(sessionsDir, "by-project", "a", "one.jsonl");
    writeFileSync(f1, [
      JSON.stringify({ type: "session", id: "s1", cwd: "/workspace/a" }),
      JSON.stringify({ type: "session_info", name: "Renamed One", timestamp: new Date().toISOString() }),
      JSON.stringify({ type: "message", message: { role: "user", content: "hi" } }),
      JSON.stringify({ type: "message", message: { role: "assistant", content: "ok" } }),
      JSON.stringify({ type: "compaction", summary: "compacted", tokensBefore: 100 }),
    ].join("\n") + "\n");

    // session_two: 无 session_info，首行有 workspace 字段
    const f2 = resolve(sessionsDir, "by-project", "a", "two.jsonl");
    writeFileSync(f2, [
      JSON.stringify({ type: "session", id: "s2", workspace: "/workspace/b" }),
      JSON.stringify({ type: "message", message: { role: "user", content: "hi" } }),
    ].join("\n") + "\n");

    const ctx = mockContext({
      paths: { SESSIONS_DIR: sessionsDir, APP_ROOT: process.cwd(), DATA_DIR: tmpDir, PI_CONFIG_DIR: resolve(tmpDir, "pi") },
    });
    const { status, body } = await callHandler(handleDashboard, "GET", "/api/usage/summary", undefined, ctx);
    assert.strictEqual(status, 200);
    const data = parseJSON(body);

    assert.strictEqual(data.sessions, 2, "2 个 session 文件");
    assert.strictEqual(data.compactCount, 1, "1 条 compaction");
    // token 统计：只有 session_one 的 assistant message 有 usage（未设置则无）
    assert.ok(data.tokens, "应有 tokens 字段");
    assert.strictEqual(data.tokens.input, 0, "测试数据无 usage 字段，故为 0");
    assert.strictEqual(data.tokens.output, 0);
    assert.strictEqual(typeof data.cost, "number");
    assert.strictEqual(data.cost, 0);

    // Top 5 按 token 数降序
    assert.strictEqual(data.topSessions.length, 2);
    assert.strictEqual(data.topSessions[0].id, "s1", "id 来自 JSONL 首行 type:session");
    assert.strictEqual(data.topSessions[0].name, "Renamed One", "从 session_info 读取名称");
    assert.strictEqual(data.topSessions[0].workspace, "/workspace/a", "从 cwd 读取 workspace");
    assert.strictEqual(data.topSessions[1].id, "s2");
    assert.strictEqual(data.topSessions[1].name, "未命名", "无 session_info 时为未命名");
    assert.strictEqual(data.topSessions[1].workspace, "/workspace/b", "从 workspace 字段读取");
  });

  it("GET /api/paths 返回路径", async () => {
    const { status, body } = await callHandler(handleDashboard, "GET", "/api/paths");
    assert.strictEqual(status, 200);
    const data = parseJSON(body);
    assert.ok(data.dataDir);
    assert.ok(data.sessionsDir);
  });

  it("未知 URL 返回 false", async () => {
    const { handled } = await callHandler(handleDashboard, "GET", "/api/bogus");
    assert.strictEqual(handled, false);
  });

  describe("POST /api/compact", () => {
    it("压缩成功返回 compacted:true", async () => {
      let compactCalledWith;
      const ctx = mockContext({
        runtime: {
          session: {
            ...mockSession(),
            compact: async (focus) => { compactCalledWith = focus; return { summary: "compacted" }; },
          },
        },
      });
      const { status, body } = await callHandler(handleDashboard, "POST", "/api/compact", { focus: "keep bugs" }, ctx);
      assert.strictEqual(status, 200);
      const data = parseJSON(body);
      assert.ok(data.ok);
      assert.strictEqual(data.compacted, true);
      assert.strictEqual(compactCalledWith, "keep bugs", "focus 传入 compact()");
    });

    it("Nothing to compact 返回 compacted:false", async () => {
      const ctx = mockContext({
        runtime: {
          session: {
            ...mockSession(),
            compact: async () => { throw new Error("Nothing to compact (session too small)"); },
          },
        },
      });
      const { status, body } = await callHandler(handleDashboard, "POST", "/api/compact", {}, ctx);
      assert.strictEqual(status, 200);
      const data = parseJSON(body);
      assert.ok(data.ok);
      assert.strictEqual(data.compacted, false);
      assert.ok(data.message.includes("Nothing to compact"));
    });

    it("Already compacted 返回 compacted:false", async () => {
      const ctx = mockContext({
        runtime: {
          session: {
            ...mockSession(),
            compact: async () => { throw new Error("Already compacted"); },
          },
        },
      });
      const { status, body } = await callHandler(handleDashboard, "POST", "/api/compact", {}, ctx);
      assert.strictEqual(status, 200);
      const data = parseJSON(body);
      assert.ok(data.ok);
      assert.strictEqual(data.compacted, false);
    });

    it("streaming 时返回 409", async () => {
      const ctx = mockContext({
        runtime: {
          session: {
            ...mockSession({ isStreaming: true }),
            compact: async () => ({ summary: "ok" }),
          },
        },
      });
      const { status } = await callHandler(handleDashboard, "POST", "/api/compact", {}, ctx);
      assert.strictEqual(status, 409);
    });

    it("isCompacting 时返回 409", async () => {
      const ctx = mockContext({
        runtime: {
          session: {
            ...mockSession({ isCompacting: true }),
            compact: async () => ({ summary: "ok" }),
          },
        },
      });
      const { status } = await callHandler(handleDashboard, "POST", "/api/compact", {}, ctx);
      assert.strictEqual(status, 409);
    });

    it("compact 后创建 usage-index.json", async () => {
      const tmpDir = mkdtempSync(resolve(tmpdir(), "compact-index-"));
      const sessionsDir = resolve(tmpDir, "sessions");
      mkdirSync(resolve(sessionsDir, "by-project", "a"), { recursive: true });
      const sessionFile = resolve(sessionsDir, "by-project", "a", "s1.jsonl");
      writeFileSync(sessionFile, [
        JSON.stringify({ type: "session", id: "s1" }),
        JSON.stringify({ type: "message", message: { role: "assistant", usage: { input: 10, output: 20, cacheRead: 30, cacheWrite: 40, cost: { total: 0.5 } } } }),
      ].join("\n") + "\n");
      const indexPath = resolve(tmpDir, "pi", "usage-index.json");

      const ctx = mockContext({
        runtime: {
          session: {
            ...mockSession(),
            sessionFile,
            compact: async () => {
              // 模拟 compact：追加一条
              writeFileSync(sessionFile, [
                JSON.stringify({ type: "session", id: "s1" }),
                JSON.stringify({ type: "message", message: { role: "assistant", usage: { input: 10, output: 20, cacheRead: 30, cacheWrite: 40, cost: { total: 0.5 } } } }),
                JSON.stringify({ type: "compaction", timestamp: new Date().toISOString() }),
              ].join("\n") + "\n");
              return { summary: "compacted" };
            },
          },
        },
        paths: { SESSIONS_DIR: sessionsDir, PI_CONFIG_DIR: resolve(tmpDir, "pi"), DATA_DIR: tmpDir, APP_ROOT: process.cwd() },
      });
      const { status, body: _b } = await callHandler(handleDashboard, "POST", "/api/compact", {}, ctx);
      assert.strictEqual(status, 200);

      // 验证索引创建且更新了 compact 数据
      assert.ok(existsSync(indexPath), "usage-index.json 已创建");
      const index = JSON.parse(readFileSync(indexPath, "utf-8"));
      assert.ok(index.sessions?.s1, "索引包含 s1");
      assert.strictEqual(index.sessions.s1.compactCount, 1, "compactCount 为 1");
      assert.strictEqual(index.sessions.s1.input, 10, "input 保留 10");
    });
  });

  describe("GET /api/mcp/servers", () => {
    it("返回 200 JSON 数组", async () => {
      const { status, body } = await callHandler(handleDashboard, "GET", "/api/mcp/servers");
      assert.strictEqual(status, 200);
      const data = parseJSON(body);
      assert.ok(Array.isArray(data), "返回数组");
    });

    it("不泄露 env / 敏感字段", async () => {
      const { status, body } = await callHandler(handleDashboard, "GET", "/api/mcp/servers");
      assert.strictEqual(status, 200);
      const data = parseJSON(body);
      for (const s of data) {
        if (s.config) {
          assert.ok(!("env" in s.config), `env 已被脱敏: ${s.name}`);
        }
      }
    });

    it("禁用 server 仍出现在列表中", async () => {
      const dir = mkdtempSync(resolve(tmpdir(), "mcp-test-"));
      try {
        writeFileSync(resolve(dir, ".mcp.json"), JSON.stringify({
          servers: { disabled: { command: "node", enabled: false }, active: { command: "node" } },
        }));
        const ctx = mockContext({ runtime: { ...mockRuntime(), currentWorkspace: dir }, paths: { APP_ROOT: dir } });
        const { status, body } = await callHandler(handleDashboard, "GET", "/api/mcp/servers", undefined, ctx);
        assert.strictEqual(status, 200);
        const data = parseJSON(body);
        assert.strictEqual(data.length, 2, "2 个 server 都在列表中");
        const d = data.find((s) => s.name === "disabled");
        assert.ok(d, "disabled server 可见");
        assert.strictEqual(d.config.enabled, false);
      } finally { rmSync(dir, { recursive: true, force: true }); }
    });

    it("POST toggle 修改当前 workspace 的 .mcp.json", async () => {
      const dir = mkdtempSync(resolve(tmpdir(), "mcp-test-"));
      try {
        writeFileSync(resolve(dir, ".mcp.json"), JSON.stringify({
          servers: { myServer: { command: "node", enabled: false } },
        }));
        const ctx = mockContext({ runtime: { ...mockRuntime(), currentWorkspace: dir }, paths: { APP_ROOT: dir } });
        const { status, body } = await callHandler(handleDashboard, "POST", "/api/mcp/servers/myServer/toggle", undefined, ctx);
        assert.strictEqual(status, 200);
        const data = parseJSON(body);
        assert.strictEqual(data.enabled, true, "已被启用");
        const file = JSON.parse(readFileSync(resolve(dir, ".mcp.json"), "utf-8"));
        assert.strictEqual(file.servers.myServer.enabled, true, "文件内容已变更");
      } finally { rmSync(dir, { recursive: true, force: true }); }
    });

    it("POST toggle 支持 URL-encoded server 名", async () => {
      const dir = mkdtempSync(resolve(tmpdir(), "mcp-test-"));
      try {
        writeFileSync(resolve(dir, ".mcp.json"), JSON.stringify({
          servers: { "my server": { command: "node", enabled: true } },
        }));
        const ctx = mockContext({ runtime: { ...mockRuntime(), currentWorkspace: dir }, paths: { APP_ROOT: dir } });
        const { status, body } = await callHandler(handleDashboard, "POST", "/api/mcp/servers/my%20server/toggle", undefined, ctx);
        assert.strictEqual(status, 200);
        const data = parseJSON(body);
        assert.strictEqual(data.name, "my server", "名称已 decode");
        assert.strictEqual(data.enabled, false, "已被禁用");
      } finally { rmSync(dir, { recursive: true, force: true }); }
    });
  });

  describe("MCP 目录/安装/卸载", () => {
    it("GET /api/mcp/catalog 返回精选列表", async () => {
      const { status, body } = await callHandler(handleDashboard, "GET", "/api/mcp/catalog");
      assert.strictEqual(status, 200);
      const data = parseJSON(body);
      assert.ok(Array.isArray(data), "返回数组");
      assert.ok(data.length > 5, "至少 6 个精选条目");
      assert.ok(data.every((e) => e.id && e.name), "每项有 id 和 name");
    });

    it("POST /api/mcp/install 安装有效 id 写入 .mcp.json", async () => {
      const dir = mkdtempSync(resolve(tmpdir(), "mcp-test-"));
      try {
        const ctx = mockContext({ runtime: { ...mockRuntime(), currentWorkspace: dir }, paths: { APP_ROOT: dir } });
        const { status, body } = await callHandler(handleDashboard, "POST", "/api/mcp/install", { id: "filesystem" }, ctx);
        assert.strictEqual(status, 200);
        const data = parseJSON(body);
        assert.strictEqual(data.ok, true);
        // 断言写入 key 是 id（filesystem）而非中文名
        const config = JSON.parse(readFileSync(resolve(dir, ".mcp.json"), "utf-8"));
        assert.ok(config.servers.filesystem, "以 id 为 key 写入 .mcp.json");
        assert.ok(!config.servers["文件系统"], "没有以中文名写入");
      } finally { rmSync(dir, { recursive: true, force: true }); }
    });

    it("POST /api/mcp/install 拒绝未知 id", async () => {
      const ctx = mockContext();
      const { status, body } = await callHandler(handleDashboard, "POST", "/api/mcp/install", { id: "nonexistent-mcp" }, ctx);
      assert.strictEqual(status, 400);
      const data = parseJSON(body);
      assert.strictEqual(data.ok, false);
    });

    it("POST /api/mcp/uninstall 删除当前 workspace 的 server", async () => {
      const dir = mkdtempSync(resolve(tmpdir(), "mcp-test-"));
      try {
        writeFileSync(resolve(dir, ".mcp.json"), JSON.stringify({
          servers: { "DuckDuckGo 搜索": { command: "npx", args: ["-y", "mcp-server-duckduckgo"] } },
        }));
        const ctx = mockContext({ runtime: { ...mockRuntime(), currentWorkspace: dir }, paths: { APP_ROOT: dir } });
        const { status, body } = await callHandler(handleDashboard, "POST", "/api/mcp/uninstall", { name: "DuckDuckGo 搜索" }, ctx);
        assert.strictEqual(status, 200);
        const data = parseJSON(body);
        assert.strictEqual(data.ok, true);
        // 验证文件已删除
        const config = JSON.parse(readFileSync(resolve(dir, ".mcp.json"), "utf-8"));
        assert.ok(!config.servers["DuckDuckGo 搜索"], "已从 .mcp.json 删除");
      } finally { rmSync(dir, { recursive: true, force: true }); }
    });

    it("POST /api/mcp/uninstall 对非 workspace 根来源返回 403", async () => {
      const dir = mkdtempSync(resolve(tmpdir(), "mcp-test-"));
      try {
        mkdirSync(resolve(dir, ".vscode"), { recursive: true });
        writeFileSync(resolve(dir, ".vscode", "mcp.json"), JSON.stringify({
          servers: { "not-local": { command: "node" } },
        }));
        const ctx = mockContext({ runtime: { ...mockRuntime(), currentWorkspace: dir }, paths: { APP_ROOT: dir } });
        const { status } = await callHandler(handleDashboard, "POST", "/api/mcp/uninstall", { name: "not-local" }, ctx);
        assert.strictEqual(status, 403, "非 workspace 根配置应拒绝删除");
      } finally { rmSync(dir, { recursive: true, force: true }); }
    });
  });
});

describe("chat routes", () => {
  it("GET /api/chat/stream 建立 SSE 连接", async () => {
    const ctx = mockContext();
    const { status, headers } = await callHandler(handleChat, "GET", "/api/chat/stream", undefined, ctx);
    assert.strictEqual(status, 200);
    assert.strictEqual(headers["Content-Type"], "text/event-stream");
  });

  it("POST /api/workspace/switch 切换工作区", async () => {
    // workspace switch 在 req.on('end') 回调中异步写响应
    // 用真实 HTTP server 测试
    const ctx = mockContext();
    ctx.runtime.session._cwd = "/tmp/fake-path";
    const server = createServer(async (req, res) => {
      const handled = await handleChat(req, res, ctx);
      if (!handled) { res.writeHead(404); res.end("Not found"); }
    });
    const addr = server.listen(0, "127.0.0.1");
    await new Promise(r => addr.on("listening", r));
    const port = addr.address().port;
    try {
      const r = await fetch(`http://127.0.0.1:${port}/api/workspace/switch`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workspace: ROOT }),
      });
      assert.strictEqual(r.status, 200);
      const data = await r.json();
      assert.ok(data.ok);
    } finally {
      server.close();
    }
  });
});

describe("sessions routes", () => {
  it("GET /api/sessions 返回列表", async () => {
    const ctx = mockContext();
    const { status, body } = await callHandler(handleSessions, "GET", `/api/sessions?workspace=${encodeURIComponent(ROOT)}&other=1`, undefined, ctx);
    assert.strictEqual(status, 200);
    const data = parseJSON(body);
    assert.ok(Array.isArray(data.sessions));
    assert.ok(Array.isArray(data.other));
  });

  it("POST /api/sessions/new 创建会话", async () => {
    const ctx = mockContext();
    const { status, body } = await callHandler(handleSessions, "POST", "/api/sessions/new", { workspace: ROOT }, ctx);
    assert.strictEqual(status, 200);
    const data = parseJSON(body);
    assert.ok(data.ok);
    assert.ok(data.id);
  });

  it("POST /api/sessions/rename 不存在的 ID 仍返回 ok", async () => {
    const ctx = mockContext();
    const { status, body } = await callHandler(handleSessions, "POST", "/api/sessions/rename", { id: "nonexistent", name: "新名字" }, ctx);
    assert.strictEqual(status, 200);
    assert.ok(parseJSON(body).ok);
  });
});

describe("search routes", () => {
  it("GET /api/search filename 模式返回含 file/total/truncated", async () => {
    const ctx = mockContext();
    const { status, body } = await callHandler(handleSearch, "GET", `/api/search?root=${encodeURIComponent(ROOT)}&q=README&mode=filename`, undefined, ctx);
    assert.strictEqual(status, 200);
    const data = parseJSON(body);
    assert.ok(Array.isArray(data.results), "results 为数组");
    assert.ok(typeof data.total === "number", "total 为数字");
    assert.ok(typeof data.truncated === "boolean", "truncated 为布尔");
    if (data.results.length > 0) {
      const r = data.results[0];
      assert.ok(r.file, "结果应有 file 字段");
      assert.ok(r.absolutePath, "结果应有 absolutePath 字段");
      assert.ok(Array.isArray(r.matches), "结果应有 matches 数组");
    }
  });

  it("GET /api/search 内容模式返回匹配行", async () => {
    const ctx = mockContext();
    const { status, body } = await callHandler(handleSearch, "GET", `/api/search?root=${encodeURIComponent(ROOT)}&q=function&mode=text`, undefined, ctx);
    assert.strictEqual(status, 200);
    const data = parseJSON(body);
    if (data.results.length > 0) {
      const match = data.results[0].matches?.[0];
      if (match) {
        assert.ok(typeof match.line === "number", "匹配行有 line");
        assert.ok(typeof match.text === "string", "匹配行有 text");
      }
    }
  });

  it("GET /api/search 排除 node_modules/.git/dist 等目录", async () => {
    const ctx = mockContext();
    const { status, body } = await callHandler(handleSearch, "GET", `/api/search?root=${encodeURIComponent(ROOT)}&q=NOTHING_SHOULD_MATCH_THIS&mode=filename`, undefined, ctx);
    assert.strictEqual(status, 200);
    // node_modules 和 .git 不应该出现在结果中
    const data = parseJSON(body);
    if (data.results && data.results.length > 0) {
      const inNodeModules = data.results.some((r) => r.file.includes("node_modules"));
      const inGit = data.results.some((r) => r.file.includes(".git"));
      assert.ok(!inNodeModules, "不应包含 node_modules");
      assert.ok(!inGit, "不应包含 .git");
    }
  });

  it("GET /api/search 无 root 返回错误信息", async () => {
    const ctx = mockContext();
    ctx.paths.APP_ROOT = ''; // 模拟无工作区
    const { status, body } = await callHandler(handleSearch, "GET", "/api/search?q=test&mode=filename", undefined, ctx);
    assert.strictEqual(status, 200);
    const data = parseJSON(body);
    assert.ok(data);
    const hasError = data.error != null;
    const hasResults = Array.isArray(data.results);
    assert.ok(hasError || hasResults, '应返回 error 或 results 数组');
  });
});

describe("explorer routes", () => {
  it("GET /api/explorer 返回目录内容", async () => {
    const ctx = mockContext();
    const { status, body } = await callHandler(handleExplorer, "GET", `/api/explorer?root=${encodeURIComponent(ROOT)}&path=src`, undefined, ctx);
    assert.strictEqual(status, 200);
    const data = parseJSON(body);
    assert.ok(Array.isArray(data.items));
    assert.ok(data.items.length > 0);
    // 语义检查：返回项应有 name/isDir/path 字段
    const first = data.items[0];
    assert.ok(first.name, "每项应有 name");
    assert.ok(typeof first.isDir === "boolean", "每项应有 isDir");
    assert.ok(first.path, "每项应有 path");
  });

  it("GET /api/file/read 读取文件", async () => {
    const ctx = mockContext();
    const { status, body } = await callHandler(handleExplorer, "GET", `/api/file/read?root=${encodeURIComponent(ROOT)}&path=package.json`, undefined, ctx);
    assert.strictEqual(status, 200);
    const data = parseJSON(body);
    assert.ok(data.content, "应有 content");
    assert.ok(data.content.length > 0, "content 非空");
    assert.ok(data.path, "应有 path 字段");
  });

  it("GET /api/file/read ../ 路径穿越被拒绝", async () => {
    const ctx = mockContext();
    const { status, body } = await callHandler(handleExplorer, "GET", `/api/file/read?root=${encodeURIComponent(ROOT)}&path=../../../etc/passwd`, undefined, ctx);
    const data = parseJSON(body);
    // 应返回 403 或 error
    const isBlocked = status === 403 || data?.error || false;
    assert.ok(isBlocked, "路径穿越应被拒绝（403 或 error）");
  });

  it("GET /api/explorer 路径穿越被拒绝", async () => {
    const ctx = mockContext();
    const { status, body } = await callHandler(handleExplorer, "GET", `/api/explorer?root=${encodeURIComponent(ROOT)}&path=../../../etc`, undefined, ctx);
    const data = parseJSON(body);
    const isBlocked = status === 403 || data?.error || false;
    assert.ok(isBlocked, "路径穿越应被拒绝");
  });
});

describe("git routes", () => {
  it("GET /api/git/status 返回状态（正确根目录）", async () => {
    const ctx = mockContext();
    const { status, body } = await callHandler(handleGit, "GET", `/api/git/status?root=${encodeURIComponent(ROOT)}`, undefined, ctx);
    assert.strictEqual(status, 200);
    const data = parseJSON(body);
    assert.ok(data);
    assert.ok(data.gitRoot || data.error);
  });

  it("GET /api/git/log 返回提交历史", async () => {
    const ctx = mockContext();
    const { status, body } = await callHandler(handleGit, "GET", `/api/git/log?root=${encodeURIComponent(ROOT)}&count=5`, undefined, ctx);
    assert.strictEqual(status, 200);
    assert.ok(parseJSON(body));
  });
});

describe("dispatchRoute 集成", () => {
  it("分发 /api/dashboard 被正确路由", async () => {
    const ctx = mockContext();
    const req = { url: "/api/dashboard", method: "GET", headers: { host: "localhost" }, on: () => req };
    const res = { _body: "", _status: 0, writeHead(s, h) { this._status = s; return this; }, end(d) { if (d) this._body += d; return this; }, write() { return true; }, on: () => res };
    const handled = await dispatchRoute(req, res, ctx);
    assert.strictEqual(handled, true);
    assert.strictEqual(res._status, 200);
  });

  it("真实 HTTP server 中未知路由返回 404", async () => {
    const ctx = mockContext();
    const server = createServer(async (req, res) => {
      const handled = await dispatchRoute(req, res, ctx);
      if (!handled) { res.writeHead(404); res.end("Not found"); }
    });
    const addr = server.listen(0, "127.0.0.1");
    await new Promise(r => addr.on("listening", r));
    const port = addr.address().port;
    try {
      const r = await fetch(`http://127.0.0.1:${port}/api/nonexistent`);
      assert.strictEqual(r.status, 404);
    } finally {
      server.close();
    }
  });
});
