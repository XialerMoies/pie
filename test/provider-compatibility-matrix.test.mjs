import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { ProviderNetworkClient, ProviderNetworkError } from "../src/model-provider/provider-network-client.ts";

const model = {
  id: "model-a",
  name: "Model A",
  contextWindow: 16_384,
  maxTokens: 4_096,
  reasoning: false,
  input: ["text"],
  cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
};

function draft(baseUrl = "https://provider.example/v1") {
  return {
    provider: {
      id: "acme",
      name: "Acme",
      protocol: "openai-completions",
      baseUrl,
      authMode: "apiKey",
      headers: [],
      models: [model],
    },
    secrets: { apiKey: "do-not-leak" , headers: {} },
  };
}

function response(body, status = 200) {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("provider compatibility matrix", () => {
  it("accepts sparse model metadata and leaves unknown pricing unset", async () => {
    const client = new ProviderNetworkClient({ fetch: async () => response({ data: [{ id: "remote-model" }] }) });
    const result = await client.discoverModels(draft());
    assert.deepEqual(result.ids, ["remote-model"]);
    assert.equal(result.models?.[0].cost, undefined);
  });

  for (const [status, code] of [[401, "authentication"], [429, "rate_limit"], [503, "upstream"]]) {
    it(`classifies HTTP ${status} as ${code}`, async () => {
      const client = new ProviderNetworkClient({ fetch: async () => response({ error: "do-not-leak" }, status) });
      const error = await assert.rejects(
        client.discoverModels(draft()),
        (value) => value instanceof ProviderNetworkError && value.code === code && !value.message.includes("do-not-leak"),
      );
      assert.equal(error, undefined);
    });
  }

  it("classifies timeout and caller abort distinctly", async () => {
    const timeoutClient = new ProviderNetworkClient({
      timeoutMs: 5,
      fetch: (_url, options) => new Promise((_, reject) => options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true })),
    });
    const keepAlive = setTimeout(() => {}, 100);
    try {
      await assert.rejects(timeoutClient.discoverModels(draft()), (error) => error.code === "timeout");
    } finally {
      clearTimeout(keepAlive);
    }

    const abortController = new AbortController();
    const abortClient = new ProviderNetworkClient({
      timeoutMs: 500,
      fetch: (_url, options) => new Promise((_, reject) => options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true })),
    });
    const pending = abortClient.discoverModels(draft(), abortController.signal);
    abortController.abort();
    await assert.rejects(pending, (error) => error.code === "aborted");
  });

  it("rejects malformed and oversized responses without leaking credentials", async () => {
    const malformed = new ProviderNetworkClient({ fetch: async () => response("not-json") });
    await assert.rejects(malformed.discoverModels(draft()), (error) => error.code === "unsupported_response" && !error.message.includes("do-not-leak"));

    const oversized = new ProviderNetworkClient({ fetch: async () => response("x".repeat(70 * 1024)) });
    await assert.rejects(oversized.discoverModels(draft()), (error) => error.code === "unsupported_response");
  });
});
