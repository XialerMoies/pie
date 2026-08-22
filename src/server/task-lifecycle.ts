import { createHash } from "node:crypto";
import type { EngineErrorInfo } from "../agent-engine/contracts.js";
import { RetryPolicy, type RetryDecision } from "./retry-policy.js";
import type { CorrelationIds } from "./correlation.js";
import type { ExecutionContract, ExecutionContractDecision, ToolEvidenceScope } from "../agent/types.js";

export type TaskPhase = "discovering" | "verifying" | "answering";
export type TaskStatus = "running" | "completed" | "failed" | "blocked" | "cancelled";
export type TaskKind = "general" | "verification";

export interface TaskRequirements {
  kind: TaskKind;
  requiresEvidence: boolean;
  minSuccessfulEvidence: number;
  contract?: ExecutionContract;
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
  contractRevision?: number;
  requiredEvidence?: string[];
  satisfiedEvidence?: string[];
  missingEvidence?: string[];
  reason?: string;
  phaseHistory: Array<{ phase: TaskPhase; at: string; cause: string }>;
}

export interface TaskLifecycleOptions {
  clock?: () => number;
  requirements?: TaskRequirements;
}

const VERIFICATION_REQUEST = /(?:验证|核验|检查|读取|查看|状态|证据|事实|inspect|verify|check|read|status|evidence|fact)/i;
const FACT_CONTRACT_REQUEST = /(?:验证|核验|检查|状态|证据|事实|inspect|verify|check|status|evidence|fact)/i;
const OPEN_WORK_REQUEST = /(?:修复|修改|实现|重构|排查|调试|构建|测试|fix|implement|refactor|debug|diagnose|build|test)/i;

function sourceMatches(target: string, source: string): boolean {
  const normalizedTarget = target.replace(/\\/g, "/");
  const normalizedSource = source.replace(/\\/g, "/");
  return normalizedTarget === normalizedSource
    || normalizedTarget.endsWith(`/${normalizedSource}`)
    || normalizedSource.endsWith(`/${normalizedTarget}`);
}

