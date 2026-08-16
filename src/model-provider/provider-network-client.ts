import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@xiamol/pi-coding-agent";

import {
  PROVIDER_PROTOCOLS,
  type ConnectionTestResult,
  type CustomProviderDefinition,
  type ProviderProtocol,
  type ResolvedCustomProviderDraft,
} from "./contracts.js";
import { PiCustomProviderAdapter } from "./pi-custom-provider-adapter.js";

const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_DISCOVERY_BODY_BYTES = 64 * 1024;
const MAX_ERROR_EXCERPT_BYTES = 1_024;
const REDACTED = "[redacted]";

type ConnectionErrorCode = Extract<ConnectionTestResult, { ok: false }>["code"];
export type ProviderNetworkErrorCode = ConnectionErrorCode | "unsupported_response";

export class ProviderNetworkError extends Error {
  constructor(
    public readonly code: ProviderNetworkErrorCode,
    message: string,
    public readonly excerpt = "",
  ) {
    super(message);
    this.name = "ProviderNetworkError";
  }
}

interface RuntimeForConnection {
  getModel(providerId: string, modelId: string): ReturnType<ModelRuntime["getModel"]>;
  completeSimple: ModelRuntime["completeSimple"];
}

interface AdapterForConnection {
  prepare: PiCustomProviderAdapter["prepare"];
  replaceRuntimeProviders: PiCustomProviderAdapter["replaceRuntimeProviders"];
  toProviderUsage: PiCustomProviderAdapter["toProviderUsage"];
}

export interface ProviderNetworkClientOptions {
  timeoutMs?: number;
  fetch?: typeof globalThis.fetch;
  runtimeFactory?: (options: {
    credentials: InMemoryCredentialStore;
    modelsPath: null;
    refreshOnCreate: false;
  }) => Promise<RuntimeForConnection>;
  adapterFactory?: () => AdapterForConnection;
}

interface AbortScope {
  signal: AbortSignal;
  timedOut: () => boolean;
  callerAborted: () => boolean;
  dispose: () => void;
}

function secretsFor(input: ResolvedCustomProviderDraft): string[] {
  return [input.secrets.apiKey, ...Object.values(input.secrets.headers)]
    .filter((value): value is string => typeof value === "string" && value.length > 0)
    .sort((left, right) => right.length - left.length);
}

function redact(value: string, secrets: readonly string[]): string {
  let redacted = value;
  for (const secret of secrets) redacted = redacted.replaceAll(secret, REDACTED);
  return redacted;
}

function replaceBytes(value: Buffer, target: Buffer, replacement: Buffer): Buffer {
  const chunks: Buffer[] = [];
  let offset = 0;
  let index = value.indexOf(target, offset);
  while (index !== -1) {
    chunks.push(value.subarray(offset, index), replacement);
    offset = index + target.byteLength;
    index = value.indexOf(target, offset);
  }
  if (offset === 0) return value;
  chunks.push(value.subarray(offset));
  return Buffer.concat(chunks);
}

function redactTruncatedExcerpt(value: Uint8Array, secrets: readonly string[]): string {
  const replacement = Buffer.from(REDACTED, "utf8");
  let redacted: Buffer<ArrayBufferLike> = Buffer.from(value);
  const encodedSecrets = secrets.map((secret) => Buffer.from(secret, "utf8"));
  for (const secret of encodedSecrets) redacted = replaceBytes(redacted, secret, replacement);
  for (const secret of encodedSecrets) {
    const maxPrefixLength = Math.min(secret.byteLength - 1, redacted.byteLength);
    for (let prefixLength = maxPrefixLength; prefixLength > 0; prefixLength -= 1) {
      if (!redacted.subarray(-prefixLength).equals(secret.subarray(0, prefixLength))) continue;
      redacted = Buffer.concat([redacted.subarray(0, -prefixLength), replacement]);
      break;
    }
  }
  return truncateUtf8(redacted.toString("utf8"), MAX_ERROR_EXCERPT_BYTES);
}

