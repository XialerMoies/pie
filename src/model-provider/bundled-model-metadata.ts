import {
  getBuiltinModels,
  getBuiltinProviders,
  type BuiltinProvider,
} from "@earendil-works/pi-ai/providers/all";
import type { Api, Model } from "@earendil-works/pi-ai";

import type {
  DiscoveredModelMetadata,
  ModelDiscoveryResult,
  ProviderProtocol,
} from "./contracts.js";

interface DiscoveryProviderIdentity {
  id: string;
  protocol: ProviderProtocol;
  baseUrl: string;
}

interface CatalogEntry {
  provider: BuiltinProvider;
  model: Model<Api>;
}

let catalogEntries: readonly CatalogEntry[] | undefined;

function entries(): readonly CatalogEntry[] {
  if (catalogEntries === undefined) {
    catalogEntries = Object.freeze(getBuiltinProviders().flatMap(provider => (
      getBuiltinModels(provider).map(model => ({ provider, model: model as Model<Api> }))
    )));
  }
  return catalogEntries;
}

function safeOrigin(value: string): string | undefined {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url.origin : undefined;
  } catch {
    return undefined;
  }
}

function canonicalProviderFor(
  provider: DiscoveryProviderIdentity,
  modelId: string,
): { provider: BuiltinProvider; lookupId: string } | undefined {
  const providers = new Set<BuiltinProvider>(getBuiltinProviders());
  if (providers.has(provider.id as BuiltinProvider)) {
    return { provider: provider.id as BuiltinProvider, lookupId: modelId };
  }

  const separator = modelId.indexOf("/");
  if (separator > 0) {
    const prefix = modelId.slice(0, separator) as BuiltinProvider;
    if (providers.has(prefix)) {
      return { provider: prefix, lookupId: modelId.slice(separator + 1) };
    }
  }

  const origin = safeOrigin(provider.baseUrl);
  if (origin === undefined) return undefined;
  const matchingProviders = new Set(
    entries()
      .filter(entry => safeOrigin(entry.model.baseUrl) === origin)
      .map(entry => entry.provider),
  );
  if (matchingProviders.size !== 1) return undefined;
  return { provider: [...matchingProviders][0], lookupId: modelId };
}

function capabilitySignature(model: Model<Api>): string {
  return JSON.stringify({
    name: model.name,
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
    reasoning: model.reasoning,
    input: model.input,
  });
}

function resolveCatalogModel(
  provider: DiscoveryProviderIdentity,
  modelId: string,
): Model<Api> | undefined {
  const canonical = canonicalProviderFor(provider, modelId);
  if (canonical !== undefined) {
    return entries().find(entry => (
      entry.provider === canonical.provider
      && (entry.model.id === canonical.lookupId || entry.model.id === modelId)
    ))?.model;
  }

  let candidates = entries().filter(entry => entry.model.id === modelId);
  const protocolMatches = candidates.filter(entry => entry.model.api === provider.protocol);
  if (protocolMatches.length > 0) candidates = protocolMatches;
  if (candidates.length === 0) return undefined;
  const signatures = new Set(candidates.map(entry => capabilitySignature(entry.model)));
  return signatures.size === 1 ? candidates[0].model : undefined;
}

function catalogMetadata(
  provider: DiscoveryProviderIdentity,
  modelId: string,
): DiscoveredModelMetadata | undefined {
  const model = resolveCatalogModel(provider, modelId);
  if (model === undefined) return undefined;
  return {
    id: modelId,
    name: model.name,
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
    reasoning: model.reasoning,
    input: [...model.input],
    source: "catalog",
  };
}

/**
 * Fill only missing capability fields from PI's generated model catalog.
 * Network metadata remains authoritative and catalog pricing is deliberately
 * excluded because a gateway's rates need not match the canonical provider.
 */
export function enrichDiscoveryWithBundledCatalog(
  result: ModelDiscoveryResult,
  provider: DiscoveryProviderIdentity,
): ModelDiscoveryResult {
  const upstreamById = new Map((result.models ?? []).map(model => [model.id, model]));
  const models: DiscoveredModelMetadata[] = [];
  for (const id of result.ids) {
    const upstream = upstreamById.get(id);
    const bundled = catalogMetadata(provider, id);
    if (upstream === undefined && bundled === undefined) continue;
    models.push({
      ...(bundled ?? { id }),
      ...(upstream ?? {}),
      id,
      source: upstream !== undefined && bundled !== undefined
        ? "provider+catalog"
        : upstream !== undefined ? "provider" : "catalog",
    });
  }
  return models.length === 0 ? { ids: result.ids } : { ids: result.ids, models };
}
