export const PROVIDER_PROTOCOLS = [
  "openai-completions",
  "openai-responses",
  "anthropic-messages",
  "google-generative-ai",
  "mistral-conversations",
  "azure-openai-responses",
  "pi-messages",
] as const;

export type ProviderProtocol = typeof PROVIDER_PROTOCOLS[number];
export type ProviderAuthMode = "none" | "apiKey";
export type CredentialRef = `credential:${string}`;

export interface ModelCostRates {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface ModelDescriptor {
  id: string;
  name: string;
  contextWindow: number;
  maxTokens: number;
  reasoning: boolean;
  input: Array<"text" | "image">;
  cost: ModelCostRates;
  samplingParams?: Record<string, unknown>;
  compatibility?: Record<string, unknown>;
}

export interface CustomProviderHeader {
  name: string;
  credentialRef: CredentialRef;
}

export interface CustomProviderDefinition {
  id: string;
  name: string;
  protocol: ProviderProtocol;
  baseUrl: string;
  authMode: ProviderAuthMode;
  apiKeyRef?: CredentialRef;
  headers: CustomProviderHeader[];
  modelDiscovery?: string;
  models: ModelDescriptor[];
}

export interface CustomProviderSnapshot {
  schemaVersion: 1;
  revision: number;
  providers: CustomProviderDefinition[];
}

export interface ProviderUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  reasoning?: number;
}

export interface CustomProviderDraft {
  id: string;
  name: string;
  protocol: ProviderProtocol;
  baseUrl: string;
  authMode: ProviderAuthMode;
  apiKey?: string | null;
  headers: Array<{ name: string; value?: string; remove?: boolean }>;
  modelDiscovery?: string;
  models: ModelDescriptor[];
}

export interface RedactedCustomProviderHeader {
  name: string;
  configured: boolean;
}

export type RedactedCustomProvider = Omit<
  CustomProviderDefinition,
  "apiKeyRef" | "headers"
> & {
  apiKeyConfigured: boolean;
  headers: RedactedCustomProviderHeader[];
};

export interface RedactedCustomProviderSnapshot {
  schemaVersion: 1;
  revision: number;
  providers: RedactedCustomProvider[];
}

export interface CustomProviderListResponse {
  revision: number;
  official: Array<{ id: string; name: string; configured: boolean }>;
  custom: RedactedCustomProvider[];
}

export interface ResolvedProviderSecrets {
  apiKey?: string;
  headers: Record<string, string>;
}

export interface ResolvedCustomProviderDraft {
  provider: Omit<CustomProviderDefinition, "apiKeyRef" | "headers"> & { headers: string[] };
  secrets: ResolvedProviderSecrets;
  modelId?: string;
}

export interface CustomProviderCapabilities {
  protocols: Array<{ id: ProviderProtocol; supportsCompatibility: boolean }>;
  price: { currency: "USD"; unit: "millionTokens" };
}

export type ConnectionTestResult =
  | {
    ok: true;
    providerId: string;
    modelId: string;
    latencyMs: number;
    usage: ProviderUsage;
  }
  | {
    ok: false;
    providerId: string;
    modelId?: string;
    code: "dns" | "timeout" | "tls" | "authentication" | "rate_limit" | "upstream" | "aborted";
    message: string;
  };

const PROTOCOL_SET = new Set<string>(PROVIDER_PROTOCOLS);
const PROVIDER_ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/;
const CREDENTIAL_REF_PATTERN = /^credential:[A-Za-z0-9][A-Za-z0-9._-]*$/;
const HEADER_NAME_PATTERN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const FORBIDDEN_HEADERS = new Set([
  "host",
  "content-length",
  "connection",
  "transfer-encoding",
  "proxy-authorization",
  "proxy-authenticate",
  "te",
  "trailer",
  "upgrade",
]);
const MAX_ADVANCED_JSON_BYTES = 16 * 1024;

function fail(path: string, message: string): never {
  throw new Error(`${path}: ${message}`);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  return Object.getPrototypeOf(value) === Object.prototype;
}

function expectPlainObject(value: unknown, path: string): asserts value is Record<string, unknown> {
  if (!isPlainObject(value)) fail(path, "must be a plain JSON object");
}

function rejectUnknownFields(value: Record<string, unknown>, allowed: readonly string[], path: string): void {
  const allowedSet = new Set(allowed);
  const unknown = Object.keys(value).find((key) => !allowedSet.has(key));
  if (unknown !== undefined) fail(`${path}.${unknown}`, "unknown field");
}

