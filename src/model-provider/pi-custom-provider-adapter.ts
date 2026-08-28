import {
  createProvider,
  createAssistantMessageEventStream,
  type AssistantMessageEvent,
  type AssistantMessageEventStream,
  type FetchFunction,
  type Model,
  type Provider,
  type ProviderStreams,
  type StreamOptions,
  type Usage,
} from "@earendil-works/pi-ai";
import { anthropicMessagesApi } from "@earendil-works/pi-ai/api/anthropic-messages.lazy";
import { azureOpenAIResponsesApi } from "@earendil-works/pi-ai/api/azure-openai-responses.lazy";
import { mistralConversationsApi } from "@earendil-works/pi-ai/api/mistral-conversations.lazy";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { openAIResponsesApi } from "@earendil-works/pi-ai/api/openai-responses.lazy";
import { piMessagesApi } from "@earendil-works/pi-ai/api/pi-messages.lazy";
import type { ProviderRuntime } from "./runtime-types.js";
import { assertModelProtocolEnabled } from "./protocol-components.js";

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

export class IncompleteCustomProviderRollbackError extends AggregateError {
  constructor(errors: readonly unknown[]) {
    super(errors, "Custom provider replacement failed and rollback was incomplete");
    this.name = "IncompleteCustomProviderRollbackError";
  }
}

async function refreshRuntimeProviders(runtime: ProviderRuntime, providerIds: readonly string[]): Promise<void> {
  const providers = [...new Set(providerIds)];
  if (providers.length === 0) return;
  const result = await runtime.refresh({ providers, allowNetwork: false });
  if (result.aborted) throw new Error("Custom provider availability refresh was aborted");
  const failures = providers.flatMap((providerId) => {
    const error = result.errors.get(providerId);
    return error === undefined ? [] : [error];
  });
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) {
    throw new AggregateError(failures, "Custom provider availability refresh failed");
  }
}

const API_FACTORIES = {
  "openai-completions": openAICompletionsApi,
  "openai-responses": openAIResponsesApi,
  "anthropic-messages": anthropicMessagesApi,
  "mistral-conversations": mistralConversationsApi,
  "azure-openai-responses": azureOpenAIResponsesApi,
  "pi-messages": piMessagesApi,
} satisfies Record<ProviderProtocol, () => ProviderStreams>;

// Custom model descriptors expose a boolean reasoning capability rather than
// PI's provider-specific map. Treat an enabled reasoning model as supporting
// the complete PI scale, including the extended xhigh/max levels.
const CUSTOM_REASONING_LEVEL_MAP = Object.freeze({
  off: null,
  minimal: "minimal",
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: "xhigh",
  max: "max",
});

const KEYLESS_COMPATIBILITY_SENTINEL_PREFIX = "my-code-agent-keyless-compatibility:";
const AUTH_HEADER_NAMES = [
  "authorization",
  "api-key",
  "x-api-key",
  "x-goog-api-key",
  "cf-aig-authorization",
] as const;

function keylessFetch(
  fetchImplementation: FetchFunction,
  sentinel: string,
  explicitHeaders: StreamOptions["headers"],
): FetchFunction {
  return async (input, init) => {
    const request = new Request(input, init);
    const headers = new Headers(request.headers);
    for (const name of AUTH_HEADER_NAMES) {
      if (headers.get(name)?.includes(sentinel)) headers.delete(name);
    }
    for (const [name, value] of Object.entries(explicitHeaders ?? {})) {
      if (value === null) headers.delete(name);
      else headers.set(name, value);
    }

    const url = new URL(request.url);
    const query = new URLSearchParams();
    for (const [name, value] of url.searchParams) {
      if (!value.includes(sentinel)) query.append(name, value);
    }
    url.search = query.toString();

    const sanitized = new Request(request, { headers });
    if (url.toString() === request.url) return fetchImplementation(sanitized);
    return fetchImplementation(new Request(url, sanitized as unknown as RequestInit));
  };
}

function keylessOptions<T extends StreamOptions>(
  options: T | undefined,
  sentinel: string,
): T & StreamOptions {
  const fetchImplementation = options?.fetch ?? globalThis.fetch;
  return {
    ...options,
    apiKey: sentinel,
    fetch: keylessFetch(fetchImplementation, sentinel, options?.headers),
  } as T & StreamOptions;
}

