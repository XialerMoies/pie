import { createHash } from "node:crypto";
import type { EngineErrorInfo } from "../agent-engine/contracts.js";
import { RetryPolicy, type RetryDecision } from "./retry-policy.js";
import type { CorrelationIds } from "./correlation.js";
import type { ExecutionContract, ExecutionContractDecision, FactVerificationTaskContract, ToolEvidenceScope } from "../agent/types.js";

export type TaskPhase = "discovering" | "verifying" | "answering";
export type TaskStatus = "running" | "completed" | "failed" | "blocked" | "cancelled";
export type TaskKind = "general" | "verification";

export interface VerificationPolicy {
  mode: "soft" | "hard";
  confidence: "low" | "high";
  reason: "fact_profile" | "checkpoint_request" | "evidence_only_request" | "fact_like_request";
  preferredTools: string[];
  preferredSources: string[];
  stopWhenEvidenceSatisfied: boolean;
}

export interface TaskTokenUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  reasoning: number;
  total: number;
}

export interface ExecutionPolicyMetrics {
  unrelatedAttempts: number;
  blockedAttempts: number;
}

export interface TaskExecutionMetrics extends ExecutionPolicyMetrics {
  toolCalls: number;
  evidenceSatisfied: boolean;
  finalStatus: TaskStatus;
  userExpansion: boolean;
  durationMs: number;
  tokenUsage?: TaskTokenUsage;
}

export interface TaskRequirements {
  kind: TaskKind;
  requiresEvidence: boolean;
  minSuccessfulEvidence: number;
  verificationPolicy?: VerificationPolicy;
  userExpansion?: boolean;
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
  metrics: TaskExecutionMetrics;
  phaseHistory: Array<{ phase: TaskPhase; at: string; cause: string }>;
}

export interface TaskLifecycleOptions {
  clock?: () => number;
  requirements?: TaskRequirements;
}

const FACT_LIKE_REQUEST = /(?:验证|核验|检查|读取|查看|状态|证据|事实|inspect|verify|check|read|status|evidence|fact)/i;
const CHECKPOINT_REQUEST = /(?:按|按照|依据|遵循|using|follow)[^\n\r]{0,80}checkpoint-a-verification|checkpoint-a-verification[^\n\r]{0,80}(?:检查|核验|verify|check)/i;
const EVIDENCE_ONLY_REQUEST = /(?:(?:只|仅)(?:报告|输出|说明)?[^\n\r]{0,40}(?:实际|真实)?(?:读取到|观察到|返回的|可检查的)?[^\n\r]{0,30}(?:事实|证据)|only\s+(?:report|use)[^\n\r]{0,60}(?:facts?|evidence))/i;
const OPEN_WORK_REQUEST = /(?:修复|修改|实现|重构|排查|调试|构建|测试|分析|审查|评估|解释|总结|建议|规划|设计|为什么|原因|fix|implement|refactor|debug|diagnose|build|test|analy[sz]e|review|evaluate|explain|summarize|recommend|plan|design|why)/i;

function sourceMatches(target: string, source: string): boolean {
  const normalizedTarget = target.replace(/\\/g, "/");
  const normalizedSource = source.replace(/\\/g, "/");
  return normalizedTarget === normalizedSource
    || normalizedTarget.endsWith(`/${normalizedSource}`)
    || normalizedSource.endsWith(`/${normalizedTarget}`)
    || (normalizedSource.startsWith("memory:") && normalizedTarget.startsWith(`${normalizedSource}/`));
}

export function isFactVerificationContract(
  contract: ExecutionContract | undefined,
): contract is ExecutionContract & { kind: "fact_verification" | "fact_verification_batch" } {
  return contract?.kind === "fact_verification" || contract?.kind === "fact_verification_batch"
}

