import { once } from "node:events";
import { createServer } from "node:http";
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  ProviderNetworkClient,
  ProviderNetworkError,
} from "../src/model-provider/provider-network-client.ts";
import { PROVIDER_PROTOCOLS } from "../src/model-provider/contracts.ts";

const model = {
  id: "model-a",
  name: "Model A",
  contextWindow: 16_384,
  maxTokens: 4_096,
  reasoning: false,
  input: ["text"],
  cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
};

function resolvedDraft(baseUrl, overrides = {}) {
  return {
    provider: {
      id: "acme",
      name: "Acme",
      protocol: "openai-completions",
      baseUrl,
      authMode: "apiKey",
      headers: ["X-Tenant"],
      modelDiscovery: "/models",
      models: [model],
      ...overrides.provider,
    },
    secrets: {
      apiKey: "api-key-network-fixture",
      headers: { "X-Tenant": "header-network-fixture" },
      ...overrides.secrets,
    },
    modelId: "model-a",
    ...Object.fromEntries(Object.entries(overrides).filter(([key]) => key !== "provider" && key !== "secrets")),
  };
}

async function fixture(handler) {
  const server = createServer(handler);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  const origin = `http://127.0.0.1:${address.port}`;
  return {
    origin,
    close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}

async function captureError(operation) {
  try {
    await operation();
  } catch (error) {
    return error;
  }
  assert.fail("expected operation to fail");
}

describe("ProviderNetworkClient model discovery", () => {
  it("runs only when explicitly called and parses unique non-empty OpenAI model IDs", async () => {
    let requests = 0;
    const server = await fixture((req, res) => {
      requests += 1;
      assert.equal(req.url, "/models");
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: [{ id: "a" }, { id: "b" }, { id: "a" }, { id: "  " }] }));
    });
    try {
      const client = new ProviderNetworkClient();
      const draft = resolvedDraft(`${server.origin}/v1/`);
      assert.equal(requests, 0);
      assert.deepEqual(await client.discoverModels(draft), { ids: ["a", "b"] });
      assert.equal(requests, 1);
    } finally {
      await server.close();
    }
  });

  it("resolves a relative discovery path against the Base URL", async () => {
    let requestedPath;
    const server = await fixture((req, res) => {
      requestedPath = req.url;
      res.writeHead(200, { "content-type": "application/json" });
      res.end('{"data":[{"id":"relative"}]}');
    });
    try {
      const draft = resolvedDraft(`${server.origin}/api/v1/`, {
        provider: { modelDiscovery: "../models" },
      });
      assert.deepEqual(await new ProviderNetworkClient().discoverModels(draft), { ids: ["relative"] });
      assert.equal(requestedPath, "/api/models");
    } finally {
      await server.close();
    }
  });

  it("rejects a different origin and unsupported Google protocol before fetch", async () => {
    let fetchCalls = 0;
    const client = new ProviderNetworkClient({
      fetch: async () => {
        fetchCalls += 1;
        throw new Error("fetch must not run");
      },
    });
    const crossOrigin = resolvedDraft("https://api.example.test/v1/", {
      provider: { modelDiscovery: "https://other.example.test/models" },
    });
    const google = resolvedDraft("https://api.example.test/v1/", {
      provider: { protocol: "google-generative-ai" },
    });

    for (const draft of [crossOrigin, google]) {
      const error = await captureError(() => client.discoverModels(draft));
      assert.ok(error instanceof ProviderNetworkError);
      assert.equal(error.code, "unsupported_response");
    }
    assert.equal(fetchCalls, 0);
  });

  it("rejects 301, 302, 307, and 308 without following redirects", async () => {
    for (const status of [301, 302, 307, 308]) {
      let requests = 0;
      const server = await fixture((req, res) => {
        requests += 1;
        if (req.url === "/models") {
          res.writeHead(status, { location: "/redirected" });
          res.end();
          return;
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end('{"data":[{"id":"followed"}]}');
      });
      try {
        const error = await captureError(() => (
          new ProviderNetworkClient().discoverModels(resolvedDraft(`${server.origin}/v1/`))
        ));
        assert.equal(error.code, "upstream");
        assert.equal(requests, 1, `status ${status} must not be followed`);
      } finally {
        await server.close();
      }
    }
  });

  it("maps invalid shapes and bodies larger than 64 KiB to unsupported_response", async () => {
    const bodies = [
      JSON.stringify({ models: [{ id: "wrong-shape" }] }),
      JSON.stringify({ data: [{ name: "missing-id" }] }),
      `{"data":[],"padding":"${"x".repeat(65 * 1024)}"}`,
    ];
    for (const body of bodies) {
      const server = await fixture((_req, res) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(body);
      });
      try {
        const error = await captureError(() => (
          new ProviderNetworkClient().discoverModels(resolvedDraft(server.origin))
        ));
        assert.equal(error.code, "unsupported_response");
      } finally {
        await server.close();
      }
    }
  });

  it("uses a 15 second default timeout and allows a shorter injected timeout", async () => {
    assert.equal(new ProviderNetworkClient().timeoutMs, 15_000);
    const server = await fixture(() => {});
    try {
      const started = Date.now();
      const error = await captureError(() => (
        new ProviderNetworkClient({ timeoutMs: 25 }).discoverModels(resolvedDraft(server.origin))
      ));
      assert.equal(error.code, "timeout");
      assert.ok(Date.now() - started < 2_000);
    } finally {
      await server.close();
    }
  });

  it("maps DNS and TLS failures plus HTTP authentication, rate-limit, and upstream statuses", async () => {
    for (const [causeCode, expected] of [["ENOTFOUND", "dns"], ["CERT_HAS_EXPIRED", "tls"]]) {
      const client = new ProviderNetworkClient({
        fetch: async () => {
          throw new TypeError("fetch failed", { cause: Object.assign(new Error("transport"), { code: causeCode }) });
        },
      });
      const error = await captureError(() => client.discoverModels(resolvedDraft("https://api.example.test")));
      assert.equal(error.code, expected);
    }

    for (const [status, expected] of [[401, "authentication"], [403, "authentication"], [429, "rate_limit"], [500, "upstream"], [503, "upstream"]]) {
      const server = await fixture((_req, res) => {
        res.writeHead(status, { "content-type": "text/plain" });
        res.end(`status ${status}`);
      });
      try {
        const error = await captureError(() => (
          new ProviderNetworkClient().discoverModels(resolvedDraft(server.origin))
        ));
        assert.equal(error.code, expected);
      } finally {
        await server.close();
      }
    }
  });

  it("does not expose upstream response excerpts on public errors", async () => {
    const apiKey = "api-key-network-fixture";
    const headerValue = "header-network-fixture";
    let receivedHeaders;
    const server = await fixture((req, res) => {
      receivedHeaders = req.headers;
      res.writeHead(500, { "content-type": "text/plain" });
      res.end(`${apiKey} ${headerValue} ${"z".repeat(8 * 1024)}`);
    });
    try {
      const error = await captureError(() => (
        new ProviderNetworkClient().discoverModels(resolvedDraft(server.origin))
      ));
      assert.equal(error.code, "upstream");
      assert.equal(receivedHeaders.authorization, `Bearer ${apiKey}`);
      assert.equal(receivedHeaders["x-tenant"], headerValue);
      assert.equal(error.message.includes(apiKey), false);
      assert.equal(error.message.includes(headerValue), false);
      assert.equal(Object.hasOwn(error, "excerpt"), false);
      assert.equal(JSON.stringify(error).includes(apiKey), false);
      assert.equal(JSON.stringify(error).includes(headerValue), false);
    } finally {
      await server.close();
    }
  });

  it("does not expose secrets split by the former error excerpt boundary", async () => {
    for (const [kind, secret] of [
      ["apiKey", "APIKE-boundary-secret-value"],
      ["header", "HDRSE-boundary-secret-value"],
    ]) {
      const server = await fixture((_req, res) => {
        res.writeHead(500, { "content-type": "text/plain" });
        res.end(`${"x".repeat(1_019)}${secret}`);
      });
      try {
        const draft = resolvedDraft(server.origin, {
          secrets: kind === "apiKey"
            ? { apiKey: secret }
            : { headers: { "X-Tenant": secret } },
        });
        const error = await captureError(() => new ProviderNetworkClient().discoverModels(draft));

        assert.equal(error.code, "upstream");
        assert.equal(Object.hasOwn(error, "excerpt"), false);
        assert.equal(JSON.stringify(error).includes(secret), false);
        assert.equal(JSON.stringify(error).includes(secret.slice(0, 5)), false);
      } finally {
        await server.close();
      }
    }
  });

  it("does not expose a multibyte secret split at the former excerpt boundary", async () => {
    const secret = "Aé-boundary-secret";
    const server = await fixture((_req, res) => {
      res.writeHead(500, { "content-type": "text/plain" });
      res.end(Buffer.concat([Buffer.alloc(1_022, "x"), Buffer.from(secret, "utf8")]));
    });
    try {
      const error = await captureError(() => new ProviderNetworkClient().discoverModels(
        resolvedDraft(server.origin, { secrets: { apiKey: secret } }),
      ));

      assert.equal(error.code, "upstream");
      assert.equal(Object.hasOwn(error, "excerpt"), false);
      assert.equal(JSON.stringify(error).includes(secret), false);
    } finally {
      await server.close();
    }
  });

  it("does not serialize raw, percent-encoded, or JSON-escaped secret variants", async () => {
    const apiKey = "api/key?tenant=one&scope=%secure";
    const headerValue = 'tenant/one?filter="private"\\segment';
    const body = [
      apiKey,
      headerValue,
      encodeURIComponent(apiKey),
      encodeURIComponent(headerValue),
      JSON.stringify(apiKey).slice(1, -1),
      JSON.stringify(headerValue).slice(1, -1),
    ].join("|");
    const server = await fixture((_req, res) => {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(body);
    });
    try {
      const error = await captureError(() => new ProviderNetworkClient().discoverModels(resolvedDraft(
        server.origin,
        { secrets: { apiKey, headers: { "X-Tenant": headerValue } } },
      )));
      const serialized = JSON.stringify(error);

      assert.equal(error.code, "upstream");
      assert.equal(Object.hasOwn(error, "excerpt"), false);
      for (const variant of [
        apiKey,
        headerValue,
        encodeURIComponent(apiKey),
        encodeURIComponent(headerValue),
        JSON.stringify(apiKey).slice(1, -1),
        JSON.stringify(headerValue).slice(1, -1),
      ]) {
        assert.equal(serialized.includes(variant), false, `serialized error leaked ${variant}`);
      }
      assert.deepEqual(Object.keys(error).sort(), ["code", "name"]);
    } finally {
      await server.close();
    }
  });

  it("maps caller cancellation to aborted", async () => {
    const controller = new AbortController();
    const server = await fixture(() => {});
    try {
      const pending = new ProviderNetworkClient().discoverModels(resolvedDraft(server.origin), controller.signal);
      controller.abort();
      const error = await captureError(() => pending);
      assert.equal(error.code, "aborted");
    } finally {
      await server.close();
    }
  });
});

