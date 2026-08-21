import { randomUUID } from "node:crypto";
import type { AgentRuntime } from "../agent/runtime.js";
import {
  ENGINE_EVENT_VERSION,
  normalizeEngineEvent,
  normalizeModelCapabilities,
  type AgentEngine,
  type EngineEvent,
  type EngineEventBase,
  type EngineContextUsage,
  type EnginePromptInput,
  type EngineSessionSnapshot,
  type EngineSessionStats,
  type EngineTerminalEvent,
  type EngineUsage,
} from "./contracts.js";
import { AgentEngineError, normalizeEngineError } from "./errors.js";
import { mapPiEvent, usageFromContext } from "./event-normalizer.js";

export interface PiAgentEngineAdapterOptions {
  id?: string;
  clock?: () => number;
  turnId?: () => string;
  /** Parent-agent guardrails. They apply to one prompt, including PI's internal tool loop. */
  maxTurns?: number;
  maxToolCalls?: number;
  maxRepeatedToolCalls?: number;
  timeoutMs?: number;
}

const DEFAULT_PARENT_LIMITS = {
  maxTurns: 40,
  maxToolCalls: 200,
  maxRepeatedToolCalls: 3,
  timeoutMs: 15 * 60 * 1000,
} as const;

function positiveLimit(value: number | undefined, fallback: number, max: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.min(Math.floor(value), max)
    : fallback;
}

interface TurnGuard {
  toolCalls: number;
  turns: number;
  toolFingerprintCounts: Map<string, number>;
  error?: AgentEngineError;
}

type RuntimeLike = Pick<
  AgentRuntime,
  | "currentWorkspace"
  | "session"
  | "modelRegistry"
  | "onEvent"
  | "getContextUsageSnapshot"
  | "runWithStableSession"
  | "switchWorkspace"
  | "openSession"
  | "createNewSession"
  | "syncModelProviders"
  | "dispose"
>;

function sessionId(runtime: RuntimeLike): string {
  try {
    const active = (runtime as RuntimeLike & { getActiveSession?: () => { id?: string } | null }).getActiveSession?.();
    if (active?.id) return active.id;
    return runtime.session.sessionManager?.getSessionId?.() || "";
  } catch { return ""; }
}

export class PiAgentEngineAdapter implements AgentEngine {
  readonly id: string;
  readonly #runtime: RuntimeLike;
  readonly #clock: () => number;
  readonly #turnIdFactory: () => string;
  readonly #maxTurns: number;
  readonly #maxToolCalls: number;
  readonly #maxRepeatedToolCalls: number;
  readonly #timeoutMs: number;
  readonly #listeners = new Set<(event: EngineEvent) => void>();
  readonly #unsubscribeRuntime: () => void;
  #seq = 0;
  #activeTurnId = "";
  #pendingTurnId = "";
  #terminal?: EngineTerminalEvent;
  #compactionBefore?: EngineUsage;
  #assistantMessageSeq = 0;
  readonly #seenAssistantContent = new Set<string>();
  #promptInFlight = false;
  #turnGuard?: TurnGuard;
  #guardTimer?: ReturnType<typeof setTimeout>;
  #disposed = false;
  readonly #knownModels = new Map<string, unknown>();

