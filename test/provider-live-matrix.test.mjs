import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { ProviderNetworkClient } from "../src/model-provider/provider-network-client.ts";

function loadConfigPath() {
  return process.env.PROVIDER_MATRIX_FILE?.trim();
}

async function loadMatrix() {
  const path = loadConfigPath();
  assert.ok(path, "PROVIDER_MATRIX_FILE is required for the live provider matrix");
  const parsed = JSON.parse(await readFile(path, "utf8"));
  assert.ok(parsed && Array.isArray(parsed.providers) && parsed.providers.length > 0, "providers must be a non-empty array");
  return parsed.providers;
}

describe("live provider compatibility matrix", () => {
  it("discovers real provider models without inventing capabilities or prices", async (t) => {
    if (!loadConfigPath()) {
      t.skip("set PROVIDER_MATRIX_FILE to run against real providers");
      return;
    }

    const entries = await loadMatrix();
    const client = new ProviderNetworkClient({ timeoutMs: Number(process.env.PROVIDER_MATRIX_TIMEOUT_MS) || 15_000 });
    const report = [];
    for (const entry of entries) {
      assert.equal(typeof entry?.id, "string", "provider id is required");
      assert.equal(typeof entry?.baseUrl, "string", `${entry.id}: baseUrl is required`);
      assert.equal(typeof entry?.protocol, "string", `${entry.id}: protocol is required`);
      const apiKey = entry.apiKeyEnv ? process.env[entry.apiKeyEnv] : undefined;
      const headers = Object.fromEntries(Object.entries(entry.headers ?? {}).map(([name, envName]) => [name, process.env[envName] ?? ""]));
      const draft = {
        provider: {
          id: entry.id,
          name: entry.name ?? entry.id,
          protocol: entry.protocol,
          baseUrl: entry.baseUrl,
          authMode: entry.authMode ?? (apiKey ? "apiKey" : "none"),
          headers: Object.keys(headers),
          ...(entry.modelDiscovery ? { modelDiscovery: entry.modelDiscovery } : {}),
          models: [],
        },
        secrets: { apiKey, headers },
      };
      const discovered = await client.discoverModels(draft);
      assert.ok(discovered.ids.length > 0, `${entry.id}: provider returned no models`);
      for (const metadata of discovered.models ?? []) {
        assert.equal(metadata.id.length > 0, true);
        if (metadata.cost) {
          assert.equal(typeof metadata.cost.input, "number");
          assert.equal(typeof metadata.cost.output, "number");
        }
      }
      const connection = await client.testConnection(draft);
      report.push({
        id: entry.id,
        models: discovered.ids.length,
        metadata: discovered.models?.length ?? 0,
        pricesKnown: (discovered.models ?? []).filter((model) => model.cost !== undefined).length,
        connection: connection.code ?? "ok",
      });
    }
    process.stdout.write(`${JSON.stringify({ providerMatrix: report })}\n`);
  });
});