describe("ProviderNetworkClient isolated connection test", () => {
  it("rejects every redirect status without forwarding credentials to another origin", async () => {
    for (const status of [301, 302, 303, 307, 308]) {
      const forwarded = [];
      const target = await fixture((req, res) => {
        forwarded.push({ authorization: req.headers.authorization, tenant: req.headers["x-tenant"] });
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.end("data: [DONE]\n\n");
      });
      const source = await fixture((req, res) => {
        assert.equal(req.headers.authorization, "Bearer api-key-network-fixture");
        assert.equal(req.headers["x-tenant"], "header-network-fixture");
        res.writeHead(status, { location: `${target.origin}/captured` });
        res.end();
      });
      try {
        const result = await new ProviderNetworkClient().testConnection(resolvedDraft(`${source.origin}/v1`));
        assert.equal(result.ok, false, `status ${status} must fail`);
        assert.equal(result.code, "upstream");
        assert.deepEqual(forwarded, [], `status ${status} forwarded credentials cross-origin`);
      } finally {
        await source.close();
        await target.close();
      }
    }
  });

  it("uses the request-local manual-redirect transport for all six custom protocols", async () => {
    const originalFetch = globalThis.fetch;
    const fetchCalls = [];
    const runtime = {
      getModel: (providerId, modelId) => ({ provider: providerId, id: modelId }),
      async completeSimple(_selectedModel, _context, options) {
        assert.equal(typeof options.fetch, "function");
        try {
          await options.fetch("https://api.example.test/v1/request", { method: "POST" });
        } catch (error) {
          return {
            stopReason: "error",
            errorMessage: error.message,
            usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          };
        }
        assert.fail("redirect transport must reject");
      },
    };
    const client = new ProviderNetworkClient({
      fetch: async (input, init) => {
        fetchCalls.push({ url: new Request(input, init).url, redirect: init?.redirect });
        return new Response(null, { status: 307, headers: { location: "https://other.example.test/" } });
      },
      runtimeFactory: async () => runtime,
      adapterFactory: () => ({
        prepare: (definition) => ({ providerId: definition.id, models: definition.models }),
        replaceRuntimeProviders: async () => {},
        toProviderUsage: (usage) => usage,
      }),
    });

    for (const protocol of PROVIDER_PROTOCOLS) {
      const result = await client.testConnection(resolvedDraft("https://api.example.test/v1/", {
        provider: { protocol },
      }));
      assert.equal(result.ok, false, protocol);
      assert.equal(result.code, "upstream", protocol);
    }

    assert.equal(globalThis.fetch, originalFetch);
    assert.equal(fetchCalls.length, PROVIDER_PROTOCOLS.length);
    assert.deepEqual(fetchCalls.map((entry) => entry.redirect), PROVIDER_PROTOCOLS.map(() => "manual"));
  });

  it("runs the default PI runtime and adapter against an isolated local provider", async () => {
    let requestBody;
    const server = await fixture(async (req, res) => {
      assert.equal(req.url, "/v1/chat/completions");
      assert.equal(req.headers.authorization, "Bearer api-key-network-fixture");
      assert.equal(req.headers["x-tenant"], "header-network-fixture");
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      requestBody = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write('data: {"id":"test","object":"chat.completion.chunk","created":1,"model":"model-a","choices":[{"index":0,"delta":{"role":"assistant","content":"ok"},"finish_reason":null}]}\n\n');
      res.write('data: {"id":"test","object":"chat.completion.chunk","created":1,"model":"model-a","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":4,"completion_tokens":2,"prompt_tokens_details":{"cached_tokens":1}}}\n\n');
      res.end("data: [DONE]\n\n");
    });
    try {
      const result = await new ProviderNetworkClient().testConnection(resolvedDraft(`${server.origin}/v1`));
      assert.deepEqual(result, {
        ok: true,
        providerId: "acme",
        modelId: "model-a",
        latencyMs: result.latencyMs,
        usage: { input: 3, output: 2, cacheRead: 1, cacheWrite: 0, reasoning: 0 },
      });
      assert.ok(result.latencyMs >= 0);
      assert.equal(requestBody.model, "model-a");
      assert.equal(requestBody.messages.length, 1);
      assert.equal(requestBody.messages[0].role, "user");
    } finally {
      await server.close();
    }
  });

  it("registers only the in-memory draft, selects its explicit model, and normalizes usage", async () => {
    const events = [];
    const currentRuntime = { setModel() { assert.fail("current runtime must not be changed"); } };
    const store = { commit() { assert.fail("connection test must not persist"); } };
    void currentRuntime;
    void store;
    const isolatedRuntime = {
      getModel(providerId, modelId) {
        events.push(["getModel", providerId, modelId]);
        return { provider: providerId, id: modelId };
      },
      async completeSimple(selectedModel, context, options) {
        events.push(["completeSimple", selectedModel, context, options.signal.aborted]);
        return {
          provider: selectedModel.provider,
          model: selectedModel.id,
          stopReason: "stop",
          usage: { input: 3, output: 2, cacheRead: 1, cacheWrite: 0, reasoning: 4 },
        };
      },
    };
    const adapter = {
      prepare(definition, secrets) {
        events.push(["prepare", definition.id, secrets.apiKey, secrets.headers["X-Tenant"]]);
        return { providerId: definition.id, models: definition.models };
      },
      async replaceRuntimeProviders(runtime, prepared) {
        events.push(["replace", runtime, prepared.map((entry) => entry.providerId)]);
      },
      toProviderUsage(usage) {
        return {
          input: usage.input,
          output: usage.output,
          cacheRead: usage.cacheRead,
          cacheWrite: usage.cacheWrite,
          reasoning: usage.reasoning,
        };
      },
    };
    const client = new ProviderNetworkClient({
      runtimeFactory: async (options) => {
        assert.equal(options.modelsPath, null);
        assert.equal(options.refreshOnCreate, false);
        assert.equal(options.credentials?.constructor.name, "InMemoryCredentialStore");
        return isolatedRuntime;
      },
      adapterFactory: () => adapter,
    });

    const result = await client.testConnection(resolvedDraft("https://api.example.test/v1/"));

    assert.equal(result.ok, true);
    assert.equal(result.providerId, "acme");
    assert.equal(result.modelId, "model-a");
    assert.ok(result.latencyMs >= 0);
    assert.deepEqual(result.usage, { input: 3, output: 2, cacheRead: 1, cacheWrite: 0, reasoning: 4 });
    assert.deepEqual(events[0], ["prepare", "acme", "api-key-network-fixture", "header-network-fixture"]);
    assert.equal(events[1][0], "replace");
    assert.strictEqual(events[1][1], isolatedRuntime);
    assert.deepEqual(events[1][2], ["acme"]);
    assert.deepEqual(events[2], ["getModel", "acme", "model-a"]);
    assert.equal(events[3][0], "completeSimple");
    assert.deepEqual(events[3][1], { provider: "acme", id: "model-a" });
    assert.equal(events[3][2].messages.length, 1);
    assert.equal(events[3][2].messages[0].role, "user");
    assert.equal(events[3][3], false);
  });

  it("returns a stable redacted failure without raw response details", async () => {
    const apiKey = "api-key-network-fixture";
    const headerValue = "header-network-fixture";
    const client = new ProviderNetworkClient({
      runtimeFactory: async () => ({
        getModel: () => ({ provider: "acme", id: "model-a" }),
        async completeSimple() {
          throw Object.assign(new Error(`401 request exposed ${apiKey} ${headerValue}`), {
            response: { headers: { authorization: apiKey }, body: "full body" },
          });
        },
      }),
      adapterFactory: () => ({
        prepare: (definition) => ({ providerId: definition.id, models: definition.models }),
        replaceRuntimeProviders: async () => {},
        toProviderUsage: (usage) => usage,
      }),
    });

    const result = await client.testConnection(resolvedDraft("https://api.example.test/v1/"));
    assert.deepEqual(
      { ok: result.ok, providerId: result.providerId, modelId: result.modelId, code: result.code },
      { ok: false, providerId: "acme", modelId: "model-a", code: "authentication" },
    );
    assert.equal(result.message.includes(apiKey), false);
    assert.equal(result.message.includes(headerValue), false);
    assert.equal(JSON.stringify(result).includes("authorization"), false);
    assert.equal(JSON.stringify(result).includes("full body"), false);
  });

  it("times out while runtime creation is unresolved", async () => {
    const client = new ProviderNetworkClient({
      timeoutMs: 25,
      runtimeFactory: () => new Promise(() => {}),
      adapterFactory: () => assert.fail("adapter must not be created after timeout"),
    });
    const started = Date.now();

    const result = await Promise.race([
      client.testConnection(resolvedDraft("https://api.example.test/v1/")),
      new Promise((_, reject) => setTimeout(() => reject(new Error("connection test hung")), 500)),
    ]);

    assert.equal(result.ok, false);
    assert.equal(result.code, "timeout");
    assert.ok(Date.now() - started < 400);
  });

  it("does not continue a delayed runtime pipeline after timeout or caller abort", async () => {
    for (const cancellation of ["timeout", "caller"]) {
      let resolveRuntime;
      const events = [];
      const runtimePromise = new Promise((resolve) => { resolveRuntime = resolve; });
      const controller = new AbortController();
      const client = new ProviderNetworkClient({
        timeoutMs: cancellation === "timeout" ? 20 : 1_000,
        runtimeFactory: () => runtimePromise,
        adapterFactory: () => {
          events.push("adapter");
          return {
            prepare: () => { events.push("prepare"); },
            replaceRuntimeProviders: async () => { events.push("replace"); },
            toProviderUsage: (usage) => usage,
          };
        },
      });
      const pending = client.testConnection(
        resolvedDraft("https://api.example.test/v1/"),
        controller.signal,
      );
      if (cancellation === "caller") controller.abort();

      const result = await Promise.race([
        pending,
        new Promise((_, reject) => setTimeout(() => reject(new Error(`${cancellation} did not settle`)), 500)),
      ]);
      assert.equal(result.ok, false);
      assert.equal(result.code, cancellation === "timeout" ? "timeout" : "aborted");
      resolveRuntime({
        getModel: () => { events.push("getModel"); },
        completeSimple: async () => { events.push("completeSimple"); },
      });
      await new Promise((resolve) => setImmediate(resolve));
      assert.deepEqual(events, []);
    }
  });
});
