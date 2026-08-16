import {
  createProvider,
  type Model,
  type Provider,
  type ProviderStreams,
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
} from "./contracts.js";

export interface PreparedCustomProvider {
  readonly providerId: string;
  readonly models: readonly Model<ProviderProtocol>[];
}

interface PreparedRegistration {
  providerId: string;
  provider: Provider<ProviderProtocol>;
}

const API_FACTORIES = {
  "openai-completions": openAICompletionsApi,
  "openai-responses": openAIResponsesApi,
  "anthropic-messages": anthropicMessagesApi,
  "google-generative-ai": googleGenerativeAIApi,
  "mistral-conversations": mistralConversationsApi,
  "azure-openai-responses": azureOpenAIResponsesApi,
  "pi-messages": piMessagesApi,
} satisfies Record<ProviderProtocol, () => ProviderStreams>;

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

function copyHeaders(headers: Readonly<Record<string, string>>): Record<string, string> {
  const copy = Object.create(null) as Record<string, string>;
  for (const [name, value] of Object.entries(headers)) copy[name] = value;
  return copy;
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
  readonly #ownedByRuntime = new WeakMap<
    ModelRuntime,
    ReadonlyMap<string, Provider<ProviderProtocol>>
  >();

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

    const usesApiKey = validated.authMode === "apiKey";
    if (usesApiKey && validated.headers.some((header) => header.name.toLowerCase() === "authorization")) {
      throw new Error(`Provider ${validated.id} cannot use an Authorization header with authMode apiKey`);
    }
    if (usesApiKey && (typeof secrets.apiKey !== "string" || secrets.apiKey.length === 0)) {
      throw new Error(`Provider ${validated.id} requires a resolved API key`);
    }
    const apiKey = usesApiKey ? secrets.apiKey : undefined;

    const provider = createProvider<ProviderProtocol>({
      id: validated.id,
      name: validated.name,
      baseUrl: validated.baseUrl,
      auth: {
        apiKey: {
          name: validated.name,
          check: async () => ({ type: "api_key", source: "custom-provider" }),
          resolve: async () => ({
            auth: {
              ...(apiKey === undefined ? {} : { apiKey }),
              headers: copyHeaders(headers),
            },
            source: "custom-provider",
          }),
        },
      },
      models,
      api: API_FACTORIES[validated.protocol](),
    });
    this.#registrations.set(prepared, {
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

    const recordedPrior = this.#ownedByRuntime.get(runtime) ?? new Map<string, Provider<ProviderProtocol>>();
    const prior = new Map<string, Provider<ProviderProtocol>>();
    for (const [providerId, provider] of recordedPrior) {
      if (runtime.getRegisteredNativeProvider(providerId) === provider) prior.set(providerId, provider);
    }
    this.#ownedByRuntime.set(runtime, prior);

    let collisionId: string | undefined;
    for (const registration of registrations) {
      if (runtime.getProvider(registration.providerId) !== undefined && !prior.has(registration.providerId)) {
        collisionId ??= registration.providerId;
      }
    }
    if (collisionId !== undefined) {
      throw new Error(`Provider ID collision: ${collisionId} is already registered`);
    }

    const attempted: PreparedRegistration[] = [];
    try {
      for (const [providerId, provider] of prior) {
        if (runtime.getRegisteredNativeProvider(providerId) === provider) {
          runtime.unregisterProvider(providerId);
        }
      }
      for (const registration of registrations) {
        attempted.push(registration);
        runtime.registerNativeProvider(registration.provider);
        if (runtime.getRegisteredNativeProvider(registration.providerId) !== registration.provider) {
          throw new Error(`Native provider registration was not retained: ${registration.providerId}`);
        }
      }
      this.#ownedByRuntime.set(runtime, new Map(
        registrations.map((registration) => [registration.providerId, registration.provider]),
      ));
    } catch (primaryFailure) {
      const rollbackFailures: unknown[] = [];
      for (const registration of attempted) {
        if (runtime.getRegisteredNativeProvider(registration.providerId) !== registration.provider) continue;
        try {
          runtime.unregisterProvider(registration.providerId);
        } catch (error) {
          rollbackFailures.push(error);
        }
      }

      const restored = new Map<string, Provider<ProviderProtocol>>();
      for (const [providerId, provider] of prior) {
        const currentNative = runtime.getRegisteredNativeProvider(providerId);
        if (currentNative === provider) {
          restored.set(providerId, provider);
          continue;
        }
        if (currentNative !== undefined || runtime.getProvider(providerId) !== undefined) {
          rollbackFailures.push(new Error(`Rollback could not restore provider replaced externally: ${providerId}`));
          continue;
        }
        try {
          runtime.registerNativeProvider(provider);
          if (runtime.getRegisteredNativeProvider(providerId) !== provider) {
            throw new Error(`Rollback did not retain restored provider: ${providerId}`);
          }
          restored.set(providerId, provider);
        } catch (error) {
          rollbackFailures.push(error);
          if (runtime.getRegisteredNativeProvider(providerId) === provider) {
            restored.set(providerId, provider);
          }
        }
      }
      this.#ownedByRuntime.set(runtime, restored);

      if (rollbackFailures.length > 0) {
        throw new AggregateError(
          [primaryFailure, ...rollbackFailures],
          "Custom provider replacement failed and rollback was incomplete",
        );
      }
      throw primaryFailure;
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
}
