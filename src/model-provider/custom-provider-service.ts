import type { ProviderRuntime } from "./runtime-types.js";

import {
  PROVIDER_PROTOCOLS,
  PROVIDER_PROTOCOL_AUTH_MODES,
  CustomProviderInvalidRequestError,
  CustomProviderValidationError,
  validateCustomProviderDraft,
  type ConnectionTestResult,
  type CustomProviderCapabilities,
  type CustomProviderDeleteInput,
  type CustomProviderDraft,
  type CustomProviderListResponse,
  type CustomProviderMutationInput,
  type ModelDiscoveryResult,
  type CustomProviderSnapshot,
  type RedactedCustomProviderSnapshot,
  type ResolvedCustomProviderDraft,
  type ResolvedProviderSecrets,
} from "./contracts.js";
import {
  CustomProviderRevisionConflict,
  type CustomProviderStore,
  type StoredProviderMutation,
} from "./custom-provider-store.js";
import type { ProviderReferenceChecker } from "./provider-reference-checker.js";
import type { ProviderReferenceMutationLock } from "./provider-reference-lock.js";
import { ProviderNetworkClient } from "./provider-network-client.js";
import type { CustomProviderRuntimeCoordinator } from "./runtime-coordinator.js";

export class CustomProviderIdConflict extends Error {
  constructor(
    public readonly providerId: string,
    public readonly source: "official" | "custom",
  ) {
    super(`Custom provider ID conflicts with an ${source} provider: ${providerId}`);
    this.name = "CustomProviderIdConflict";
  }
}

export class CustomProviderImmutableIdError extends Error {
  constructor(
    public readonly providerId: string,
    public readonly requestedId: string,
  ) {
    super(`Custom provider ID is immutable: ${providerId}`);
    this.name = "CustomProviderImmutableIdError";
  }
}

export class CustomProviderApiKeyUnavailable extends Error {
  constructor(public readonly providerId: string) {
    super(`Custom provider API key is not configured: ${providerId}`);
    this.name = "CustomProviderApiKeyUnavailable";
  }
}

export class CustomProviderNotFoundError extends Error {
  constructor(public readonly providerId: string) {
    super("Custom provider was not found");
    this.name = "CustomProviderNotFoundError";
  }
}

export interface CustomProviderServiceOptions {
  store: Pick<
    CustomProviderStore,
    "commit" | "readSnapshot" | "readRedacted" | "revealApiKey" | "resolveSecrets"
  >;
  coordinator: Pick<CustomProviderRuntimeCoordinator, "sync">;
  referenceChecker: ProviderReferenceChecker;
  referenceLock: ProviderReferenceMutationLock;
  networkClient?: Pick<ProviderNetworkClient, "testConnection" | "discoverModels">;
}

const MODEL_DISCOVERY_SENTINEL_ID = "__model_discovery__";

function assertRevision(expectedRevision: number, currentRevision: number): void {
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
    throw new CustomProviderInvalidRequestError("expectedRevision");
  }
  if (expectedRevision !== currentRevision) {
    throw new CustomProviderRevisionConflict(expectedRevision, currentRevision);
  }
}

function storedMutation(draft: CustomProviderDraft): StoredProviderMutation {
  return {
    id: draft.id,
    name: draft.name,
    protocol: draft.protocol,
    baseUrl: draft.baseUrl,
    authMode: draft.authMode,
    headers: draft.headers.filter((header) => header.remove !== true).map((header) => header.name),
    ...(draft.modelDiscovery === undefined ? {} : { modelDiscovery: draft.modelDiscovery }),
    models: draft.models,
  };
}

function redact(snapshot: CustomProviderSnapshot): RedactedCustomProviderSnapshot {
  return {
    schemaVersion: 1,
    revision: snapshot.revision,
    providers: snapshot.providers.map(({ apiKeyRef, headers, ...provider }) => ({
      ...structuredClone(provider),
      apiKeyConfigured: apiKeyRef !== undefined,
      headers: headers.map((header) => ({ name: header.name, configured: true })),
    })),
  };
}

export class CustomProviderService {
  readonly #store: CustomProviderServiceOptions["store"];
  readonly #coordinator: CustomProviderServiceOptions["coordinator"];
  readonly #referenceChecker: ProviderReferenceChecker;
  readonly #referenceLock: ProviderReferenceMutationLock;
  readonly #networkClient: NonNullable<CustomProviderServiceOptions["networkClient"]>;
  readonly #knownCustomIds = new Set<string>();
  readonly #officialIds = new WeakMap<ProviderRuntime, Set<string>>();