export function inferTaskRequirements(message: string): TaskRequirements {
  const requiresEvidence = VERIFICATION_REQUEST.test(message || "");
  const targetMatch = message.match(/(?:`|\b)((?:agent|src|data|docs|test)[/\\][^`\s\r\n]+)(?:`|\b)/i);
  const target = targetMatch?.[1]?.replace(/\\/g, "/");
  const contract: ExecutionContract | undefined = FACT_CONTRACT_REQUEST.test(message || "") && !OPEN_WORK_REQUEST.test(message || "") && target
    ? {
        kind: "fact_verification",
        targets: [target],
        ...(message.includes("checkpoint-a-verification") && target.includes("skill-verification")
          ? { instructionSources: ["agent/skills/checkpoint-a-verification/SKILL.md"] }
          : {}),
        allowedSources: [target, "data/user/skill-state.json"],
        allowedTools: ["file_read", "skill_facts"],
        requiredEvidence: ["content", "trust", "enabled", "parse"],
        completionCondition: "evidence_satisfied",
        onMissingEvidence: "report_unverified",
        maxUnrelatedAttempts: 0,
        revision: 1,
      }
    : undefined;
  return {
    kind: requiresEvidence ? "verification" : "general",
    requiresEvidence,
    minSuccessfulEvidence: requiresEvidence ? 1 : 0,
    ...(contract ? { contract } : {}),
  };
}

/**
 * A bounded, host-owned control frame for fact checks. It gives the model a
 * deterministic first move without turning the instruction file into evidence
 * or exposing internal server state in the user-facing response.
 */
export function formatExecutionContractGuidance(requirements: TaskRequirements | undefined): string {
  const contract = requirements?.contract
  if (!contract || contract.kind !== "fact_verification") return ""
  const target = contract.targets?.[0] || "the requested source"
  const instruction = contract.instructionSources?.[0]
  return [
    "[Host execution contract: fact_verification]",
    `First read the requested target with file_read: ${target}.`,
    "Then call skill_facts for the requested skill scope when trust/enabled/parse are required.",
    ...(instruction ? [`You may read this instruction source only if needed to understand the procedure: ${instruction}. Its content is not evidence.`] : []),
    "Do not use explorer_list, search, command, hash, or unrelated sources. After the required evidence is collected, answer immediately; missing fields must be reported as 未验证.",
  ].join("\n")
}

const CONTRACT_EXPANSION_REQUEST = /(?:继续|展开|深入|查.*(?:实现|源码|parse)|查看.*(?:实现|源码)|investigate|implementation|source)/i;

/** Explicit user expansion creates a new open-work contract revision. */
export function expandTaskRequirements(previous: TaskRequirements | undefined, message: string): TaskRequirements | undefined {
  if (!previous?.contract || !CONTRACT_EXPANSION_REQUEST.test(message || "")) return undefined;
  return {
    kind: "general",
    requiresEvidence: false,
    minSuccessfulEvidence: 0,
    contract: {
      kind: "diagnosis",
      completionCondition: "user_stop",
      revision: previous.contract.revision + 1,
    },
  };
}

/** Host-owned pre-tool decision for a bounded fact-verification turn. */
export function authorizeExecutionContractAttempt(
  contract: ExecutionContract | undefined,
  lifecycle: TaskLifecycleSnapshot | undefined,
  attempts: Set<string>,
  toolName: string,
  scope: ToolEvidenceScope,
): ExecutionContractDecision {
  if (!contract || contract.kind !== "fact_verification") return { allowed: true };
  const target = scope.target || "";
  const sourceAllowed = !contract.allowedSources?.length
    || contract.allowedSources.some((source) => sourceMatches(target, source))
    || contract.instructionSources?.some((source) => sourceMatches(target, source));
  if (!sourceAllowed) return { allowed: false, code: "execution_contract_violation", reason: "source_not_allowed", retryable: false };
  if (contract.allowedTools?.length && !contract.allowedTools.includes(toolName)) {
    return { allowed: false, code: "execution_contract_violation", reason: "tool_not_allowed", retryable: false };
  }
  if (contract.requiredEvidence?.length && lifecycle?.missingEvidence?.length === 0) {
    return { allowed: false, code: "execution_contract_complete", reason: "evidence_satisfied", retryable: false };
  }
  const key = `${contract.revision}:${toolName}:${scope.argsFingerprint || ""}:${scope.target || ""}`;
  if (attempts.has(key)) return { allowed: false, code: "duplicate_attempt", reason: "duplicate_attempt", retryable: false };
  attempts.add(key);
  return { allowed: true };
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
  #evidenceFields = new Set<string>();

  constructor(options: TaskLifecycleOptions = {}) {
    this.#clock = options.clock ?? Date.now;
    this.#requirements = options.requirements ?? { kind: "general", requiresEvidence: false, minSuccessfulEvidence: 0 };
  }

  start(turnId: string, requirements = this.#requirements, correlation?: Pick<CorrelationIds, "traceId" | "sessionId">): void {
    this.#requirements = requirements;
    this.#startedTools.clear();
    this.#completedTools.clear();
    this.#retryPolicy = new RetryPolicy();
    this.#evidenceFields.clear();
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
      ...(requirements.contract ? {
        contractRevision: requirements.contract.revision,
        requiredEvidence: [...(requirements.contract.requiredEvidence || [])],
        satisfiedEvidence: [],
        missingEvidence: [...(requirements.contract.requiredEvidence || [])],
      } : {}),
      phaseHistory: [],
    };
    this.#transition("discovering", "turn.started");
  }

  toolStarted(toolCallId: string, name: string, input: unknown): void {
    if (this.#snapshot.status !== "running") return;
    this.#startedTools.set(toolCallId, { name, inputFingerprint: fingerprint(input) });
    this.#transition("discovering", "tool.started");
  }

  toolCompleted(toolCallId: string, evidenceAvailable: boolean, evidenceFields: readonly string[] = []): void {
    if (this.#snapshot.status !== "running" || this.#completedTools.has(toolCallId)) return;
    this.#completedTools.add(toolCallId);
    this.#startedTools.delete(toolCallId);
    this.recordEvidenceFields(evidenceFields);
    if (evidenceAvailable) this.#snapshot.successfulEvidence += 1;
    this.#transition("verifying", evidenceAvailable ? "tool.completed.evidence" : "tool.completed");
  }

  recordEvidenceFields(fields: readonly string[]): void {
    if (this.#snapshot.status !== "running") return;
    for (const field of fields) {
      if (typeof field === "string" && field.length > 0) this.#evidenceFields.add(field);
    }
    const required = this.#requirements.contract?.requiredEvidence || [];
    if (required.length > 0) {
      const satisfied = required.filter((field) => this.#evidenceFields.has(field));
      this.#snapshot.satisfiedEvidence = satisfied;
      this.#snapshot.missingEvidence = required.filter((field) => !this.#evidenceFields.has(field));
    }
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
    } else if (this.#requirements.contract?.requiredEvidence?.length) {
      const missing = this.#requirements.contract.requiredEvidence.filter((field) => !this.#evidenceFields.has(field));
      this.#snapshot.satisfiedEvidence = this.#requirements.contract.requiredEvidence.filter((field) => this.#evidenceFields.has(field));
      this.#snapshot.missingEvidence = missing;
      if (missing.length > 0) {
        this.#block(this.#requirements.contract.onMissingEvidence === "report_unverified" ? "evidence_unverified" : "evidence_insufficient");
      } else if (this.#requirements.requiresEvidence && this.#snapshot.successfulEvidence < this.#requirements.minSuccessfulEvidence) {
        this.#block("evidence_insufficient");
      } else {
        this.#snapshot.status = "completed";
        this.#transition("answering", "turn.completed");
      }
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
    // A runtime-enforced block is stronger than a later provider cancellation.
    // Preserve the original failure reason so cancellation cannot turn a
    // denied/invalid request into an apparently user-cancelled turn.
    if (this.#snapshot.status === "completed" || this.#snapshot.status === "blocked") return;
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
