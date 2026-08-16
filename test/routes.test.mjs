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
import { execFileSync } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { ModelRegistry, ModelRuntime } from "@xiamol/pi-coding-agent";
import { workspaceDataPaths } from "../src/server/routes/session-dir.ts";
import { CustomProviderRevisionConflict } from "../src/model-provider/custom-provider-store.ts";
import { CustomProviderIdConflict } from "../src/model-provider/custom-provider-service.ts";
import { CustomProviderReferenceConflict } from "../src/model-provider/provider-reference-checker.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

describe("route implementation cleanup", () => {
  it("does not retain superseded route helpers", () => {
    const sessions = readFileSync(resolve(ROOT, "src/server/routes/sessions.ts"), "utf8");
    const searchCore = readFileSync(resolve(ROOT, "src/server/routes/search-core.ts"), "utf8");
    const gitCore = readFileSync(resolve(ROOT, "src/server/routes/git-core.ts"), "utf8");
    const sessionDir = readFileSync(resolve(ROOT, "src/server/routes/session-dir.ts"), "utf8");

    assert.doesNotMatch(sessions, /export function findAllJsonl\(/);
    assert.doesNotMatch(sessions, /export function findSessionFileById\(/);
    assert.doesNotMatch(searchCore, /export function searchConversations\(/);
    assert.doesNotMatch(gitCore, /export function parseLogVerbose\(/);
    assert.doesNotMatch(gitCore, /export (?:const STATUS_LABELS|function statusLabel)\b/);
    assert.doesNotMatch(sessionDir, /legacyUsageIndexFile:\s*(?:string|resolve\()/);
    assert.strictEqual(existsSync(resolve(ROOT, "src/server/session-workspace.ts")), false);
  });
});

describe("dashboard MCP route ownership", () => {
  it("delegates MCP routes after session readiness to a focused module", () => {
    const dashboardPath = resolve(ROOT, "src/server/routes/dashboard.ts");
    const mcpPath = resolve(ROOT, "src/server/routes/dashboard-mcp.ts");
    const pathUtilsPath = resolve(ROOT, "src/server/routes/route-path-utils.ts");
    assert.strictEqual(existsSync(mcpPath), true, "dashboard-mcp.ts must own dashboard MCP routes");
    assert.strictEqual(existsSync(pathUtilsPath), true, "shared route path helpers must have neutral ownership");

    const dashboardSource = readFileSync(dashboardPath, "utf8");
    const mcpSource = readFileSync(mcpPath, "utf8");
    const readinessIndex = dashboardSource.indexOf("waitForSessionReady");
    const delegationIndex = dashboardSource.indexOf("handleDashboardMcp(");

    assert.match(dashboardSource, /from "\.\/dashboard-mcp\.js"/);
    assert.ok(readinessIndex >= 0 && delegationIndex > readinessIndex, "MCP delegation must remain behind session readiness");
    assert.doesNotMatch(dashboardSource, /\/api\/mcp\//);
    assert.doesNotMatch(dashboardSource, /\b(?:TrustStore|MCP_CATALOG|updateMcpConfigFile|publishMcpChanged)\b/);
    assert.match(dashboardSource, /from "\.\/route-path-utils\.js"/);
    assert.match(mcpSource, /export const handleDashboardMcp: RouteHandler/);
    assert.match(mcpSource, /from "\.\/route-path-utils\.js"/);
    assert.doesNotMatch(mcpSource, /from "\.\/dashboard\.js"/);
    assert.doesNotMatch(`${dashboardSource}\n${mcpSource}`, /function (?:existingAncestorForPath|pathExists)\b/);
  });
});

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
    syncModelProviders: async () => 0,
    runWithStableSession: async (operation) => operation(),
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

function mockContextUsageSnapshot() {
  return {
    tokens: 1300,
    contextWindow: 200000,
    percent: 0.65,
    source: "mixed",
    exactTokens: 1234,
    estimatedTokens: 66,
  };
}

function mockAppEvents(overrides) {
  const published = [];
  return {
    published,
    publish(type, payload) { published.push({ type, payload }); },
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
    appEvents: mockAppEvents(),
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
  it("GET /api/bootstrap returns ok", async () => {
    const { status, body } = await callHandler(handleDashboard, "GET", "/api/bootstrap");
    assert.strictEqual(status, 200);
    assert.deepStrictEqual(parseJSON(body), { ok: true });
  });

  it("HEAD /api/bootstrap returns headers without a body", async () => {
    const { status, body } = await callHandler(handleDashboard, "HEAD", "/api/bootstrap");
    assert.strictEqual(status, 200);
    assert.strictEqual(body, "");
  });

  it("waits for a session transition before serving dashboard data", async () => {
    let release;
    const pending = new Promise((resolve) => { release = resolve; });
    const runtime = mockRuntime();
    const session = runtime.session;
    let ready = false;
    Object.defineProperty(runtime, "session", {
      configurable: true,
      get() {
        if (!ready) throw new Error("session transition in progress");
        return session;
      },
    });
    runtime.waitForSessionReady = async () => {
      await pending;
      ready = true;
      return session;
    };

    const request = callHandler(handleDashboard, "GET", "/api/dashboard", undefined, mockContext({ runtime }));
    await Promise.resolve();
    release();
    const { status, body } = await request;
    assert.strictEqual(status, 200);
    assert.strictEqual(parseJSON(body).modelId, "test-model");
  });

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
    const runtime = mockRuntime({ getContextUsageSnapshot: mockContextUsageSnapshot });
    const { status, body } = await callHandler(
      handleDashboard,
      "GET",
      "/api/token-usage",
      undefined,
      mockContext({ runtime }),
    );
    assert.strictEqual(status, 200);
    const data = parseJSON(body);
    assert.ok(data.contextUsage);
    assert.deepStrictEqual(data.contextUsage, mockContextUsageSnapshot());
    assert.ok(data.sessionStats);
  });

  it("GET /api/usage/current 返回当前用量", async () => {
    const runtime = mockRuntime({ getContextUsageSnapshot: mockContextUsageSnapshot });
    const { status, body } = await callHandler(
      handleDashboard,
      "GET",
      "/api/usage/current",
      undefined,
      mockContext({ runtime }),
    );
    assert.strictEqual(status, 200);
    const data = parseJSON(body);
    assert.ok(data.hasActiveSession, "应有活跃会话");
    assert.ok(data.sessionId, "应有 sessionId");
    assert.strictEqual(data.provider, "test-provider", "应有 provider");
    assert.ok(data.contextUsage, "应有 contextUsage");
    assert.deepStrictEqual(data.contextUsage, mockContextUsageSnapshot());
    assert.ok(data.tokens, "应有 tokens");
    assert.strictEqual(data.tokens.input, 500);
    // B-4：命中率口径修正 = cacheRead/(input+cacheRead+cacheWrite)
    // = 100/(500+100+50) ≈ 15%（旧公式漏 input 误报 67%）
    assert.strictEqual(data.cacheHitRate, 15, "100/(500+100+50)*100 ≈ 15%");
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
      assert.deepStrictEqual(data, { ok: true, compacted: true, message: "Compaction completed" });
      assert.deepStrictEqual(ctx.appEvents.published, [], "the REST route must not duplicate session lifecycle events");
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
      assert.deepStrictEqual(ctx.appEvents.published, []);
    });

    it("does not duplicate lifecycle events when compaction fails", async () => {
      const ctx = mockContext({
        runtime: {
          session: {
            ...mockSession(),
            compact: async () => { throw new Error("compact exploded"); },
          },
        },
      });
      const { status, body } = await callHandler(handleDashboard, "POST", "/api/compact", {}, ctx);
      assert.strictEqual(status, 500);
      assert.deepStrictEqual(parseJSON(body), { ok: false, error: "compact exploded" });
      assert.deepStrictEqual(ctx.appEvents.published, []);
    });

    it("keeps the exact compaction response when the UI publisher throws", async () => {
      const session = mockSession({ compact: async () => ({ summary: "compacted" }) });
      const ctx = mockContext({
        runtime: { session },
        appEvents: mockAppEvents({ publish() { throw new Error("UI unavailable"); } }),
      });

      const { status, body } = await callHandler(handleDashboard, "POST", "/api/compact", {}, ctx);

      assert.strictEqual(status, 200);
      assert.deepStrictEqual(parseJSON(body), { ok: true, compacted: true, message: "Compaction completed" });
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

    it("不泄露实际 server 配置中的 env / headers 敏感字段", async () => {
      const dir = mkdtempSync(resolve(tmpdir(), "mcp-redaction-"));
      try {
        writeFileSync(resolve(dir, ".mcp.json"), JSON.stringify({
          servers: {
            secretServer: {
              command: "node",
              args: ["server.js"],
              env: { API_TOKEN: "env-secret-value" },
              headers: { Authorization: "Bearer header-secret-value" },
            },
          },
        }));
        const ctx = mockContext({ runtime: { ...mockRuntime(), currentWorkspace: dir }, paths: { APP_ROOT: dir } });
        const { status, body } = await callHandler(handleDashboard, "GET", "/api/mcp/servers", undefined, ctx);
        assert.strictEqual(status, 200);
        const data = parseJSON(body);
        const server = data.find((entry) => entry.name === "secretServer");
        assert.ok(server);
        assert.ok(!("env" in server.config));
        assert.ok(!("headers" in server.config));
        assert.strictEqual(body.includes("env-secret-value"), false);
        assert.strictEqual(body.includes("header-secret-value"), false);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("禁用 server 仍出现在列表中", async () => {
      const dir = mkdtempSync(resolve(tmpdir(), "mcp-test-"));
      const origHome = process.env.HOME;
      const origProfile = process.env.USERPROFILE;
      try {
        process.env.HOME = dir;
        process.env.USERPROFILE = dir;
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
      } finally {
        process.env.HOME = origHome;
        process.env.USERPROFILE = origProfile;
        rmSync(dir, { recursive: true, force: true });
      }
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
        assert.deepStrictEqual(ctx.appEvents.published.map((event) => event.type), ["mcp.changed"]);
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

    it("keeps the MCP config response when the UI publisher throws", async () => {
      const dir = mkdtempSync(resolve(tmpdir(), "mcp-publisher-fail-"));
      try {
        writeFileSync(resolve(dir, ".mcp.json"), JSON.stringify({
          servers: { myServer: { command: "node", enabled: false } },
        }));
        const ctx = mockContext({
          runtime: { ...mockRuntime(), currentWorkspace: dir },
          paths: { APP_ROOT: dir },
          appEvents: mockAppEvents({ publish() { throw new Error("UI unavailable"); } }),
        });

        const { status, body } = await callHandler(handleDashboard, "POST", "/api/mcp/servers/myServer/toggle", undefined, ctx);

        assert.strictEqual(status, 200);
        assert.deepStrictEqual(parseJSON(body), {
          ok: true,
          name: "myServer",
          enabled: true,
          restartNeeded: true,
          message: "请重启会话以应用更改",
        });
        const config = JSON.parse(readFileSync(resolve(dir, ".mcp.json"), "utf-8"));
        assert.strictEqual(config.servers.myServer.enabled, true);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  describe("MCP 信任", () => {
    it("POST /api/mcp/servers/:name/trust 信任后记录添加", async () => {
      const dir = mkdtempSync(resolve(tmpdir(), "mcp-test-"));
      const origHome = process.env.HOME;
      const origProfile = process.env.USERPROFILE;
      try {
        process.env.HOME = dir;
        process.env.USERPROFILE = dir;
        writeFileSync(resolve(dir, ".mcp.json"), JSON.stringify({
          servers: { "test-srv": { command: "node", args: ["-e", "1"] } },
        }));
        const ctx = mockContext({ runtime: { ...mockRuntime(), currentWorkspace: dir }, paths: { APP_ROOT: dir } });
        const { status, body } = await callHandler(handleDashboard, "POST", "/api/mcp/servers/test-srv/trust", undefined, ctx);
        assert.strictEqual(status, 200);
        const data = parseJSON(body);
        assert.strictEqual(data.ok, true, "信任成功");
        assert.strictEqual(data.name, "test-srv");
        assert.deepStrictEqual(ctx.appEvents.published.map((event) => event.type), ["mcp.changed"]);
      } finally {
        process.env.HOME = origHome;
        process.env.USERPROFILE = origProfile;
        rmSync(dir, { recursive: true, force: true });
      }
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

    it("POST /api/mcp/install 安装到全局配置，默认禁用", async () => {
      const dir = mkdtempSync(resolve(tmpdir(), "mcp-test-"));
      const origHome = process.env.HOME;
      const origProfile = process.env.USERPROFILE;
      try {
        // 模拟 HOME 指向临时目录，使 defaultGlobalConfigPath 写入临时位置
        process.env.HOME = dir;
        process.env.USERPROFILE = dir;
        const ctx = mockContext({ runtime: { ...mockRuntime(), currentWorkspace: dir }, paths: { APP_ROOT: dir } });
        const { status, body } = await callHandler(handleDashboard, "POST", "/api/mcp/install", { id: "filesystem" }, ctx);
        assert.strictEqual(status, 200);
        const data = parseJSON(body);
        assert.strictEqual(data.ok, true);
        assert.strictEqual(data.isGlobal, true, "返回 global 标识");
        // 断言配置写入了全局路径，而非项目路径
        const globalPath = resolve(dir, ".pi", "agent", "mcp.json");
        const config = JSON.parse(readFileSync(globalPath, "utf-8"));
        assert.deepStrictEqual(ctx.appEvents.published.map((event) => event.type), ["mcp.changed"]);
        assert.ok(config.servers.filesystem, "以 id 为 key 写入全局配置");
        assert.strictEqual(config.servers.filesystem.enabled, false, "安装后默认禁用");
        // 项目目录不应有 .mcp.json
        assert.ok(!existsSync(resolve(dir, ".mcp.json")), "项目目录未写入");
      } finally {
        process.env.HOME = origHome;
        process.env.USERPROFILE = origProfile;
        rmSync(dir, { recursive: true, force: true });
      }
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

    it("POST /api/mcp/uninstall 对 .vscode/mcp.json 来源成功删除", async () => {
      const dir = mkdtempSync(resolve(tmpdir(), "mcp-test-"));
      try {
        mkdirSync(resolve(dir, ".vscode"), { recursive: true });
        writeFileSync(resolve(dir, ".vscode", "mcp.json"), JSON.stringify({
          servers: { "not-local": { command: "node" } },
        }));
        const ctx = mockContext({ runtime: { ...mockRuntime(), currentWorkspace: dir }, paths: { APP_ROOT: dir } });
        const { status, body } = await callHandler(handleDashboard, "POST", "/api/mcp/uninstall", { name: "not-local" }, ctx);
        assert.strictEqual(status, 200, "按 sourcePath 删除");
        const data = parseJSON(body);
        assert.strictEqual(data.ok, true);
        // 验证 .vscode/mcp.json 中已删除
        const config = JSON.parse(readFileSync(resolve(dir, ".vscode", "mcp.json"), "utf-8"));
        assert.deepStrictEqual(ctx.appEvents.published.map((event) => event.type), ["mcp.changed"]);
        assert.ok(!config.servers["not-local"], "已从 .vscode/mcp.json 删除");
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
    const ctx = mockContext({
      runtime: mockRuntime({ currentWorkspace: ROOT }),
    });
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
        body: JSON.stringify({ workspace: resolve(ROOT, "src") }),
      });
      assert.strictEqual(r.status, 200);
      const data = await r.json();
      assert.deepStrictEqual(data, { ok: true, workspace: resolve(ROOT, "src"), switched: true });
      assert.deepStrictEqual(ctx.appEvents.published.map((event) => event.type), ["dashboard.changed", "usage.changed"]);
    } finally {
      server.close();
    }
  });

  it("POST /api/workspace/switch does not publish when switching fails", async () => {
    const ctx = mockContext({
      runtime: mockRuntime({
        currentWorkspace: ROOT,
        switchWorkspace: async () => { throw new Error("switch failed"); },
      }),
    });
    const server = createServer(async (req, res) => {
      const handled = await handleChat(req, res, ctx);
      if (!handled) { res.writeHead(404); res.end("Not found"); }
    });
    const addr = server.listen(0, "127.0.0.1");
    await new Promise((resolveListening) => addr.on("listening", resolveListening));
    const port = addr.address().port;
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/workspace/switch`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workspace: resolve(ROOT, "src") }),
      });
      assert.strictEqual(response.status, 400);
      assert.deepStrictEqual(await response.json(), { error: "switch failed" });
      assert.deepStrictEqual(ctx.appEvents.published, []);
    } finally {
      server.close();
    }
  });

  it("keeps the workspace switch response when the UI publisher throws", async () => {
    const workspace = resolve(ROOT, "src");
    const ctx = mockContext({
      runtime: mockRuntime({ currentWorkspace: ROOT }),
      appEvents: mockAppEvents({ publish() { throw new Error("UI unavailable"); } }),
    });
    const server = createServer(async (req, res) => {
      const handled = await handleChat(req, res, ctx);
      if (!handled) { res.writeHead(404); res.end("Not found"); }
    });
    const addr = server.listen(0, "127.0.0.1");
    await new Promise((resolveListening) => addr.on("listening", resolveListening));
    const port = addr.address().port;
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/workspace/switch`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workspace }),
      });
      assert.strictEqual(response.status, 200);
      assert.deepStrictEqual(await response.json(), { ok: true, workspace, switched: true });
    } finally {
      server.close();
    }
  });
});

describe("git workspace diff", () => {
  it("returns HEAD-to-worktree changes for tracked and untracked files", async () => {
    const root = mkdtempSync(resolve(tmpdir(), "git-diff-route-"));
    try {
      execFileSync("git", ["init"], { cwd: root });
      execFileSync("git", ["config", "user.name", "Route Test"], { cwd: root });
      execFileSync("git", ["config", "user.email", "route@test.invalid"], { cwd: root });
      writeFileSync(resolve(root, "tracked.txt"), "before\nkeep\n", "utf8");
      writeFileSync(resolve(root, "old-name.txt"), "renamed\n", "utf8");
      execFileSync("git", ["add", "tracked.txt", "old-name.txt"], { cwd: root });
      execFileSync("git", ["commit", "-m", "initial"], { cwd: root });
      writeFileSync(resolve(root, "tracked.txt"), "staged\nkeep\n", "utf8");
      execFileSync("git", ["add", "tracked.txt"], { cwd: root });
      writeFileSync(resolve(root, "tracked.txt"), "after\nkeep\n", "utf8");
      writeFileSync(resolve(root, "new.txt"), "first\nsecond\n", "utf8");
      execFileSync("git", ["mv", "old-name.txt", "new-name.txt"], { cwd: root });

      const ctx = mockContext({ paths: { ...mockPaths(), APP_ROOT: root } });
      const trackedResult = await callHandler(
        handleGit,
        "GET",
        `/api/git/diff?root=${encodeURIComponent(root)}&path=${encodeURIComponent("tracked.txt")}`,
        undefined,
        ctx,
      );
      assert.strictEqual(trackedResult.status, 200);
      const tracked = parseJSON(trackedResult.body);
      assert.strictEqual(tracked.type, "update");
      assert.strictEqual(tracked.filePath, "tracked.txt");
      assert.strictEqual(tracked.linesAdded, 1);
      assert.strictEqual(tracked.linesRemoved, 1);
      assert.deepStrictEqual(tracked.structuredPatch[0].lines, ["-before", "+after", " keep"]);

      const untrackedResult = await callHandler(
        handleGit,
        "GET",
        `/api/git/diff?root=${encodeURIComponent(root)}&path=${encodeURIComponent("new.txt")}`,
        undefined,
        ctx,
      );
      const untracked = parseJSON(untrackedResult.body);
      assert.strictEqual(untracked.type, "create");
      assert.strictEqual(untracked.linesAdded, 2);
      assert.deepStrictEqual(untracked.structuredPatch[0].lines, ["+first", "+second"]);

      const renameResult = await callHandler(
        handleGit,
        "GET",
        `/api/git/diff?root=${encodeURIComponent(root)}&path=${encodeURIComponent("new-name.txt")}`,
        undefined,
        ctx,
      );
      const renamed = parseJSON(renameResult.body);
      assert.strictEqual(renamed.type, "rename");
      assert.strictEqual(renamed.filePath, "new-name.txt");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("handles deleted and binary files and rejects traversal", async () => {
    const root = mkdtempSync(resolve(tmpdir(), "git-diff-edge-"));
    try {
      execFileSync("git", ["init"], { cwd: root });
      execFileSync("git", ["config", "user.name", "Route Test"], { cwd: root });
      execFileSync("git", ["config", "user.email", "route@test.invalid"], { cwd: root });
      writeFileSync(resolve(root, "deleted.txt"), "gone\n", "utf8");
      writeFileSync(resolve(root, "binary.bin"), Buffer.from([0, 1, 2, 3]));
      execFileSync("git", ["add", "deleted.txt", "binary.bin"], { cwd: root });
      execFileSync("git", ["commit", "-m", "initial"], { cwd: root });
      rmSync(resolve(root, "deleted.txt"));
      writeFileSync(resolve(root, "binary.bin"), Buffer.from([0, 4, 5, 6]));

      const ctx = mockContext({ paths: { ...mockPaths(), APP_ROOT: root } });
      const deletedResult = await callHandler(handleGit, "GET", `/api/git/diff?root=${encodeURIComponent(root)}&path=deleted.txt`, undefined, ctx);
      const deleted = parseJSON(deletedResult.body);
      assert.strictEqual(deleted.type, "delete");
      assert.strictEqual(deleted.linesRemoved, 1);

      const binaryResult = await callHandler(handleGit, "GET", `/api/git/diff?root=${encodeURIComponent(root)}&path=binary.bin`, undefined, ctx);
      const binary = parseJSON(binaryResult.body);
      assert.strictEqual(binary.binary, true);
      assert.match(binary.message, /二进制/);

      const traversalResult = await callHandler(
        handleGit,
        "GET",
        `/api/git/diff?root=${encodeURIComponent(root)}&path=${encodeURIComponent("../outside.txt")}`,
        undefined,
        ctx,
      );
      assert.strictEqual(traversalResult.status, 403);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("settings routes", () => {
  it("publishes dashboard changes after model and thinking mutations without changing responses", async () => {
    const model = mockModel({ provider: "openai", id: "gpt-test" });
    const session = mockSession({
      thinkingLevel: "off",
      setThinkingLevel(level) { this.thinkingLevel = level; },
      getAvailableThinkingLevels: () => ["low", "high"],
      supportsThinking: () => true,
      setModel: async () => {},
    });
    const ctx = mockContext({
      runtime: mockRuntime({
        session,
        modelRegistry: { find: (provider, id) => provider === model.provider && id === model.id ? model : undefined },
      }),
    });
    try {
      mkdirSync(ctx.paths.PI_CONFIG_DIR, { recursive: true });
      const thinking = await callHandler(handleSettings, "POST", "/api/thinking-level", { level: "high" }, ctx);
      assert.strictEqual(thinking.status, 200);
      assert.deepStrictEqual(parseJSON(thinking.body), {
        ok: true,
        level: "high",
        availableLevels: ["off", "low", "high"],
        supportsThinking: true,
      });

      const switched = await callHandler(handleSettings, "POST", "/api/model/switch", { provider: "openai", modelId: "gpt-test" }, ctx);
      assert.strictEqual(switched.status, 200);
      assert.deepStrictEqual(parseJSON(switched.body), { ok: true });
      assert.deepStrictEqual(ctx.appEvents.published.map((event) => event.type), ["dashboard.changed", "dashboard.changed"]);
    } finally {
      rmSync(ctx.paths._tmpDir, { recursive: true, force: true });
    }
  });

  it("does not publish failed settings mutations and ignores publisher errors", async () => {
    const failedCtx = mockContext({
      runtime: mockRuntime({
        session: mockSession({ setThinkingLevel: () => { throw new Error("thinking failed"); } }),
      }),
    });
    const failed = await callHandler(handleSettings, "POST", "/api/thinking-level", { level: "high" }, failedCtx);
    assert.strictEqual(failed.status, 400);
    assert.deepStrictEqual(parseJSON(failed.body), { error: "thinking failed" });
    assert.deepStrictEqual(failedCtx.appEvents.published, []);

    const model = mockModel({ provider: "openai", id: "gpt-rejected" });
    const rejectedModelCtx = mockContext({
      runtime: mockRuntime({
        session: mockSession({ setModel: async () => { throw new Error("model rejected"); } }),
        modelRegistry: { find: () => model },
      }),
    });
    mkdirSync(rejectedModelCtx.paths.PI_CONFIG_DIR, { recursive: true });
    const rejectedSettingsFile = resolve(rejectedModelCtx.paths.PI_CONFIG_DIR, "settings.json");
    const priorSettings = { defaultProvider: "openai", defaultModel: "gpt-stable" };
    writeFileSync(rejectedSettingsFile, JSON.stringify(priorSettings));
    try {
      const rejected = await callHandler(handleSettings, "POST", "/api/model/switch", {
        provider: model.provider,
        modelId: model.id,
      }, rejectedModelCtx);
      assert.strictEqual(rejected.status, 400);
      assert.deepStrictEqual(parseJSON(rejected.body), { error: "model rejected" });
      assert.deepStrictEqual(rejectedModelCtx.appEvents.published, []);
      assert.deepStrictEqual(JSON.parse(readFileSync(rejectedSettingsFile, "utf8")), priorSettings);
    } finally {
      rmSync(rejectedModelCtx.paths._tmpDir, { recursive: true, force: true });
    }

    const failOpenCtx = mockContext({
      runtime: mockRuntime({
        session: mockSession({
          thinkingLevel: "off",
          setThinkingLevel(level) { this.thinkingLevel = level; },
        }),
      }),
      appEvents: mockAppEvents({ publish() { throw new Error("UI unavailable"); } }),
    });
    const succeeded = await callHandler(handleSettings, "POST", "/api/thinking-level", { level: "low" }, failOpenCtx);
    assert.strictEqual(succeeded.status, 200);
    assert.strictEqual(parseJSON(succeeded.body).level, "low");
  });

  it("model switch uses the current session when authorization changes the runtime", async () => {
    const oldModel = mockModel({ provider: "custom", id: "target", generation: "old" });
    const newModel = mockModel({ provider: "custom", id: "target", generation: "new" });
    let oldSetCalls = 0;
    let newSetCalls = 0;
    const oldSession = mockSession({
      async setModel() {
        oldSetCalls += 1;
        throw new Error("disposed old session");
      },
    });
    const newSession = mockSession({
      async setModel(model) {
        newSetCalls += 1;
        this.model = model;
      },
    });
    const runtime = mockRuntime({
      session: oldSession,
      modelRegistry: { find: () => oldModel },
      syncModelProviders: async () => 1,
    });
    const ctx = mockContext({
      runtime,
      permissionService: {
        async authorizePath(root, target) {
          runtime.session = newSession;
          runtime.modelRegistry = { find: (provider, id) => (
            provider === newModel.provider && id === newModel.id ? newModel : undefined
          ) };
          return { path: resolve(root, target), root };
        },
      },
    });
    mkdirSync(ctx.paths.PI_CONFIG_DIR, { recursive: true });
    try {
      const result = await callHandler(handleSettings, "POST", "/api/model/switch", {
        provider: "custom",
        modelId: "target",
      }, ctx);

      assert.strictEqual(result.status, 200);
      assert.deepStrictEqual(parseJSON(result.body), { ok: true });
      assert.strictEqual(oldSetCalls, 0);
      assert.strictEqual(newSetCalls, 1);
      assert.strictEqual(newSession.model, newModel);
    } finally {
      rmSync(ctx.paths._tmpDir, { recursive: true, force: true });
    }
  });

  it("rolls back the runtime model when settings persistence fails", async () => {
    const priorModel = mockModel({ provider: "openai", id: "stable" });
    const targetModel = mockModel({ provider: "custom", id: "target" });
    const appliedModels = [];
    const session = mockSession({
      model: priorModel,
      async setModel(model) {
        appliedModels.push(model);
        this.model = model;
      },
    });
    const ctx = mockContext({
      runtime: mockRuntime({
        session,
        modelRegistry: { find: () => targetModel },
      }),
    });
    mkdirSync(resolve(ctx.paths.PI_CONFIG_DIR, "settings.json"), { recursive: true });
    try {
      const result = await callHandler(handleSettings, "POST", "/api/model/switch", {
        provider: targetModel.provider,
        modelId: targetModel.id,
      }, ctx);

      assert.strictEqual(result.status, 400);
      assert.deepStrictEqual(appliedModels, [targetModel, priorModel]);
      assert.strictEqual(session.model, priorModel);
      assert.deepStrictEqual(ctx.appEvents.published, []);
    } finally {
      rmSync(ctx.paths._tmpDir, { recursive: true, force: true });
    }
  });

  it("GET /api/auth redacts stored provider keys", async () => {
    const ctx = mockContext();
    try {
      mkdirSync(ctx.paths.PI_CONFIG_DIR, { recursive: true });
      writeFileSync(resolve(ctx.paths.PI_CONFIG_DIR, "auth.json"), JSON.stringify({
        openai: { type: "api_key", key: "sk-test-secret-value" },
      }));

      const { status, body } = await callHandler(handleSettings, "GET", "/api/auth", undefined, ctx);

      assert.strictEqual(status, 200);
      const data = parseJSON(body);
      assert.ok(Array.isArray(data.providers));
      const openai = data.providers.find((item) => item.provider === "openai");
      assert.ok(openai);
      assert.strictEqual(openai.hasKey, true);
      assert.strictEqual(openai.canReveal, true);
      assert.strictEqual(openai.keyPreview, "sk-test-...");
      assert.strictEqual(Object.hasOwn(openai, "keyFull"), false);
      assert.strictEqual(JSON.stringify(data).includes("secret-value"), false);
    } finally {
      if (ctx.paths._tmpDir) rmSync(ctx.paths._tmpDir, { recursive: true, force: true });
    }
  });

  it("reveals a configured key only after an explicit provider request", async () => {
    const ctx = mockContext({
      runtime: mockRuntime({
        modelRuntime: {
          getProviderAuthStatus: (provider) => provider === "openai" ? { configured: true, source: "stored" } : { configured: false },
          getAuth: async (provider) => provider === "openai"
            ? { auth: { apiKey: "sk-test-secret-value" } }
            : undefined,
        },
      }),
    });
    try {
      mkdirSync(ctx.paths.PI_CONFIG_DIR, { recursive: true });
      writeFileSync(resolve(ctx.paths.PI_CONFIG_DIR, "auth.json"), JSON.stringify({
        openai: { type: "api_key", key: "sk-test-secret-value" },
      }));

      const { status, body } = await callHandler(handleSettings, "POST", "/api/auth/reveal", { provider: "openai" }, ctx);
      assert.strictEqual(status, 200);
      assert.deepStrictEqual(parseJSON(body), { ok: true, apiKey: "sk-test-secret-value" });
    } finally {
      if (ctx.paths._tmpDir) rmSync(ctx.paths._tmpDir, { recursive: true, force: true });
    }
  });

  it("distinguishes configured providers from revealable stored API keys", async () => {
    const ctx = mockContext({
      runtime: mockRuntime({
        modelRuntime: {
          getProviderAuthStatus: (provider) => provider === "openai"
            ? { configured: true, source: "oauth" }
            : { configured: false },
        },
      }),
    });
    try {
      mkdirSync(ctx.paths.PI_CONFIG_DIR, { recursive: true });
      writeFileSync(resolve(ctx.paths.PI_CONFIG_DIR, "auth.json"), JSON.stringify({
        openai: { type: "oauth", accessToken: "oauth-secret-value" },
      }));

      const { status, body } = await callHandler(handleSettings, "GET", "/api/auth", undefined, ctx);

      assert.strictEqual(status, 200);
      const openai = parseJSON(body).providers.find((item) => item.provider === "openai");
      assert.ok(openai);
      assert.strictEqual(openai.hasKey, true);
      assert.strictEqual(openai.canReveal, false);
      assert.strictEqual(openai.keyPreview, "");
      assert.strictEqual(JSON.stringify(openai).includes("oauth-secret-value"), false);
    } finally {
      if (ctx.paths._tmpDir) rmSync(ctx.paths._tmpDir, { recursive: true, force: true });
    }
  });

  it("refreshes ModelRuntime after saving an API key", async () => {
    const ctx = mockContext();
    try {
      mkdirSync(ctx.paths.PI_CONFIG_DIR, { recursive: true });
      const modelRuntime = await ModelRuntime.create({
        authPath: resolve(ctx.paths.PI_CONFIG_DIR, "auth.json"),
        modelsPath: null,
        allowModelNetwork: false,
      });
      ctx.runtime = mockRuntime({
        modelRuntime,
        modelRegistry: new ModelRegistry(modelRuntime),
      });

      assert.strictEqual(modelRuntime.getProviderAuthStatus("openai").configured, false);
      assert.strictEqual(ctx.runtime.modelRegistry.getAvailable().some((model) => model.provider === "openai"), false);

      const saved = await callHandler(handleSettings, "POST", "/api/auth", {
        provider: "openai",
        apiKey: "sk-test-secret-value",
      }, ctx);
      assert.strictEqual(saved.status, 200);
      assert.deepStrictEqual(parseJSON(saved.body), { ok: true });
      assert.deepStrictEqual(modelRuntime.getProviderAuthStatus("openai"), { configured: true, source: "stored" });

      const models = await callHandler(handleSettings, "GET", "/api/models", undefined, ctx);
      assert.strictEqual(models.status, 200);
      assert.ok(parseJSON(models.body).models.some((model) => model.provider === "openai"));
    } finally {
      if (ctx.paths._tmpDir) rmSync(ctx.paths._tmpDir, { recursive: true, force: true });
    }
  });
});

describe("custom provider settings routes", () => {
  const apiSecret = "api-secret-route-fixture";
  const headerSecret = "header-secret-route-fixture";
  const redacted = (revision) => ({
    schemaVersion: 1,
    revision,
    providers: [{
      id: "acme",
      name: "Acme",
      protocol: "openai-responses",
      baseUrl: "https://api.example.test/v1",
      authMode: "apiKey",
      apiKeyConfigured: true,
      headers: [{ name: "X-Tenant", configured: true }],
      models: [],
    }],
  });
  const providerDraft = {
    id: "acme",
    name: "Acme",
    protocol: "openai-responses",
    baseUrl: "https://api.example.test/v1",
    authMode: "apiKey",
    apiKey: apiSecret,
    headers: [{ name: "X-Tenant", value: headerSecret }],
    models: [],
  };

  function service(overrides = {}) {
    return {
      capabilities: () => ({
        protocols: [
          { id: "openai-responses", authModes: ["none", "apiKey"], supportsCompatibility: true },
          { id: "google-generative-ai", authModes: ["apiKey"], supportsCompatibility: true },
        ],
        price: { currency: "USD", unit: "millionTokens" },
      }),
      list: async () => ({
        revision: 0,
        official: [{ id: "openai", name: "OpenAI", configured: true }],
        custom: [],
      }),
      create: async () => redacted(1),
      update: async () => redacted(2),
      delete: async () => ({ schemaVersion: 1, revision: 3, providers: [] }),
      revealApiKey: async () => apiSecret,
      ...overrides,
    };
  }

  it("serves capabilities and redacted official/custom lists", async () => {
    const modelRuntime = { marker: "model-runtime" };
    let listedRuntime;
    const ctx = mockContext({
      runtime: mockRuntime({ modelRuntime }),
      customProviderService: service({
        list: async (received) => {
          listedRuntime = received;
          return {
            revision: 4,
            official: [{ id: "openai", name: "OpenAI", configured: true }],
            custom: redacted(4).providers,
          };
        },
      }),
    });

    const capabilities = await callHandler(handleSettings, "GET", "/api/custom-providers/capabilities", undefined, ctx);
    assert.strictEqual(capabilities.status, 200);
    assert.deepStrictEqual(parseJSON(capabilities.body).price, { currency: "USD", unit: "millionTokens" });
    assert.deepStrictEqual(
      parseJSON(capabilities.body).protocols.find((entry) => entry.id === "google-generative-ai").authModes,
      ["apiKey"],
    );

    const listed = await callHandler(handleSettings, "GET", "/api/custom-providers", undefined, ctx);
    assert.strictEqual(listed.status, 200);
    assert.strictEqual(listedRuntime, modelRuntime);
    assert.equal(listed.body.includes(apiSecret), false);
    assert.equal(listed.body.includes(headerSecret), false);
    assert.equal(JSON.stringify(parseJSON(listed.body)).includes("credential:"), false);
  });

  it("passes explicit revisions through create, update, and delete and returns new redacted snapshots", async () => {
    const calls = [];
    const syncCalls = [];
    const modelRuntime = { marker: "model-runtime" };
    const ctx = mockContext({
      runtime: mockRuntime({
        modelRuntime,
        syncModelProviders() {
          syncCalls.push("sync");
          return new Promise(() => {});
        },
      }),
      customProviderService: service({
        async create(input, receivedRuntime) {
          calls.push(["create", input, receivedRuntime]);
          return redacted(1);
        },
        async update(id, input, receivedRuntime) {
          calls.push(["update", id, input, receivedRuntime]);
          return redacted(2);
        },
        async delete(id, input, receivedRuntime) {
          calls.push(["delete", id, input, receivedRuntime]);
          return { schemaVersion: 1, revision: 3, providers: [] };
        },
      }),
    });

    const created = await callHandler(handleSettings, "POST", "/api/custom-providers", {
      expectedRevision: 0,
      provider: providerDraft,
    }, ctx);
    const updated = await callHandler(handleSettings, "PUT", "/api/custom-providers/acme", {
      expectedRevision: 1,
      provider: { ...providerDraft, name: "Renamed" },
    }, ctx);
    const deleted = await callHandler(handleSettings, "DELETE", "/api/custom-providers/acme", {
      expectedRevision: 2,
    }, ctx);

    assert.deepStrictEqual([created.status, updated.status, deleted.status], [201, 200, 200]);
    assert.deepStrictEqual(
      [parseJSON(created.body).revision, parseJSON(updated.body).revision, parseJSON(deleted.body).revision],
      [1, 2, 3],
    );
    assert.deepStrictEqual(calls, [
      ["create", { expectedRevision: 0, provider: providerDraft }, modelRuntime],
      ["update", "acme", { expectedRevision: 1, provider: { ...providerDraft, name: "Renamed" } }, modelRuntime],
      ["delete", "acme", { expectedRevision: 2 }, modelRuntime],
    ]);
    assert.deepStrictEqual(syncCalls, ["sync", "sync", "sync"]);
    for (const result of [created, updated, deleted]) {
      assert.equal(result.body.includes(apiSecret), false);
      assert.equal(result.body.includes(headerSecret), false);
    }
  });

  it("maps official collisions, stale revisions, and references to stable 409 responses", async () => {
    const references = [
      { kind: "currentModel", providerId: "acme", modelId: "model-a" },
      {
        kind: "customAgent",
        providerId: "acme",
        modelId: "model-b",
        agentId: "reviewer",
        agentName: "Reviewer",
      },
    ];
    const cases = [
      {
        error: new CustomProviderIdConflict("openai", "official"),
        expected: { error: "Provider ID is already in use", code: "provider_id_conflict", providerId: "openai" },
      },
      {
        error: new CustomProviderRevisionConflict(2, 7),
        expected: { error: "Custom provider revision conflict", code: "revision_conflict", currentRevision: 7 },
      },
      {
        error: new CustomProviderReferenceConflict(references),
        expected: { error: "Custom provider is still in use", code: "provider_in_use", references },
      },
    ];

    for (const entry of cases) {
      const ctx = mockContext({ customProviderService: service({ create: async () => { throw entry.error; } }) });
      const result = await callHandler(handleSettings, "POST", "/api/custom-providers", {
        expectedRevision: 0,
        provider: providerDraft,
      }, ctx);
      assert.strictEqual(result.status, 409);
      assert.deepStrictEqual(parseJSON(result.body), entry.expected);
      assert.equal(result.body.includes(apiSecret), false);
      assert.equal(result.body.includes(headerSecret), false);
    }
  });

  it("fails closed when the service is absent and sanitizes unexpected service errors", async () => {
    const missing = await callHandler(
      handleSettings,
      "GET",
      "/api/custom-providers",
      undefined,
      mockContext({ customProviderService: undefined }),
    );
    assert.strictEqual(missing.status, 503);
    assert.deepStrictEqual(parseJSON(missing.body), {
      error: "Custom providers unavailable",
      code: "service_unavailable",
    });

    const ctx = mockContext({
      customProviderService: service({
        create: async () => { throw new Error(`upstream included ${apiSecret} and ${headerSecret}`); },
      }),
    });
    const failed = await callHandler(handleSettings, "POST", "/api/custom-providers", {
      expectedRevision: 0,
      provider: providerDraft,
    }, ctx);
    assert.strictEqual(failed.status, 500);
    assert.deepStrictEqual(parseJSON(failed.body), {
      error: "Custom provider request failed",
      code: "internal_error",
    });
    assert.equal(failed.body.includes(apiSecret), false);
    assert.equal(failed.body.includes(headerSecret), false);
  });

  it("reveals only the explicitly requested provider API key and never Header values", async () => {
    const requested = [];
    const ctx = mockContext({
      customProviderService: service({
        async revealApiKey(providerId) {
          requested.push(providerId);
          return apiSecret;
        },
      }),
    });

    const result = await callHandler(handleSettings, "POST", "/api/custom-providers/reveal", {
      providerId: "acme",
    }, ctx);
    assert.strictEqual(result.status, 200);
    assert.deepStrictEqual(parseJSON(result.body), { apiKey: apiSecret });
    assert.deepStrictEqual(requested, ["acme"]);
    assert.equal(result.body.includes(headerSecret), false);
    assert.equal(Object.hasOwn(parseJSON(result.body), "headers"), false);
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
    const ctx = mockContext({ runtime: mockRuntime({ createNewSession: async () => "sess-created" }) });
    const { status, body } = await callHandler(handleSessions, "POST", "/api/sessions/new", { workspace: ROOT }, ctx);
    assert.strictEqual(status, 200);
    const data = parseJSON(body);
    assert.deepStrictEqual(data, { ok: true, id: "sess-created" });
    assert.deepStrictEqual(ctx.appEvents.published.map((event) => event.type), ["dashboard.changed", "usage.changed"]);
  });

  it("keeps the new-session response when the UI publisher throws", async () => {
    const ctx = mockContext({
      runtime: mockRuntime({ createNewSession: async () => "sess-created" }),
      appEvents: mockAppEvents({ publish() { throw new Error("UI unavailable"); } }),
    });
    const { status, body } = await callHandler(handleSessions, "POST", "/api/sessions/new", { workspace: ROOT }, ctx);
    assert.strictEqual(status, 200);
    assert.deepStrictEqual(parseJSON(body), { ok: true, id: "sess-created" });
  });

  it("does not publish when session creation fails", async () => {
    const ctx = mockContext({
      runtime: mockRuntime({ createNewSession: async () => { throw new Error("create failed"); } }),
    });
    const { status, body } = await callHandler(handleSessions, "POST", "/api/sessions/new", { workspace: ROOT }, ctx);
    assert.strictEqual(status, 400);
    assert.deepStrictEqual(parseJSON(body), { error: "create failed" });
    assert.deepStrictEqual(ctx.appEvents.published, []);
  });

  it("publishes dashboard and usage changes after activating a session", async () => {
    const root = mkdtempSync(resolve(tmpdir(), "session-activate-events-"));
    const workspace = resolve(root, "workspace");
    const sessionsDir = resolve(root, "sessions");
    const sessionDir = resolve(sessionsDir, "by-project", "workspace");
    const sessionFile = resolve(sessionDir, "activate-me.jsonl");
    mkdirSync(workspace, { recursive: true });
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(sessionFile, JSON.stringify({ type: "session", id: "activate-me", workspace }) + "\n");
    const runtime = mockRuntime({
      currentWorkspace: workspace,
      openSession: async () => {},
      getActiveSession: () => ({ id: "activate-me", file: sessionFile }),
    });
    const ctx = mockContext({
      runtime,
      paths: {
        ...mockPaths(),
        APP_ROOT: workspace,
        DATA_DIR: root,
        PI_CONFIG_DIR: resolve(root, "pi"),
        SESSIONS_DIR: sessionsDir,
      },
    });
    try {
      const { status, body } = await callHandler(handleSessions, "POST", "/api/sessions/activate", { id: "activate-me", workspace }, ctx);
      assert.strictEqual(status, 200);
      assert.deepStrictEqual(parseJSON(body), { ok: true, activeSessionId: "activate-me", messages: [] });
      assert.deepStrictEqual(ctx.appEvents.published.map((event) => event.type), ["dashboard.changed", "usage.changed"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(ctx.paths._tmpDir, { recursive: true, force: true });
    }
  });

  it("activates a session from the authorized requested workspace", async () => {
    const root = mkdtempSync(resolve(tmpdir(), "session-activate-workspace-"));
    const currentWorkspace = resolve(root, "current-workspace");
    const requestedWorkspace = resolve(root, "requested-workspace");
    const requestedSessionsDir = workspaceDataPaths(root, requestedWorkspace).sessionsDir;
    const sessionFile = resolve(requestedSessionsDir, "activate-requested.jsonl");
    mkdirSync(currentWorkspace, { recursive: true });
    mkdirSync(requestedWorkspace, { recursive: true });
    mkdirSync(requestedSessionsDir, { recursive: true });
    writeFileSync(sessionFile, JSON.stringify({ type: "session", id: "activate-requested", cwd: requestedWorkspace }) + "\n");
    let openedFile = "";
    let openedWorkspace = "";
    const authorizedRoots = [];
    const runtime = mockRuntime({
      currentWorkspace,
      openSession: async (file, workspace) => {
        openedFile = file;
        openedWorkspace = workspace;
      },
      getActiveSession: () => openedFile ? { id: "activate-requested", file: openedFile } : null,
    });
    const ctx = mockContext({
      runtime,
      permissionService: {
        authorizeWorkspaceRoot: async () => requestedWorkspace,
        authorizePath: async (sessionsRoot, target, operation) => {
          authorizedRoots.push(sessionsRoot);
          return {
            operation,
            root: sessionsRoot,
            path: target,
            relativePath: target.slice(sessionsRoot.length),
          };
        },
      },
      paths: {
        ...mockPaths(),
        APP_ROOT: currentWorkspace,
        DATA_DIR: root,
        PI_CONFIG_DIR: resolve(root, "pi"),
        SESSIONS_DIR: resolve(root, "pi", "sessions"),
        STARTUP: { dataRoot: root, workspace: currentWorkspace },
      },
    });
    try {
      const { status, body } = await callHandler(
        handleSessions,
        "POST",
        "/api/sessions/activate",
        { id: "activate-requested", workspace: requestedWorkspace },
        ctx,
      );
      assert.strictEqual(status, 200);
      assert.strictEqual(parseJSON(body).activeSessionId, "activate-requested");
      assert.strictEqual(openedFile, sessionFile);
      assert.strictEqual(openedWorkspace, requestedWorkspace);
      assert.ok(authorizedRoots.length > 0);
      assert.deepStrictEqual([...new Set(authorizedRoots)], [requestedSessionsDir]);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(ctx.paths._tmpDir, { recursive: true, force: true });
    }
  });

  it("publishes after branching opens a new active session", async () => {
    const root = mkdtempSync(resolve(tmpdir(), "session-branch-events-"));
    const workspace = resolve(root, "workspace");
    const sessionsDir = resolve(root, "sessions");
    const sessionDir = resolve(sessionsDir, "by-project", "workspace");
    const sourceFile = resolve(sessionDir, "source.jsonl");
    mkdirSync(workspace, { recursive: true });
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(sourceFile, JSON.stringify({ type: "session", id: "source", workspace }) + "\n");
    let openedFile = "";
    const runtime = mockRuntime({
      currentWorkspace: workspace,
      openSession: async (file) => { openedFile = file; },
      getActiveSession: () => openedFile ? { id: openedFile.split(/[\\/]/).at(-1).replace(/\.jsonl$/, ""), file: openedFile } : null,
    });
    const ctx = mockContext({
      runtime,
      paths: {
        ...mockPaths(),
        APP_ROOT: workspace,
        DATA_DIR: root,
        PI_CONFIG_DIR: resolve(root, "pi"),
        SESSIONS_DIR: sessionsDir,
      },
    });
    try {
      const { status, body } = await callHandler(handleSessions, "POST", "/api/sessions/branch", { id: "source", workspace, name: "Branch" }, ctx);
      const data = parseJSON(body);
      assert.strictEqual(status, 200);
      assert.strictEqual(data.ok, true);
      assert.strictEqual(data.activeSessionId, data.id);
      assert.ok(openedFile.endsWith(`${data.id}.jsonl`));
      assert.ok(Array.isArray(data.messages));
      assert.deepStrictEqual(ctx.appEvents.published.map((event) => event.type), ["dashboard.changed", "usage.changed"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(ctx.paths._tmpDir, { recursive: true, force: true });
    }
  });

  it("does not publish when session activation fails", async () => {
    const root = mkdtempSync(resolve(tmpdir(), "session-activate-fail-events-"));
    const workspace = resolve(root, "workspace");
    const sessionsDir = resolve(root, "sessions");
    const sessionDir = resolve(sessionsDir, "by-project", "workspace");
    mkdirSync(workspace, { recursive: true });
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(resolve(sessionDir, "activate-me.jsonl"), JSON.stringify({ type: "session", id: "activate-me", workspace }) + "\n");
    const ctx = mockContext({
      runtime: mockRuntime({
        currentWorkspace: workspace,
        openSession: async () => { throw new Error("open failed"); },
        getActiveSession: () => null,
      }),
      paths: {
        ...mockPaths(),
        APP_ROOT: workspace,
        DATA_DIR: root,
        PI_CONFIG_DIR: resolve(root, "pi"),
        SESSIONS_DIR: sessionsDir,
      },
    });
    try {
      const { status, body } = await callHandler(handleSessions, "POST", "/api/sessions/activate", { id: "activate-me", workspace }, ctx);
      assert.strictEqual(status, 400);
      assert.deepStrictEqual(parseJSON(body), { error: "open failed" });
      assert.deepStrictEqual(ctx.appEvents.published, []);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(ctx.paths._tmpDir, { recursive: true, force: true });
    }
  });

  it("does not publish when opening a branched session fails", async () => {
    const root = mkdtempSync(resolve(tmpdir(), "session-branch-fail-events-"));
    const workspace = resolve(root, "workspace");
    const sessionsDir = resolve(root, "sessions");
    const sessionDir = resolve(sessionsDir, "by-project", "workspace");
    mkdirSync(workspace, { recursive: true });
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(resolve(sessionDir, "source.jsonl"), JSON.stringify({ type: "session", id: "source", workspace }) + "\n");
    const ctx = mockContext({
      runtime: mockRuntime({
        currentWorkspace: workspace,
        openSession: async () => { throw new Error("branch open failed"); },
      }),
      paths: {
        ...mockPaths(),
        APP_ROOT: workspace,
        DATA_DIR: root,
        PI_CONFIG_DIR: resolve(root, "pi"),
        SESSIONS_DIR: sessionsDir,
      },
    });
    try {
      const { status, body } = await callHandler(handleSessions, "POST", "/api/sessions/branch", { id: "source", workspace }, ctx);
      assert.strictEqual(status, 400);
      assert.deepStrictEqual(parseJSON(body), { error: "branch open failed" });
      assert.deepStrictEqual(ctx.appEvents.published, []);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(ctx.paths._tmpDir, { recursive: true, force: true });
    }
  });

  it("POST /api/sessions/rename 不存在的 ID 仍返回 ok", async () => {
    const ctx = mockContext();
    const { status, body } = await callHandler(handleSessions, "POST", "/api/sessions/rename", { id: "nonexistent", name: "新名字" }, ctx);
    assert.strictEqual(status, 200);
    assert.ok(parseJSON(body).ok);
  });

  it("POST /api/sessions/rename 持久化 titleSource 并在列表返回", async () => {
    const tmpDir = mkdtempSync(resolve(tmpdir(), "session-title-source-"));
    const sessionsDir = resolve(tmpDir, "data", "pi", "sessions");
    const workspace = resolve(tmpDir, "project-title-source");
    const projectDir = resolve(sessionsDir, "by-project", "project-title-source");
    mkdirSync(workspace, { recursive: true });
    mkdirSync(projectDir, { recursive: true });
    const sessionFile = resolve(projectDir, "sess-title-source.jsonl");
    writeFileSync(sessionFile, [
      JSON.stringify({ type: "session", id: "sess-title-source", timestamp: "2026-07-27T00:00:00.000Z", workspace }),
      JSON.stringify({ type: "message", timestamp: "2026-07-27T00:00:01.000Z", message: { role: "user", content: [{ type: "text", text: "帮我自动命名会话" }] } }),
    ].join("\n") + "\n");

    try {
      const ctx = mockContext({
        runtime: mockRuntime({ currentWorkspace: workspace }),
        paths: {
          ...mockPaths(),
          APP_ROOT: workspace,
          DATA_DIR: resolve(tmpDir, "data"),
          PI_CONFIG_DIR: resolve(tmpDir, "data", "pi"),
          SESSIONS_DIR: sessionsDir,
        },
      });
      const renamed = await callHandler(handleSessions, "POST", "/api/sessions/rename", { id: "sess-title-source", name: "自动标题", titleSource: "auto" }, ctx);
      assert.strictEqual(renamed.status, 200);
      assert.ok(parseJSON(renamed.body).ok);
      assert.match(readFileSync(sessionFile, "utf-8"), /"titleSource":"auto"/);

      const listed = await callHandler(handleSessions, "GET", `/api/sessions?workspace=${encodeURIComponent(workspace)}`, undefined, ctx);
      assert.strictEqual(listed.status, 200);
      const data = parseJSON(listed.body);
      const item = data.sessions.find((session) => session.id === "sess-title-source");
      assert.ok(item, "应返回重命名的会话");
      assert.strictEqual(item.name, "自动标题");
      assert.strictEqual(item.titleSource, "auto");
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
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

describe("search replace route", () => {
  it("POST /api/search/replace preview ok", async () => {
    const ctx = mockContext();
    const { status, body } = await callHandler(
      handleSearch, "POST", "/api/search/replace",
      { query: "function", replacement: "fn", root: ROOT, type: "text", previewOnly: true },
      ctx,
    );
    assert.strictEqual(status, 200);
    const data = parseJSON(body);
    assert.strictEqual(data.preview, true);
    assert.ok(typeof data.totalChanges === "number");
    assert.ok(Array.isArray(data.files));
  });

  it("POST /api/search/replace missing query 400", async () => {
    const ctx = mockContext();
    const { status } = await callHandler(
      handleSearch, "POST", "/api/search/replace",
      { replacement: "fn", type: "text" },
      ctx,
    );
    assert.strictEqual(status, 400);
  });

  it("POST /api/search/replace type=filename 400", async () => {
    const ctx = mockContext();
    const { status } = await callHandler(
      handleSearch, "POST", "/api/search/replace",
      { query: "test", replacement: "x", type: "filename" },
      ctx,
    );
    assert.strictEqual(status, 400);
  });

  it("POST /api/search/replace path traversal 403", async () => {
    const ctx = mockContext();
    const { status } = await callHandler(
      handleSearch, "POST", "/api/search/replace",
      { query: "test", replacement: "x", root: "../../../etc", type: "text" },
      ctx,
    );
    assert.strictEqual(status, 403);
  });
});

describe("search conversations route", () => {
  it("POST /api/search/conversations 返回 JSON", async () => {
    const ctx = mockContext();
    const { status, body } = await callHandler(
      handleSearch, "POST", "/api/search/conversations",
      { query: "test" },
      ctx,
    );
    assert.strictEqual(status, 200);
    const data = parseJSON(body);
    assert.ok(Array.isArray(data.results), "results 为数组");
    assert.ok(typeof data.total === "number", "total 为数字");
    assert.ok(typeof data.truncated === "boolean", "truncated 为布尔");
  });

  it("POST /api/search/conversations 缺少 query 返回 400", async () => {
    const ctx = mockContext();
    const { status } = await callHandler(
      handleSearch, "POST", "/api/search/conversations",
      {},
      ctx,
    );
    assert.strictEqual(status, 400);
  });

  it("POST /api/search/conversations 返回 0-based msgIndex", async () => {
    const tmpDir = mkdtempSync(resolve(tmpdir(), "conv-search-"));
    const sessionsDir = resolve(tmpDir, "data", "pi", "sessions");
    const projectDir = resolve(sessionsDir, "by-project", "demo");
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(resolve(projectDir, "sess-1.jsonl"), [
      JSON.stringify({ type: "session", id: "sess-1", timestamp: "2026-07-25T00:00:00.000Z", workspace: "E:/my-code-agent" }),
      JSON.stringify({ type: "session_info", timestamp: "2026-07-25T00:00:01.000Z", name: "needle session" }),
      JSON.stringify({ type: "message", timestamp: "2026-07-25T00:00:02.000Z", message: { role: "user", content: [{ type: "text", text: "first needle hit" }] } }),
      JSON.stringify({ type: "message", timestamp: "2026-07-25T00:00:03.000Z", message: { role: "assistant", content: [{ type: "text", text: "second message" }] } }),
    ].join("\n") + "\n");

    const ctx = mockContext({
      paths: {
        APP_ROOT: ROOT,
        DATA_DIR: resolve(tmpDir, "data"),
        PI_CONFIG_DIR: resolve(tmpDir, "data", "pi"),
        SESSIONS_DIR: sessionsDir,
        SETTINGS_FILE: resolve(tmpDir, "data", "pi", "settings.json"),
        FRONTEND_DIR: resolve(ROOT, "dist", "frontend"),
        FRONTEND_SRC_DIR: resolve(ROOT, "src", "frontend"),
        HAS_BUILT_FRONTEND: false,
        _tmpDir: tmpDir,
      },
    });

    try {
      const { status, body } = await callHandler(
        handleSearch, "POST", "/api/search/conversations",
        { query: "needle" },
        ctx,
      );
      assert.strictEqual(status, 200);
      const data = parseJSON(body);
      assert.ok(Array.isArray(data.results) && data.results.length > 0, "应返回结果");
      const msgIndexes = data.results.flatMap((result) => result.matches.map((match) => match.msgIndex).filter((value) => value !== undefined));
      assert.ok(msgIndexes.includes(0), "应包含 0-based 的首条消息索引 0");
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("POST /api/search/conversations 的 msgIndex 跟可见消息对齐", async () => {
    const tmpDir = mkdtempSync(resolve(tmpdir(), "conv-search-visible-"));
    const sessionsDir = resolve(tmpDir, "data", "pi", "sessions");
    const projectDir = resolve(sessionsDir, "by-project", "demo");
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(resolve(projectDir, "sess-visible.jsonl"), [
      JSON.stringify({ type: "session", id: "sess-visible", timestamp: "2026-07-25T00:00:00.000Z", workspace: "E:/my-code-agent" }),
      JSON.stringify({ type: "session_info", timestamp: "2026-07-25T00:00:01.000Z", name: "visible session" }),
      JSON.stringify({ type: "message", timestamp: "2026-07-25T00:00:02.000Z", message: { role: "user", content: [{ type: "text", text: "first visible message" }] } }),
      JSON.stringify({ type: "message", timestamp: "2026-07-25T00:00:03.000Z", message: { role: "toolResult", toolName: "shell", content: [{ type: "text", text: "hidden tool output" }] } }),
      JSON.stringify({ type: "message", timestamp: "2026-07-25T00:00:04.000Z", message: { role: "assistant", content: [{ type: "text", text: "target needle reply" }] } }),
    ].join("\n") + "\n");

    const ctx = mockContext({
      paths: {
        APP_ROOT: ROOT,
        DATA_DIR: resolve(tmpDir, "data"),
        PI_CONFIG_DIR: resolve(tmpDir, "data", "pi"),
        SESSIONS_DIR: sessionsDir,
        SETTINGS_FILE: resolve(tmpDir, "data", "pi", "settings.json"),
        FRONTEND_DIR: resolve(ROOT, "dist", "frontend"),
        FRONTEND_SRC_DIR: resolve(ROOT, "src", "frontend"),
        HAS_BUILT_FRONTEND: false,
        _tmpDir: tmpDir,
      },
    });

    try {
      const { status, body } = await callHandler(
        handleSearch, "POST", "/api/search/conversations",
        { query: "needle" },
        ctx,
      );
      assert.strictEqual(status, 200);
      const data = parseJSON(body);
      const hit = data.results[0]?.matches.find((match) => match.text.includes("needle"));
      assert.ok(hit, "应返回 assistant 命中的结果");
      assert.strictEqual(hit.msgIndex, 1, "toolResult 不应占用前端可见消息索引");
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("POST /api/search/conversations 同一消息多处命中返回多条可定位结果", async () => {
    const tmpDir = mkdtempSync(resolve(tmpdir(), "conv-search-multi-"));
    const sessionsDir = resolve(tmpDir, "data", "pi", "sessions");
    const projectDir = resolve(sessionsDir, "by-project", "demo");
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(resolve(projectDir, "sess-multi.jsonl"), [
      JSON.stringify({ type: "session", id: "sess-multi", timestamp: "2026-07-25T00:00:00.000Z", workspace: "E:/my-code-agent" }),
      JSON.stringify({ type: "session_info", timestamp: "2026-07-25T00:00:01.000Z", name: "multi session" }),
      JSON.stringify({ type: "message", timestamp: "2026-07-25T00:00:02.000Z", message: { role: "assistant", content: [{ type: "text", text: "needle one, then needle two, then needle three" }] } }),
    ].join("\n") + "\n");

    const ctx = mockContext({
      paths: {
        APP_ROOT: ROOT,
        DATA_DIR: resolve(tmpDir, "data"),
        PI_CONFIG_DIR: resolve(tmpDir, "data", "pi"),
        SESSIONS_DIR: sessionsDir,
        SETTINGS_FILE: resolve(tmpDir, "data", "pi", "settings.json"),
        FRONTEND_DIR: resolve(ROOT, "dist", "frontend"),
        FRONTEND_SRC_DIR: resolve(ROOT, "src", "frontend"),
        HAS_BUILT_FRONTEND: false,
        _tmpDir: tmpDir,
      },
    });

    try {
      const { status, body } = await callHandler(
        handleSearch, "POST", "/api/search/conversations",
        { query: "needle" },
        ctx,
      );
      assert.strictEqual(status, 200);
      const data = parseJSON(body);
      const hits = data.results[0]?.matches.filter((match) => match.msgIndex === 0) || [];
      assert.strictEqual(hits.length, 3, "同一可见消息内的每处命中都应独立返回");
      assert.deepStrictEqual(hits.map((hit) => hit.matchOrdinal), [0, 1, 2]);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

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

  it("GET /api/file/raw 返回 image/png", async () => {
    const dir = mkdtempSync(resolve(tmpdir(), "raw-test-"));
    try {
      writeFileSync(resolve(dir, "test.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
      const ctx = mockContext({ paths: { ...mockPaths(), APP_ROOT: dir } });
      const { status, headers: h } = await callHandler(handleExplorer, "GET", `/api/file/raw?root=${encodeURIComponent(dir)}&path=test.png`, undefined, ctx);
      assert.strictEqual(status, 200);
      assert.strictEqual(h["Content-Type"], "image/png");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("GET /api/file/raw 返回 video/mp4", async () => {
    const dir = mkdtempSync(resolve(tmpdir(), "raw-test-"));
    try {
      writeFileSync(resolve(dir, "test.mp4"), Buffer.from([0x00, 0x00, 0x00, 0x1c]));
      const ctx = mockContext({ paths: { ...mockPaths(), APP_ROOT: dir } });
      const { status, headers: h } = await callHandler(handleExplorer, "GET", `/api/file/raw?root=${encodeURIComponent(dir)}&path=test.mp4`, undefined, ctx);
      assert.strictEqual(status, 200);
      assert.strictEqual(h["Content-Type"], "video/mp4");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("GET /api/file/raw unsupported 类型返回 403", async () => {
    const dir = mkdtempSync(resolve(tmpdir(), "raw-test-"));
    try {
      writeFileSync(resolve(dir, "test.exe"), Buffer.from([0x4d, 0x5a]));
      const ctx = mockContext({ paths: { ...mockPaths(), APP_ROOT: dir } });
      const { status, body } = await callHandler(handleExplorer, "GET", `/api/file/raw?root=${encodeURIComponent(dir)}&path=test.exe`, undefined, ctx);
      const data = parseJSON(body);
      assert.strictEqual(status, 403);
      assert.ok(data?.error?.includes("Unsupported"), "应提示 Unsupported");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("GET /api/file/raw ../ 路径穿越被拒绝", async () => {
    const ctx = mockContext();
    const { status, body } = await callHandler(handleExplorer, "GET", `/api/file/raw?root=${encodeURIComponent(ROOT)}&path=../../../etc/passwd`, undefined, ctx);
    const data = parseJSON(body);
    assert.strictEqual(status, 403);
    assert.ok(data?.error, "应返回 error");
  });

  it("GET /api/explorer ../ 兄弟目录逃逸被拒绝", async () => {
    const parent = mkdtempSync(resolve(tmpdir(), "explorer-guard-"));
    try {
      const root = resolve(parent, "root");
      mkdirSync(root);
      mkdirSync(resolve(parent, "root-evil"));
      const ctx = mockContext({ paths: { ...mockPaths(), APP_ROOT: root } });
      const { status, body } = await callHandler(handleExplorer, "GET", `/api/explorer?root=${encodeURIComponent(root)}&path=../root-evil`, undefined, ctx);
      const data = parseJSON(body);
      assert.strictEqual(status, 403);
      assert.ok(data?.error, "应返回 error");
    } finally { rmSync(parent, { recursive: true, force: true }); }
  });

  it("POST /api/file/write 拒绝兄弟目录前缀逃逸", async () => {
    const parent = mkdtempSync(resolve(tmpdir(), "explorer-write-guard-"));
    try {
      const root = resolve(parent, "root");
      const sibling = resolve(parent, "root-evil");
      mkdirSync(root);
      mkdirSync(sibling);
      const target = resolve(sibling, "pwn.txt");
      const ctx = mockContext({ paths: { ...mockPaths(), APP_ROOT: root } });

      const { status, body } = await callHandler(
        handleExplorer,
        "POST",
        "/api/file/write",
        { root, path: "../root-evil/pwn.txt", content: "owned" },
        ctx,
      );

      const data = parseJSON(body);
      assert.strictEqual(status, 403);
      assert.ok(data?.error, "应返回安全拒绝错误");
      assert.strictEqual(existsSync(target), false, "不应写入兄弟目录");
    } finally { rmSync(parent, { recursive: true, force: true }); }
  });

  it("POST /api/file/delete 拒绝兄弟目录前缀逃逸", async () => {
    const parent = mkdtempSync(resolve(tmpdir(), "explorer-delete-guard-"));
    try {
      const root = resolve(parent, "root");
      const sibling = resolve(parent, "root-evil");
      mkdirSync(root);
      mkdirSync(sibling);
      const target = resolve(sibling, "keep.txt");
      writeFileSync(target, "keep");
      const ctx = mockContext({ paths: { ...mockPaths(), APP_ROOT: root } });

      const { status, body } = await callHandler(
        handleExplorer,
        "POST",
        "/api/file/delete",
        { root, path: "../root-evil/keep.txt" },
        ctx,
      );

      const data = parseJSON(body);
      assert.strictEqual(status, 403);
      assert.ok(data?.error, "应返回安全拒绝错误");
      assert.strictEqual(readFileSync(target, "utf-8"), "keep", "不应删除兄弟目录文件");
    } finally { rmSync(parent, { recursive: true, force: true }); }
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

  it("真实 HTTP server 中 GET /api/file/raw 支持 Range 请求", async () => {
    const dir = mkdtempSync(resolve(tmpdir(), "range-test-"));
    try {
      writeFileSync(resolve(dir, "v.mp4"), Buffer.from([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]));
      const ctx = mockContext({ paths: { ...mockPaths(), APP_ROOT: dir } });
      const server = createServer(async (req, res) => {
        const handled = await handleExplorer(req, res, ctx);
        if (!handled) { res.writeHead(404); res.end("Not found"); }
      });
      const addr = server.listen(0, "127.0.0.1");
      await new Promise(r => addr.on("listening", r));
      const port = addr.address().port;
      const response = await fetch(`http://127.0.0.1:${port}/api/file/raw?root=${encodeURIComponent(dir)}&path=v.mp4`, { headers: { "Range": "bytes=2-5" } });
      assert.strictEqual(response.status, 206);
      assert.strictEqual(response.headers.get("content-range"), "bytes 2-5/10");
      assert.strictEqual(response.headers.get("accept-ranges"), "bytes");
      const bytes = Array.from(new Uint8Array(await response.arrayBuffer()));
      assert.deepStrictEqual(bytes, [2, 3, 4, 5]);
      server.close();
    } finally { rmSync(dir, { recursive: true, force: true }); }
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