function expectNonEmptyString(value: unknown, path: string): asserts value is string {
  if (typeof value !== "string" || value.trim().length === 0) fail(path, "must be a non-empty string");
}

function expectCredentialRef(value: unknown, path: string): asserts value is CredentialRef {
  if (typeof value !== "string" || !CREDENTIAL_REF_PATTERN.test(value)) {
    fail(path, "must be formatted as credential:<stable-id>");
  }
}

function expectHttpUrl(value: unknown, path: string): asserts value is string {
  if (typeof value !== "string") fail(path, "must be an absolute HTTP(S) URL");
  try {
    const parsed = new URL(value);
    if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") || !parsed.hostname) {
      fail(path, "must be an absolute HTTP(S) URL");
    }
  } catch {
    fail(path, "must be an absolute HTTP(S) URL");
  }
}

function expectPositiveInteger(value: unknown, path: string): asserts value is number {
  if (!Number.isFinite(value) || !Number.isInteger(value) || (value as number) <= 0) {
    fail(path, "must be a positive finite integer");
  }
}

function expectNonNegativeFinite(value: unknown, path: string): asserts value is number {
  if (!Number.isFinite(value)) fail(path, "must be finite");
  if ((value as number) < 0) fail(path, "must be non-negative");
}

function validateJsonValue(value: unknown, path: string, ancestors: Set<object>): void {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) fail(path, "must be finite JSON data");
    return;
  }
  if (typeof value !== "object") fail(path, "must contain only JSON values");
  if (ancestors.has(value)) fail(path, "must not contain circular JSON data");
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      for (let index = 0; index < value.length; index += 1) {
        validateJsonValue(value[index], `${path}[${index}]`, ancestors);
      }
      return;
    }
    if (!isPlainObject(value)) fail(path, "must contain only plain JSON objects");
    for (const [key, nested] of Object.entries(value)) {
      validateJsonValue(nested, `${path}.${key}`, ancestors);
    }
  } finally {
    ancestors.delete(value);
  }
}

function validateAdvancedObject(value: unknown, path: string): void {
  expectPlainObject(value, path);
  validateJsonValue(value, path, new Set());
  if (Buffer.byteLength(JSON.stringify(value), "utf8") > MAX_ADVANCED_JSON_BYTES) {
    fail(path, "must not exceed 16 KiB");
  }
}

export function assertSafeHeaderName(name: unknown, path = "header name"): asserts name is string {
  if (typeof name !== "string" || !HEADER_NAME_PATTERN.test(name)) {
    fail(path, "must be a valid HTTP header name");
  }
  if (FORBIDDEN_HEADERS.has(name.toLowerCase())) fail(path, `forbidden header name: ${name}`);
}

function validateModel(value: unknown, path: string): asserts value is ModelDescriptor {
  expectPlainObject(value, path);
  rejectUnknownFields(value, [
    "id", "name", "contextWindow", "maxTokens", "reasoning", "input", "cost",
    "samplingParams", "compatibility",
  ], path);
  expectNonEmptyString(value.id, `${path}.id`);
  expectNonEmptyString(value.name, `${path}.name`);
  expectPositiveInteger(value.contextWindow, `${path}.contextWindow`);
  expectPositiveInteger(value.maxTokens, `${path}.maxTokens`);
  if (value.maxTokens > value.contextWindow) fail(`${path}.maxTokens`, "must not exceed contextWindow");
  if (typeof value.reasoning !== "boolean") fail(`${path}.reasoning`, "must be a boolean");

  if (!Array.isArray(value.input) || value.input.length === 0) fail(`${path}.input`, "must contain text or image");
  const seenInputs = new Set<string>();
  for (let index = 0; index < value.input.length; index += 1) {
    const item = value.input[index];
    if (item !== "text" && item !== "image") fail(`${path}.input[${index}]`, "must be text or image");
    if (seenInputs.has(item)) fail(`${path}.input`, `duplicate input capability: ${item}`);
    seenInputs.add(item);
  }
  if (!seenInputs.has("text")) fail(`${path}.input`, "must include text");

  expectPlainObject(value.cost, `${path}.cost`);
  rejectUnknownFields(value.cost, ["input", "output", "cacheRead", "cacheWrite"], `${path}.cost`);
  for (const field of ["input", "output", "cacheRead", "cacheWrite"] as const) {
    expectNonNegativeFinite(value.cost[field], `${path}.cost.${field}`);
  }
  if (value.samplingParams !== undefined) validateAdvancedObject(value.samplingParams, `${path}.samplingParams`);
  if (value.compatibility !== undefined) validateAdvancedObject(value.compatibility, `${path}.compatibility`);
}

