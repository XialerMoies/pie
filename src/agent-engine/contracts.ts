import type { ToolFailureKind } from "../agent/types.js";
import type { PlanStateSnapshot, PlanStateTarget } from "../agent/plan-state.js";

export const ENGINE_EVENT_VERSION = 1 as const;

export type UsageSource = "exact" | "mixed" | "estimated";
export type CapabilityState = "supported" | "unsupported" | "unknown";
export type EngineTerminalEvent = "turn.completed" | "turn.failed" | "turn.cancelled";
export type EngineContentPhase = "start" | "delta" | "end";
/** Visibility of a runtime event before it is reduced into presentation events. */
export type EngineEventVisibility = "user" | "debug" | "internal";
export type EngineErrorCategory =
  | "provider"
  | "permission"
  | "validation"
  | "network"
  | "storage"
  | "cancelled"
  | "internal";

export type EngineCost =
  | { status: "unknown" }
  | { status: "known"; amount: number; currency: "USD" };

export interface EngineUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  reasoning: number;
  source: UsageSource;
  cost: EngineCost;
}

export interface EngineContextUsage {
  tokens: number | null;
  contextWindow: number;
  percent: number | null;
  source: UsageSource;
  exactTokens?: number;
  estimatedTokens?: number;
}

export interface EngineSessionStats {
  usage: EngineUsage;
  compactCount: number;
  lastCompactionAt: string | null;
  lastCompactionSummary: string | null;
}

export type NumericCapability =
  | { status: "unknown" }
  | { status: "known"; value: number };

export interface ModelCapabilities {
  reasoning: CapabilityState;
  imageInput: CapabilityState;
  contextWindow: NumericCapability;
  maxOutputTokens: NumericCapability;
}

export interface EngineModel {
  provider: string;
  id: string;
  name?: string;
  capabilities: ModelCapabilities;
}

export interface EngineErrorInfo {
  code: string;
  category: EngineErrorCategory;
  retryable: boolean;
  message: string;
  /** Preserved tool-level failure classification when this is a tool error. */
  kind?: ToolFailureKind;
  details?: unknown;
}

export interface EngineSessionSnapshot {
  id: string;
  workspace: string;
  sessionFile?: string;
  model?: EngineModel;
  isStreaming: boolean;
  isCompacting: boolean;
  thinkingLevel?: string;
  availableThinkingLevels?: string[];
  supportsThinking?: boolean;
  messagesCount?: number;
  tools?: string[];
  profile?: { id: string; revision: number };
  planState?: PlanStateSnapshot;
  profileLifecycle?: {
    requested: { id: string; revision: number; generation: number };
    effective?: { id: string; revision: number; generation: number };
    source: "builtin" | "workspace" | "user";
    action: "create" | "resume" | "switch" | "fork";
    status: "applied" | "rejected" | "rolled_back";
    reason?: string;
    timestamp: string;
  };
}

export interface EngineEventBase {
  version: typeof ENGINE_EVENT_VERSION;
  type: string;
  sessionId: string;
  turnId: string;
  seq: number;
  timestamp: number;
  /** Runtime visibility boundary; normalized events always carry this field. */
  visibility?: EngineEventVisibility;
  /** Assistant message ordinal and content segment index, when the provider exposes them. */
  messageSeq?: number;
}

export type EngineEvent =
  | (EngineEventBase & { type: "engine.ready"; turnId: "" })
  | (EngineEventBase & { type: "session.changed"; turnId: ""; session: EngineSessionSnapshot })
  | (EngineEventBase & { type: "plan.changed"; turnId: ""; state: PlanStateSnapshot })
  | (EngineEventBase & { type: "turn.started" })
  | (EngineEventBase & { type: "content.delta"; text: string; contentIndex?: number; phase?: EngineContentPhase })
  | (EngineEventBase & { type: "thinking.delta"; text: string; contentIndex?: number; phase?: EngineContentPhase })
  | (EngineEventBase & { type: "tool.started"; toolCallId: string; name: string; input?: unknown })
  | (EngineEventBase & { type: "tool.updated"; toolCallId: string; name: string; output: string })
  | (EngineEventBase & { type: "tool.completed"; toolCallId: string; name: string; output?: string; metadata?: Record<string, unknown> })
  | (EngineEventBase & { type: "tool.failed"; toolCallId: string; name: string; error: EngineErrorInfo; metadata?: Record<string, unknown> })
  | (EngineEventBase & { type: "usage.updated"; usage: EngineUsage })
  | (EngineEventBase & { type: "turn.completed"; usage?: EngineUsage })
  | (EngineEventBase & { type: "turn.failed"; error: EngineErrorInfo })
  | (EngineEventBase & { type: "turn.cancelled"; reason?: string })
  | (EngineEventBase & { type: "compaction.started"; before?: EngineUsage })
  | (EngineEventBase & { type: "compaction.completed"; before?: EngineUsage; after?: EngineUsage })
  | (EngineEventBase & { type: "compaction.failed"; error: EngineErrorInfo })
  | (EngineEventBase & { type: "queue.updated"; steering: string[]; followUp: string[] })
  | (EngineEventBase & { type: "diagnostic"; level: "info" | "warning" | "error"; code: string; message: string });