function toolTarget(toolName: string, input: unknown): string {
  const args = input && typeof input === "object" ? input as Record<string, unknown> : {};
  if (typeof args.target === "string" || typeof args.path === "string" || typeof args.file === "string") {
    return String(args.target || args.path || args.file).replace(/\\/g, "/").slice(0, 512);
  }
  if (toolName === "skill_facts" && typeof args.id === "string") {
    return `${args.source === "user" ? "user/skills" : "agent/skills"}/${args.id}/SKILL.md`.slice(0, 512);
  }
  if (toolName === "list_memory" || toolName === "read_memory") {
    return `memory:${args.scope === "workspace" ? "workspace" : "user"}${toolName === "read_memory" && typeof args.name === "string" ? `/${args.name}` : ""}`;
  }
  return "";
}

function batchTaskFor(contract: ExecutionContract, toolName: string, target: string): FactVerificationTaskContract | undefined {
  if (contract.kind !== "fact_verification_batch") return undefined;
  return contract.tasks?.find((task) => task.allowedTools.includes(toolName)
    && (task.targets.some((source) => sourceMatches(target, source))
      || task.allowedSources.some((source) => sourceMatches(target, source))));
}

export function markFactVerificationStep(
  progress: Map<string, Set<string>> | undefined,
  contract: ExecutionContract | undefined,
  toolName: string,
  input: unknown,
): void {
  if (!progress || !contract || contract.kind !== "fact_verification_batch") return;
  const task = batchTaskFor(contract, toolName, toolTarget(toolName, input));
  if (!task || !task.sequence?.includes(toolName)) return;
  const completed = progress.get(task.id) || new Set<string>();
  completed.add(toolName);
  progress.set(task.id, completed);
}

export function namespaceFactEvidence(
  contract: ExecutionContract | undefined,
  toolName: string,
  input: unknown,
  fields: readonly string[],
): string[] {
  if (!contract || contract.kind !== "fact_verification_batch") return [...fields];
  const task = batchTaskFor(contract, toolName, toolTarget(toolName, input));
  return task ? fields.map((field) => `${task.id}.${field}`) : [];
}

function buildFactVerificationBatchTasks(text: string, target: string | undefined, skillTarget: boolean): FactVerificationTaskContract[] {
  const hasUserTask = /任务\s*B[：:]?[\s\S]*(?:用户级|用户|user)[^\n\r]*(?:记忆|memory)/i.test(text)
    || /(?:用户级|用户|user)[^\n\r]*(?:记忆|memory)/i.test(text);
  const hasWorkspaceTask = /任务\s*C[：:]?[\s\S]*(?:当前工作区|工作区|workspace)[^\n\r]*(?:记忆|memory)/i.test(text)
    || /(?:当前工作区|工作区|workspace)[^\n\r]*(?:记忆|memory)/i.test(text);
  if (!target || !skillTarget || !hasUserTask || !hasWorkspaceTask) return [];
  const skillTask: FactVerificationTaskContract = {
    id: "A",
    targets: [target],
    instructionSources: text.includes("checkpoint-a-verification") && target.includes("skill-verification")
      ? ["agent/skills/checkpoint-a-verification/SKILL.md"]
      : [],
    allowedSources: [target, "data/user/skill-state.json"],
    allowedTools: ["file_read", "skill_facts"],
    requiredEvidence: ["content", "trust", "enabled", "parse"],
    sequence: ["file_read", "skill_facts"],
  };
  const memoryTask = (id: string, scope: "user" | "workspace"): FactVerificationTaskContract => ({
    id,
    targets: [`memory:${scope}`],
    allowedSources: [`memory:${scope}`],
    allowedTools: ["list_memory", "read_memory"],
    requiredEvidence: ["scope", "entry", "enabled", "source", "content"],
    sequence: ["list_memory", "read_memory"],
  });
  return [skillTask, memoryTask("B", "user"), memoryTask("C", "workspace")];
}

