import type { ModelRuntime } from "@xiamol/pi-coding-agent";

import {
  PROVIDER_PROTOCOLS,
  PROVIDER_PROTOCOL_AUTH_MODES,
  CustomProviderInvalidRequestError,
  validateCustomProviderDraft,
  type CustomProviderCapabilities,
  type CustomProviderDeleteInput,
  type CustomProviderDraft,
  type CustomProviderListResponse,
  type CustomProviderMutationInput,
  type CustomProviderSnapshot,
  type RedactedCustomProviderSnapshot,
} from "./contracts.js";
import {
  CustomProviderRevisionConflict,
  type CustomProviderStore,
  type StoredProviderMutation,
} from "./custom-provider-store.js";
import type { ProviderReferenceChecker } from "./provider-reference-checker.js";
import type { ProviderReferenceMutationLock } from "./provider-reference-lock.js";
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
  store: Pick<CustomProviderStore, "commit" | "readSnapshot" | "readRedacted" | "revealApiKey">;
  coordinator: Pick<CustomProviderRuntimeCoordinator, "sync">;
  referenceChecker: ProviderReferenceChecker;
  referenceLock: ProviderReferenceMutationLock;
}

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
  readonly #knownCustomIds = new Set<string>();
  readonly #officialIds = new WeakMap<ModelRuntime, Set<string>>();

  constructor(options: CustomProviderServiceOptions) {
    this.#store = options.store;
    this.#coordinator = options.coordinator;
    this.#referenceChecker = options.referenceChecker;
    this.#referenceLock = options.referenceLock;
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

  #officialIdsFor(runtime: ModelRuntime, customIds: ReadonlySet<string>): Set<string> {
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

  async list(runtime: ModelRuntime): Promise<CustomProviderListResponse> {
    const snapshot = await this.#store.readRedacted();
    const customIds = new Set(snapshot.providers.map((provider) => provider.id));
    const officialIds = this.#officialIdsFor(runtime, customIds);
    const official = runtime.getProviders()
      .filter((provider) => officialIds.has(provider.id))
      .map((provider) => ({
        id: provider.id,
        name: provider.name,
        configured: runtime.getProviderAuthStatus(provider.id).configured,
      }));
    return { revision: snapshot.revision, official, custom: snapshot.providers };
  }

  async create(input: CustomProviderMutationInput, runtime: ModelRuntime): Promise<RedactedCustomProviderSnapshot> {
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
    runtime: ModelRuntime,
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
    runtime: ModelRuntime,
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

  async syncRuntime(runtime: ModelRuntime): Promise<number> {
    const snapshot = await this.#store.readSnapshot();
    this.#officialIdsFor(runtime, new Set(snapshot.providers.map((provider) => provider.id)));
    return this.#coordinator.sync(runtime);
  }
}
