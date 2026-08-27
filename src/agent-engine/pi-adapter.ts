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
import type { PlanStateSnapshot, PlanStateTarget } from "../agent/plan-state.js";

export interface PiAgentEngineAdapterOptions {
  id?: string;
  clock?: () => number;
  turnId?: () => string;
}

type RuntimeLike = Pick<
  AgentRuntime,
  | "currentWorkspace"
  | "session"
  | "findModel"
  | "onEvent"
  | "getContextUsageSnapshot"
  | "runWithStableSession"
  | "switchWorkspace"
  | "openSession"
  | "createNewSession"
  | "switchProfile"
  | "activeProfile"
  | "activeProfileLifecycle"
  | "activeComponentGeneration"
  | "planState"
  | "onPlanStateChange"
  | "requestPlanState"
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
  readonly #listeners = new Set<(event: EngineEvent) => void>();
  readonly #unsubscribeRuntime: () => void;
  readonly #unsubscribePlanState: () => void;
  #seq = 0;
  #activeTurnId = "";
  #pendingTurnId = "";
  #terminal?: EngineTerminalEvent;
  #compactionBefore?: EngineUsage;
  #assistantMessageSeq = 0;
  readonly #seenAssistantContent = new Set<string>();
  #disposed = false;
  readonly #knownModels = new Map<string, unknown>();

  constructor(runtime: RuntimeLike, options: PiAgentEngineAdapterOptions = {}) {
    this.#runtime = runtime;
    this.id = options.id ?? randomUUID();
    this.#clock = options.clock ?? Date.now;
    this.#turnIdFactory = options.turnId ?? randomUUID;
    this.#unsubscribeRuntime = typeof runtime.onEvent === "function"
      ? runtime.onEvent((event, sourceSession) => {
          if (!this.#isCurrentSession(sourceSession)) return;
          this.#onPiEvent(event);
        })
      : () => {};
    this.#unsubscribePlanState = typeof runtime.onPlanStateChange === "function"
      ? runtime.onPlanStateChange((state) => {
          this.#emit({ ...this.#base(), type: "plan.changed", turnId: "", state });
        })
      : () => {};
  }

  get session(): EngineSessionSnapshot {
    const session = this.#runtime.session;
    const model = session.model;
    const profile = this.#runtime.activeProfile ?? { id: "standard", revision: 1 };
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
      isStreaming: Boolean(session.isStreaming),
      isCompacting: Boolean((session as { isCompacting?: boolean }).isCompacting),
      thinkingLevel: typeof session.thinkingLevel === "string" ? session.thinkingLevel : "off",
      availableThinkingLevels: this.#thinkingLevels(session),
      supportsThinking: this.#thinkingLevels(session).some((level) => level !== "off"),
      messagesCount: Array.isArray(session.messages) ? session.messages.length : 0,
      tools: ((session.agent?.state?.tools as Array<{ name?: unknown }> | undefined) ?? [])
        .map((tool) => typeof tool.name === "string" ? tool.name : "")
        .filter(Boolean),
      profile: { ...profile },
      ...(this.#runtime.activeComponentGeneration ? { components: this.#runtime.activeComponentGeneration } : {}),
      planState: this.#runtime.planState,
      ...(this.#runtime.activeProfileLifecycle ? { profileLifecycle: this.#runtime.activeProfileLifecycle } : {}),
    };
  }

  async prompt(input: EnginePromptInput, signal?: AbortSignal): Promise<void> {
    this.#assertAvailable();
    if (signal?.aborted) throw normalizeEngineError(signal.reason, {
      code: "turn_cancelled",
      category: "cancelled",
      message: "操作已取消",
    });
    this.#pendingTurnId = input.turnId?.trim() || this.#turnIdFactory();
    this.#activeTurnId = this.#pendingTurnId;
    this.#terminal = undefined;
    const onAbort = () => { void this.cancel(this.#activeTurnId); };
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      await (this.#runtime.runWithStableSession ?? (async (operation: () => Promise<void>) => operation())).call(this.#runtime, async () => {
        await this.#runtime.session.prompt(input.message);
      });
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

  async openSession(sessionFile: string, workspace: string, lifecycleAction: "resume" | "fork" = "resume"): Promise<void> {
    await this.#runtime.openSession(sessionFile, workspace, lifecycleAction);
    this.#resetTurn();
    this.#emitSessionChanged();
  }

  async createNewSession(profileId?: string): Promise<string> {
    const id = await this.#runtime.createNewSession(profileId);
    this.#resetTurn();
    this.#emitSessionChanged();
    return id;
  }

  async switchProfile(profileId: string): Promise<{ id: string; revision: number }> {
    const profile = await this.#runtime.switchProfile(profileId);
    this.#resetTurn();
    this.#emitSessionChanged();
    return profile;
  }

  async requestPlanState(target: PlanStateTarget): Promise<PlanStateSnapshot> {
    return this.#runtime.requestPlanState(target);
  }

  async setModel(provider: string, modelId: string): Promise<void> {
    const model = this.#runtime.findModel(provider, modelId);
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
    this.#unsubscribePlanState();
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

  #assertAvailable(): void {
    if (this.#disposed) throw new AgentEngineError({ code: "engine_disposed", category: "internal", retryable: false, message: "AgentEngine 已释放" });
  }

  #thinkingLevels(session: RuntimeLike["session"]): string[] {
    const levels = (session as { getAvailableThinkingLevels?: () => unknown }).getAvailableThinkingLevels?.();
    const values = Array.isArray(levels) ? levels.filter((level): level is string => typeof level === "string") : ["low", "medium", "high"];
    return ["off", ...values.filter((level) => level !== "off")];
  }
}

/** Named host implementation used by production wiring. The adapter alias is
 * retained for callers and fixtures that still use the migration name. */
export class PiAgentEngine extends PiAgentEngineAdapter {}
