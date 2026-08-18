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
  it("automatically tries /v1/models then /models when no discovery path is configured", async () => {
    const requests = [];
    const server = await fixture((req, res) => {
      requests.push(req.url);
      if (req.url === "/v1/models") {
        res.writeHead(404);
        res.end();
        return;
      }
      assert.equal(req.url, "/models");
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: [{ id: " model-a " }, { id: "model-b" }, { id: "model-a" }] }));
    });
    try {
      const draft = resolvedDraft(`${server.origin}/`, { provider: { modelDiscovery: undefined } });
      assert.deepEqual(await new ProviderNetworkClient().discoverModels(draft), { ids: ["model-a", "model-b"] });
      assert.deepEqual(requests, ["/v1/models", "/models"]);
    } finally {
      await server.close();
    }
  });

  it("derives versioned and compatibility-path candidates without leaving the provider origin", async () => {
    const cases = [
      { basePath: "/v4", expected: ["/v4/models"] },
      { basePath: "/api/anthropic", expected: ["/api/anthropic/v1/models", "/api/anthropic/models", "/v1/models"] },
    ];
    for (const testCase of cases) {
      const requests = [];
      const server = await fixture((req, res) => {
        requests.push(req.url);
        if (req.url === testCase.expected.at(-1)) {
          res.writeHead(200, { "content-type": "application/json" });
          res.end('{"data":[{"id":"derived-model"}]}');
          return;
        }
        res.writeHead(404);
        res.end();
      });
      try {
        const draft = resolvedDraft(`${server.origin}${testCase.basePath}`, {
          provider: { modelDiscovery: undefined },
        });
        assert.deepEqual(await new ProviderNetworkClient().discoverModels(draft), { ids: ["derived-model"] });
        assert.deepEqual(requests, testCase.expected);
        assert.ok(requests.every(path => path.startsWith("/")));
      } finally {
        await server.close();
      }
    }
  });

  it("uses protocol authentication headers and lets custom headers override defaults", async () => {
    for (const [protocol, defaultHeader] of [
      ["anthropic-messages", "x-api-key"],
      ["azure-openai-responses", "api-key"],
    ]) {
      let received;
      const server = await fixture((req, res) => {
        received = req.headers;
        res.writeHead(200, { "content-type": "application/json" });
        res.end('{"data":[{"id":"header-model"}]}');
      });
      try {
        const draft = resolvedDraft(`${server.origin}/v1`, {
          provider: {
            protocol,
            modelDiscovery: undefined,
            headers: ["X-Tenant", defaultHeader],
          },
          secrets: {
            apiKey: "protocol-key",
            headers: {
              "X-Tenant": "tenant-value",
              [defaultHeader]: "custom-auth-value",
            },
          },
        });
        assert.deepEqual(await new ProviderNetworkClient().discoverModels(draft), { ids: ["header-model"] });
        assert.equal(received[defaultHeader], "custom-auth-value");
        assert.equal(received["x-tenant"], "tenant-value");
        assert.equal(received.authorization, undefined);
      } finally {
        await server.close();
      }
    }
  });

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
  it("probes a provider with GET without a model or runtime and reports HTTP reachability", async () => {
    let request;
    const server = await fixture((req, res) => {
      request = { method: req.method, path: req.url, authorization: req.headers.authorization };
      res.writeHead(401);
      res.end();
    });
    try {
      const result = await new ProviderNetworkClient().testConnection(resolvedDraft(`${server.origin}/v1`, {
        provider: { models: [], modelDiscovery: undefined },
        modelId: undefined,
      }));
      assert.deepEqual(
        { ok: result.ok, reachable: result.reachable, httpStatus: result.httpStatus, code: result.code },
        { ok: false, reachable: true, httpStatus: 401, code: "authentication" },
      );
      assert.equal(request.method, "GET");
      assert.equal(request.path, "/v1");
      assert.equal(request.authorization, "Bearer api-key-network-fixture");
    } finally {
      await server.close();
    }
  });

  it("marks HTTP errors reachable while preserving transport failures as unreachable", async () => {
    for (const status of [404, 500]) {
      const server = await fixture((_req, res) => {
        res.writeHead(status);
        res.end();
      });
      try {
        const result = await new ProviderNetworkClient().testConnection(
          resolvedDraft(`${server.origin}/v1`, { modelId: undefined }),
        );
        assert.equal(result.ok, false);
        assert.equal(result.reachable, true);
        assert.equal(result.httpStatus, status);
        assert.equal(result.code, "upstream");
      } finally {
        await server.close();
      }
    }

    const result = await new ProviderNetworkClient({
      fetch: async () => {
        throw new TypeError("fetch failed", { cause: Object.assign(new Error("dns"), { code: "ENOTFOUND" }) });
      },
    }).testConnection(resolvedDraft("https://api.example.test/v1", { modelId: undefined }));
    assert.equal(result.ok, false);
    assert.equal(result.reachable, false);
    assert.equal(result.code, "dns");
    assert.equal(result.httpStatus, undefined);
  });

  it("reports redirects as reachable without forwarding credentials", async () => {
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
        assert.equal(result.ok, false, `status ${status} must not be considered an OK response`);
        assert.equal(result.reachable, true);
        assert.equal(result.httpStatus, status);
        assert.equal(result.code, "upstream");
        assert.deepEqual(forwarded, [], `status ${status} forwarded credentials cross-origin`);
      } finally {
        await source.close();
        await target.close();
      }
    }
  });

  it("uses a manual GET probe for all six custom protocols", async () => {
    const fetchCalls = [];
    const client = new ProviderNetworkClient({
      fetch: async (input, init) => {
        fetchCalls.push({ url: new Request(input, init).url, method: init?.method, redirect: init?.redirect });
        return new Response(null, { status: 204 });
      },
    });

    for (const protocol of PROVIDER_PROTOCOLS) {
      const result = await client.testConnection(resolvedDraft("https://api.example.test/v1/", {
        provider: { protocol },
      }));
      assert.equal(result.ok, true, protocol);
      assert.equal(result.reachable, true, protocol);
    }

    assert.equal(fetchCalls.length, PROVIDER_PROTOCOLS.length);
    assert.deepEqual(fetchCalls.map((entry) => entry.method), PROVIDER_PROTOCOLS.map(() => "GET"));
    assert.deepEqual(fetchCalls.map((entry) => entry.redirect), PROVIDER_PROTOCOLS.map(() => "manual"));
  });

  it("returns a stable redacted transport failure without raw response details", async () => {
    const apiKey = "api-key-network-fixture";
    const headerValue = "header-network-fixture";
    const client = new ProviderNetworkClient({
      fetch: async () => {
        throw new Error(`401 request exposed ${apiKey} ${headerValue}`);
      },
    });

    const result = await client.testConnection(resolvedDraft("https://api.example.test/v1/"));
    assert.deepEqual(
      { ok: result.ok, reachable: result.reachable, providerId: result.providerId, code: result.code },
      { ok: false, reachable: false, providerId: "acme", code: "authentication" },
    );
    assert.equal(result.message.includes(apiKey), false);
    assert.equal(result.message.includes(headerValue), false);
    assert.equal(JSON.stringify(result).includes("authorization"), false);
    assert.equal(JSON.stringify(result).includes("full body"), false);
  });

  it("times out while the probe fetch is unresolved", async () => {
    const client = new ProviderNetworkClient({
      timeoutMs: 25,
      fetch: () => new Promise(() => {}),
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

  it("settles promptly when a delayed probe is cancelled", async () => {
    for (const cancellation of ["timeout", "caller"]) {
      let resolveFetch;
      const fetchPromise = new Promise((resolve) => { resolveFetch = resolve; });
      const controller = new AbortController();
      const client = new ProviderNetworkClient({
        timeoutMs: cancellation === "timeout" ? 20 : 1_000,
        fetch: () => fetchPromise,
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
      resolveFetch(new Response(null, { status: 204 }));
      await new Promise((resolve) => setImmediate(resolve));
    }
  });
});
