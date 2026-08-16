import {
  createProvider,
  type Model,
  type Provider,
  type Usage,
} from "@earendil-works/pi-ai";
import { anthropicMessagesApi } from "@earendil-works/pi-ai/api/anthropic-messages.lazy";
import { azureOpenAIResponsesApi } from "@earendil-works/pi-ai/api/azure-openai-responses.lazy";
import { googleGenerativeAIApi } from "@earendil-works/pi-ai/api/google-generative-ai.lazy";
import { mistralConversationsApi } from "@earendil-works/pi-ai/api/mistral-conversations.lazy";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { openAIResponsesApi } from "@earendil-works/pi-ai/api/openai-responses.lazy";
import { piMessagesApi } from "@earendil-works/pi-ai/api/pi-messages.lazy";
import type { ModelRuntime } from "@xiamol/pi-coding-agent";

import {
  validateCustomProviderDefinition,
  type CustomProviderDefinition,
  type ProviderProtocol,
  type ProviderUsage,
  type ResolvedProviderSecrets,
} from "./contracts.ts";

export interface PreparedCustomProvider {
  readonly providerId: string;
  readonly models: readonly Model<ProviderProtocol>[];
}

type RuntimeProviderConfig = Parameters<ModelRuntime["registerProvider"]>[1];

type PreparedRegistration =
  | {
      kind: "configured";
      providerId: string;
      config: RuntimeProviderConfig;
    }
  | {
      kind: "native";
      providerId: string;
      provider: Provider<ProviderProtocol>;
    };

const API_FACTORIES = {
  "openai-completions": openAICompletionsApi,
  "openai-responses": openAIResponsesApi,
  "anthropic-messages": anthropicMessagesApi,
  "google-generative-ai": googleGenerativeAIApi,
  "mistral-conversations": mistralConversationsApi,
  "azure-openai-responses": azureOpenAIResponsesApi,
  "pi-messages": piMessagesApi,
} satisfies Record<ProviderProtocol, () => ReturnType<typeof openAICompletionsApi>>;

function cloneHeaders(
  definition: CustomProviderDefinition,
  secrets: ResolvedProviderSecrets,
): Record<string, string> {
  const configuredNames = new Set(definition.headers.map((header) => header.name));
  for (const name of Object.keys(secrets.headers)) {
    if (!configuredNames.has(name)) {
      throw new Error(`Resolved header is not configured for provider ${definition.id}: ${name}`);
    }
  }

  const headers = Object.create(null) as Record<string, string>;
  for (const header of definition.headers) {
    if (!Object.prototype.hasOwnProperty.call(secrets.headers, header.name)) {
      throw new Error(`Provider header does not have a resolved value: ${header.name}`);
    }
    const value = secrets.headers[header.name];
    if (typeof value !== "string") {
      throw new Error(`Provider header does not have a resolved value: ${header.name}`);
    }
    headers[header.name] = value;
  }
  return headers;
}

function mapModels(definition: CustomProviderDefinition): readonly Model<ProviderProtocol>[] {
  return Object.freeze(definition.models.map((descriptor) => ({
    id: descriptor.id,
    name: descriptor.name,
    api: definition.protocol,
    provider: definition.id,
    baseUrl: definition.baseUrl,
    reasoning: descriptor.reasoning,
    input: structuredClone(descriptor.input),
    cost: structuredClone(descriptor.cost),
    contextWindow: descriptor.contextWindow,
    maxTokens: descriptor.maxTokens,
    ...(descriptor.samplingParams === undefined
      ? {}
      : { samplingParams: structuredClone(descriptor.samplingParams) }),
    ...(descriptor.compatibility === undefined
      ? {}
      : { compat: structuredClone(descriptor.compatibility) }),
  } as Model<ProviderProtocol>)));
}

export class PiCustomProviderAdapter {
  readonly #registrations = new WeakMap<PreparedCustomProvider, PreparedRegistration>();
  readonly #ownedByRuntime = new WeakMap<ModelRuntime, ReadonlyMap<string, PreparedCustomProvider>>();

