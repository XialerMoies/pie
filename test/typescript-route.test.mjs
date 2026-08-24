import { describe, it, beforeEach, after } from "node:test";
import assert from "node:assert";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { handleTypeScript } from "../src/server/routes/typescript.ts";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const ROOT = resolve(__dirname, "..");
const TEST_WORKSPACE = mkdtempSync(resolve(ROOT, ".tmp-ts-route-"));
const TEST_FILE = resolve(TEST_WORKSPACE, "test.ts");
const OUTSIDE_FILE = resolve(TEST_WORKSPACE, "..", "outside.ts");

async function callHandler(handler, method, url, body, ctx) {
  const req = {
    url,
    method,
    headers: { host: "localhost", "content-type": "application/json" },
    on(event, cb) {
      if (event === "data" && body) cb(Buffer.from(JSON.stringify(body)));
      if (event === "end") cb();
      return req;
    },
  };
  const res = {
    _body: "",
    _status: 0,
    writeHead(status, headers) {
      this._status = status;
      if (headers) Object.assign(this, headers);
      return this;
    },
    end(data) {
      if (data) this._body += data;
      return this;
    },
    write() { return true; },
    on() { return this; },
  };
  const handled = await handler(req, res, ctx);
  return { handled, status: res._status, body: res._body };
}

function parseJSON(body) {
  return JSON.parse(body);
}