  constructor(runtime: RuntimeLike, options: PiAgentEngineAdapterOptions = {}) {
    this.#runtime = runtime;
    this.id = options.id ?? randomUUID();
    this.#clock = options.clock ?? Date.now;
    this.#turnIdFactory = options.turnId ?? randomUUID;
    this.#maxTurns = positiveLimit(options.maxTurns, DEFAULT_PARENT_LIMITS.maxTurns, 1000);
    this.#maxToolCalls = positiveLimit(options.maxToolCalls, DEFAULT_PARENT_LIMITS.maxToolCalls, 10_000);
    this.#maxRepeatedToolCalls = positiveLimit(options.maxRepeatedToolCalls, DEFAULT_PARENT_LIMITS.maxRepeatedToolCalls, 100);
    this.#timeoutMs = positiveLimit(options.timeoutMs, DEFAULT_PARENT_LIMITS.timeoutMs, 24 * 60 * 60 * 1000);
    this.#unsubscribeRuntime = typeof runtime.onEvent === "function"
      ? runtime.onEvent((event, sourceSession) => {
          if (!this.#isCurrentSession(sourceSession)) return;
          this.#onPiEvent(event);
        })
      : () => {};
  }

  get session(): EngineSessionSnapshot {
    const session = this.#runtime.session;
    const model = session.model;
    if (model) this.#knownModels.set(`${model.provider}/${model.id}`, model);
    return {
      id: sessionId(this.#runtime),
      workspace: this.#runtime.currentWorkspace,
      ...(session.sessionFile ? { sessionFile: session.sessionFile } : {}),
      ...(model ? {
        model: {
          provider: model.provider,
          id: model.id,
          ...(model.name ? { name: model.name } : {}),
          capabilities: normalizeModelCapabilities(model),
        },
      } : {}),
      isStreaming: Boolean(session.isStreaming) || this.#promptInFlight,
      ...(this.#promptInFlight ? { isPromptActive: true } : {}),
      isCompacting: Boolean((session as { isCompacting?: boolean }).isCompacting),
      thinkingLevel: typeof session.thinkingLevel === "string" ? session.thinkingLevel : "off",
      availableThinkingLevels: this.#thinkingLevels(session),
      supportsThinking: this.#thinkingLevels(session).some((level) => level !== "off"),
      messagesCount: Array.isArray(session.messages) ? session.messages.length : 0,
      tools: ((session.agent?.state?.tools as Array<{ name?: unknown }> | undefined) ?? [])
        .map((tool) => typeof tool.name === "string" ? tool.name : "")
        .filter(Boolean),
    };
  }

  async prompt(input: EnginePromptInput, signal?: AbortSignal): Promise<void> {
    this.#assertAvailable();
    if (signal?.aborted) throw normalizeEngineError(signal.reason, {
      code: "turn_cancelled",
      category: "cancelled",
      message: "操作已取消",
    });
    if (this.#promptInFlight || this.#runtime.session.isStreaming) {
      throw new AgentEngineError({
        code: "turn_in_progress",
        category: "validation",
        retryable: false,
        message: "当前已有任务正在执行，请使用补充或中止操作",
      });
    }
    this.#pendingTurnId = input.turnId?.trim() || this.#turnIdFactory();
    this.#activeTurnId = this.#pendingTurnId;
    this.#terminal = undefined;
    this.#promptInFlight = true;
    this.#turnGuard = { toolCalls: 0, turns: 0, toolFingerprintCounts: new Map() };
    this.#guardTimer = setTimeout(() => {
      this.#tripGuard("turn_timeout", "任务执行超过时间限制");
    }, this.#timeoutMs);
    const onAbort = () => { void this.cancel(this.#activeTurnId); };
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      await (this.#runtime.runWithStableSession ?? (async (operation: () => Promise<void>) => operation())).call(this.#runtime, async () => {
        await this.#runtime.session.prompt(input.message);
      });
      if (this.#turnGuard?.error) throw this.#turnGuard.error;
    } catch (error) {
      if (!this.#terminal) {
        const normalized = normalizeEngineError(error, {
          code: "prompt_failed",
          category: "provider",
          retryable: true,
          message: "发送消息失败",
        });
        this.#terminal = "turn.failed";
        this.#emit({ ...this.#base(), type: "turn.failed", error: normalized.toJSON() });
      }
      throw error;
    } finally {
      if (this.#guardTimer !== undefined) clearTimeout(this.#guardTimer);
      this.#guardTimer = undefined;
      this.#turnGuard = undefined;
      this.#promptInFlight = false;
      signal?.removeEventListener("abort", onAbort);
    }
  }

  async steer(text: string): Promise<void> {
    await (this.#runtime.runWithStableSession ?? (async (operation: () => Promise<void>) => operation())).call(this.#runtime, async () => { await this.#runtime.session.steer(text); });
  }

  async followUp(text: string): Promise<void> {
    await (this.#runtime.runWithStableSession ?? (async (operation: () => Promise<void>) => operation())).call(this.#runtime, async () => { await this.#runtime.session.followUp(text); });
  }

  async cancel(turnId?: string): Promise<boolean> {
    const streaming = Boolean(this.#runtime.session.isStreaming);
    if (this.#terminal || (turnId && this.#activeTurnId && turnId !== this.#activeTurnId)) return false;
    if (!this.#activeTurnId && !streaming) {
      this.#runtime.session.abort();
      return true;
    }
    if (!this.#activeTurnId) this.#activeTurnId = turnId || this.#turnIdFactory();
    this.#runtime.session.abort();
    this.#terminal = "turn.cancelled";
    this.#emit({ ...this.#base(), type: "turn.cancelled", reason: "cancelled_by_user" });
    return true;
  }

  async compact(focus?: string): Promise<void> {
    const session = this.#runtime.session as {
      compact?: (focus?: string) => Promise<unknown>;
    };
    if (!session.compact) throw new AgentEngineError({ code: "compaction_unsupported", category: "validation", retryable: false, message: "当前会话不支持上下文压缩" });
    await session.compact(focus);
  }

  async switchWorkspace(workspace: string): Promise<void> {
    await this.#runtime.switchWorkspace(workspace);
    this.#resetTurn();
    this.#emitSessionChanged();
  }

  async openSession(sessionFile: string, workspace: string): Promise<void> {
    await this.#runtime.openSession(sessionFile, workspace);
    this.#resetTurn();
    this.#emitSessionChanged();
  }

  async createNewSession(): Promise<string> {
    const id = await this.#runtime.createNewSession();
    this.#resetTurn();
    this.#emitSessionChanged();
    return id;
  }

  async setModel(provider: string, modelId: string): Promise<void> {
    const model = this.#runtime.modelRegistry.find(provider, modelId);
    if (!model) throw new AgentEngineError({ code: "model_not_found", category: "validation", retryable: false, message: "未找到指定模型" });
    const known = this.#knownModels.get(`${provider}/${modelId}`);
    await this.#runtime.session.setModel((known ?? model) as never);
    this.#knownModels.set(`${provider}/${modelId}`, known ?? model);
    this.#emitSessionChanged();
  }

  async setThinkingLevel(level: string): Promise<void> {
    await Promise.resolve(this.#runtime.session.setThinkingLevel(level as never));
  }

  syncModelProviders(): Promise<number> {
    return typeof this.#runtime.syncModelProviders === "function"
      ? this.#runtime.syncModelProviders()
      : Promise.resolve(0);
  }

  getUsage(): EngineUsage | undefined {
    return usageFromContext(this.#runtime.getContextUsageSnapshot());
  }

  getContextUsage(): EngineContextUsage | undefined {
    const usage = this.#runtime.getContextUsageSnapshot();
    if (!usage) return undefined;
    return {
      tokens: usage.tokens,
      contextWindow: usage.contextWindow,
      percent: usage.percent,
      source: usage.source,
      ...(typeof usage.exactTokens === "number" ? { exactTokens: usage.exactTokens } : {}),
      ...(typeof usage.estimatedTokens === "number" ? { estimatedTokens: usage.estimatedTokens } : {}),
    };
  }

  getSessionStats(): EngineSessionStats | undefined {
    const session = this.#runtime.session as unknown as {
      getSessionStats?: () => {
        tokens?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number };
        cost?: number;
      };
      sessionManager?: { getBranch?: () => Array<Record<string, unknown>> };
    };
    const stats = session.getSessionStats?.();
    if (!stats) return undefined;
    const tokens = stats.tokens ?? {};
    let compactCount = 0;
    let lastCompactionAt: string | null = null;
    let lastCompactionSummary: string | null = null;
    for (const entry of session.sessionManager?.getBranch?.() ?? []) {
      if (entry.type !== "compaction") continue;
      compactCount += 1;
      lastCompactionAt = typeof entry.timestamp === "string" ? entry.timestamp : null;
      lastCompactionSummary = typeof entry.summary === "string" ? entry.summary : null;
    }
    return {
      usage: {
        input: Number(tokens.input) || 0,
        output: Number(tokens.output) || 0,
        cacheRead: Number(tokens.cacheRead) || 0,
        cacheWrite: Number(tokens.cacheWrite) || 0,
        reasoning: 0,
        source: "exact",
        cost: typeof stats.cost === "number" && Number.isFinite(stats.cost)
          ? { status: "known", amount: stats.cost, currency: "USD" }
          : { status: "unknown" },
      },
      compactCount,
      lastCompactionAt,
      lastCompactionSummary,
    };
  }

  subscribe(listener: (event: EngineEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#unsubscribeRuntime();
    this.#listeners.clear();
    this.#runtime.dispose();
  }

  #onPiEvent(raw: unknown): void {
    const type = raw && typeof raw === "object" && typeof (raw as { type?: unknown }).type === "string"
      ? (raw as { type: string }).type
      : "unknown";
    if (type === "agent_start") {
      this.#activeTurnId = this.#pendingTurnId || this.#turnIdFactory();
      this.#pendingTurnId = "";
      this.#terminal = undefined;
      this.#assistantMessageSeq = 0;
      this.#seenAssistantContent.clear();
    }
    if (type === "turn_end" && this.#turnGuard) {
      this.#turnGuard.turns += 1;
      if (this.#turnGuard.turns >= this.#maxTurns) {
        this.#tripGuard("turn_limit", "任务步骤超过限制，已自动停止");
      }
    }
    if (type === "tool_execution_start" && this.#turnGuard) {
      this.#turnGuard.toolCalls += 1;
      const event = raw as { toolName?: unknown; args?: unknown };
      let args = "";
      try { args = JSON.stringify(event.args ?? null); } catch { args = "[unserializable]"; }
      const fingerprint = `${typeof event.toolName === "string" ? event.toolName : "unknown"}:${args}`;
      const fingerprintCount = (this.#turnGuard.toolFingerprintCounts.get(fingerprint) ?? 0) + 1;
      this.#turnGuard.toolFingerprintCounts.set(fingerprint, fingerprintCount);
      if (this.#turnGuard.toolCalls >= this.#maxToolCalls) {
        this.#tripGuard("turn_tool_limit", "工具调用次数超过限制，已自动停止");
      } else if (fingerprintCount >= this.#maxRepeatedToolCalls) {
        this.#tripGuard("turn_repeated_tool", "检测到同一工具调用反复重复，已自动停止");
      }
    }
    if (type === "message_start" && (raw as { message?: { role?: unknown } } | undefined)?.message?.role === "assistant") {
      this.#assistantMessageSeq += 1;
    }
    const base = { ...this.#base(), ...(this.#assistantMessageSeq > 0 ? { messageSeq: this.#assistantMessageSeq } : {}) };
    const mapping = mapPiEvent(raw, {
      base,
      contextUsage: this.#runtime.getContextUsageSnapshot(),
      compactionBefore: this.#compactionBefore,
    });
    if (type === "compaction_start") this.#compactionBefore = mapping.compactionBefore;
    if (type === "compaction_end") this.#compactionBefore = undefined;

    if (mapping.terminal) {
      if (this.#terminal) return;
      this.#terminal = mapping.terminal;
    }
    for (const mappedEvent of mapping.events) {
      let event = mappedEvent;
      if (event.type === "content.delta" || event.type === "thinking.delta") {
        const index = event.contentIndex === undefined ? "*" : String(event.contentIndex);
        const key = `${event.messageSeq ?? 0}:${event.type}:${index}`;
        // Providers in the wild omit *_start. Synthesize it only for the first
        // segment; subsequent deltas must still target an open node.
        if (event.phase === "delta" && !this.#seenAssistantContent.has(key)) {
          event = { ...event, phase: "start" };
        }
        this.#seenAssistantContent.add(key);
      }
      this.#emit(event);
    }
  }

  #base(): EngineEventBase {
    return {
      version: ENGINE_EVENT_VERSION,
      type: "diagnostic",
      sessionId: sessionId(this.#runtime),
      turnId: this.#activeTurnId,
      seq: this.#seq + 1,
      timestamp: this.#clock(),
    };
  }

  #emit(event: EngineEvent): void {
    const normalized = normalizeEngineEvent({ ...event, seq: ++this.#seq } as EngineEvent);
    for (const listener of [...this.#listeners]) {
      try { listener(normalized); } catch {}
    }
  }

  #emitSessionChanged(): void {
    this.#emit({ ...this.#base(), type: "session.changed", turnId: "", session: this.session });
  }

  #isCurrentSession(sourceSession: unknown): boolean {
    if (!sourceSession) return true;
    try { return this.#runtime.session === sourceSession; } catch { return false; }
  }

  #resetTurn(): void {
    this.#activeTurnId = "";
    this.#pendingTurnId = "";
    this.#terminal = undefined;
    this.#compactionBefore = undefined;
    this.#assistantMessageSeq = 0;
    this.#seenAssistantContent.clear();
  }

  #tripGuard(code: "turn_timeout" | "turn_limit" | "turn_tool_limit" | "turn_repeated_tool", message: string): void {
    const guard = this.#turnGuard;
    if (!guard || guard.error || this.#terminal) return;
    guard.error = new AgentEngineError({ code, category: "validation", retryable: false, message });
    this.#terminal = "turn.failed";
    this.#emit({ ...this.#base(), type: "turn.failed", error: guard.error.toJSON() });
    try { this.#runtime.session.abort(); } catch { /* PI abort is best effort. */ }
  }

  #assertAvailable(): void {
    if (this.#disposed) throw new AgentEngineError({ code: "engine_disposed", category: "internal", retryable: false, message: "AgentEngine 已释放" });
  }

  #thinkingLevels(session: RuntimeLike["session"]): string[] {
    const levels = (session as { getAvailableThinkingLevels?: () => unknown }).getAvailableThinkingLevels?.();
    const values = Array.isArray(levels) ? levels.filter((level): level is string => typeof level === "string") : ["low", "medium", "high"];
    return ["off", ...values.filter((level) => level !== "off")];
  }
}
