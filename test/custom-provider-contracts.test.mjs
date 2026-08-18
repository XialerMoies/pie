import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { relative, resolve } from "node:path";
import { describe, it } from "node:test";

import {
  PROVIDER_PROTOCOLS,
  CustomProviderValidationError,
  assertSafeHeaderName,
  validateCustomProviderDefinition,
  validateCustomProviderDraft,
  validateCustomProviderSnapshot,
} from "../src/model-provider/contracts.ts";

function model(overrides = {}) {
  return {
    id: "reasoner-v1",
    name: "Reasoner v1",
    contextWindow: 128_000,
    maxTokens: 16_384,
    reasoning: true,
    input: ["text", "image"],
    cost: {
      input: 1.25,
      output: 5,
      cacheRead: 0.25,
      cacheWrite: 1.5,
    },
    samplingParams: { temperature: 0.7, stop: ["END"] },
    compatibility: { supportsDeveloperRole: true, nested: { mode: "strict" } },
    ...overrides,
  };
}

function provider(overrides = {}) {
  return {
    id: "acme-gateway",
    name: "Acme Gateway",
    protocol: "openai-responses",
    baseUrl: "https://api.example.test/v1",
    authMode: "apiKey",
    apiKeyRef: "credential:api-key-1",
    headers: [{ name: "X-Tenant", credentialRef: "credential:tenant-1" }],
    modelDiscovery: "https://api.example.test/v1/models",
    models: [model()],
    ...overrides,
  };
}

function snapshot(overrides = {}) {
  return {
    schemaVersion: 1,
    revision: 7,
    providers: [provider()],
    ...overrides,
  };
}

function clone(value) {
  return structuredClone(value);
}

