import { randomUUID } from "node:crypto";
import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { IncomingHttpHeaders } from "node:http";

export type LogLevel = "info" | "warn" | "error";

export interface LogEntry {
  timestamp: string;
  level: LogLevel;
  event: string;
  requestId?: string;
  traceId?: string;
  fields: Record<string, unknown>;
}

export interface StructuredLoggerOptions {
  filePath?: string;
  maxEntries?: number;
  clock?: () => number;
}

export interface RequestContext {
  requestId: string;
  traceId: string;
}

const REDACTED = "[redacted]";
const SENSITIVE_KEY = /(api.?key|token|secret|password|authorization|cookie|credential|private.?key)/i;
const CORRELATION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

function headerValue(headers: IncomingHttpHeaders | Record<string, unknown>, name: string): unknown {
  return headers[name] ?? headers[name.toLowerCase()];
}

function usableCorrelationId(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return CORRELATION_ID.test(normalized) ? normalized : undefined;
}

export function createRequestContext(request: { headers: IncomingHttpHeaders | Record<string, unknown> }): RequestContext {
  return {
    requestId: usableCorrelationId(headerValue(request.headers, "x-request-id")) ?? randomUUID(),
    traceId: usableCorrelationId(headerValue(request.headers, "x-trace-id")) ?? randomUUID(),
  };
}

export function safeRequestUrl(value: string): string {
  try {
    const url = new URL(value, "http://localhost");
    const query = [...url.searchParams.keys()]
      .filter((key) => !SENSITIVE_KEY.test(key))
      .map((key) => `${encodeURIComponent(key)}=${encodeURIComponent(url.searchParams.get(key) ?? "")}`)
      .join("&");
    return `${url.pathname}${query ? `?${query}` : ""}`;
  } catch {
    return value.split(/[?#]/, 1)[0] || "/";
  }
}

export function redactMetadata(value: unknown, sensitiveValues: readonly string[] = []): unknown {
  if (Array.isArray(value)) return value.map((item) => redactMetadata(item, sensitiveValues));
  if (value && typeof value === "object") {
    const output: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      output[key] = SENSITIVE_KEY.test(key) ? REDACTED : redactMetadata(item, sensitiveValues);
    }
    return output;
  }
  if (typeof value === "string") {
    const redacted = sensitiveValues.reduce((current, secret) => secret ? current.replaceAll(secret, REDACTED) : current, value);
    return redacted
      .replace(/\bBearer\s+[A-Za-z0-9._~+\-/]+=*/gi, `Bearer ${REDACTED}`)
      .replace(/\b(?:sk|key|token)[-_][A-Za-z0-9._-]{12,}\b/gi, REDACTED);
  }
  return value;
}

export class StructuredLogger {
  readonly #filePath?: string;
  readonly #maxEntries: number;
  readonly #clock: () => number;
  #entries: LogEntry[] = [];
  #writeTail: Promise<void> = Promise.resolve();

  constructor(options: StructuredLoggerOptions = {}) {
    this.#filePath = options.filePath;
    this.#maxEntries = Math.max(1, Math.min(1000, Math.floor(options.maxEntries ?? 200)));
    this.#clock = options.clock ?? Date.now;
  }

  info(event: string, fields?: Record<string, unknown>, context?: Partial<RequestContext>): LogEntry {
    return this.log("info", event, fields, context);
  }

  warn(event: string, fields?: Record<string, unknown>, context?: Partial<RequestContext>): LogEntry {
    return this.log("warn", event, fields, context);
  }

  error(event: string, fields?: Record<string, unknown>, context?: Partial<RequestContext>): LogEntry {
    return this.log("error", event, fields, context);
  }

  log(level: LogLevel, event: string, fields: Record<string, unknown> = {}, context: Partial<RequestContext> = {}): LogEntry {
    const entry: LogEntry = {
      timestamp: new Date(this.#clock()).toISOString(),
      level,
      event,
      ...(context.requestId ? { requestId: context.requestId } : {}),
      ...(context.traceId ? { traceId: context.traceId } : {}),
      fields: redactMetadata(fields) as Record<string, unknown>,
    };
    this.#entries.push(entry);
    if (this.#entries.length > this.#maxEntries) this.#entries.splice(0, this.#entries.length - this.#maxEntries);
    if (this.#filePath) {
      const line = `${JSON.stringify(entry)}\n`;
      this.#writeTail = this.#writeTail.then(async () => {
        await mkdir(dirname(this.#filePath!), { recursive: true });
        await appendFile(this.#filePath!, line, "utf8");
      });
    }
    return entry;
  }

  entries(): LogEntry[] {
    return this.#entries.map((entry) => ({ ...entry, fields: { ...entry.fields } }));
  }

  async flush(): Promise<void> {
    await this.#writeTail;
  }
}

export interface ServerObservability {
  logger: StructuredLogger;
  appVersion: string;
  startedAt: number;
}

export function diagnosticsSnapshot(
  observability: ServerObservability,
  requestId: string | undefined,
  workspace: string | undefined,
  instanceId: string | undefined,
): Record<string, unknown> {
  return {
    ok: true,
    appVersion: observability.appVersion,
    uptimeMs: Math.max(0, Date.now() - observability.startedAt),
    pid: process.pid,
    platform: process.platform,
    requestId,
    workspaceConfigured: Boolean(workspace),
    instanceId,
    logs: observability.logger.entries(),
  };
}