  constructor(options: CustomProviderServiceOptions) {
    this.#store = options.store;
    this.#coordinator = options.coordinator;
    this.#referenceChecker = options.referenceChecker;
    this.#referenceLock = options.referenceLock;
    this.#networkClient = options.networkClient ?? new ProviderNetworkClient();
  }

  capabilities(): CustomProviderCapabilities {
    return {
      protocols: PROVIDER_PROTOCOLS.map((id) => ({
        id,
        authModes: PROVIDER_PROTOCOL_AUTH_MODES[id],
        supportsCompatibility: true,
      })),
      price: { currency: "USD", unit: "millionTokens" },
    };
  }

  #officialIdsFor(runtime: ProviderRuntime, customIds: ReadonlySet<string>): Set<string> {
    for (const id of customIds) this.#knownCustomIds.add(id);
    let officialIds = this.#officialIds.get(runtime);
    if (officialIds === undefined) {
      officialIds = new Set(
        runtime.getProviders()
          .map((provider) => provider.id)
          .filter((id) => !customIds.has(id) && !this.#knownCustomIds.has(id)),
      );
      this.#officialIds.set(runtime, officialIds);
    }
    return officialIds;
  }

  async list(runtime: ProviderRuntime): Promise<CustomProviderListResponse> {
    const snapshot = await this.#store.readRedacted();
    const customIds = new Set(snapshot.providers.map((provider) => provider.id));
    const officialIds = this.#officialIdsFor(runtime, customIds);
    const official = runtime.getProviders()
      .filter((provider) => officialIds.has(provider.id))
      .map((provider) => ({
        id: provider.id,
        name: provider.name,
        configured: Boolean(runtime.getProviderAuthStatus(provider.id)?.configured),
      }));
    return { revision: snapshot.revision, official, custom: snapshot.providers };
  }

