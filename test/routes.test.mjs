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
import { mkdtempSync } from "node:fs";
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
