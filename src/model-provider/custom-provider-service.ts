import type { ModelRuntime } from "@xiamol/pi-coding-agent";

import {
  PROVIDER_PROTOCOLS,
  PROVIDER_PROTOCOL_AUTH_MODES,
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

export interface CustomProviderServiceOptions {
  store: Pick<CustomProviderStore, "commit" | "readSnapshot" | "readRedacted" | "revealApiKey">;
  coordinator: Pick<CustomProviderRuntimeCoordinator, "sync">;
  referenceChecker: ProviderReferenceChecker;
}

function assertRevision(expectedRevision: number, currentRevision: number): void {
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
    throw new Error("expectedRevision must be a non-negative safe integer");
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

  constructor(options: CustomProviderServiceOptions) {
    this.#store = options.store;
    this.#coordinator = options.coordinator;
    this.#referenceChecker = options.referenceChecker;
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

  async list(runtime: ModelRuntime): Promise<CustomProviderListResponse> {
    const snapshot = await this.#store.readRedacted();
    const customIds = new Set(snapshot.providers.map((provider) => provider.id));
    const official = runtime.getProviders()
      .filter((provider) => !customIds.has(provider.id))
      .map((provider) => ({
        id: provider.id,
        name: provider.name,
        configured: runtime.getProviderAuthStatus(provider.id).configured,
      }));
    return { revision: snapshot.revision, official, custom: snapshot.providers };
  }

  async create(input: CustomProviderMutationInput, runtime: ModelRuntime): Promise<RedactedCustomProviderSnapshot> {
    const current = await this.#store.readSnapshot();
    assertRevision(input.expectedRevision, current.revision);
    if (current.providers.some((provider) => provider.id === input.provider.id)) {
      throw new CustomProviderIdConflict(input.provider.id, "custom");
    }
    const customIds = new Set(current.providers.map((provider) => provider.id));
    if (runtime.getProviders().some((provider) => provider.id === input.provider.id && !customIds.has(provider.id))) {
      throw new CustomProviderIdConflict(input.provider.id, "official");
    }
    const committed = await this.#store.commit({
      expectedRevision: input.expectedRevision,
      provider: storedMutation(input.provider),
      secretPatch: { apiKey: input.provider.apiKey, headers: input.provider.headers },
    });
    return redact(committed);
  }

  async update(
    providerId: string,
    input: CustomProviderMutationInput,
    _runtime: ModelRuntime,
  ): Promise<RedactedCustomProviderSnapshot> {
    const current = await this.#store.readSnapshot();
    assertRevision(input.expectedRevision, current.revision);
    if (input.provider.id !== providerId) {
      throw new CustomProviderImmutableIdError(providerId, input.provider.id);
    }
    const existing = current.providers.find((provider) => provider.id === providerId);
    if (existing === undefined) throw new Error(`Unknown custom provider: ${providerId}`);
    const nextModelIds = new Set(input.provider.models.map((model) => model.id));
    const removedModelIds = new Set(
      existing.models.map((model) => model.id).filter((modelId) => !nextModelIds.has(modelId)),
    );
    if (removedModelIds.size > 0) this.#referenceChecker.assertUnused(providerId, removedModelIds);

    const committed = await this.#store.commit({
      expectedRevision: input.expectedRevision,
      provider: storedMutation(input.provider),
      secretPatch: { apiKey: input.provider.apiKey, headers: input.provider.headers },
    });
    return redact(committed);
  }

  async delete(
    providerId: string,
    input: CustomProviderDeleteInput,
    _runtime: ModelRuntime,
  ): Promise<RedactedCustomProviderSnapshot> {
    const current = await this.#store.readSnapshot();
    assertRevision(input.expectedRevision, current.revision);
    if (!current.providers.some((provider) => provider.id === providerId)) {
      throw new Error(`Unknown custom provider: ${providerId}`);
    }
    this.#referenceChecker.assertUnused(providerId);
    const committed = await this.#store.commit({
      expectedRevision: input.expectedRevision,
      removeProviderId: providerId,
      secretPatch: { headers: [] },
    });
    return redact(committed);
  }

  async revealApiKey(providerId: string): Promise<string> {
    const apiKey = await this.#store.revealApiKey(providerId);
    if (apiKey === undefined) throw new CustomProviderApiKeyUnavailable(providerId);
    return apiKey;
  }

  syncRuntime(runtime: ModelRuntime): Promise<number> {
    return this.#coordinator.sync(runtime);
  }
}
