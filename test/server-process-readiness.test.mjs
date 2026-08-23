import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  classifyServerReadinessFailure,
  waitForServerBootstrap,
} from "./helpers/server-process-readiness.mjs";

function runningChild(overrides = {}) {
  return { pid: 1234, exitCode: null, signalCode: null, ...overrides };
}

function transportError(code, message = code) {
  return new TypeError("fetch failed", { cause: Object.assign(new Error(message), { code }) });
}

describe("server process readiness", () => {
  it("uses bounded read-only probes and preserves a transient refusal before success", async () => {
    let calls = 0;
    const ready = await waitForServerBootstrap({
      child: runningChild(),
      port: 43123,
      token: "secret-token",
      stdout: () => "SERVER_PORT:43123",
      stderr: () => "",
      timeoutMs: 100,
      intervalMs: 1,
      fetchImpl: async (_url, request) => {
        calls += 1;
        assert.strictEqual(request.method, "GET");
        if (calls === 1) throw transportError("ECONNREFUSED");
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      },
    });

    assert.strictEqual(calls, 2);
    assert.deepStrictEqual(ready.attempts.map((attempt) => attempt.outcome), ["connection_refused", "success"]);
    assert.strictEqual(ready.attempts[0].code, "ECONNREFUSED");
    assert.match(ready.diagnostics.stdout, /SERVER_PORT:43123/);
    assert.strictEqual((await ready.response.json()).ok, true);
  });

  it("fails immediately with child exit evidence instead of exhausting the deadline", async () => {
    const child = runningChild();
    let calls = 0;
    await assert.rejects(
      waitForServerBootstrap({
        child,
        port: 43124,
        token: "secret-token",
        stdout: () => "SERVER_PORT:43124",
        stderr: () => "fatal startup failure",
        timeoutMs: 1_000,
        intervalMs: 50,
        fetchImpl: async () => {
          calls += 1;
          child.exitCode = 1;
          throw transportError("ECONNRESET");
        },
      }),
      (error) => {
        assert.strictEqual(error.classification, "child_exited");
        assert.strictEqual(error.stage, "bootstrap-readiness");
        assert.match(error.message, /exitCode=1/);
        assert.doesNotMatch(error.message, /secret-token/);
        return true;
      },
    );
    assert.strictEqual(calls, 1);
  });

  it("classifies port conflicts and resource exhaustion from process diagnostics", () => {
    assert.strictEqual(
      classifyServerReadinessFailure(new Error("fetch failed"), { exited: true, stderr: "listen EADDRINUSE: address already in use" }),
      "port_conflict",
    );
    assert.strictEqual(
      classifyServerReadinessFailure(new Error("fetch failed"), { exited: true, stderr: "uv_os_get_passwd returned ENOMEM" }),
      "resource_exhausted",
    );
  });

  it("reports a bounded timeout with attempt history and redacted diagnostics", async () => {
    await assert.rejects(
      waitForServerBootstrap({
        child: runningChild(),
        port: 43125,
        token: "secret-token",
        stdout: () => "SERVER_PORT:43125 secret-token",
        stderr: () => "connect secret-token",
        timeoutMs: 12,
        intervalMs: 2,
        fetchImpl: async () => { throw transportError("ECONNREFUSED"); },
      }),
      (error) => {
        assert.strictEqual(error.classification, "startup_timeout");
        assert.ok(error.attempts.length >= 1);
        assert.match(error.message, /connection_refused/);
        assert.match(error.message, /\[redacted\]/);
        assert.doesNotMatch(error.message, /secret-token/);
        return true;
      },
    );
  });

  it("returns the first HTTP response without retrying authorization or route failures", async () => {
    let calls = 0;
    const ready = await waitForServerBootstrap({
      child: runningChild(),
      port: 43126,
      token: "secret-token",
      stdout: "SERVER_PORT:43126",
      stderr: "",
      fetchImpl: async () => {
        calls += 1;
        return new Response("unauthorized", { status: 401 });
      },
    });

    assert.strictEqual(calls, 1);
    assert.strictEqual(ready.response.status, 401);
    assert.strictEqual(ready.attempts[0].outcome, "http_error");
  });

  it("bounds a fetch implementation that never settles", async () => {
    const startedAt = Date.now();
    await assert.rejects(
      waitForServerBootstrap({
        child: runningChild(),
        port: 43127,
        token: "secret-token",
        stdout: "SERVER_PORT:43127",
        stderr: "",
        timeoutMs: 25,
        requestTimeoutMs: 5,
        intervalMs: 1,
        fetchImpl: async () => new Promise(() => {}),
      }),
      (error) => {
        assert.strictEqual(error.classification, "startup_timeout");
        assert.ok(error.attempts.some((attempt) => attempt.outcome === "transport_timeout"));
        return true;
      },
    );
    assert.ok(Date.now() - startedAt < 500, "readiness deadline must bound a hung transport");
  });
});
