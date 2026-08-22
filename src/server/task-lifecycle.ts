import { createHash } from "node:crypto";
import type { EngineErrorInfo } from "../agent-engine/contracts.js";
import { RetryPolicy, type RetryDecision } from "./retry-policy.js";
import type { CorrelationIds } from "./correlation.js";

export type TaskPhase = "discovering" | "verifying" | "answering";
export type TaskStatus = "running" | "completed" | "failed" | "blocked" | "cancelled";
export type TaskKind = "general" | "verification";

export interface TaskRequirements {
  kind: TaskKind;
  requiresEvidence: boolean;
  minSuccessfulEvidence: number;
}

export interface TaskLifecycleSnapshot {
  turnId: string;
  traceId?: string;
  sessionId?: string;
  phase: TaskPhase;
  status: TaskStatus;
  kind: TaskKind;
  requiresEvidence: boolean;
  successfulEvidence: number;
  retryableFailures: number;
  retryDecisions: RetryDecision[];
  reason?: string;
  phaseHistory: Array<{ phase: TaskPhase; at: string; cause: string }>;
}

export interface TaskLifecycleOptions {
  clock?: () => number;
  requirements?: TaskRequirements;
}

const VERIFICATION_REQUEST = /(?:验证|核验|检查|读取|查看|状态|证据|事实|inspect|verify|check|read|status|evidence|fact)/i;

export function inferTaskRequirements(message: string): TaskRequirements {
  const requiresEvidence = VERIFICATION_REQUEST.test(message || "");
  return {
    kind: requiresEvidence ? "verification" : "general",
    requiresEvidence,
    minSuccessfulEvidence: requiresEvidence ? 1 : 0,
  };
}

function fingerprint(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value ?? null)).digest("hex");
}

/**
 * Runtime task state machine. Prompt text may guide the model, but only this
 * reducer can enter answering/completed/failed/blocked states.
 */
export class TaskLifecycle {
  readonly #clock: () => number;
  #requirements: TaskRequirements;
  #snapshot: TaskLifecycleSnapshot = {
    turnId: "",
    phase: "discovering",
    status: "running",
    kind: "general",
    requiresEvidence: false,
    successfulEvidence: 0,
    retryableFailures: 0,
    retryDecisions: [],
    phaseHistory: [],
  };
  #startedTools = new Map<string, { name: string; inputFingerprint: string }>();
  #completedTools = new Set<string>();
  #retryPolicy = new RetryPolicy();

  constructor(options: TaskLifecycleOptions = {}) {
    this.#clock = options.clock ?? Date.now;
    this.#requirements = options.requirements ?? { kind: "general", requiresEvidence: false, minSuccessfulEvidence: 0 };
  }

  start(turnId: string, requirements = this.#requirements, correlation?: Pick<CorrelationIds, "traceId" | "sessionId">): void {
    this.#requirements = requirements;
    this.#startedTools.clear();
    this.#completedTools.clear();
    this.#retryPolicy = new RetryPolicy();
    this.#snapshot = {
      turnId,
      ...(correlation?.traceId ? { traceId: correlation.traceId } : {}),
      ...(correlation?.sessionId ? { sessionId: correlation.sessionId } : {}),
      phase: "discovering",
      status: "running",
      kind: requirements.kind,
      requiresEvidence: requirements.requiresEvidence,
      successfulEvidence: 0,
      retryableFailures: 0,
      retryDecisions: [],
      phaseHistory: [],
    };
    this.#transition("discovering", "turn.started");
  }

  toolStarted(toolCallId: string, name: string, input: unknown): void {
    if (this.#snapshot.status !== "running") return;
    this.#startedTools.set(toolCallId, { name, inputFingerprint: fingerprint(input) });
    this.#transition("discovering", "tool.started");
  }

  toolCompleted(toolCallId: string, evidenceAvailable: boolean): void {
    if (this.#snapshot.status !== "running" || this.#completedTools.has(toolCallId)) return;
    this.#completedTools.add(toolCallId);
    this.#startedTools.delete(toolCallId);
    if (evidenceAvailable) this.#snapshot.successfulEvidence += 1;
    this.#transition("verifying", evidenceAvailable ? "tool.completed.evidence" : "tool.completed");
  }

  toolFailed(toolCallId: string, name: string, error: EngineErrorInfo): void {
    if (this.#snapshot.status !== "running") return;
    const request = this.#startedTools.get(toolCallId);
    this.#startedTools.delete(toolCallId);
    const requestKey = request?.inputFingerprint || toolCallId;
    const decision = this.#retryPolicy.decide(name, requestKey, error);
    this.#snapshot.retryDecisions = this.#retryPolicy.decisions();
    if (decision.action === "retry") {
      this.#snapshot.retryableFailures += 1;
      this.#transition("discovering", "retryable.failure");
      return;
    }
    if (decision.action === "cancel") {
      this.cancel(decision.reason);
      return;
    }
    this.#block(decision.reason);
  }

  contentDelta(text: string): void {
    if (this.#snapshot.status !== "running" || !text) return;
    this.#transition("answering", "content.delta");
  }

  complete(hasFinalText: boolean, successfulEvidence = this.#snapshot.successfulEvidence): TaskLifecycleSnapshot {
    if (this.#snapshot.status !== "running") return this.snapshot();
    this.#snapshot.successfulEvidence = Math.max(this.#snapshot.successfulEvidence, successfulEvidence);
    if (!hasFinalText) {
      this.#block("final_text_missing");
    } else if (this.#requirements.requiresEvidence && this.#snapshot.successfulEvidence < this.#requirements.minSuccessfulEvidence) {
      this.#block("evidence_insufficient");
    } else {
      this.#snapshot.status = "completed";
      this.#transition("answering", "turn.completed");
    }
    return this.snapshot();
  }

  fail(reason = "turn_failed"): void {
    if (this.#snapshot.status === "completed" || this.#snapshot.status === "cancelled" || this.#snapshot.status === "blocked") return;
    this.#snapshot.status = "failed";
    this.#snapshot.reason = reason;
  }

  cancel(reason = "cancelled"): void {
    if (this.#snapshot.status === "completed") return;
    this.#snapshot.status = "cancelled";
    this.#snapshot.reason = reason;
  }

  snapshot(): TaskLifecycleSnapshot {
    return {
      ...this.#snapshot,
      retryDecisions: this.#snapshot.retryDecisions.map((decision) => ({ ...decision })),
      phaseHistory: this.#snapshot.phaseHistory.map((item) => ({ ...item })),
    };
  }

  #block(reason: string): void {
    this.#snapshot.status = "blocked";
    this.#snapshot.reason = reason;
  }

  #transition(phase: TaskPhase, cause: string): void {
    this.#snapshot.phase = phase;
    const last = this.#snapshot.phaseHistory.at(-1);
    if (last?.phase === phase && last.cause === cause) return;
    this.#snapshot.phaseHistory.push({ phase, at: new Date(this.#clock()).toISOString(), cause });
  }
}
