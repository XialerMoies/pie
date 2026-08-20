import { afterEach, describe, it } from "node:test";
import assert from "node:assert";

import { agentToolToPIToolDefinition } from "../src/agent/types.ts";
import { explorerListTool } from "../src/agent/tools/explorer-list.ts";
import { fileOutlineTool } from "../src/agent/tools/file-outline.ts";
import { fileReadTool } from "../src/agent/tools/file-read.ts";
import { gitLogTool } from "../src/agent/tools/git-log.ts";
import { gitStatusTool } from "../src/agent/tools/git-status.ts";
import { localApiFetch, setLocalApiToken } from "../src/agent/tools/local-api.ts";
import { setCurrentRuntime } from "../src/agent/globals.ts";
import { searchTool } from "../src/agent/tools/search.ts";

const originalFetch = globalThis.fetch;
const originalServerPort = process.env.SERVER_PORT;

afterEach(() => {
  globalThis.fetch = originalFetch;
  setCurrentRuntime(null);
  setLocalApiToken(undefined);
  if (originalServerPort === undefined) delete process.env.SERVER_PORT;
  else process.env.SERVER_PORT = originalServerPort;
});

it("uses the active runtime token when a reduced tool context omits it", async () => {
  process.env.SERVER_PORT = "3099";
  let receivedInit;
  globalThis.fetch = async (_url, init = {}) => {
    receivedInit = init;
    return { ok: true, status: 200 };
  };
  setCurrentRuntime({ config: { desktopApiToken: "runtime-token" } });
  await localApiFetch("http://127.0.0.1:3099/api/file/read", toolContext(undefined));
  assert.strictEqual(new Headers(receivedInit.headers).get("x-my-code-agent-token"), "runtime-token");
});

it("uses the current server token instead of a stale callback token", async () => {
  process.env.SERVER_PORT = "3099";
  let receivedInit;
  globalThis.fetch = async (_url, init = {}) => {
    receivedInit = init;
    return { ok: true, status: 200 };
  };
  setLocalApiToken("current-server-token");
  await localApiFetch("http://127.0.0.1:3099/api/file/read", {
    ...toolContext(undefined),
    desktopApiToken: "stale-callback-token",
  });
  assert.strictEqual(new Headers(receivedInit.headers).get("x-my-code-agent-token"), "current-server-token");
});

it("uses the current server token for every local API tool", async () => {
  process.env.SERVER_PORT = "3099";
  const receivedTokens = [];
  globalThis.fetch = async (url, init = {}) => {
    receivedTokens.push({
      path: new URL(url).pathname,
      token: new Headers(init.headers).get("x-my-code-agent-token"),
    });
    const path = new URL(url).pathname;
    if (path === "/api/file/read") {
      return {
        ok: true,
        status: 200,
        json: async () => ({ content: "", size: 0, mtime: "", symbols: [], total: 0 }),
      };
    }
    if (path === "/api/explorer") return { ok: true, status: 200, json: async () => ({ items: [] }) };
    if (path === "/api/search") return { ok: true, status: 200, json: async () => ({ results: [], total: 0 }) };
    if (path === "/api/git/status") return { ok: true, status: 200, json: async () => ({ entries: [], total: 0 }) };
    if (path === "/api/git/log") return { ok: true, status: 200, json: async () => ({ entries: [] }) };
    throw new Error(`unexpected local API path: ${path}`);
  };

  setLocalApiToken("current-server-token");
  const ctx = { ...toolContext(undefined), desktopApiToken: "stale-callback-token" };
  await fileReadTool.execute({ path: "README.md" }, ctx);
  await fileOutlineTool.execute({ path: "README.md" }, ctx);
  await explorerListTool.execute({}, ctx);
  await searchTool.execute({ query: "needle" }, ctx);
  await gitStatusTool.execute({}, ctx);
  await gitLogTool.execute({}, ctx);

  assert.deepStrictEqual(receivedTokens, [
    { path: "/api/file/read", token: "current-server-token" },
    { path: "/api/file/read", token: "current-server-token" },
    { path: "/api/explorer", token: "current-server-token" },
    { path: "/api/search", token: "current-server-token" },
    { path: "/api/git/status", token: "current-server-token" },
    { path: "/api/git/log", token: "current-server-token" },
  ]);
});