function statusCode(error: unknown): number | undefined {
  if (error === null || typeof error !== "object") return undefined;
  const direct = (error as { status?: unknown }).status;
  if (typeof direct === "number") return direct;
  const response = (error as { response?: { status?: unknown } }).response;
  return typeof response?.status === "number" ? response.status : undefined;
}

function nestedCode(error: unknown): string | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current !== null && typeof current === "object"; depth += 1) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string") return code;
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}

function codeForStatus(status: number): ProviderNetworkErrorCode {
  if (status === 401 || status === 403) return "authentication";
  if (status === 429) return "rate_limit";
  return "upstream";
}

function stableMessage(code: ProviderNetworkErrorCode): string {
  switch (code) {
    case "dns": return "Could not resolve the provider host";
    case "timeout": return "Provider request timed out";
    case "tls": return "Could not establish a secure provider connection";
    case "authentication": return "Provider authentication failed";
    case "rate_limit": return "Provider rate limit was reached";
    case "aborted": return "Provider request was aborted";
    case "unsupported_response": return "Provider returned an unsupported response";
    case "upstream": return "Provider request failed";
  }
}

function classifyError(error: unknown, scope: AbortScope): ProviderNetworkErrorCode {
  if (scope.timedOut()) return "timeout";
  if (scope.callerAborted()) return "aborted";
  const status = statusCode(error);
  if (status !== undefined) return codeForStatus(status);
  const code = nestedCode(error)?.toUpperCase();
  if (code === "ENOTFOUND" || code === "EAI_AGAIN" || code === "EAI_FAIL") return "dns";
  if (code === "ABORT_ERR" || code === "ERR_ABORTED") return "aborted";
  if (code !== undefined && (
    code.startsWith("CERT_")
    || code.startsWith("ERR_TLS_")
    || code.startsWith("ERR_SSL_")
    || code === "DEPTH_ZERO_SELF_SIGNED_CERT"
    || code === "SELF_SIGNED_CERT_IN_CHAIN"
    || code === "UNABLE_TO_VERIFY_LEAF_SIGNATURE"
  )) return "tls";
  if (error instanceof DOMException && error.name === "AbortError") return "aborted";
  const message = error instanceof Error ? error.message : "";
  if (/(?:^|\D)(?:401|403)(?:\D|$)/.test(message)) return "authentication";
  if (/(?:^|\D)429(?:\D|$)/.test(message)) return "rate_limit";
  if (/\b(?:ENOTFOUND|EAI_AGAIN|getaddrinfo)\b/i.test(message)) return "dns";
  if (/\b(?:certificate|TLS|SSL)\b/i.test(message)) return "tls";
  if (/\b(?:timed?\s*out|timeout)\b/i.test(message)) return "timeout";
  return "upstream";
}

function networkError(
  code: ProviderNetworkErrorCode,
  secrets: readonly string[],
  excerpt = "",
): ProviderNetworkError {
  return new ProviderNetworkError(
    code,
    redact(stableMessage(code), secrets),
    redact(excerpt, secrets),
  );
}

function createAbortScope(callerSignal: AbortSignal | undefined, timeoutMs: number): AbortScope {
  const controller = new AbortController();
  let timedOut = false;
  let callerAborted = callerSignal?.aborted ?? false;
  const abortFromCaller = () => {
    callerAborted = true;
    controller.abort(callerSignal?.reason);
  };
  if (callerAborted) controller.abort(callerSignal?.reason);
  else callerSignal?.addEventListener("abort", abortFromCaller, { once: true });
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort(new DOMException("Timed out", "TimeoutError"));
  }, timeoutMs);
  timer.unref?.();
  return {
    signal: controller.signal,
    timedOut: () => timedOut,
    callerAborted: () => callerAborted,
    dispose: () => {
      clearTimeout(timer);
      callerSignal?.removeEventListener("abort", abortFromCaller);
    },
  };
}

