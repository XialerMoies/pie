export interface CorrelationIds {
  traceId: string;
  turnId?: string;
  sessionId?: string;
  toolCallId?: string;
}

export type CorrelationStage =
  | "runtime.event"
  | "tool.outcome"
  | "evidence.recorded"
  | "task.transition"
  | "presentation.emitted"
  | "sse.replay"
  | "session.persisted";

export interface CorrelationRecord extends CorrelationIds {
  at: string;
  stage: CorrelationStage;
  eventType?: string;
  status?: string;
  failureKind?: string;
  evidenceId?: string;
  source?: string;
  replay?: boolean;
  details?: Record<string, unknown>;
}

export interface CorrelationLedgerOptions {
  maxEntries?: number;
  clock?: () => number;
}

const SENSITIVE_KEY = /(api.?key|token|secret|password|authorization|cookie|credential|private.?key)/i;
const REDACTED = "[redacted]";

function redactDetails(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactDetails);
  if (value && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) result[key] = SENSITIVE_KEY.test(key) ? REDACTED : redactDetails(item);
    return result;
  }
  if (typeof value === "string") {
    return value
      .replace(/\bBearer\s+[A-Za-z0-9._~+\-/]+=*/gi, `Bearer ${REDACTED}`)
      .replace(/\b(?:sk|key|token)[-_][A-Za-z0-9._-]{12,}\b/gi, REDACTED);
  }
  return value;
}

/**
 * Bounded, metadata-only correlation trail. Payloads and tool arguments never
 * enter this ledger; it is safe to expose through the diagnostics endpoint.
 */
export class CorrelationLedger {
  readonly #maxEntries: number;
  readonly #clock: () => number;
  #records: CorrelationRecord[] = [];

  constructor(options: CorrelationLedgerOptions = {}) {
    this.#maxEntries = Math.max(32, Math.min(4096, Math.floor(options.maxEntries ?? 512)));
    this.#clock = options.clock ?? Date.now;
  }

  record(input: Omit<CorrelationRecord, "at"> & { at?: string }): CorrelationRecord {
    const record: CorrelationRecord = {
      ...input,
      at: input.at || new Date(this.#clock()).toISOString(),
      ...(input.details ? { details: redactDetails(input.details) as Record<string, unknown> } : {}),
    };
    this.#records.push(record);
    if (this.#records.length > this.#maxEntries) this.#records.splice(0, this.#records.length - this.#maxEntries);
    return { ...record, ...(record.details ? { details: { ...record.details } } : {}) };
  }

  entries(): CorrelationRecord[] {
    return this.#records.map((record) => ({
      ...record,
      ...(record.details ? { details: { ...record.details } } : {}),
    }));
  }

  forTrace(traceId: string): CorrelationRecord[] {
    return this.entries().filter((record) => record.traceId === traceId);
  }

  snapshot(): {
    total: number;
    traces: number;
    turns: number;
    records: CorrelationRecord[];
  } {
    return {
      total: this.#records.length,
      traces: new Set(this.#records.map((record) => record.traceId)).size,
      turns: new Set(this.#records.map((record) => record.turnId).filter(Boolean)).size,
      records: this.entries(),
    };
  }
}
