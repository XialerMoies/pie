import { afterEach, describe, it } from "node:test";
import assert from "node:assert";

import { agentToolToPIToolDefinition } from "../src/agent/types.ts";
import { gitLogTool } from "../src/agent/tools/git-log.ts";
import { gitStatusTool } from "../src/agent/tools/git-status.ts";
import { localApiFetch } from "../src/agent/tools/local-api.ts";
import { searchTool } from "../src/agent/tools/search.ts";

const originalFetch = globalThis.fetch;
const originalServerPort = process.env.SERVER_PORT;

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalServerPort === undefined) delete process.env.SERVER_PORT;
  else process.env.SERVER_PORT = originalServerPort;
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