describe("typescript routes", () => {
  let lastTsRequest = null;
  let isRunningCalls = 0;
  let diagnosticsCalls = 0;
  let diagnosticsFailure = null;
  let organizeImportsResult = null;

  const sendRequest = async (cmd, args) => {
    lastTsRequest = { cmd, args };
    switch (cmd) {
      case "semanticDiagnosticsSync":
      case "syntacticDiagnosticsSync":
        diagnosticsCalls++;
        await new Promise((resolve) => setTimeout(resolve, 20));
        if (diagnosticsFailure) throw new Error(diagnosticsFailure);
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
        return [{
          description: "fix it",
          changes: [{
            fileName: TEST_FILE,
            textChanges: [{
              span: { start: { line: 1, offset: 1 }, end: { line: 1, offset: 1 } },
              newText: "const fixed = true;\n",
            }],
          }],
          commands: [],
          fixId: "fix",
          fixName: "fix-it",
          fixAllDescription: "Fix it",
        }];
      case "getApplicableRefactors":
        return [{
          name: "Extract type",
          description: "Extract type",
          actions: [{
            name: "Extract to type alias",
            description: "Extract to type alias",
            kind: "refactor.extract.type",
          }],
        }];
      case "getEditsForRefactor":
        return {
          edits: [{
            fileName: TEST_FILE,
            textChanges: [{
              span: { start: { line: 1, offset: 1 }, end: { line: 1, offset: 1 } },
              newText: "type Extracted = string;\n",
            }],
          }],
          renameFilename: undefined,
          renameLocation: undefined,
        };
      case "organizeImports":
        return organizeImportsResult ?? [];
      default:
        return { success: true, command: cmd, arguments: args };
    }
  };

  const mockTsServer = {
    sendRequest,
    send: sendRequest,
    start: async () => {},
    init: async () => {},
    isRunning: () => {
      isRunningCalls++;
      return true;
    },
  };

  const ctx = {
    session: {},
    runtime: { currentWorkspace: TEST_WORKSPACE },
    modelRegistry: {},
    chatStream: {},
    sseClients: [],
    paths: {
      APP_ROOT: TEST_WORKSPACE,
      DATA_DIR: resolve(TEST_WORKSPACE, "data"),
      PI_CONFIG_DIR: resolve(TEST_WORKSPACE, "data", "pi"),
      SESSIONS_DIR: resolve(TEST_WORKSPACE, "data", "pi", "sessions"),
      SETTINGS_FILE: resolve(TEST_WORKSPACE, "data", "pi", "settings.json"),
      FRONTEND_DIR: resolve(ROOT, "dist", "frontend"),
      FRONTEND_SRC_DIR: resolve(ROOT, "src", "frontend"),
      HAS_BUILT_FRONTEND: false,
    },
    tsServer: mockTsServer,
  };
  ctx.groups = {
    core: { runtime: ctx.runtime, chatStream: ctx.chatStream, engine: {}, appEvents: { publish() {} } },
    security: {},
    storage: { get paths() { return ctx.paths; } },
    providers: { model: { modelRuntime: {}, modelRegistry: {}, syncModelProviders: async () => 0, runWithStableSession: async (operation) => operation() } },
    infra: { get tsServer() { return ctx.tsServer; } },
  };

  beforeEach(() => {
    lastTsRequest = null;
    isRunningCalls = 0;
    diagnosticsCalls = 0;
    diagnosticsFailure = null;
    organizeImportsResult = null;
    writeFileSync(TEST_FILE, "const test = 1;\n", "utf-8");
  });

  it("coalesces concurrent diagnostics requests for the same file", async () => {
    const [first, second] = await Promise.all([
      callHandler(handleTypeScript, "GET", `/api/ts/diagnostics?file=${encodeURIComponent(TEST_FILE)}&projectRoot=${encodeURIComponent(TEST_WORKSPACE)}`, undefined, ctx),
      callHandler(handleTypeScript, "GET", `/api/ts/diagnostics?file=${encodeURIComponent(TEST_FILE)}&projectRoot=${encodeURIComponent(TEST_WORKSPACE)}`, undefined, ctx),
    ]);

    assert.equal(first.status, 200);
    assert.equal(second.status, 200);
    assert.equal(diagnosticsCalls, 2, "two concurrent route calls should share one semantic+s syntactic pair");
  });

  it("returns a terminal timeout contract instead of empty diagnostics", async () => {
    diagnosticsFailure = "tsserver request timeout: semanticDiagnosticsSync";
    const result = await callHandler(
      handleTypeScript,
      "GET",
      `/api/ts/diagnostics?file=${encodeURIComponent(TEST_FILE)}&projectRoot=${encodeURIComponent(TEST_WORKSPACE)}`,
      undefined,
      ctx,
    );
    const body = parseJSON(result.body);
    assert.equal(result.status, 504);
    assert.equal(body.status, "timeout");
    assert.equal(body.code, "timeout");
    assert.deepEqual(body.diagnostics, []);
  });

  after(() => {
    rmSync(TEST_WORKSPACE, { recursive: true, force: true });
  });

  it("returns false for non-TypeScript routes", async () => {
    const { handled } = await callHandler(handleTypeScript, "GET", "/api/other", null, ctx);
    assert.strictEqual(handled, false);
  });

  it("opens a workspace file and passes the guarded path to tsserver", async () => {
    const { status, body } = await callHandler(handleTypeScript, "POST", "/api/ts/open", {
      file: TEST_FILE,
      content: "const x = 1;",
      scriptKindName: "TS",
    }, ctx);
    assert.strictEqual(status, 200);
    assert.ok(parseJSON(body).ok);
    assert.strictEqual(lastTsRequest?.cmd, "open");
    assert.strictEqual(lastTsRequest?.args?.file, TEST_FILE);
    assert.strictEqual(lastTsRequest?.args?.projectRootPath, TEST_WORKSPACE);
  });

  it("uses runtime.currentWorkspace as the TS authorization root", async () => {
    const workspaceOnlyCtx = {
      ...ctx,
      runtime: { currentWorkspace: TEST_WORKSPACE },
      paths: {
        ...ctx.paths,
        APP_ROOT: resolve(TEST_WORKSPACE, "..", "ts-app-root-unused"),
      },
    };

    const { status, body } = await callHandler(handleTypeScript, "POST", "/api/ts/open", {
      file: TEST_FILE,
      content: "const x = 1;",
      scriptKindName: "TS",
    }, workspaceOnlyCtx);

    assert.strictEqual(status, 200);
    assert.ok(parseJSON(body).ok);
    assert.strictEqual(lastTsRequest?.args?.file, TEST_FILE);
    assert.strictEqual(lastTsRequest?.args?.projectRootPath, TEST_WORKSPACE);
  });

  it("rejects missing file before tsserver", async () => {
    const { status, body } = await callHandler(handleTypeScript, "POST", "/api/ts/open", { content: "x" }, ctx);
    const data = parseJSON(body);
    assert.strictEqual(status, 400);
    assert.strictEqual(data.code, "missing_file");
    assert.strictEqual(lastTsRequest, null);
    assert.strictEqual(isRunningCalls, 0);
  });

  it("rejects files outside the current workspace before tsserver", async () => {
    const { status, body } = await callHandler(handleTypeScript, "POST", "/api/ts/open", {
      file: OUTSIDE_FILE,
      content: "x",
    }, ctx);
    const data = parseJSON(body);
    assert.strictEqual(status, 403);
    assert.strictEqual(data.code, "access_denied");
    assert.strictEqual(lastTsRequest, null);
    assert.strictEqual(isRunningCalls, 0);
  });

  it("handles change, close, completions, quickinfo, definition, and references", async () => {
    assert.strictEqual((await callHandler(handleTypeScript, "POST", "/api/ts/change", {
      file: TEST_FILE,
      content: "const y = 2;",
    }, ctx)).status, 200);
    assert.strictEqual((await callHandler(handleTypeScript, "POST", "/api/ts/close", {
      file: TEST_FILE,
    }, ctx)).status, 200);

    const completions = await callHandler(handleTypeScript, "POST", "/api/ts/completions", {
      file: TEST_FILE,
      line: 1,
      offset: 1,
    }, ctx);
    assert.strictEqual(completions.status, 200);
    assert.ok(Array.isArray(parseJSON(completions.body)?.entries ?? []));

    for (const route of ["/api/ts/quickinfo", "/api/ts/definition", "/api/ts/references"]) {
      const result = await callHandler(handleTypeScript, "POST", route, {
        file: TEST_FILE,
        line: 1,
        offset: 1,
      }, ctx);
      assert.strictEqual(result.status, 200);
    }
  });

  it("returns quickfix and refactor code actions", async () => {
    const quickfix = await callHandler(handleTypeScript, "POST", "/api/ts/code-actions", {
      file: TEST_FILE,
      line: 1,
      offset: 1,
      endLine: 1,
      endOffset: 1,
      errorCodes: [1001],
    }, ctx);
    assert.strictEqual(quickfix.status, 200);
    const quickfixData = parseJSON(quickfix.body);
    assert.strictEqual(quickfixData.actions[0].kind, "quickfix");
    assert.strictEqual(quickfixData.actions[0].description, "fix it");

    const refactor = await callHandler(handleTypeScript, "POST", "/api/ts/code-actions", {
      file: TEST_FILE,
      line: 1,
      offset: 1,
      endLine: 1,
      endOffset: 1,
      errorCodes: [],
    }, ctx);
    assert.strictEqual(refactor.status, 200);
    const refactorData = parseJSON(refactor.body);
    assert.strictEqual(refactorData.actions[0].kind, "refactor.extract.type");
    assert.strictEqual(refactorData.actions[0].description, "Extract to type alias");
  });

  it("returns diagnostics for a guarded workspace file", async () => {
    const result = await callHandler(
      handleTypeScript,
      "GET",
      `/api/ts/diagnostics?file=${encodeURIComponent(TEST_FILE)}`,
      null,
      ctx,
    );
    assert.strictEqual(result.handled, true);
    assert.strictEqual(result.status, 200);
    const diagnostics = parseJSON(result.body);
    assert.equal(diagnostics.status, "ok");
    assert.ok(Array.isArray(diagnostics.diagnostics));
  });

  it("skips non-TypeScript files without starting or querying tsserver", async () => {
    const markdown = resolve(TEST_WORKSPACE, "README.md");
    writeFileSync(markdown, "# notes\n", "utf-8");
    const before = isRunningCalls;
    const result = await callHandler(
      handleTypeScript,
      "GET",
      `/api/ts/diagnostics?file=${encodeURIComponent(markdown)}`,
      null,
      ctx,
    );
    const body = parseJSON(result.body);
    assert.equal(result.status, 200);
    assert.equal(body.status, "skipped");
    assert.equal(body.code, "unsupported_file");
    assert.deepEqual(body.diagnostics, []);
    assert.equal(isRunningCalls, before);
    assert.equal(lastTsRequest, null);
  });

  it("applies code actions only after all target files pass authorization", async () => {
    const before = readFileSync(TEST_FILE, "utf-8");
    const result = await callHandler(handleTypeScript, "POST", "/api/ts/apply-code-action", {
      changes: [
        {
          fileName: TEST_FILE,
          textChanges: [{
            span: { start: { line: 1, offset: 1 }, end: { line: 1, offset: 1 } },
            newText: "const changed = true;\n",
          }],
        },
        {
          fileName: OUTSIDE_FILE,
          textChanges: [{
            span: { start: { line: 1, offset: 1 }, end: { line: 1, offset: 1 } },
            newText: "outside",
          }],
        },
      ],
    }, ctx);
    const data = parseJSON(result.body);
    assert.strictEqual(result.status, 403);
    assert.strictEqual(data.code, "access_denied");
    assert.strictEqual(readFileSync(TEST_FILE, "utf-8"), before);
  });

  it("organize imports preflights all returned files before writing", async () => {
    const before = readFileSync(TEST_FILE, "utf-8");
    organizeImportsResult = [
      {
        fileName: TEST_FILE,
        textChanges: [{
          span: { start: { line: 1, offset: 1 }, end: { line: 1, offset: 1 } },
          newText: "import './safe';\n",
        }],
      },
      {
        fileName: OUTSIDE_FILE,
        textChanges: [{
          span: { start: { line: 1, offset: 1 }, end: { line: 1, offset: 1 } },
          newText: "outside",
        }],
      },
    ];

    const result = await callHandler(handleTypeScript, "POST", "/api/ts/organize-imports", {
      file: TEST_FILE,
    }, ctx);
    const data = parseJSON(result.body);
    assert.strictEqual(result.status, 403);
    assert.strictEqual(data.code, "access_denied");
    assert.strictEqual(readFileSync(TEST_FILE, "utf-8"), before);
  });
});
