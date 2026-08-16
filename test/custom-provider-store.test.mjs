import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rename, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { describe, it } from "node:test";

import {
  CustomProviderRevisionConflict,
  CustomProviderStore,
} from "../src/model-provider/custom-provider-store.ts";

function descriptor(overrides = {}) {
  return {
    id: "model-a",
    name: "Model A",
    contextWindow: 16_384,
    maxTokens: 4_096,
    reasoning: false,
    input: ["text"],
    cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0.2 },
    ...overrides,
  };
}

function providerMutation(overrides = {}) {
  return {
    id: "acme",
    name: "Acme",
    protocol: "openai-responses",
    baseUrl: "https://api.example.test/v1",
    authMode: "apiKey",
    headers: ["X-Tenant"],
    models: [descriptor()],
    ...overrides,
  };
}

async function atomicWrite(filePath, contents) {
  await mkdir(dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.${randomUUID()}.test.tmp`;
  try {
    await writeFile(temporary, contents, "utf8");
    await rename(temporary, filePath);
  } finally {
    await unlink(temporary).catch((error) => {
      if (error?.code !== "ENOENT") throw error;
    });
  }
}

async function fixture() {
  const root = await mkdtemp(resolve(tmpdir(), "custom-provider-store-"));
  const configFile = resolve(root, "custom-providers.json");
  const secretsFile = resolve(root, "custom-provider-secrets.json");
  return {
    root,
    configFile,
    secretsFile,
    store: new CustomProviderStore({ configFile, secretsFile }),
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

async function createProvider(store, overrides = {}) {
  return store.commit({
    expectedRevision: 0,
    provider: providerMutation(overrides),
    secretPatch: {
      apiKey: "api-secret-v1",
      headers: [{ name: "X-Tenant", value: "tenant-secret-v1" }],
    },
  });
}

function mutationFromStored(provider, overrides = {}) {
  const { apiKeyRef: _apiKeyRef, headers, ...definition } = provider;
  return {
    ...definition,
    headers: headers.map((header) => header.name),
    ...overrides,
  };
}

describe("custom provider store", () => {
  it("returns versioned empty defaults for missing files", async () => {
    const env = await fixture();
    try {
      assert.deepEqual(await env.store.readSnapshot(), { schemaVersion: 1, revision: 0, providers: [] });
      assert.deepEqual(await env.store.readRedacted(), { schemaVersion: 1, revision: 0, providers: [] });
      assert.equal(await env.store.revealApiKey("missing"), undefined);
    } finally {
      await env.cleanup();
    }
  });

  it("creates revision one with immutable credential refs and separate secret values", async () => {
    const env = await fixture();
    try {
      const committed = await createProvider(env.store);
      assert.equal(committed.revision, 1);
      const stored = committed.providers[0];
      assert.match(stored.apiKeyRef, /^credential:[0-9a-f-]{36}$/);
      assert.match(stored.headers[0].credentialRef, /^credential:[0-9a-f-]{36}$/);
      assert.notEqual(stored.apiKeyRef, stored.headers[0].credentialRef);

      const configText = await readFile(env.configFile, "utf8");
      assert.equal(configText.includes("api-secret-v1"), false);
      assert.equal(configText.includes("tenant-secret-v1"), false);
      const secrets = JSON.parse(await readFile(env.secretsFile, "utf8"));
      assert.deepEqual(secrets, {
        schemaVersion: 1,
        values: {
          [stored.apiKeyRef]: "api-secret-v1",
          [stored.headers[0].credentialRef]: "tenant-secret-v1",
        },
      });
    } finally {
      await env.cleanup();
    }
  });

  it("preserves refs for omitted values and allocates refs only for changed secrets", async () => {
    const env = await fixture();
    try {
      const first = await createProvider(env.store);
      const original = first.providers[0];
      const preserved = await env.store.commit({
        expectedRevision: 1,
        provider: mutationFromStored(original, {
          name: "Acme Renamed",
          headers: ["x-tenant"],
        }),
        secretPatch: { headers: [] },
      });
      assert.equal(preserved.providers[0].apiKeyRef, original.apiKeyRef);
      assert.equal(preserved.providers[0].headers[0].credentialRef, original.headers[0].credentialRef);

      const changed = await env.store.commit({
        expectedRevision: 2,
        provider: mutationFromStored(preserved.providers[0]),
        secretPatch: {
          apiKey: "api-secret-v2",
          headers: [{ name: "X-Tenant", value: "tenant-secret-v2" }],
        },
      });
      assert.notEqual(changed.providers[0].apiKeyRef, original.apiKeyRef);
      assert.notEqual(changed.providers[0].headers[0].credentialRef, original.headers[0].credentialRef);
      assert.deepEqual(await env.store.resolveSecrets(changed.providers[0]), {
        apiKey: "api-secret-v2",
        headers: { "x-tenant": "tenant-secret-v2" },
      });

      const secrets = JSON.parse(await readFile(env.secretsFile, "utf8"));
      assert.deepEqual(Object.keys(secrets.values).sort(), [
        changed.providers[0].apiKeyRef,
        changed.providers[0].headers[0].credentialRef,
      ].sort());
    } finally {
      await env.cleanup();
    }
  });

  it("matches header patches case-insensitively and rejects duplicate header names", async () => {
    const env = await fixture();
    try {
      const first = await createProvider(env.store);
      const updated = await env.store.commit({
        expectedRevision: 1,
        provider: mutationFromStored(first.providers[0]),
        secretPatch: { headers: [{ name: "x-tenant", value: "changed" }] },
      });
      assert.equal((await env.store.resolveSecrets(updated.providers[0])).headers["X-Tenant"], "changed");
      await assert.rejects(
        () => env.store.commit({
          expectedRevision: 2,
          provider: mutationFromStored(updated.providers[0], { headers: ["X-Tenant", "x-tenant"] }),
          secretPatch: { headers: [] },
        }),
        /duplicate header name/i,
      );
    } finally {
      await env.cleanup();
    }
  });

  it("redacts refs and values and reveals only the selected provider API key", async () => {
    const env = await fixture();
    try {
      const committed = await createProvider(env.store);
      const redacted = await env.store.readRedacted();
      assert.equal(redacted.revision, 1);
      assert.equal(redacted.providers[0].apiKeyConfigured, true);
      assert.equal("hasApiKey" in redacted.providers[0], false);
      assert.deepEqual(redacted.providers[0].headers, [{ name: "X-Tenant", configured: true }]);
      assert.equal("hasValue" in redacted.providers[0].headers[0], false);
      const serialized = JSON.stringify(redacted);
      assert.equal(serialized.includes("credential:"), false);
      assert.equal(serialized.includes("api-secret-v1"), false);
      assert.equal(serialized.includes("tenant-secret-v1"), false);
      assert.equal(await env.store.revealApiKey("acme"), "api-secret-v1");
      assert.equal(await env.store.revealApiKey("missing"), undefined);
      assert.equal("revealHeader" in env.store, false);
      assert.deepEqual(await env.store.resolveSecrets(committed.providers[0]), {
        apiKey: "api-secret-v1",
        headers: { "X-Tenant": "tenant-secret-v1" },
      });
    } finally {
      await env.cleanup();
    }
  });

  it("serializes contending writers to revisions one and two", async () => {
    const env = await fixture();
    let releaseFirst;
    let firstSecretWrite;
    const firstStarted = new Promise((resolvePromise) => { firstSecretWrite = resolvePromise; });
    const firstMayFinish = new Promise((resolvePromise) => { releaseFirst = resolvePromise; });
    try {
      let paused = false;
      const firstStore = new CustomProviderStore({
        configFile: env.configFile,
        secretsFile: env.secretsFile,
        atomicWrite: async (filePath, contents) => {
          if (filePath === env.secretsFile && !paused) {
            paused = true;
            firstSecretWrite();
            await firstMayFinish;
          }
          await atomicWrite(filePath, contents);
        },
      });
      const secondStore = new CustomProviderStore({ configFile: env.configFile, secretsFile: env.secretsFile });
      const firstCommit = createProvider(firstStore);
      await firstStarted;
      const secondCommit = secondStore.commit({
        expectedRevision: 1,
        provider: providerMutation({ id: "second", name: "Second", authMode: "none", headers: [] }),
        secretPatch: { headers: [] },
      });
      releaseFirst();
      const [first, second] = await Promise.all([firstCommit, secondCommit]);
      assert.equal(first.revision, 1);
      assert.equal(second.revision, 2);
      assert.deepEqual((await env.store.readSnapshot()).providers.map((entry) => entry.id).sort(), ["acme", "second"]);
    } finally {
      releaseFirst?.();
      await env.cleanup();
    }
  });

  it("throws a structured conflict for stale expected revisions", async () => {
    const env = await fixture();
    try {
      await createProvider(env.store);
      await assert.rejects(
        () => env.store.commit({
          expectedRevision: 0,
          provider: providerMutation({ id: "stale", name: "Stale", authMode: "none", headers: [] }),
          secretPatch: { headers: [] },
        }),
        (error) => {
          assert.ok(error instanceof CustomProviderRevisionConflict);
          assert.equal(error.expectedRevision, 0);
          assert.equal(error.currentRevision, 1);
          return true;
        },
      );
    } finally {
      await env.cleanup();
    }
  });

  it("keeps the old config and all referenced secrets usable when config write fails", async () => {
    const env = await fixture();
    try {
      const first = await createProvider(env.store);
      const failingStore = new CustomProviderStore({
        configFile: env.configFile,
        secretsFile: env.secretsFile,
        atomicWrite: async (filePath, contents) => {
          if (filePath === env.configFile) throw new Error("injected config failure");
          await atomicWrite(filePath, contents);
        },
      });
      await assert.rejects(
        () => failingStore.commit({
          expectedRevision: 1,
          provider: mutationFromStored(first.providers[0]),
          secretPatch: {
            apiKey: "uncommitted-api-key",
            headers: [{ name: "X-Tenant", value: "uncommitted-header" }],
          },
        }),
        /injected config failure/,
      );
      assert.deepEqual(await env.store.readSnapshot(), first);
      assert.equal(await env.store.revealApiKey("acme"), "api-secret-v1");
      assert.deepEqual(await env.store.resolveSecrets(first.providers[0]), {
        apiKey: "api-secret-v1",
        headers: { "X-Tenant": "tenant-secret-v1" },
      });
    } finally {
      await env.cleanup();
    }
  });

  it("keeps committed refs usable when best-effort orphan cleanup fails", async () => {
    const env = await fixture();
    try {
      const first = await createProvider(env.store);
      let secretWrites = 0;
      const cleanupFailingStore = new CustomProviderStore({
        configFile: env.configFile,
        secretsFile: env.secretsFile,
        atomicWrite: async (filePath, contents) => {
          if (filePath === env.secretsFile && ++secretWrites === 2) {
            throw new Error("injected cleanup failure");
          }
          await atomicWrite(filePath, contents);
        },
      });
      const committed = await cleanupFailingStore.commit({
        expectedRevision: 1,
        provider: mutationFromStored(first.providers[0]),
        secretPatch: { apiKey: "api-secret-v2", headers: [] },
      });
      assert.equal(committed.revision, 2);
      assert.equal(await env.store.revealApiKey("acme"), "api-secret-v2");
      assert.equal((await env.store.resolveSecrets(committed.providers[0])).headers["X-Tenant"], "tenant-secret-v1");
      const values = JSON.parse(await readFile(env.secretsFile, "utf8")).values;
      assert.equal(values[first.providers[0].apiKeyRef], "api-secret-v1");
      assert.equal(values[committed.providers[0].apiKeyRef], "api-secret-v2");
    } finally {
      await env.cleanup();
    }
  });

  it("commits deletion before cleaning orphan secrets", async () => {
    const env = await fixture();
    try {
      await createProvider(env.store);
      const writes = [];
      const deletingStore = new CustomProviderStore({
        configFile: env.configFile,
        secretsFile: env.secretsFile,
        atomicWrite: async (filePath, contents) => {
          writes.push(filePath);
          if (filePath === env.secretsFile) {
            const config = JSON.parse(await readFile(env.configFile, "utf8"));
            assert.deepEqual(config.providers, []);
          }
          await atomicWrite(filePath, contents);
        },
      });
      const deleted = await deletingStore.commit({
        expectedRevision: 1,
        removeProviderId: "acme",
        secretPatch: { headers: [] },
      });
      assert.deepEqual(deleted, { schemaVersion: 1, revision: 2, providers: [] });
      assert.deepEqual(writes, [env.configFile, env.secretsFile]);
      assert.deepEqual(JSON.parse(await readFile(env.secretsFile, "utf8")), { schemaVersion: 1, values: {} });
    } finally {
      await env.cleanup();
    }
  });

  it("rejects caller-forged API key refs and cannot expose another provider secret", async () => {
    const env = await fixture();
    try {
      const first = await createProvider(env.store);
      const victim = first.providers[0];
      const forgedProvider = {
        ...providerMutation({ id: "api-attacker", name: "API Attacker", headers: [] }),
        apiKeyRef: victim.apiKeyRef,
      };

      await assert.rejects(
        () => env.store.commit({
          expectedRevision: 1,
          provider: forgedProvider,
          secretPatch: { headers: [] },
        }),
        /apiKeyRef|headers\[0\]/,
      );
      assert.equal(await env.store.revealApiKey("api-attacker"), undefined);
      assert.equal(await env.store.revealApiKey("acme"), "api-secret-v1");
      assert.equal((await env.store.readSnapshot()).revision, 1);
    } finally {
      await env.cleanup();
    }
  });

  it("rejects header-only forged credential refs and cannot reuse another provider header secret", async () => {
    const env = await fixture();
    try {
      const first = await createProvider(env.store);
      const victim = first.providers[0];
      const forgedProvider = {
        ...providerMutation({
          id: "header-attacker",
          name: "Header Attacker",
          authMode: "none",
        }),
        headers: [{ name: "X-Stolen", credentialRef: victim.headers[0].credentialRef }],
      };
      assert.equal("apiKeyRef" in forgedProvider, false);

      await assert.rejects(
        () => env.store.commit({
          expectedRevision: 1,
          provider: forgedProvider,
          secretPatch: { headers: [] },
        }),
        /provider\.headers\[0\]/,
      );
      const snapshot = await env.store.readSnapshot();
      assert.equal(snapshot.revision, 1);
      assert.equal(snapshot.providers.some((provider) => provider.id === "header-attacker"), false);
      assert.deepEqual(await env.store.resolveSecrets(victim), {
        apiKey: "api-secret-v1",
        headers: { "X-Tenant": "tenant-secret-v1" },
      });
    } finally {
      await env.cleanup();
    }
  });

  it("fails closed for malformed config, malformed secrets, and missing referenced secrets", async () => {
    const env = await fixture();
    try {
      await writeFile(env.configFile, "{broken", "utf8");
      await assert.rejects(() => env.store.readSnapshot(), SyntaxError);

      await rm(env.configFile, { force: true });
      const committed = await createProvider(env.store);
      await writeFile(env.secretsFile, "{broken", "utf8");
      await assert.rejects(() => env.store.readSnapshot(), SyntaxError);
      await assert.rejects(() => env.store.readRedacted(), SyntaxError);
      await assert.rejects(() => env.store.revealApiKey("acme"), SyntaxError);

      await writeFile(env.secretsFile, JSON.stringify({ schemaVersion: 1, values: {} }), "utf8");
      await assert.rejects(() => env.store.resolveSecrets(committed.providers[0]), /missing secret/i);
      await assert.rejects(() => env.store.readSnapshot(), /missing secret/i);
    } finally {
      await env.cleanup();
    }
  });
});
