import {
  PROVIDER_PROTOCOLS,
  type ConnectionTestResult,
  type ProviderProtocol,
  type ResolvedCustomProviderDraft,
} from "./contracts.js";

const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_DISCOVERY_BODY_BYTES = 64 * 1024;
const REDACTED = "[redacted]";

type ConnectionErrorCode = NonNullable<ConnectionTestResult["code"]>;
export type ProviderNetworkErrorCode = ConnectionErrorCode | "unsupported_response";

export class ProviderNetworkError extends Error {
  constructor(
    public readonly code: ProviderNetworkErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ProviderNetworkError";
  }
}

export interface ProviderNetworkClientOptions {
  timeoutMs?: number;
  fetch?: typeof globalThis.fetch;
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

function codeForStatus(status: number): ConnectionErrorCode {
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

function probeMessage(status: number): string {
  if (status >= 200 && status < 300) return "Provider responded successfully";
  if (status === 401 || status === 403) return "Provider is reachable but authentication failed";
  if (status === 404 || status === 405) return "Provider is reachable but the endpoint was not found";
  if (status === 429) return "Provider is reachable but rate limited the request";
  return `Provider is reachable but returned HTTP ${status}`;
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
): ProviderNetworkError {
  return new ProviderNetworkError(
    code,
    redact(stableMessage(code), secrets),
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
  const headers = new Headers();
  const apiKey = input.secrets.apiKey;
  if (input.provider.authMode === "apiKey" && apiKey !== undefined) {
    if (input.provider.protocol === "anthropic-messages") headers.set("x-api-key", apiKey);
    else if (input.provider.protocol === "azure-openai-responses") headers.set("api-key", apiKey);
    else headers.set("authorization", `Bearer ${apiKey}`);
  }
  for (const [name, value] of Object.entries(input.secrets.headers)) headers.set(name, value);
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

function throwIfAborted(signal: AbortSignal): void {
  if (!signal.aborted) return;
  throw signal.reason instanceof Error
    ? signal.reason
    : new DOMException("Aborted", "AbortError");
}

function raceWithAbort<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const settle = (callback: (value: T | PromiseLike<T>) => void, value: T | PromiseLike<T>) => {
      signal.removeEventListener("abort", onAbort);
      callback(value);
    };
    const fail = (error: unknown) => {
      signal.removeEventListener("abort", onAbort);
      reject(error);
    };
    const onAbort = () => fail(signal.reason);
    operation.then((value) => settle(resolve, value), fail);
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  });
}

const MODEL_COMPATIBILITY_SUFFIXES = [
  "/api/claudecode",
  "/api/anthropic",
  "/apps/anthropic",
  "/api/coding",
  "/claudecode",
  "/anthropic",
  "/step_plan",
  "/coding",
  "/claude",
] as const;

function appendPath(baseUrl: URL, suffix: string): URL {
  const result = new URL(baseUrl.href);
  result.search = "";
  result.hash = "";
  const basePath = result.pathname.replace(/\/+$/, "");
  result.pathname = `${basePath}${suffix}` || suffix;
  return result;
}

function rootWithPath(baseUrl: URL, pathname: string): URL {
  const result = new URL(baseUrl.href);
  result.search = "";
  result.hash = "";
  result.pathname = pathname || "/";
  return result;
}

function modelDiscoveryCandidates(baseUrlValue: string, explicitPath?: string): URL[] {
  const baseUrl = new URL(baseUrlValue);
  if (typeof explicitPath === "string" && explicitPath.trim().length > 0) {
    return [new URL(explicitPath, baseUrl)];
  }

  const pathname = baseUrl.pathname.replace(/\/+$/, "");
  const candidates: URL[] = [];
  const lastSegment = pathname.split("/").at(-1) ?? "";
  const versioned = /^v\d+$/.test(lastSegment);
  if (versioned) {
    candidates.push(appendPath(baseUrl, "/models"));
    if (lastSegment !== "v1") candidates.push(appendPath(baseUrl, "/v1/models"));
  } else {
    candidates.push(appendPath(baseUrl, "/v1/models"));
    candidates.push(appendPath(baseUrl, "/models"));
  }

  const compatibilitySuffix = MODEL_COMPATIBILITY_SUFFIXES.find((suffix) => pathname.endsWith(suffix));
  if (compatibilitySuffix) {
    const rootPath = pathname.slice(0, -compatibilitySuffix.length).replace(/\/+$/, "");
    candidates.push(rootWithPath(baseUrl, `${rootPath}/v1/models`));
    candidates.push(rootWithPath(baseUrl, `${rootPath}/models`));
  }

  const unique: URL[] = [];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    const key = candidate.href;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(candidate);
  }
  return unique;
}

