import { randomUUID } from "node:crypto";
import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { IncomingHttpHeaders } from "node:http";
import type { ToolOutcomeObservation } from "../agent/types.js";
import type { EvidenceLedger } from "./evidence-ledger.js";

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
  toolOutcomeMetrics?: ToolOutcomeMetrics;
  evidenceLedger?: EvidenceLedger;
}

export interface ToolOutcomeToolMetric {
  total: number;
  structured: number;
  legacy: number;
  failures: number;
}

export interface ToolOutcomeMetricsSnapshot {
  total: number;
  structured: number;
  legacy: number;
  missingOutcome: number;
  invalidOutcome: number;
  failures: number;
  bySource: Record<string, { total: number; structured: number; legacy: number; missingOutcome: number; invalidOutcome: number; failures: number }>;
  byTool: Record<string, ToolOutcomeToolMetric>;
  unobservedTools?: string[];
}

/** Bounded, process-local counters for the outcome migration. */
export class ToolOutcomeMetrics {
  #total = 0;
  #structured = 0;
  #legacy = 0;
  #missingOutcome = 0;
  #invalidOutcome = 0;
  #failures = 0;
  #sources = new Map<string, { total: number; structured: number; legacy: number; missingOutcome: number; invalidOutcome: number; failures: number }>();
  #tools = new Map<string, ToolOutcomeToolMetric>();
  #expectedTools = new Set<string>();
  #maxKeys: number;

  constructor(maxKeys = 256) {
    this.#maxKeys = Math.max(8, Math.min(1024, Math.floor(maxKeys)));
  }

  observe(observation: ToolOutcomeObservation): void {
    const legacy = observation.legacy === true;
    const failed = observation.outcome === "failed";
    this.#total += 1;
    if (legacy) this.#legacy += 1;
    else this.#structured += 1;
    if (failed) this.#failures += 1;
    if (observation.legacyReason === "missing_outcome") this.#missingOutcome += 1;
    if (observation.legacyReason === "invalid_outcome") this.#invalidOutcome += 1;

    const source = observation.source || "live";
    const sourceMetric = this.#sources.get(source) || { total: 0, structured: 0, legacy: 0, missingOutcome: 0, invalidOutcome: 0, failures: 0 };
    sourceMetric.total += 1;
    if (legacy) sourceMetric.legacy += 1;
    else sourceMetric.structured += 1;
    if (observation.legacyReason === "missing_outcome") sourceMetric.missingOutcome += 1;
    if (observation.legacyReason === "invalid_outcome") sourceMetric.invalidOutcome += 1;
    if (failed) sourceMetric.failures += 1;
    if (this.#sources.has(source) || this.#sources.size < this.#maxKeys) this.#sources.set(source, sourceMetric);

    const toolName = this.#tools.has(observation.toolName) || this.#tools.size < this.#maxKeys ? observation.toolName : "<other>";
    const toolMetric = this.#tools.get(toolName) || { total: 0, structured: 0, legacy: 0, failures: 0 };
    toolMetric.total += 1;
    if (legacy) toolMetric.legacy += 1;
    else toolMetric.structured += 1;
    if (failed) toolMetric.failures += 1;
    this.#tools.set(toolName, toolMetric);
  }

  snapshot(): ToolOutcomeMetricsSnapshot {
    return {
      total: this.#total,
      structured: this.#structured,
      legacy: this.#legacy,
      missingOutcome: this.#missingOutcome,
      invalidOutcome: this.#invalidOutcome,
      failures: this.#failures,
      bySource: Object.fromEntries([...this.#sources.entries()].map(([key, value]) => [key, { ...value }])),
      byTool: Object.fromEntries([...this.#tools.entries()].map(([key, value]) => [key, { ...value }])),
      ...(this.#expectedTools.size > 0 ? { unobservedTools: [...this.#expectedTools].filter((name) => !this.#tools.has(name)).sort() } : {}),
    };
  }

  setExpectedTools(names: readonly string[]): void {
    this.#expectedTools = new Set(names.filter((name) => typeof name === "string" && name.length > 0));
  }

  assertLiveClean(): void {
    const live = this.#sources.get("live");
    if (live?.legacy || live?.missingOutcome || live?.invalidOutcome) {
      throw new Error(`live tool outcome compatibility hits: legacy=${live?.legacy || 0}, missing=${live?.missingOutcome || 0}, invalid=${live?.invalidOutcome || 0}`);
    }
  }
}

export function createToolOutcomeObserver(
  metrics: ToolOutcomeMetrics,
  logger?: StructuredLogger,
  evidenceLedger?: EvidenceLedger,
): (observation: ToolOutcomeObservation) => void {
  return (observation) => {
    metrics.observe(observation);
    evidenceLedger?.observe(observation);
    logger?.info("tool.outcome", {
      source: observation.source,
      toolName: observation.toolName,
      toolCallId: observation.toolCallId,
      outcome: observation.outcome,
      ...(observation.failureKind ? { failureKind: observation.failureKind } : {}),
      legacy: observation.legacy,
      ...(observation.legacyReason ? { legacyReason: observation.legacyReason } : {}),
    });
    if (process.env.MY_CODE_AGENT_TOOL_OUTCOME_STRICT === "1" && observation.source === "live") {
      metrics.assertLiveClean();
    }
  };
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
    ...(observability.toolOutcomeMetrics ? { toolOutcomeMetrics: observability.toolOutcomeMetrics.snapshot() } : {}),
    ...(observability.evidenceLedger ? { evidenceLedger: observability.evidenceLedger.snapshot() } : {}),
    logs: observability.logger.entries(),
  };
}