function redactCompatibilityValue<T>(value: T, sentinel: string): T {
  if (typeof value === "string") {
    return value.replaceAll(sentinel, "[redacted]") as T;
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactCompatibilityValue(item, sentinel)) as T;
  }
  if (value === null || typeof value !== "object") return value;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return value;
  const copy = Object.create(prototype) as Record<string, unknown>;
  for (const [key, nested] of Object.entries(value)) {
    copy[key] = redactCompatibilityValue(nested, sentinel);
  }
  return copy as T;
}

function redactKeylessStream(
  source: AssistantMessageEventStream,
  sentinel: string,
): AssistantMessageEventStream {
  const target = createAssistantMessageEventStream();
  void (async () => {
    const result = source.result();
    for await (const event of source) {
      target.push(redactCompatibilityValue<AssistantMessageEvent>(event, sentinel));
    }
    target.end(redactCompatibilityValue(await result, sentinel));
  })();
  return target;
}

function keylessStreams(streams: ProviderStreams): ProviderStreams {
  const sentinel = `${KEYLESS_COMPATIBILITY_SENTINEL_PREFIX}${globalThis.crypto.randomUUID()}`;
  return {
    stream: (model, context, options) => redactKeylessStream(
      streams.stream(model, context, keylessOptions(options, sentinel)),
      sentinel,
    ),
    streamSimple: (model, context, options) => redactKeylessStream(
      streams.streamSimple(model, context, keylessOptions(options, sentinel)),
      sentinel,
    ),
  };
}

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
    ...(descriptor.reasoning ? { thinkingLevelMap: CUSTOM_REASONING_LEVEL_MAP } : {}),
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
    ProviderRuntime,
    ReadonlyMap<string, Provider<ProviderProtocol>>
  >();

  prepare(
    definition: CustomProviderDefinition,
    secrets: ResolvedProviderSecrets,
  ): PreparedCustomProvider {
    const validated = validateCustomProviderDefinition(definition);
    assertModelProtocolEnabled(validated.protocol);
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

    const streams = API_FACTORIES[validated.protocol]();
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
      api: usesApiKey ? streams : keylessStreams(streams),
    });
    this.#registrations.set(prepared, {
      providerId: validated.id,
      provider,
    });
    return prepared;
  }

  async replaceRuntimeProviders(
    runtime: ProviderRuntime,
    prepared: readonly PreparedCustomProvider[],
  ): Promise<void> {
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
    const changedProviderIds = [
      ...prior.keys(),
      ...registrations.map((registration) => registration.providerId),
    ];
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
      await refreshRuntimeProviders(runtime, changedProviderIds);
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

      const survivingOwned = new Map<string, Provider<ProviderProtocol>>();
      for (const registration of attempted) {
        if (runtime.getRegisteredNativeProvider(registration.providerId) === registration.provider) {
          survivingOwned.set(registration.providerId, registration.provider);
        }
      }
      for (const [providerId, provider] of prior) {
        const currentNative = runtime.getRegisteredNativeProvider(providerId);
        if (currentNative === provider) {
          survivingOwned.set(providerId, provider);
          continue;
        }
        if (currentNative !== undefined || runtime.getProvider(providerId) !== undefined) {
          if (!survivingOwned.has(providerId)) {
            rollbackFailures.push(new Error(`Rollback could not restore provider replaced externally: ${providerId}`));
          }
          continue;
        }
        try {
          runtime.registerNativeProvider(provider);
          if (runtime.getRegisteredNativeProvider(providerId) !== provider) {
            throw new Error(`Rollback did not retain restored provider: ${providerId}`);
          }
          survivingOwned.set(providerId, provider);
        } catch (error) {
          rollbackFailures.push(error);
          if (runtime.getRegisteredNativeProvider(providerId) === provider) {
            survivingOwned.set(providerId, provider);
          }
        }
      }
      this.#ownedByRuntime.set(runtime, survivingOwned);

      try {
        await refreshRuntimeProviders(runtime, changedProviderIds);
      } catch (error) {
        rollbackFailures.push(error);
      }

      if (rollbackFailures.length > 0) {
        throw new IncompleteCustomProviderRollbackError([primaryFailure, ...rollbackFailures]);
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