export class ProviderNetworkClient {
  readonly timeoutMs: number;
  readonly #fetch: typeof globalThis.fetch;

  constructor(options: ProviderNetworkClientOptions = {}) {
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    if (!Number.isFinite(this.timeoutMs) || this.timeoutMs <= 0) {
      throw new TypeError("timeoutMs must be a positive finite number");
    }
    this.#fetch = options.fetch ?? globalThis.fetch;
  }

  async discoverModels(
    input: ResolvedCustomProviderDraft,
    signal?: AbortSignal,
  ): Promise<{ ids: string[] }> {
    const secrets = secretsFor(input);
    assertSupportedProtocol(input.provider.protocol, secrets);
    let baseUrl: URL;
    let discoveryUrls: URL[];
    try {
      baseUrl = new URL(input.provider.baseUrl);
      discoveryUrls = modelDiscoveryCandidates(input.provider.baseUrl, input.provider.modelDiscovery);
    } catch {
      throw networkError("unsupported_response", secrets);
    }
    if (baseUrl.protocol !== "http:" && baseUrl.protocol !== "https:") {
      throw networkError("unsupported_response", secrets);
    }

    const scope = createAbortScope(signal, this.timeoutMs);
    try {
      for (const discoveryUrl of discoveryUrls) {
        if (discoveryUrl.origin !== baseUrl.origin) throw networkError("unsupported_response", secrets);
        let response: Response;
        try {
          response = await raceWithAbort(this.#fetch(discoveryUrl, {
            method: "GET",
            headers: discoveryHeaders(input),
            redirect: "manual",
            signal: scope.signal,
          }), scope.signal);
        } catch (error) {
          if (error instanceof ProviderNetworkError) throw error;
          const code = classifyError(error, scope);
          throw networkError(code, secrets);
        }

        if (response.status >= 300 && response.status < 400) {
          await response.body?.cancel();
          throw networkError("upstream", secrets);
        }
        if (response.status === 404 || response.status === 405) {
          await response.body?.cancel();
          continue;
        }
        if (!response.ok) {
          await response.body?.cancel();
          throw networkError(codeForStatus(response.status), secrets);
        }
        const body = await readLimitedBody(response, MAX_DISCOVERY_BODY_BYTES);
        return { ids: parseModelIds(body, secrets) };
      }
      throw networkError("upstream", secrets);
    } catch (error) {
      if (error instanceof ProviderNetworkError) {
        throw new ProviderNetworkError(
          error.code,
          redact(error.message, secrets),
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
    const secrets = secretsFor(input);
    const scope = createAbortScope(signal, this.timeoutMs);
    const started = performance.now();
    try {
      throwIfAborted(scope.signal);
      assertSupportedProtocol(input.provider.protocol, secrets);
      const baseUrl = new URL(input.provider.baseUrl);
      if (baseUrl.protocol !== "http:" && baseUrl.protocol !== "https:") {
        throw networkError("unsupported_response", secrets);
      }
      const response = await raceWithAbort(this.#fetch(baseUrl, {
        method: "GET",
        headers: discoveryHeaders(input),
        redirect: "manual",
        signal: scope.signal,
      }), scope.signal);
      throwIfAborted(scope.signal);
      const latencyMs = Math.max(0, Math.round(performance.now() - started));
      const httpStatus = response.status;
      await response.body?.cancel();
      const code = response.ok ? undefined : codeForStatus(httpStatus);
      return {
        ok: response.ok,
        reachable: true,
        providerId,
        latencyMs,
        httpStatus,
        ...(code === undefined ? {} : { code }),
        message: probeMessage(httpStatus),
      };
    } catch (error) {
      const code = error instanceof ProviderNetworkError ? error.code : classifyError(error, scope);
      const connectionCode = code === "unsupported_response" ? "upstream" : code;
      return {
        ok: false,
        reachable: false,
        providerId,
        latencyMs: Math.max(0, Math.round(performance.now() - started)),
        code: connectionCode,
        message: redact(stableMessage(connectionCode), secrets),
      };
    } finally {
      scope.dispose();
    }
  }
}