function discoveryHeaders(input: ResolvedCustomProviderDraft): Headers {
  const headers = new Headers(input.secrets.headers);
  const apiKey = input.secrets.apiKey;
  if (input.provider.authMode !== "apiKey" || apiKey === undefined) return headers;
  if (input.provider.protocol === "anthropic-messages") headers.set("x-api-key", apiKey);
  else if (input.provider.protocol === "azure-openai-responses") headers.set("api-key", apiKey);
  else headers.set("authorization", `Bearer ${apiKey}`);
  return headers;
}

async function readLimitedBody(response: Response, limit: number): Promise<string> {
  if (response.body === null) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let size = 0;
  let body = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        await reader.cancel();
        throw new ProviderNetworkError("unsupported_response", stableMessage("unsupported_response"));
      }
      body += decoder.decode(value, { stream: true });
    }
    body += decoder.decode();
    return body;
  } finally {
    reader.releaseLock();
  }
}

async function readErrorExcerpt(response: Response, limit: number): Promise<Buffer> {
  if (response.body === null) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (size < limit) {
      const { done, value } = await reader.read();
      if (done) break;
      const remaining = limit - size;
      chunks.push(value.byteLength > remaining ? value.subarray(0, remaining) : value);
      size += Math.min(value.byteLength, remaining);
      if (value.byteLength > remaining || size === limit) {
        await reader.cancel();
        break;
      }
    }
    return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));
  } finally {
    reader.releaseLock();
  }
}

function truncateUtf8(value: string, limit: number): string {
  let bytes = 0;
  let truncated = "";
  for (const codePoint of value) {
    const codePointBytes = Buffer.byteLength(codePoint, "utf8");
    if (bytes + codePointBytes > limit) break;
    truncated += codePoint;
    bytes += codePointBytes;
  }
  return truncated;
}

function parseModelIds(body: string, secrets: readonly string[]): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body) as unknown;
  } catch {
    throw networkError("unsupported_response", secrets);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw networkError("unsupported_response", secrets);
  }
  const data = (parsed as { data?: unknown }).data;
  if (!Array.isArray(data)) throw networkError("unsupported_response", secrets);
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const entry of data) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) continue;
    const id = (entry as { id?: unknown }).id;
    if (typeof id !== "string" || id.trim().length === 0) continue;
    const normalized = id.trim();
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    ids.push(normalized);
  }
  if (data.length > 0 && ids.length === 0) throw networkError("unsupported_response", secrets);
  return ids;
}

function assertSupportedProtocol(protocol: string, secrets: readonly string[]): asserts protocol is ProviderProtocol {
  if (!(PROVIDER_PROTOCOLS as readonly string[]).includes(protocol)) {
    throw networkError("unsupported_response", secrets);
  }
}

function connectionDefinition(input: ResolvedCustomProviderDraft): CustomProviderDefinition {
  const { headers, modelDiscovery: _modelDiscovery, ...provider } = input.provider;
  return {
    ...provider,
    ...(provider.authMode === "apiKey" ? { apiKeyRef: "credential:network-api-key" as const } : {}),
    headers: headers.map((name, index) => ({
      name,
      credentialRef: `credential:network-header-${index}` as const,
    })),
  };
}

export class ProviderNetworkClient {
  readonly timeoutMs: number;
  readonly #fetch: typeof globalThis.fetch;
  readonly #runtimeFactory: NonNullable<ProviderNetworkClientOptions["runtimeFactory"]>;
  readonly #adapterFactory: NonNullable<ProviderNetworkClientOptions["adapterFactory"]>;

  constructor(options: ProviderNetworkClientOptions = {}) {
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    if (!Number.isFinite(this.timeoutMs) || this.timeoutMs <= 0) {
      throw new TypeError("timeoutMs must be a positive finite number");
    }
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#runtimeFactory = options.runtimeFactory ?? ((runtimeOptions) => ModelRuntime.create(runtimeOptions));
    this.#adapterFactory = options.adapterFactory ?? (() => new PiCustomProviderAdapter());
  }