describe("custom provider contracts", () => {
  it("type-checks the exact stable exported contract shapes", () => {
    const repositoryRoot = resolve(import.meta.dirname, "..");
    const root = mkdtempSync(resolve(tmpdir(), "custom-provider-contract-types-"));
    const fixtureFile = resolve(root, "contract-fixture.ts");
    const modulePath = relative(root, resolve(repositoryRoot, "src/model-provider/contracts.ts"))
      .replaceAll("\\", "/");
    const source = `
import type {
  ConnectionTestResult,
  CustomProviderCapabilities,
  CustomProviderDeleteInput,
  CustomProviderDraft,
  CustomProviderListResponse,
  CustomProviderMutationInput,
  DiscoveredModelMetadata,
  ModelDiscoveryResult,
  ModelCostRates,
  ModelDescriptor,
  ProviderUsage,
  RedactedCustomProvider,
  ResolvedCustomProviderDraft,
} from ${JSON.stringify(modulePath)};

const cost: ModelCostRates = { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0.2 };
const model: ModelDescriptor = {
  id: "model-a", name: "Model A", contextWindow: 100, maxTokens: 20,
  reasoning: false, input: ["text"], cost,
};
const draft: CustomProviderDraft = {
  id: "acme", name: "Acme", protocol: "openai-responses",
  baseUrl: "https://example.test/v1", authMode: "apiKey", apiKey: null,
  headers: [{ name: "X-One", value: "secret" }, { name: "X-Old", remove: true }],
  models: [model],
};
const mutation: CustomProviderMutationInput = { expectedRevision: 7, provider: draft };
const deletion: CustomProviderDeleteInput = { expectedRevision: 7 };
const revisionFreeDraft: CustomProviderDraft = {
  ...draft,
  // @ts-expect-error Optimistic concurrency metadata must stay outside the provider draft.
  expectedRevision: 7,
};
const redacted: RedactedCustomProvider = {
  id: "acme", name: "Acme", protocol: "openai-responses",
  baseUrl: "https://example.test/v1", authMode: "apiKey",
  apiKeyConfigured: true, headers: [{ name: "X-One", configured: true }], models: [model],
};
const list: CustomProviderListResponse = {
  revision: 1,
  official: [{ id: "openai", name: "OpenAI", configured: true }],
  custom: [redacted],
};
const resolved: ResolvedCustomProviderDraft = {
  provider: {
    id: "acme", name: "Acme", protocol: "openai-responses",
    baseUrl: "https://example.test/v1", authMode: "apiKey",
    headers: ["X-One"], models: [model],
  },
  secrets: { apiKey: "secret", headers: { "X-One": "value" } },
  modelId: "model-a",
};
const capabilities: CustomProviderCapabilities = {
  protocols: [{
    id: "openai-responses",
    authModes: ["none", "apiKey"],
    supportsCompatibility: true,
  }],
  price: { currency: "USD", unit: "millionTokens" },
};
const usage: ProviderUsage = { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 };
const discoveredMetadata: DiscoveredModelMetadata = {
  id: "model-a", contextWindow: 100, input: ["text"], cost: { input: 1 }, source: "provider",
};
const idOnlyDiscovery: ModelDiscoveryResult = { ids: ["model-a"] };
const richDiscovery: ModelDiscoveryResult = { ids: ["model-a"], models: [discoveredMetadata] };
const success: ConnectionTestResult = {
  ok: true, reachable: true, providerId: "acme", latencyMs: 5, httpStatus: 204,
  message: "ok",
};
const failure: ConnectionTestResult = {
  ok: false, reachable: true, providerId: "acme", latencyMs: 6, httpStatus: 401,
  code: "authentication", message: "denied",
};
const invalidDraft: CustomProviderDraft = {
  ...draft,
  headers: [{ name: "X-One",
    // @ts-expect-error Header values cannot be null.
    value: null }],
};
void [mutation, deletion, revisionFreeDraft, list, resolved, capabilities, usage, discoveredMetadata, idOnlyDiscovery, richDiscovery, success, failure, invalidDraft];
`;
    writeFileSync(fixtureFile, source, "utf8");
    try {
      const result = spawnSync(process.execPath, [
        resolve(repositoryRoot, "node_modules/typescript/bin/tsc"),
        "--noEmit",
        "--strict",
        "--target", "ES2022",
        "--module", "NodeNext",
        "--moduleResolution", "NodeNext",
        "--allowImportingTsExtensions",
        "--skipLibCheck",
        fixtureFile,
      ], { cwd: repositoryRoot, encoding: "utf8" });
      assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("exports the exact supported protocol list and accepts a complete fixture", () => {
    assert.deepEqual(PROVIDER_PROTOCOLS, [
      "openai-completions",
      "openai-responses",
      "anthropic-messages",
      "mistral-conversations",
      "azure-openai-responses",
      "pi-messages",
    ]);
    const fixture = snapshot();
    assert.deepEqual(validateCustomProviderDefinition(fixture.providers[0]), fixture.providers[0]);
    assert.deepEqual(validateCustomProviderSnapshot(fixture), fixture);
  });

  it("strictly validates drafts with stable typed field paths", () => {
    const valid = {
      id: "acme-gateway",
      name: "Acme Gateway",
      protocol: "openai-responses",
      baseUrl: "https://api.example.test/v1",
      authMode: "apiKey",
      apiKey: null,
      headers: [
        { name: "X-Tenant", value: "tenant-secret" },
        { name: "X-Old", remove: true },
      ],
      modelDiscovery: "https://api.example.test/v1/models",
      models: [model()],
    };
    assert.deepEqual(validateCustomProviderDraft(valid), valid);

    for (const [candidate, fieldPath] of [
      [{ ...valid, expectedRevision: 2 }, "provider"],
      [{ ...valid, apiKey: "   " }, "provider.apiKey"],
      [{ ...valid, headers: [{ name: "X-One", value: "" }] }, "provider.headers[0].value"],
      [{ ...valid, headers: [{ name: "X-One", value: "secret", remove: true }] }, "provider.headers[0]"],
      [{ ...valid, protocol: "google-generative-ai" }, "provider.protocol"],
    ]) {
      assert.throws(
        () => validateCustomProviderDraft(candidate),
        (error) => error instanceof CustomProviderValidationError && error.fieldPath === fieldPath,
      );
    }
  });

  it("advertises and enforces authentication modes for every protocol", async () => {
    const { PROVIDER_PROTOCOL_AUTH_MODES } = await import("../src/model-provider/contracts.ts");

    for (const protocol of PROVIDER_PROTOCOLS) {
      assert.deepEqual(PROVIDER_PROTOCOL_AUTH_MODES[protocol], ["none", "apiKey"]);
      const keyless = provider({ protocol, authMode: "none" });
      delete keyless.apiKeyRef;
      assert.doesNotThrow(() => validateCustomProviderDefinition(keyless));
      assert.doesNotThrow(() => validateCustomProviderDefinition(provider({ protocol })));
    }

    assert.equal(Object.hasOwn(PROVIDER_PROTOCOL_AUTH_MODES, "google-generative-ai"), false);
    assert.throws(
      () => validateCustomProviderDefinition(provider({ protocol: "google-generative-ai" })),
      (error) => error instanceof CustomProviderValidationError && error.fieldPath === "provider.protocol",
    );
  });

  it("rejects unknown fields at snapshot, provider, and model levels", () => {
    assert.throws(() => validateCustomProviderSnapshot({ ...snapshot(), extra: true }), /snapshot.*unknown field/);
    assert.throws(() => validateCustomProviderDefinition({ ...provider(), extra: true }), /provider.*unknown field/);
    assert.throws(
      () => validateCustomProviderDefinition(provider({ models: [{ ...model(), extra: true }] })),
      /models\[0\].*unknown field/,
    );
  });

  it("does not echo attacker-controlled unknown field names in validation errors", () => {
    const credentialId = "credential:fixture-sensitive-reference";
    const candidate = {
      id: "acme-gateway",
      name: "Acme Gateway",
      protocol: "openai-responses",
      baseUrl: "https://api.example.test/v1",
      authMode: "apiKey",
      apiKey: null,
      headers: [],
      models: [model()],
      [credentialId]: "fixture-secret-value",
    };
    assert.throws(
      () => validateCustomProviderDraft(candidate),
      (error) => error instanceof CustomProviderValidationError
        && error.fieldPath === "provider"
        && !error.message.includes(credentialId)
        && !error.message.includes("fixture-secret-value"),
    );
  });

  it("requires plain, finite JSON advanced objects no larger than 16 KiB", () => {
    const nonPlain = Object.create({ inherited: true });
    nonPlain.value = true;
    assert.throws(
      () => validateCustomProviderDefinition(provider({ models: [model({ samplingParams: nonPlain })] })),
      /models\[0\]\.samplingParams.*plain JSON object/,
    );
    assert.throws(
      () => validateCustomProviderDefinition(provider({ models: [model({ compatibility: { value: Number.NaN } })] })),
      /models\[0\]\.compatibility\.value.*finite/,
    );
    assert.throws(
      () => validateCustomProviderDefinition(provider({ models: [model({ samplingParams: { run() {} } })] })),
      /models\[0\]\.samplingParams\.run.*JSON/,
    );
    assert.throws(
      () => validateCustomProviderDefinition(provider({ models: [model({ compatibility: { data: "x".repeat(16 * 1024) } })] })),
      /models\[0\]\.compatibility.*16 KiB/,
    );
  });

  it("rejects invalid snapshots and duplicate provider ids or names", () => {
    assert.throws(() => validateCustomProviderSnapshot({ ...snapshot(), schemaVersion: 2 }), /snapshot\.schemaVersion/);
    assert.throws(() => validateCustomProviderSnapshot({ ...snapshot(), revision: -1 }), /snapshot\.revision/);
    assert.throws(() => validateCustomProviderSnapshot({ ...snapshot(), revision: 1.5 }), /snapshot\.revision/);
    assert.doesNotThrow(
      () => validateCustomProviderSnapshot({ schemaVersion: 1, revision: Number.MAX_SAFE_INTEGER, providers: [] }),
    );
    assert.throws(
      () => validateCustomProviderSnapshot({ schemaVersion: 1, revision: Number.MAX_SAFE_INTEGER + 1, providers: [] }),
      /snapshot\.revision.*safe integer/,
    );
    assert.throws(
      () => validateCustomProviderSnapshot(snapshot({ providers: [provider(), provider()] })),
      /providers\[1\]\.id.*duplicate/i,
    );
    assert.throws(
      () => validateCustomProviderSnapshot(snapshot({ providers: [provider(), provider({ id: "other" })] })),
      /providers\[1\]\.name.*duplicate/i,
    );
  });

  it("validates provider ids, names, protocols, URLs, and authentication", () => {
    assert.throws(() => validateCustomProviderDefinition(provider({ id: "Upper_Case" })), /provider\.id/);
    assert.throws(() => validateCustomProviderDefinition(provider({ name: "  " })), /provider\.name/);
    assert.throws(() => validateCustomProviderDefinition(provider({ protocol: "unknown" })), /provider\.protocol/);
    for (const baseUrl of ["/relative", "ftp://example.test/models", "not a url"]) {
      assert.throws(() => validateCustomProviderDefinition(provider({ baseUrl })), /provider\.baseUrl/);
    }
    for (const baseUrl of [
      "https://user@api.example.test/v1",
      "https://user:password@api.example.test/v1",
    ]) {
      assert.throws(() => validateCustomProviderDefinition(provider({ baseUrl })), /provider\.baseUrl/);
      const unsafeDraft = {
        ...provider({ baseUrl }),
        apiKey: "draft-secret",
        headers: [{ name: "X-Tenant", value: "tenant-secret" }],
      };
      delete unsafeDraft.apiKeyRef;
      assert.throws(() => validateCustomProviderDraft(unsafeDraft), /provider\.baseUrl/);
    }
    assert.equal(
      validateCustomProviderDefinition(provider({ modelDiscovery: "../models" })).modelDiscovery,
      "../models",
    );
    const relativeDraft = {
      ...provider({ modelDiscovery: "/models" }),
      apiKey: "draft-secret",
      headers: [{ name: "X-Tenant", value: "tenant-secret" }],
    };
    delete relativeDraft.apiKeyRef;
    assert.equal(validateCustomProviderDraft(relativeDraft).modelDiscovery, "/models");
    for (const modelDiscovery of ["", "   ", "javascript:alert(1)", "data:text/plain,models", "ftp://example.test/models", "http://["]) {
      assert.throws(
        () => validateCustomProviderDefinition(provider({ modelDiscovery })),
        /provider\.modelDiscovery/,
      );
    }
    for (const modelDiscovery of [
      "https://user@api.example.test/models",
      "https://user:password@api.example.test/models",
      "//user:password@api.example.test/models",
    ]) {
      assert.throws(
        () => validateCustomProviderDefinition(provider({ modelDiscovery })),
        /provider\.modelDiscovery/,
      );
      assert.throws(
        () => validateCustomProviderDraft({ ...relativeDraft, modelDiscovery }),
        /provider\.modelDiscovery/,
      );
    }
    assert.throws(
      () => validateCustomProviderDefinition(provider({ authMode: "none" })),
      /provider\.apiKeyRef.*must not/i,
    );
    const noRef = provider();
    delete noRef.apiKeyRef;
    assert.doesNotThrow(() => validateCustomProviderDefinition(noRef));
    assert.throws(
      () => validateCustomProviderDefinition(provider({ apiKeyRef: "secret:not-stable" })),
      /provider\.apiKeyRef/,
    );
    const anonymous = provider({ authMode: "none" });
    delete anonymous.apiKeyRef;
    assert.doesNotThrow(() => validateCustomProviderDefinition(anonymous));

  });

  it("validates safe header tokens, forbidden names, credential refs, and duplicates case-insensitively", () => {
    for (const name of ["host", "content-length", "connection", "transfer-encoding", "proxy-authorization", "proxy-authenticate", "te", "trailer", "upgrade"]) {
      assert.throws(() => assertSafeHeaderName(name.toUpperCase()), new RegExp(name, "i"));
    }
    assert.throws(() => assertSafeHeaderName("Bad Header"), /header name/i);
    assert.doesNotThrow(() => assertSafeHeaderName("X-Custom_Thing"));
    assert.throws(
      () => validateCustomProviderDefinition(provider({ headers: [{ name: "X-One", credentialRef: "bad-ref" }] })),
      /provider\.headers\[0\]\.credentialRef/,
    );
    assert.throws(
      () => validateCustomProviderDefinition(provider({ headers: [
        { name: "X-One", credentialRef: "credential:one" },
        { name: "x-one", credentialRef: "credential:two" },
      ] })),
      /provider\.headers\[1\]\.name.*duplicate/i,
    );
  });

  it("validates model identity, token limits, costs, and input capabilities", () => {
    assert.throws(
      () => validateCustomProviderDefinition(provider({ models: [model({ id: "" })] })),
      /models\[0\]\.id/,
    );
    assert.throws(
      () => validateCustomProviderDefinition(provider({ models: [model({ name: "" })] })),
      /models\[0\]\.name/,
    );
    for (const [field, value] of [["contextWindow", 0], ["contextWindow", 1.5], ["maxTokens", -1], ["maxTokens", Infinity]]) {
      assert.throws(
        () => validateCustomProviderDefinition(provider({ models: [model({ [field]: value })] })),
        new RegExp(`models\\[0\\]\\.${field}`),
      );
    }
    assert.throws(
      () => validateCustomProviderDefinition(provider({ models: [model({ contextWindow: 10, maxTokens: 11 })] })),
      /models\[0\]\.maxTokens.*contextWindow/,
    );
    for (const field of ["input", "output", "cacheRead", "cacheWrite"]) {
      const invalid = model();
      invalid.cost[field] = -0.01;
      assert.throws(
        () => validateCustomProviderDefinition(provider({ models: [invalid] })),
        new RegExp(`models\\[0\\]\\.cost\\.${field}`),
      );
    }
    const nonFinite = model();
    nonFinite.cost.output = Number.NaN;
    assert.throws(
      () => validateCustomProviderDefinition(provider({ models: [nonFinite] })),
      /models\[0\]\.cost\.output.*finite/,
    );
    for (const input of [[], ["audio"], ["text", "text"]]) {
      assert.throws(
        () => validateCustomProviderDefinition(provider({ models: [model({ input })] })),
        /models\[0\]\.input/,
      );
    }
    assert.throws(
      () => validateCustomProviderDefinition(provider({ models: [] })),
      /provider\.models/,
    );
  });

  it("rejects duplicate model ids and names", () => {
    assert.throws(
      () => validateCustomProviderDefinition(provider({ models: [model(), model()] })),
      /models\[1\]\.id.*duplicate/i,
    );
    assert.throws(
      () => validateCustomProviderDefinition(provider({ models: [model(), model({ id: "other" })] })),
      /models\[1\]\.name.*duplicate/i,
    );
  });
});