  async create(input: CustomProviderMutationInput, runtime: ProviderRuntime): Promise<RedactedCustomProviderSnapshot> {
    const provider = validateCustomProviderDraft(input.provider);
    const current = await this.#store.readSnapshot();
    assertRevision(input.expectedRevision, current.revision);
    if (current.providers.some((candidate) => candidate.id === provider.id)) {
      throw new CustomProviderIdConflict(provider.id, "custom");
    }
    const customIds = new Set(current.providers.map((provider) => provider.id));
    const officialIds = this.#officialIdsFor(runtime, customIds);
    if (officialIds.has(provider.id)) {
      throw new CustomProviderIdConflict(provider.id, "official");
    }
    const committed = await this.#store.commit({
      expectedRevision: input.expectedRevision,
      provider: storedMutation(provider),
      secretPatch: { apiKey: provider.apiKey, headers: provider.headers },
    });
    this.#knownCustomIds.add(provider.id);
    return redact(committed);
  }

  async update(
    providerId: string,
    input: CustomProviderMutationInput,
    runtime: ProviderRuntime,
  ): Promise<RedactedCustomProviderSnapshot> {
    const provider = validateCustomProviderDraft(input.provider);
    return this.#referenceLock.runExclusive(async () => {
      const current = await this.#store.readSnapshot();
      assertRevision(input.expectedRevision, current.revision);
      if (provider.id !== providerId) {
        throw new CustomProviderImmutableIdError(providerId, provider.id);
      }
      const existing = current.providers.find((candidate) => candidate.id === providerId);
      if (existing === undefined) throw new CustomProviderNotFoundError(providerId);
      this.#officialIdsFor(runtime, new Set(current.providers.map((candidate) => candidate.id)));
      const nextModelIds = new Set(provider.models.map((model) => model.id));
      const removedModelIds = new Set(
        existing.models.map((model) => model.id).filter((modelId) => !nextModelIds.has(modelId)),
      );
      if (removedModelIds.size > 0) this.#referenceChecker.assertUnused(providerId, removedModelIds);

      const committed = await this.#store.commit({
        expectedRevision: input.expectedRevision,
        provider: storedMutation(provider),
        secretPatch: { apiKey: provider.apiKey, headers: provider.headers },
      });
      return redact(committed);
    });
  }

  async delete(
    providerId: string,
    input: CustomProviderDeleteInput,
    runtime: ProviderRuntime,
  ): Promise<RedactedCustomProviderSnapshot> {
    return this.#referenceLock.runExclusive(async () => {
      const current = await this.#store.readSnapshot();
      assertRevision(input.expectedRevision, current.revision);
      if (!current.providers.some((provider) => provider.id === providerId)) {
        throw new CustomProviderNotFoundError(providerId);
      }
      this.#officialIdsFor(runtime, new Set(current.providers.map((provider) => provider.id)));
      this.#referenceChecker.assertUnused(providerId);
      const committed = await this.#store.commit({
        expectedRevision: input.expectedRevision,
        removeProviderId: providerId,
        secretPatch: { headers: [] },
      });
      return redact(committed);
    });
  }

  async revealApiKey(providerId: string): Promise<string> {
    const apiKey = await this.#store.revealApiKey(providerId);
    if (apiKey === undefined) throw new CustomProviderApiKeyUnavailable(providerId);
    return apiKey;
  }

  async #resolveNetworkDraft(
    draft: CustomProviderDraft,
    options: { allowNetworkSentinel?: boolean } = {},
  ): Promise<ResolvedCustomProviderDraft> {
    const validated = validateCustomProviderDraft(draft);
    const models = options.allowNetworkSentinel
      && validated.models.length === 1
      && validated.models[0]?.id === MODEL_DISCOVERY_SENTINEL_ID
      ? []
      : validated.models;
    const snapshot = await this.#store.readSnapshot();
    const saved = snapshot.providers.find((provider) => provider.id === validated.id);
    const activeHeaders = validated.headers.flatMap((header, index) => (
      header.remove === true ? [] : [{ header, index }]
    ));
    const needsSavedApiKey = validated.authMode === "apiKey" && validated.apiKey === undefined;
    const needsSavedHeaders = activeHeaders.some(({ header }) => header.value === undefined);
    let savedSecrets: ResolvedProviderSecrets | undefined;
    if (saved !== undefined && (needsSavedApiKey || needsSavedHeaders)) {
      savedSecrets = await this.#store.resolveSecrets(saved);
    }

    let apiKey: string | undefined;
    if (validated.authMode === "apiKey") {
      apiKey = validated.apiKey === undefined ? savedSecrets?.apiKey : validated.apiKey ?? undefined;
      if (apiKey === undefined) {
        throw new CustomProviderValidationError("provider.apiKey", "must be provided for network operations");
      }
    }

    const headers = Object.create(null) as Record<string, string>;
    for (let index = 0; index < activeHeaders.length; index += 1) {
      const { header, index: draftIndex } = activeHeaders[index];
      const savedHeader = savedSecrets === undefined
        ? undefined
        : Object.entries(savedSecrets.headers).find(([name]) => name.toLowerCase() === header.name.toLowerCase())?.[1];
      const value = header.value ?? savedHeader;
      if (value === undefined) {
        throw new CustomProviderValidationError(
          `provider.headers[${draftIndex}].value`,
          "must be provided for network operations",
        );
      }
      headers[header.name] = value;
    }

    const { apiKey: _apiKey, headers: _headers, ...provider } = validated;
    return {
      provider: {
        ...provider,
        models,
        headers: activeHeaders.map(({ header }) => header.name),
      },
      secrets: {
        ...(apiKey === undefined ? {} : { apiKey }),
        headers,
      },
      modelId: models[0]?.id,
    };
  }

  async testConnection(draft: CustomProviderDraft, signal?: AbortSignal): Promise<ConnectionTestResult> {
    return this.#networkClient.testConnection(
      await this.#resolveNetworkDraft(draft, { allowNetworkSentinel: true }),
      signal,
    );
  }

  async discoverModels(draft: CustomProviderDraft, signal?: AbortSignal): Promise<ModelDiscoveryResult> {
    return this.#networkClient.discoverModels(
      await this.#resolveNetworkDraft(draft, { allowNetworkSentinel: true }),
      signal,
    );
  }

  async syncRuntime(runtime: ProviderRuntime): Promise<number> {
    const snapshot = await this.#store.readSnapshot();
    this.#officialIdsFor(runtime, new Set(snapshot.providers.map((provider) => provider.id)));
    return this.#coordinator.sync(runtime);
  }
}