function batchFactVerificationContract(tasks: readonly FactVerificationTaskContract[]): ExecutionContract {
  return {
    kind: "fact_verification_batch",
    tasks,
    targets: tasks.flatMap((task) => task.targets),
    instructionSources: tasks.flatMap((task) => task.instructionSources || []),
    allowedSources: [...new Set(tasks.flatMap((task) => task.allowedSources))],
    allowedTools: [...new Set(tasks.flatMap((task) => task.allowedTools))],
    requiredEvidence: tasks.flatMap((task) => task.requiredEvidence.map((field) => `${task.id}.${field}`)),
    completionCondition: "evidence_satisfied",
    onMissingEvidence: "report_unverified",
    maxUnrelatedAttempts: 0,
    revision: 1,
  };
}

export function inferTaskRequirements(message: string, profileId?: string): TaskRequirements {
  const text = message || "";
  const targetMatches = [...text.matchAll(/(?:`|\b)((?:agent|src|data|docs|test)[/\\][^`\s\r\n]+)(?:`|\b)/gi)];
  const targetMatch = targetMatches.at(-1);
  const target = targetMatch?.[1]?.replace(/\\/g, "/");
  const memoryScope = /(?:用户级|用户|user)[^\n\r]*(?:记忆|memory)/i.test(message || "")
    ? "user"
    : /(?:工作区|当前工作区|workspace)[^\n\r]*(?:记忆|memory)/i.test(message || "")
      ? "workspace"
      : undefined;
  const skillTarget = Boolean(target && /(?:^|\/)skills\/[^/]+\/SKILL\.md$/i.test(target));
  const batchTasks = buildFactVerificationBatchTasks(text, target, skillTarget);
  const factProfile = profileId === "fact-verification";
  const openWork = OPEN_WORK_REQUEST.test(text);
  const checkpointRequest = CHECKPOINT_REQUEST.test(text);
  const evidenceOnlyRequest = EVIDENCE_ONLY_REQUEST.test(text);
  const factLikeRequest = FACT_LIKE_REQUEST.test(text) && !openWork;
  const highConfidence = factProfile || (!openWork && (checkpointRequest || (evidenceOnlyRequest && Boolean(target || memoryScope))));
  const supportedFactRequest = Boolean(target || memoryScope) && !openWork;
  const policyReason: VerificationPolicy["reason"] = factProfile
    ? "fact_profile"
    : checkpointRequest
      ? "checkpoint_request"
      : evidenceOnlyRequest
        ? "evidence_only_request"
        : "fact_like_request";
  const preferredTools = memoryScope
    ? ["list_memory", "read_memory"]
    : skillTarget
      ? ["file_read", "skill_facts"]
      : target
        ? ["file_read"]
        : [];
  const preferredSources = memoryScope ? [`memory:${memoryScope}`] : target ? [target] : [];
  const verificationPolicy: VerificationPolicy | undefined = highConfidence || factLikeRequest
    ? {
        mode: highConfidence ? "hard" : "soft",
        confidence: highConfidence ? "high" : "low",
        reason: policyReason,
        preferredTools,
        preferredSources,
        stopWhenEvidenceSatisfied: true,
      }
    : undefined;
  const contract: ExecutionContract | undefined = highConfidence
    ? (batchTasks.length > 1
      ? batchFactVerificationContract(batchTasks)
      : !supportedFactRequest
      ? {
          kind: "fact_verification",
          targets: ["profile:fact-verification"],
          allowedSources: ["profile:fact-verification"],
          allowedTools: ["__unsupported_fact_request__"],
          requiredEvidence: ["supported_target"],
          completionCondition: "evidence_satisfied",
          onMissingEvidence: "report_unverified",
          maxUnrelatedAttempts: 0,
          revision: 1,
        }
      : target
      ? {
          kind: "fact_verification",
          targets: [target],
          ...(skillTarget && message.includes("checkpoint-a-verification") && target.includes("skill-verification")
            ? { instructionSources: ["agent/skills/checkpoint-a-verification/SKILL.md"] }
            : {}),
          allowedSources: skillTarget ? [target, "data/user/skill-state.json"] : [target],
          allowedTools: skillTarget ? ["file_read", "skill_facts"] : ["file_read"],
          requiredEvidence: skillTarget ? ["content", "trust", "enabled", "parse"] : ["content"],
          completionCondition: "evidence_satisfied",
          onMissingEvidence: "report_unverified",
          maxUnrelatedAttempts: 0,
          revision: 1,
        }
      : memoryScope
        ? {
            kind: "fact_verification",
            targets: [`memory:${memoryScope}`],
            allowedSources: [`memory:${memoryScope}`],
            allowedTools: ["list_memory", "read_memory"],
            requiredEvidence: ["scope", "entry", "enabled", "source", "content"],
            completionCondition: "evidence_satisfied",
            onMissingEvidence: "report_unverified",
            maxUnrelatedAttempts: 0,
            revision: 1,
          }
        : undefined)
    : undefined;
  return {
    kind: verificationPolicy ? "verification" : "general",
    requiresEvidence: verificationPolicy?.mode === "hard",
    minSuccessfulEvidence: verificationPolicy?.mode === "hard" ? 1 : 0,
    ...(verificationPolicy ? { verificationPolicy } : {}),
    ...(contract ? { contract } : {}),
  };
}

/**
 * A bounded, host-owned control frame for fact checks. It gives the model a
 * deterministic first move without turning the instruction file into evidence
 * or exposing internal server state in the user-facing response.
 */
export function formatExecutionContractGuidance(requirements: TaskRequirements | undefined): string {
  const policy = requirements?.verificationPolicy;
  const contract = requirements?.contract
  if (!isFactVerificationContract(contract)) {
    if (policy?.mode !== "soft") return "";
    const preferredTools = policy.preferredTools.length > 0 ? policy.preferredTools.join(", ") : "the most direct read-only tool";
    const preferredSources = policy.preferredSources.length > 0 ? ` Start with: ${policy.preferredSources.join(", ")}.` : "";
    return [
      "[Host verification guidance: soft]",
      `Prefer ${preferredTools} for the first direct check.${preferredSources}`,
      "Stop once the requested facts are supported. You may inspect other relevant sources when the task genuinely requires it.",
    ].join("\n");
  }
  if (contract.kind === "fact_verification_batch") {
    const taskGuidance = (contract.tasks || []).map((task) => {
      const target = task.targets[0] || "the requested source";
      const memoryMatch = /^memory:(user|workspace)$/i.exec(target);
      return memoryMatch
        ? `${task.id}: first call list_memory with scope=${memoryMatch[1].toLowerCase()}, then read_memory for the returned entry.`
        : `${task.id}: first read ${target} with file_read, then call skill_facts when its status fields are required.`;
    }).join("\n");
    return [
      "[Host execution contract: fact_verification_batch]",
      taskGuidance,
      "Each task has an independent evidence scope. Complete each task sequence before reporting its facts.",
      "Do not use explorer_list, search, command, hash, or unrelated sources. Missing fields must be reported as 未验证.",
    ].join("\n");
  }
  const target = contract.targets?.[0] || "the requested source"
  const instruction = contract.instructionSources?.[0]
  const memoryMatch = /^memory:(user|workspace)$/i.exec(target)
  const unsupportedProfileRequest = target === "profile:fact-verification"
  const firstStep = unsupportedProfileRequest
    ? "This request has no supported fact-verification target. Do not call tools; report 未验证 and state that a concrete file, skill, or memory scope is required."
    : memoryMatch
    ? `First call list_memory with scope=${memoryMatch[1].toLowerCase()} for ${target}. If an entry is returned, call read_memory for that entry.`
    : `First read the requested target with file_read: ${target}.`
  return [
    "[Host execution contract: fact_verification]",
    firstStep,
    ...(memoryMatch || unsupportedProfileRequest ? [] : ["Then call skill_facts for the requested skill scope when trust/enabled/parse are required."]),
    ...(instruction ? [`You may read this instruction source only if needed to understand the procedure: ${instruction}. Its content is not evidence.`] : []),
    "Do not use explorer_list, search, command, hash, or unrelated sources. After the required evidence is collected, answer immediately; missing fields must be reported as 未验证.",
  ].join("\n")
}

const CONTRACT_EXPANSION_REQUEST = /(?:(?:扩大|扩展|放宽)(?:调查|检查|核验|搜索|来源|工具|范围)?|(?:继续|展开|深入)[^\n\r]{0,50}(?:实现|源码|目录|其他来源|更多|parse)|(?:expand|broaden)[^\n\r]{0,50}(?:scope|source|search)|(?:continue|investigate)[^\n\r]{0,50}(?:implementation|source|more))/i;

/** Explicit user expansion creates a new open-work contract revision. */
export function expandTaskRequirements(previous: TaskRequirements | undefined, message: string, profileId?: string): TaskRequirements | undefined {
  if (!previous?.contract || !CONTRACT_EXPANSION_REQUEST.test(message || "")) return undefined;
  return {
    kind: "general",
    requiresEvidence: false,
    minSuccessfulEvidence: 0,
    userExpansion: true,
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
  metrics?: ExecutionPolicyMetrics,
  progress?: Map<string, Set<string>>,
): ExecutionContractDecision {
  if (!isFactVerificationContract(contract)) return { allowed: true };
  const target = scope.target || "";
  const task = contract.kind === "fact_verification_batch" ? batchTaskFor(contract, toolName, target) : undefined;
  const allowedSources = task?.allowedSources || contract.allowedSources;
  const instructionSources = task?.instructionSources || contract.instructionSources;
  const allowedTools = task?.allowedTools || contract.allowedTools;
  const sourceAllowed = Boolean(task || contract.kind !== "fact_verification_batch")
    && (!allowedSources?.length
      || allowedSources.some((source) => sourceMatches(target, source))
      || instructionSources?.some((source) => sourceMatches(target, source)));
  if (!sourceAllowed) {
    if (metrics) {
      metrics.unrelatedAttempts += 1;
      metrics.blockedAttempts += 1;
    }
    return { allowed: false, code: "execution_contract_violation", reason: "source_not_allowed", retryable: false };
  }
  if (allowedTools?.length && !allowedTools.includes(toolName)) {
    if (metrics) {
      metrics.unrelatedAttempts += 1;
      metrics.blockedAttempts += 1;
    }
    return { allowed: false, code: "execution_contract_violation", reason: "tool_not_allowed", retryable: false };
  }
  const sequence = task?.sequence;
  if (task && sequence?.length) {
    const step = sequence.indexOf(toolName);
    const previous = step > 0 ? sequence[step - 1] : undefined;
    if (previous && !progress?.get(task.id)?.has(previous)) {
      if (metrics) {
        metrics.unrelatedAttempts += 1;
        metrics.blockedAttempts += 1;
      }
      return { allowed: false, code: "execution_contract_violation", reason: "sequence_required", retryable: false };
    }
  }
  if (contract.requiredEvidence?.length && lifecycle?.missingEvidence?.length === 0) {
    if (metrics) metrics.blockedAttempts += 1;
    return { allowed: false, code: "execution_contract_complete", reason: "evidence_satisfied", retryable: false };
  }
  const key = `${contract.revision}:${toolName}:${scope.argsFingerprint || ""}:${scope.target || ""}`;
  if (attempts.has(key)) {
    if (metrics) metrics.blockedAttempts += 1;
    return { allowed: false, code: "duplicate_attempt", reason: "duplicate_attempt", retryable: false };
  }
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
    metrics: {
      toolCalls: 0,
      unrelatedAttempts: 0,
      blockedAttempts: 0,
      evidenceSatisfied: false,
      finalStatus: "running",
      userExpansion: false,
      durationMs: 0,
    },
    phaseHistory: [],
  };
  #startedTools = new Map<string, { name: string; inputFingerprint: string }>();
  #completedTools = new Set<string>();
  #retryPolicy = new RetryPolicy();
  #evidenceFields = new Set<string>();
  #startedAt = 0;

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
    this.#startedAt = this.#clock();
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
      metrics: {
        toolCalls: 0,
        unrelatedAttempts: 0,
        blockedAttempts: 0,
        evidenceSatisfied: false,
        finalStatus: "running",
        userExpansion: requirements.userExpansion === true,
        durationMs: 0,
      },
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
    if (!this.#startedTools.has(toolCallId) && !this.#completedTools.has(toolCallId)) this.#snapshot.metrics.toolCalls += 1;
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
      this.#snapshot.metrics.evidenceSatisfied = this.#snapshot.missingEvidence.length === 0;
    }
  }

  recordPolicyMetrics(metrics: ExecutionPolicyMetrics | undefined): void {
    if (!metrics) return;
    this.#snapshot.metrics.unrelatedAttempts = Math.max(0, metrics.unrelatedAttempts);
    this.#snapshot.metrics.blockedAttempts = Math.max(0, metrics.blockedAttempts);
  }

  recordUsage(usage: { input: number; output: number; cacheRead: number; cacheWrite: number; reasoning: number } | undefined): void {
    if (!usage) return;
    const input = Math.max(0, Number(usage.input) || 0);
    const output = Math.max(0, Number(usage.output) || 0);
    const cacheRead = Math.max(0, Number(usage.cacheRead) || 0);
    const cacheWrite = Math.max(0, Number(usage.cacheWrite) || 0);
    const reasoning = Math.max(0, Number(usage.reasoning) || 0);
    this.#snapshot.metrics.tokenUsage = { input, output, cacheRead, cacheWrite, reasoning, total: input + output + cacheRead + cacheWrite };
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
        this.#snapshot.metrics.evidenceSatisfied = true;
        this.#snapshot.status = "completed";
        this.#transition("answering", "turn.completed");
      }
    } else if (this.#requirements.requiresEvidence && this.#snapshot.successfulEvidence < this.#requirements.minSuccessfulEvidence) {
      this.#block("evidence_insufficient");
    } else {
      this.#snapshot.status = "completed";
      this.#transition("answering", "turn.completed");
    }
    this.#finalizeMetrics();
    return this.snapshot();
  }

  fail(reason = "turn_failed"): void {
    if (this.#snapshot.status === "completed" || this.#snapshot.status === "cancelled" || this.#snapshot.status === "blocked") return;
    this.#snapshot.status = "failed";
    this.#snapshot.reason = reason;
    this.#finalizeMetrics();
  }

  cancel(reason = "cancelled"): void {
    // A runtime-enforced block is stronger than a later provider cancellation.
    // Preserve the original failure reason so cancellation cannot turn a
    // denied/invalid request into an apparently user-cancelled turn.
    if (this.#snapshot.status === "completed" || this.#snapshot.status === "blocked") return;
    this.#snapshot.status = "cancelled";
    this.#snapshot.reason = reason;
    this.#finalizeMetrics();
  }

  snapshot(): TaskLifecycleSnapshot {
    return {
      ...this.#snapshot,
      retryDecisions: this.#snapshot.retryDecisions.map((decision) => ({ ...decision })),
      metrics: {
        ...this.#snapshot.metrics,
        ...(this.#snapshot.metrics.tokenUsage ? { tokenUsage: { ...this.#snapshot.metrics.tokenUsage } } : {}),
      },
      phaseHistory: this.#snapshot.phaseHistory.map((item) => ({ ...item })),
    };
  }

  #block(reason: string): void {
    this.#snapshot.status = "blocked";
    this.#snapshot.reason = reason;
    this.#finalizeMetrics();
  }

  #finalizeMetrics(): void {
    this.#snapshot.metrics.finalStatus = this.#snapshot.status;
    this.#snapshot.metrics.durationMs = this.#startedAt > 0 ? Math.max(0, this.#clock() - this.#startedAt) : 0;
  }

  #transition(phase: TaskPhase, cause: string): void {
    this.#snapshot.phase = phase;
    const last = this.#snapshot.phaseHistory.at(-1);
    if (last?.phase === phase && last.cause === cause) return;
    this.#snapshot.phaseHistory.push({ phase, at: new Date(this.#clock()).toISOString(), cause });
  }
}