export function validateCustomProviderDefinition(value: unknown): CustomProviderDefinition {
  expectPlainObject(value, "provider");
  rejectUnknownFields(value, [
    "id", "name", "protocol", "baseUrl", "authMode", "apiKeyRef", "headers", "modelDiscovery", "models",
  ], "provider");

  if (typeof value.id !== "string" || !PROVIDER_ID_PATTERN.test(value.id)) {
    fail("provider.id", "must use lowercase letters, numbers, and hyphens");
  }
  expectNonEmptyString(value.name, "provider.name");
  if (typeof value.protocol !== "string" || !PROTOCOL_SET.has(value.protocol)) {
    fail("provider.protocol", "must be a supported provider protocol");
  }
  expectHttpUrl(value.baseUrl, "provider.baseUrl");
  if (value.authMode !== "none" && value.authMode !== "apiKey") {
    fail("provider.authMode", "must be none or apiKey");
  }
  if (value.protocol === "google-generative-ai" && value.authMode === "none") {
    fail("provider.authMode", "google-generative-ai requires apiKey authentication");
  }
  if (value.authMode === "none" && value.apiKeyRef !== undefined) {
    fail("provider.apiKeyRef", "must not be set when authMode is none");
  }
  if (value.authMode === "apiKey" && value.apiKeyRef === undefined) {
    fail("provider.apiKeyRef", "is required when authMode is apiKey");
  }
  if (value.apiKeyRef !== undefined) expectCredentialRef(value.apiKeyRef, "provider.apiKeyRef");
  if (value.modelDiscovery !== undefined) expectHttpUrl(value.modelDiscovery, "provider.modelDiscovery");

  if (!Array.isArray(value.headers)) fail("provider.headers", "must be an array");
  const headerNames = new Set<string>();
  for (let index = 0; index < value.headers.length; index += 1) {
    const path = `provider.headers[${index}]`;
    const header = value.headers[index];
    expectPlainObject(header, path);
    rejectUnknownFields(header, ["name", "credentialRef"], path);
    assertSafeHeaderName(header.name, `${path}.name`);
    const normalizedName = header.name.toLowerCase();
    if (headerNames.has(normalizedName)) fail(`${path}.name`, `duplicate header name: ${header.name}`);
    headerNames.add(normalizedName);
    expectCredentialRef(header.credentialRef, `${path}.credentialRef`);
  }

  if (!Array.isArray(value.models) || value.models.length === 0) {
    fail("provider.models", "must contain at least one model");
  }
  const modelIds = new Set<string>();
  const modelNames = new Set<string>();
  for (let index = 0; index < value.models.length; index += 1) {
    const path = `models[${index}]`;
    const descriptor = value.models[index];
    validateModel(descriptor, path);
    if (modelIds.has(descriptor.id)) fail(`${path}.id`, `duplicate model id: ${descriptor.id}`);
    if (modelNames.has(descriptor.name.toLowerCase())) fail(`${path}.name`, `duplicate model name: ${descriptor.name}`);
    modelIds.add(descriptor.id);
    modelNames.add(descriptor.name.toLowerCase());
  }
  return value as unknown as CustomProviderDefinition;
}

export function validateCustomProviderSnapshot(value: unknown): CustomProviderSnapshot {
  expectPlainObject(value, "snapshot");
  rejectUnknownFields(value, ["schemaVersion", "revision", "providers"], "snapshot");
  if (value.schemaVersion !== 1) fail("snapshot.schemaVersion", "must equal 1");
  if (!Number.isSafeInteger(value.revision) || (value.revision as number) < 0) {
    fail("snapshot.revision", "must be a non-negative safe integer");
  }
  if (!Array.isArray(value.providers)) fail("snapshot.providers", "must be an array");

  const providerIds = new Set<string>();
  const providerNames = new Set<string>();
  for (let index = 0; index < value.providers.length; index += 1) {
    const provider = validateCustomProviderDefinition(value.providers[index]);
    const idPath = `providers[${index}].id`;
    const namePath = `providers[${index}].name`;
    if (providerIds.has(provider.id)) fail(idPath, `duplicate provider id: ${provider.id}`);
    if (providerNames.has(provider.name.toLowerCase())) fail(namePath, `duplicate provider name: ${provider.name}`);
    providerIds.add(provider.id);
    providerNames.add(provider.name.toLowerCase());
  }
  return value as unknown as CustomProviderSnapshot;
}