  async discoverModels(
    input: ResolvedCustomProviderDraft,
    signal?: AbortSignal,
  ): Promise<{ ids: string[] }> {
    const secrets = secretsFor(input);
    assertSupportedProtocol(input.provider.protocol, secrets);
    let baseUrl: URL;
    let discoveryUrl: URL;
    try {
      baseUrl = new URL(input.provider.baseUrl);
      discoveryUrl = new URL(input.provider.modelDiscovery ?? "", baseUrl);
    } catch {
      throw networkError("unsupported_response", secrets);
    }
    if ((baseUrl.protocol !== "http:" && baseUrl.protocol !== "https:") || discoveryUrl.origin !== baseUrl.origin) {
      throw networkError("unsupported_response", secrets);
    }
    if (typeof input.provider.modelDiscovery !== "string" || input.provider.modelDiscovery.length === 0) {
      throw networkError("unsupported_response", secrets);
    }

    const scope = createAbortScope(signal, this.timeoutMs);
    try {
      let response: Response;
      try {
        response = await this.#fetch(discoveryUrl, {
          method: "GET",
          headers: discoveryHeaders(input),
          redirect: "manual",
          signal: scope.signal,
        });
      } catch (error) {
        if (error instanceof ProviderNetworkError) throw error;
        const code = classifyError(error, scope);
        throw networkError(code, secrets);
      }

      if (response.status >= 300 && response.status < 400) {
        await response.body?.cancel();
        throw networkError("upstream", secrets);
      }
      if (!response.ok) {
        const excerpt = await readErrorExcerpt(response, MAX_ERROR_EXCERPT_BYTES);
        const code = codeForStatus(response.status);
        throw networkError(code, secrets, redactTruncatedExcerpt(excerpt, secrets));
      }
      const body = await readLimitedBody(response, MAX_DISCOVERY_BODY_BYTES);
      return { ids: parseModelIds(body, secrets) };
    } catch (error) {
      if (error instanceof ProviderNetworkError) {
        throw new ProviderNetworkError(
          error.code,
          redact(error.message, secrets),
          redact(error.excerpt, secrets),
        );
      }
      const code = classifyError(error, scope);
      throw networkError(code, secrets);
    } finally {
      scope.dispose();
    }
  }

  async testConnection(
    input: ResolvedCustomProviderDraft,
    signal?: AbortSignal,
  ): Promise<ConnectionTestResult> {
    const providerId = input.provider.id;
    const modelId = input.modelId ?? input.provider.models[0]?.id;
    const secrets = secretsFor(input);
    const scope = createAbortScope(signal, this.timeoutMs);
    const started = performance.now();
    try {
      assertSupportedProtocol(input.provider.protocol, secrets);
      if (modelId === undefined) throw networkError("unsupported_response", secrets);
      const runtime = await this.#runtimeFactory({
        credentials: new InMemoryCredentialStore(),
        modelsPath: null,
        refreshOnCreate: false,
      });
      const adapter = this.#adapterFactory();
      const prepared = adapter.prepare(connectionDefinition(input), input.secrets);
      await adapter.replaceRuntimeProviders(runtime as ModelRuntime, [prepared]);
      const selectedModel = runtime.getModel(providerId, modelId);
      if (selectedModel === undefined) throw networkError("upstream", secrets);
      const response = await runtime.completeSimple(
        selectedModel,
        { messages: [{ role: "user", content: "ping", timestamp: Date.now() }] },
        { signal: scope.signal },
      );
      if (response.stopReason === "error" || response.stopReason === "aborted") {
        const error = new Error(response.errorMessage ?? response.stopReason);
        if (response.stopReason === "aborted") (error as Error & { code?: string }).code = "ABORT_ERR";
        throw error;
      }
      return {
        ok: true,
        providerId,
        modelId,
        latencyMs: Math.max(0, Math.round(performance.now() - started)),
        usage: adapter.toProviderUsage(response.usage),
      };
    } catch (error) {
      const code = error instanceof ProviderNetworkError ? error.code : classifyError(error, scope);
      const connectionCode = code === "unsupported_response" ? "upstream" : code;
      return {
        ok: false,
        providerId,
        ...(modelId === undefined ? {} : { modelId }),
        code: connectionCode,
        message: redact(stableMessage(connectionCode), secrets),
      };
    } finally {
      scope.dispose();
    }
  }
}
