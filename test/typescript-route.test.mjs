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

  const sendRequest = async (cmd, args) => {
    switch (cmd) {
      case "semanticDiagnosticsSync":
      case "syntacticDiagnosticsSync":
        return [];
      case "completionInfo":
        return { entries: [] };
      case "quickinfo":
        return { displayString: "const test: number", documentation: "" };
      case "definitionAndBoundSpan":
        return { definitions: [] };
      case "references":
        return { refs: [] };
      case "getCodeFixes":
        return [{ description: "fix it", changes: [{ fileName: "/test.ts", textChanges: [{ span: { start: { line: 1, offset: 1 }, end: { line: 1, offset: 1 } }, newText: "const fixed = true;\n" }] }], commands: [], fixId: "fix", fixName: "fix-it", fixAllDescription: "Fix it" }];
      case "getApplicableRefactors":
        return [{ name: "Extract type", description: "Extract type", actions: [{ name: "Extract to type alias", description: "Extract to type alias", kind: "refactor.extract.type" }] }];
      case "getEditsForRefactor":
        return { edits: [{ fileName: "/test.ts", textChanges: [{ span: { start: { line: 1, offset: 1 }, end: { line: 1, offset: 1 } }, newText: "type Extracted = string;\n" }] }], renameFilename: undefined, renameLocation: undefined };
      default:
        return { success: true, command: cmd, arguments: args };
    }
  };

  const mockTsServer = {
    sendRequest,
    send: sendRequest,
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

  it("POST /api/ts/code-actions 支持 quickfix", async () => {
    const { status, body } = await callHandler(handleTypeScript, "POST", "/api/ts/code-actions", { file: "/test.ts", line: 1, offset: 1, endLine: 1, endOffset: 1, errorCodes: [1001] }, ctx);
    assert.strictEqual(status, 200);
    const data = JSON.parse(body);
    assert.ok(Array.isArray(data.actions));
    assert.strictEqual(data.actions[0].kind, "quickfix");
    assert.strictEqual(data.actions[0].description, "fix it");
  });

  it("POST /api/ts/code-actions 支持 refactor", async () => {
    const { status, body } = await callHandler(handleTypeScript, "POST", "/api/ts/code-actions", { file: "/test.ts", line: 1, offset: 1, endLine: 1, endOffset: 1, errorCodes: [] }, ctx);
    assert.strictEqual(status, 200);
    const data = JSON.parse(body);
    assert.ok(Array.isArray(data.actions));
    assert.strictEqual(data.actions[0].kind, "refactor.extract.type");
    assert.strictEqual(data.actions[0].description, "Extract to type alias");
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
