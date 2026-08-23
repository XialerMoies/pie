import { createHash } from "node:crypto";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { ToolEvidenceLookup, ToolEvidenceScope, ToolFailureKind, ToolOutcomeObservation } from "../agent/types.js";
import type { CorrelationIds } from "./correlation.js";

export type EvidenceStatus = "success" | "failed" | "unverified";

export interface EvidenceLedgerEntry {
  evidenceId: string;
  toolCallId: string;
  canonicalTool: string;
  requestScope: NonNullable<ToolOutcomeObservation["requestScope"]>;
  status: EvidenceStatus;
  failureKind?: ToolFailureKind;
  summary?: string;
  payloadHash: string;
  complete: boolean;
  source: ToolOutcomeObservation["source"];
  createdAt: string;
  duplicateOf?: string;
  correlation?: CorrelationIds;
  executionContract?: ToolOutcomeObservation["executionContract"];
  evidenceFields?: string[];
}

export interface EvidenceLedgerOptions {
  filePath?: string;
  maxEntries?: number;
  clock?: () => number;
}

function stable(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  return `{${Object.keys(value as Record<string, unknown>).sort().map((key) => `${JSON.stringify(key)}:${stable((value as Record<string, unknown>)[key])}`).join(",")}}`;
}

function hash(value: unknown): string {
  return createHash("sha256").update(stable(value)).digest("hex");
}

function scopeOf(observation: ToolOutcomeObservation): NonNullable<ToolOutcomeObservation["requestScope"]> {
  return observation.requestScope || {};
}

/**
 * Bounded runtime evidence ledger. It is deliberately separate from counters:
 * every tool call has one terminal record, failures cannot be promoted to facts,
 * and persisted records can be reconstructed after a refresh.
 */
export class EvidenceLedger {
  readonly #filePath?: string;
  readonly #maxEntries: number;
  readonly #clock: () => number;
  #entries: EvidenceLedgerEntry[] = [];

  constructor(options: EvidenceLedgerOptions = {}) {
    this.#filePath = options.filePath;
    this.#maxEntries = Math.max(32, Math.min(4096, Math.floor(options.maxEntries ?? 512)));
    this.#clock = options.clock ?? Date.now;
    this.#loadPersisted();
  }

  observe(observation: ToolOutcomeObservation): EvidenceLedgerEntry {
    const createdAt = observation.timestamp || new Date(this.#clock()).toISOString();
    const scope = scopeOf(observation);
    const status: EvidenceStatus = observation.outcome === "success"
      ? (observation.complete === false ? "unverified" : "success")
      : "failed";
    const payloadHash = observation.payloadHash || hash({
      tool: observation.toolName,
      scope,
      summary: observation.payloadSummary || "",
      status,
      failureKind: observation.failureKind,
    });
    const previous = this.#entries.find((entry) =>
      entry.canonicalTool === observation.toolName &&
      stable(entry.requestScope) === stable(scope) &&
      entry.payloadHash === payloadHash,
    );
    const entry: EvidenceLedgerEntry = {
      evidenceId: `ev-${hash(`${observation.toolCallId}:${createdAt}:${payloadHash}`).slice(0, 20)}`,
      toolCallId: observation.toolCallId,
      canonicalTool: observation.toolName,
      requestScope: scope,
      status,
      ...(observation.failureKind ? { failureKind: observation.failureKind } : {}),
      ...(observation.payloadSummary ? { summary: observation.payloadSummary } : {}),
      payloadHash,
      complete: status === "success",
      source: observation.source,
      createdAt,
      ...(previous ? { duplicateOf: previous.evidenceId } : {}),
      ...(observation.correlation ? { correlation: { ...observation.correlation, toolCallId: observation.toolCallId } } : {}),
      ...(observation.executionContract ? { executionContract: { ...observation.executionContract } } : {}),
      ...(observation.evidenceFields?.length ? { evidenceFields: [...new Set(observation.evidenceFields)].slice(0, 32) } : {}),
    };
    this.#entries.push(entry);
    if (this.#entries.length > this.#maxEntries) this.#entries.splice(0, this.#entries.length - this.#maxEntries);
    this.#persist(entry);
    return entry;
  }

  entries(): EvidenceLedgerEntry[] {
    return this.#entries.map((entry) => ({ ...entry, requestScope: { ...entry.requestScope } }));
  }

  getSuccessfulFacts(toolCallIds?: readonly string[]): EvidenceLedgerEntry[] {
    const allowed = toolCallIds ? new Set(toolCallIds) : undefined;
    return this.#entries.filter((entry) => entry.status === "success" && entry.complete && (!allowed || allowed.has(entry.toolCallId)));
  }

  lookup(toolName: string, scope: ToolEvidenceScope): ToolEvidenceLookup | undefined {
    const entry = [...this.#entries].reverse().find((candidate) =>
      candidate.canonicalTool === toolName && candidate.status === "success" && candidate.complete
      && stable(candidate.requestScope) === stable(scope));
    return entry ? {
      evidenceId: entry.evidenceId,
      summary: entry.summary || "",
      payloadHash: entry.payloadHash,
      ...(entry.evidenceFields?.length ? { evidenceFields: [...entry.evidenceFields] } : {}),
    } : undefined;
  }

  snapshot(): { total: number; successful: number; failed: number; unverified: number; entries: EvidenceLedgerEntry[] } {
    return {
      total: this.#entries.length,
      successful: this.#entries.filter((entry) => entry.status === "success").length,
      failed: this.#entries.filter((entry) => entry.status === "failed").length,
      unverified: this.#entries.filter((entry) => entry.status === "unverified").length,
      entries: this.entries(),
    };
  }

  #loadPersisted(): void {
    if (!this.#filePath || !existsSync(this.#filePath)) return;
    try {
      const lines = readFileSync(this.#filePath, "utf8").split(/\r?\n/).filter(Boolean);
      for (const line of lines.slice(-this.#maxEntries)) {
        const entry = JSON.parse(line) as EvidenceLedgerEntry;
        if (entry && typeof entry.evidenceId === "string" && (entry.status === "success" || entry.status === "failed" || entry.status === "unverified")) this.#entries.push(entry);
      }
    } catch {
      // A corrupt ledger must not prevent the agent from starting; new records remain usable.
    }
  }

  #persist(entry: EvidenceLedgerEntry): void {
    if (!this.#filePath) return;
    try {
      mkdirSync(dirname(this.#filePath), { recursive: true });
      appendFileSync(this.#filePath, `${JSON.stringify(entry)}\n`, "utf8");
    } catch {
      // Persistence is best effort; the in-memory record remains authoritative for this turn.
    }
  }
}

export function createEvidenceLedgerObserver(ledger: EvidenceLedger): (observation: ToolOutcomeObservation) => void {
  return (observation) => { ledger.observe(observation); };
}