export interface EnginePromptInput {
  message: string;
  attachments?: unknown[];
  turnId?: string;
}

export interface AgentEngine {
  readonly id: string;
  readonly session: EngineSessionSnapshot;
  prompt(input: EnginePromptInput, signal?: AbortSignal): Promise<void>;
  steer(text: string): Promise<void>;
  followUp(text: string): Promise<void>;
  cancel(turnId?: string): Promise<boolean>;
  compact(focus?: string): Promise<void>;
  switchWorkspace(workspace: string): Promise<void>;
  openSession(sessionFile: string, workspace: string, lifecycleAction?: "resume" | "fork"): Promise<void>;
  createNewSession(profileId?: string): Promise<string>;
  switchProfile(profileId: string): Promise<{ id: string; revision: number }>;
  requestPlanState(target: PlanStateTarget): Promise<PlanStateSnapshot>;
  setModel(provider: string, modelId: string): Promise<void>;
  setThinkingLevel(level: string): Promise<void>;
  syncModelProviders(): Promise<number>;
  getUsage(): EngineUsage | undefined;
  getContextUsage(): EngineContextUsage | undefined;
  getSessionStats(): EngineSessionStats | undefined;
  subscribe(listener: (event: EngineEvent) => void): () => void;
  dispose(): Promise<void> | void;
}

export const ENGINE_EVENT_TYPES = [
  "engine.ready",
  "session.changed",
  "plan.changed",
  "turn.started",
  "content.delta",
  "thinking.delta",
  "tool.started",
  "tool.updated",
  "tool.completed",
  "tool.failed",
  "usage.updated",
  "turn.completed",
  "turn.failed",
  "turn.cancelled",
  "compaction.started",
  "compaction.completed",
  "compaction.failed",
  "queue.updated",
  "diagnostic",
] as const satisfies readonly EngineEvent["type"][];

const EVENT_TYPES = new Set<EngineEvent["type"]>(ENGINE_EVENT_TYPES);

export function defaultEngineEventVisibility(type: EngineEvent["type"]): EngineEventVisibility {
  if (type === "diagnostic") return "debug";
  if (type === "plan.changed") return "user";
  if (type === "content.delta" || type === "thinking.delta"
    || type === "tool.started" || type === "tool.updated"
    || type === "tool.completed" || type === "tool.failed"
    || type === "turn.completed" || type === "turn.failed"
    || type === "turn.cancelled" || type === "queue.updated") return "user";
  return "internal";
}

function nonNegativeNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

function knownPositiveInteger(value: unknown): NumericCapability {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? { status: "known", value }
    : { status: "unknown" };
}

export function normalizeEngineUsage(value: Partial<EngineUsage> & { source: UsageSource }): EngineUsage {
  const cost = value.cost?.status === "known"
    && Number.isFinite(value.cost.amount)
    && value.cost.amount >= 0
    && value.cost.currency === "USD"
    ? { status: "known" as const, amount: value.cost.amount, currency: "USD" as const }
    : { status: "unknown" as const };
  return {
    input: nonNegativeNumber(value.input),
    output: nonNegativeNumber(value.output),
    cacheRead: nonNegativeNumber(value.cacheRead),
    cacheWrite: nonNegativeNumber(value.cacheWrite),
    reasoning: nonNegativeNumber(value.reasoning),
    source: value.source,
    cost,
  };
}

export function normalizeModelCapabilities(value: {
  reasoning?: boolean;
  input?: readonly string[];
  contextWindow?: number;
  maxTokens?: number;
}): ModelCapabilities {
  return {
    reasoning: value.reasoning === undefined
      ? "unknown"
      : value.reasoning ? "supported" : "unsupported",
    imageInput: value.input === undefined
      ? "unknown"
      : value.input.includes("image") ? "supported" : "unsupported",
    contextWindow: knownPositiveInteger(value.contextWindow),
    maxOutputTokens: knownPositiveInteger(value.maxTokens),
  };
}

export function normalizeEngineEvent(value: EngineEvent): EngineEvent & { visibility: EngineEventVisibility } {
  if (!value || typeof value !== "object") throw new TypeError("engine event must be an object");
  if (value.version !== ENGINE_EVENT_VERSION) throw new TypeError("engine event version must be 1");
  if (!EVENT_TYPES.has(value.type)) throw new TypeError("engine event type is unsupported");
  if (typeof value.sessionId !== "string") throw new TypeError("engine event sessionId must be a string");
  if (typeof value.turnId !== "string") throw new TypeError("engine event turnId must be a string");
  if (!Number.isSafeInteger(value.seq) || value.seq < 1) throw new TypeError("engine event seq must be a positive integer");
  if (!Number.isFinite(value.timestamp) || value.timestamp < 0) throw new TypeError("engine event timestamp must be non-negative");
  return {
    ...value,
    visibility: value.visibility ?? defaultEngineEventVisibility(value.type),
  };
}

export function assertTerminalTransition(
  current: EngineTerminalEvent | undefined,
  next: EngineTerminalEvent,
): EngineTerminalEvent {
  if (current !== undefined && current !== next) {
    throw new Error(`turn already terminated as ${current}`);
  }
  return current ?? next;
}