function readOnlyTool(execute) {
  return {
    name: "signal_probe",
    description: "Capture the SDK abort signal.",
    parameters: { type: "object", properties: {} },
    execute,
    isReadOnly: true,
    isDestructive: false,
    isConcurrencySafe: true,
    operations: ["read"],
    riskLevel: "low",
    needsPermission: false,
    workspaceBounded: true,
    resultFormat: "structured",
  };
}

function toolContext(signal) {
  return {
    cwd: "/repo",
    sessionId: "session-1",
    workspace: "/repo",
    toolCallId: "call-1",
    signal,
  };
}

describe("tool AbortSignal propagation", () => {
  it("passes the PI SDK signal into ToolContext", async () => {
    const controller = new AbortController();
    let receivedSignal;
    const definition = agentToolToPIToolDefinition(readOnlyTool(async (_args, ctx) => {
      receivedSignal = ctx.signal;
      return { text: "ok", data: {}, metadata: {} };
    }));

    await definition.execute("call-1", {}, controller.signal, () => {});

    assert.strictEqual(receivedSignal, controller.signal);
  });

  it("passes the context signal to every local read-only HTTP tool", async () => {
    process.env.SERVER_PORT = "3099";
    const controller = new AbortController();
    const receivedSignals = [];
    globalThis.fetch = async (_url, init = {}) => {
      receivedSignals.push(init.signal);
      return {
        ok: true,
        status: 200,
        json: async () => ({ results: [], entries: [], total: 0 }),
      };
    };

    await searchTool.execute({ query: "needle" }, toolContext(controller.signal));
    await gitStatusTool.execute({}, toolContext(controller.signal));
    await gitLogTool.execute({}, toolContext(controller.signal));

    assert.deepStrictEqual(receivedSignals, [controller.signal, controller.signal, controller.signal]);
  });

  it("preserves desktop authentication while forwarding the context signal", async () => {
    process.env.SERVER_PORT = "3099";
    const controller = new AbortController();
    let receivedInit;
    globalThis.fetch = async (_url, init = {}) => {
      receivedInit = init;
      return {
        ok: true,
        status: 200,
        json: async () => ({ results: [], total: 0 }),
      };
    };

    await searchTool.execute({ query: "needle" }, {
      ...toolContext(controller.signal),
      desktopApiToken: "desktop-token",
    });

    assert.strictEqual(receivedInit.signal, controller.signal);
    assert.strictEqual(new Headers(receivedInit.headers).get("x-my-code-agent-token"), "desktop-token");
  });

  it("combines a request signal with the host context signal", async () => {
    const hostController = new AbortController();
    const requestController = new AbortController();
    let receivedSignal;
    globalThis.fetch = async (_url, init = {}) => {
      receivedSignal = init.signal;
      return { ok: true, status: 200 };
    };

    await localApiFetch("http://127.0.0.1:3099/api/test", toolContext(hostController.signal), {
      signal: requestController.signal,
    });

    assert.strictEqual(receivedSignal.aborted, false);
    hostController.abort();
    assert.strictEqual(receivedSignal.aborted, true);
  });

  it("stops waiting for an in-flight local API request when the context signal aborts", async () => {
    process.env.SERVER_PORT = "3099";
    const controller = new AbortController();
    globalThis.fetch = (_url, init = {}) => new Promise((_resolve, reject) => {
      const rejectAbort = () => {
        reject(new DOMException("The operation was aborted", "AbortError"));
      };
      if (init.signal?.aborted) rejectAbort();
      else init.signal?.addEventListener("abort", rejectAbort, { once: true });
    });

    const execution = searchTool.execute({ query: "needle" }, toolContext(controller.signal));
    controller.abort();
    const outcome = await Promise.race([
      execution.then(
        () => "completed",
        (error) => error?.name,
      ),
      new Promise((resolve) => setTimeout(() => resolve("timeout"), 100)),
    ]);

    assert.strictEqual(outcome, "AbortError");
  });
});
