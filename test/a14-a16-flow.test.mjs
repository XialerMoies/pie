import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const root = mkdtempSync(resolve(process.cwd(), ".tmp-a14-a16-"));
const workspace = resolve(root, "workspace");
const data = resolve(root, "data");
mkdirSync(workspace, { recursive: true });
mkdirSync(resolve(data, "pi", "sessions"), { recursive: true });
writeFileSync(resolve(workspace, "index.ts"), "const answer: number = 1;\n");
writeFileSync(resolve(data, "pi", "sessions", "one.jsonl"), JSON.stringify({ type: "session", id: "one", workspace }) + "\n");

function response() {
  return {
    _status: 0,
    _headers: {},
    _body: "",
    writeHead(status, headers) { this._status = status; Object.assign(this._headers, headers || {}); },
    end(body) { this._body += body || ""; },
    write() { return true; },
    on() { return this; },
  };
}

function request(method, url) {
  return { method, url, headers: { host: "localhost" }, on(event, cb) { if (event === "end") cb(); return this; } };
}

function context(tsServer) {
  const session = { id: "one", workspace, isStreaming: true, model: {}, messagesCount: 1 };
  const engine = { session, getContextUsage: () => null, getSessionStats: () => null };
  return {
    engine, session,
    runtime: { currentWorkspace: workspace, waitForSessionReady: async () => { throw new Error("must not wait"); } },
    paths: {
      APP_ROOT: workspace, DATA_DIR: data, PI_CONFIG_DIR: resolve(data, "pi"),
      SESSIONS_DIR: resolve(data, "pi", "sessions"), SETTINGS_FILE: resolve(data, "settings.json"),
      FRONTEND_DIR: workspace, FRONTEND_SRC_DIR: workspace, HAS_BUILT_FRONTEND: false,
    },
    tsServer,
    providerReferenceLock: { runExclusive: (fn) => fn() },
    appEvents: { publish() {} },
    groups: {
      core: { engine, runtime: { currentWorkspace: workspace, waitForSessionReady: async () => { throw new Error("must not wait"); } }, chatStream: {}, appEvents: { publish() {} } },
      security: {},
      storage: { paths: {
        APP_ROOT: workspace, DATA_DIR: data, PI_CONFIG_DIR: resolve(data, "pi"),
        SESSIONS_DIR: resolve(data, "pi", "sessions"), SETTINGS_FILE: resolve(data, "settings.json"),
        FRONTEND_DIR: workspace, FRONTEND_SRC_DIR: workspace, HAS_BUILT_FRONTEND: false,
      } },
      providers: { providerReferenceLock: { runExclusive: (fn) => fn() }, model: { modelRuntime: {}, modelRegistry: {}, syncModelProviders: async () => 0, runWithStableSession: async (fn) => fn() } },
      infra: { tsServer },
    },
  };
}

test("A-14 diagnostics and A-15/A-16 independent APIs complete in one concurrent flow", async (t) => {
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const { handleTypeScript } = await import("../src/server/routes/typescript.ts");
  const { handleSessions } = await import("../src/server/routes/sessions.ts");
  const { handleUiState } = await import("../src/server/routes/ui-state.ts");
  const { handleExplorer } = await import("../src/server/routes/explorer.ts");
  let releaseDiagnostics;
  const gate = new Promise((resolveGate) => { releaseDiagnostics = resolveGate; });
  const tsServer = {
    isRunning: () => true,
    sendRequest: async (command) => {
      if (command.includes("Diagnostics")) await gate;
      return [];
    },
  };
  const ctx = context(tsServer);
  const run = (handler, method, url) => {
    const res = response();
    return handler(request(method, url), res, ctx).then(() => ({ res, body: res._body ? JSON.parse(res._body) : null }));
  };

  const diagnostics = run(handleTypeScript, "GET", `/api/ts/diagnostics?file=${encodeURIComponent(resolve(workspace, "index.ts"))}`);
  const sessions = await run(handleSessions, "GET", `/api/sessions?workspace=${encodeURIComponent(workspace)}`);
  const uiState = await run(handleUiState, "GET", `/api/ui-state?workspace=${encodeURIComponent(workspace)}`);
  const explorer = await run(handleExplorer, "GET", `/api/explorer?root=${encodeURIComponent(workspace)}&path=`);
  assert.equal(sessions.res._status, 200);
  assert.equal(sessions.body.status, "ok");
  assert.equal(uiState.res._status, 200);
  assert.equal(uiState.res._headers["X-Request-State"], "complete");
  assert.equal(explorer.res._status, 200);
  assert.equal(explorer.body.status, "ok");
  releaseDiagnostics();
  const diagnosticResult = await diagnostics;
  assert.equal(diagnosticResult.res._status, 200);
  assert.equal(diagnosticResult.body.status, "ok");
  assert.deepEqual(diagnosticResult.body.diagnostics, []);
  writeFileSync(resolve(data, "pi", "sessions", "one.jsonl"), `${JSON.stringify({ type: "session", id: "one", workspace })}\n${JSON.stringify({ type: "message", message: { role: "user", content: [{ type: "text", text: "changed" }] } })}\n`);
  const refreshedSessions = await run(handleSessions, "GET", `/api/sessions?workspace=${encodeURIComponent(workspace)}`);
  assert.equal(refreshedSessions.body.sessions[0].messageCount, 1, "changed JSONL must invalidate only that cached record");
  assert.ok(process.memoryUsage().rss < 2048 * 1024 * 1024, "flow must stay below 2GB RSS");
});

test("A-14 frontend diagnostics cancels stale same-file request", async (t) => {
  const previousApp = globalThis.App;
  const previousFetch = globalThis.fetch;
  t.after(() => { globalThis.App = previousApp; globalThis.fetch = previousFetch; });
  globalThis.App = { State: { getWorkspacePath: () => workspace } };
  const requests = [];
  globalThis.fetch = (url, init) => new Promise((resolveFetch, rejectFetch) => {
    const request = { url, init, resolveFetch, rejectFetch };
    init.signal.addEventListener("abort", () => rejectFetch(Object.assign(new Error("aborted"), { name: "AbortError" })));
    requests.push(request);
  });
  const { tsDiagnostics } = await import(`../src/frontend/editor/monaco-tsserver.ts?flow=${Date.now()}`);
  const first = tsDiagnostics("index.ts");
  const second = tsDiagnostics("index.ts");
  await new Promise((resolveWait) => setImmediate(resolveWait));
  assert.equal(requests.length, 2);
  assert.equal(requests[0].init.signal.aborted, true);
  requests[1].resolveFetch({ ok: true, json: async () => ({ status: "ok", diagnostics: [{ code: 1 }] }) });
  assert.deepEqual(await first, []);
  assert.deepEqual(await second, [{ code: 1 }]);
});
