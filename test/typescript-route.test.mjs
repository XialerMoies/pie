/**
 * monaco-setup 通信测试
 *
 * 验证 tsserver IPC 请求/响应格式，mock 后端 handler 和 tsServer。
 *
 * 运行：npx tsx --test test/monaco-setup.test.mjs
 */
import { describe, it, before } from "node:test";
import assert from "node:assert";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const ROOT = resolve(__dirname, "..");

// 简化版 callHandler（避免 HTTP server）
async function callHandler(handler, method, url, body, ctx) {
  const req = {
    url, method,
    headers: { host: "localhost", "content-type": "application/json" },
    on(event, cb) {
      if (event === "data" && body) cb(Buffer.from(JSON.stringify(body)));
      if (event === "end") cb();
      return req;
    },
  };
  const res = {
    _body: "", _status: 0,
    writeHead(s, h) { this._status = s; if (h) Object.assign(this, h); return this; },
    end(d) { if (d) this._body += d; return this; },
    write() { return true; }, on() { return this; },
  };
  const handled = await handler(req, res, ctx);
  return { handled, status: res._status, body: res._body };
}

describe("tsserver 通信", () => {
  let handleTypeScript;

  const mockTsServer = {
    send: async (cmd) => ({ success: true, ...cmd }),
    start: async () => {},
    init: async () => {},
    isRunning: () => true,
  };

  const ctx = {
    session: {},
    modelRegistry: {},
    chatStream: {},
    sseClients: [],
    paths: {
      APP_ROOT: ROOT,
      DATA_DIR: resolve(ROOT, "data"),
      PI_CONFIG_DIR: resolve(ROOT, "data", "pi"),
      SESSIONS_DIR: resolve(ROOT, "data", "pi", "sessions"),
      SETTINGS_FILE: resolve(ROOT, "data", "pi", "settings.json"),
      FRONTEND_DIR: resolve(ROOT, "dist", "frontend"),
      FRONTEND_SRC_DIR: resolve(ROOT, "src", "frontend"),
      HAS_BUILT_FRONTEND: false,
    },
    tsServer: mockTsServer,
  };

  before(async () => {
    const ts = Date.now();
    const mod = await import(`../src/server/routes/typescript.ts?t=${ts}`);
    handleTypeScript = mod.handleTypeScript;
  });

  it("非 /api/ts/ 路径返回 false", async () => {
    const { handled } = await callHandler(handleTypeScript, "GET", "/api/other", null, ctx);
    assert.strictEqual(handled, false);
  });

  it("POST /api/ts/open 返回 200 JSON", async () => {
    const { status, body } = await callHandler(handleTypeScript, "POST", "/api/ts/open", { file: "/test.ts", content: "const x = 1;", scriptKindName: "TS" }, ctx);
    assert.strictEqual(status, 200);
    const data = JSON.parse(body);
    assert.ok(data);
  });

  it("POST /api/ts/open 缺少 file 返回错误", async () => {
    const { status, body } = await callHandler(handleTypeScript, "POST", "/api/ts/open", { content: "x" }, ctx);
    const data = JSON.parse(body);
    // 可能返回 400 或 200 + error
    assert.ok(data.error || status === 400);
  });

  it("POST /api/ts/change 返回 200", async () => {
    const { status } = await callHandler(handleTypeScript, "POST", "/api/ts/change", { file: "/test.ts", content: "const y = 2;" }, ctx);
    assert.strictEqual(status, 200);
  });

  it("POST /api/ts/close 返回 200", async () => {
    const { status } = await callHandler(handleTypeScript, "POST", "/api/ts/close", { file: "/test.ts" }, ctx);
    assert.strictEqual(status, 200);
  });

  it("POST /api/ts/completions 返回 JSON", async () => {
    const { status, body } = await callHandler(handleTypeScript, "POST", "/api/ts/completions", { file: "/test.ts", line: 1, offset: 1 }, ctx);
    assert.strictEqual(status, 200);
    const data = JSON.parse(body);
    assert.ok(Array.isArray(data?.entries ?? []));
  });

  it("POST /api/ts/quickinfo 返回 JSON", async () => {
    const { status, body } = await callHandler(handleTypeScript, "POST", "/api/ts/quickinfo", { file: "/test.ts", line: 1, offset: 1 }, ctx);
    assert.strictEqual(status, 200);
  });

  it("POST /api/ts/definition 返回 JSON", async () => {
    const { status, body } = await callHandler(handleTypeScript, "POST", "/api/ts/definition", { file: "/test.ts", line: 1, offset: 1 }, ctx);
    assert.strictEqual(status, 200);
  });

  it("POST /api/ts/references 返回 JSON", async () => {
    const { status, body } = await callHandler(handleTypeScript, "POST", "/api/ts/references", { file: "/test.ts", line: 1, offset: 1 }, ctx);
    assert.strictEqual(status, 200);
  });

  it("GET /api/ts/diagnostics 返回 JSON", async () => {
    const req = { url: "/api/ts/diagnostics?file=/test.ts", method: "GET", headers: { host: "localhost" }, on: () => req };
    const res = { _body: "", _status: 0, writeHead(s, h) { this._status = s; return this; }, end(d) { if (d) this._body += d; return this; }, write() { return true; }, on: () => res };
    const handled = await handleTypeScript(req, res, ctx);
    assert.strictEqual(handled, true);
    const data = JSON.parse(res._body);
    assert.ok(data);
  });
});