  prepare(
    definition: CustomProviderDefinition,
    secrets: ResolvedProviderSecrets,
  ): PreparedCustomProvider {
    const validated = validateCustomProviderDefinition(definition);
    const headers = cloneHeaders(validated, secrets);
    const models = mapModels(validated);
    const prepared = Object.freeze({
      providerId: validated.id,
      models,
    });

    if (validated.authMode === "apiKey") {
      if (typeof secrets.apiKey !== "string" || secrets.apiKey.length === 0) {
        throw new Error(`Provider ${validated.id} requires a resolved API key`);
      }
      this.#registrations.set(prepared, {
        kind: "configured",
        providerId: validated.id,
        config: {
          name: validated.name,
          baseUrl: validated.baseUrl,
          api: validated.protocol,
          apiKey: secrets.apiKey,
          headers,
          authHeader: true,
          models: models as RuntimeProviderConfig["models"],
        },
      });
      return prepared;
    }

    const provider = createProvider<ProviderProtocol>({
      id: validated.id,
      name: validated.name,
      baseUrl: validated.baseUrl,
      headers,
      auth: {
        apiKey: {
          name: validated.name,
          check: async () => ({ type: "api_key", source: "custom-provider" }),
          resolve: async () => ({ auth: {}, source: "custom-provider" }),
        },
      },
      models,
      api: API_FACTORIES[validated.protocol](),
    });
    this.#registrations.set(prepared, {
      kind: "native",
      providerId: validated.id,
      provider,
    });
    return prepared;
  }

  replaceRuntimeProviders(
    runtime: ModelRuntime,
    prepared: readonly PreparedCustomProvider[],
  ): void {
    const next = new Map<string, PreparedCustomProvider>();
    const registrations: PreparedRegistration[] = [];
    for (const entry of prepared) {
      if (next.has(entry.providerId)) {
        throw new Error(`Duplicate prepared provider ID: ${entry.providerId}`);
      }
      const registration = this.#registrations.get(entry);
      if (registration === undefined) {
        throw new Error(`Prepared provider is not owned by this adapter: ${entry.providerId}`);
      }
      next.set(entry.providerId, entry);
      registrations.push(registration);
    }

    const prior = this.#ownedByRuntime.get(runtime) ?? new Map<string, PreparedCustomProvider>();
    for (const registration of registrations) {
      if (runtime.getProvider(registration.providerId) !== undefined && !prior.has(registration.providerId)) {
        throw new Error(`Provider ID collision: ${registration.providerId} is already registered`);
      }
    }

    const attempted: PreparedRegistration[] = [];
    try {
      for (const providerId of prior.keys()) runtime.unregisterProvider(providerId);
      for (const registration of registrations) {
        attempted.push(registration);
        this.#register(runtime, registration);
      }
      this.#ownedByRuntime.set(runtime, next);
    } catch (error) {
      const rollbackIds = new Set([
        ...attempted.map((registration) => registration.providerId),
        ...prior.keys(),
      ]);
      for (const providerId of rollbackIds) {
        try {
          runtime.unregisterProvider(providerId);
        } catch {
          // Rollback is best-effort; retain the original replacement error.
        }
      }
      for (const entry of prior.values()) {
        const registration = this.#registrations.get(entry);
        if (registration === undefined) continue;
        try {
          this.#register(runtime, registration);
        } catch {
          // Rollback is best-effort; ownership remains at the prior set.
        }
      }
      throw error;
    }
  }

  toProviderUsage(usage: Usage): ProviderUsage {
    return {
      input: usage.input,
      output: usage.output,
      cacheRead: usage.cacheRead,
      cacheWrite: usage.cacheWrite,
      ...(usage.reasoning === undefined ? {} : { reasoning: usage.reasoning }),
    };
  }

  #register(runtime: ModelRuntime, registration: PreparedRegistration): void {
    if (registration.kind === "native") {
      runtime.registerNativeProvider(registration.provider);
      return;
    }
    runtime.registerProvider(registration.providerId, registration.config);
  }
}
