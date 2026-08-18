import type {
  EngineErrorInfo,
  EngineEvent,
  EngineEventBase,
  EngineTerminalEvent,
  EngineUsage,
  UsageSource,
} from "./contracts.js";
import { normalizeEngineUsage } from "./contracts.js";

export interface PiEventContext {
  base: EngineEventBase;
  contextUsage?: {
    tokens: number | null;
    source: UsageSource;
  };
  compactionBefore?: EngineUsage;
}

export interface PiEventMapping {
  events: EngineEvent[];
  terminal?: EngineTerminalEvent;
  compactionBefore?: EngineUsage;
  recognized: boolean;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function number(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

export function usageFromPi(value: unknown, source: UsageSource = "exact"): EngineUsage | undefined {
  const usage = record(value);
  if (!usage) return undefined;
  const cost = record(usage.cost);
  const amount = number(cost?.total ?? usage.cost);
  return normalizeEngineUsage({
    input: number(usage.input),
    output: number(usage.output),
    cacheRead: number(usage.cacheRead),
    cacheWrite: number(usage.cacheWrite),
    reasoning: number(usage.reasoning),
    source,
    cost: amount === undefined
      ? { status: "unknown" }
      : { status: "known", amount, currency: "USD" },
  });
}

export function usageFromContext(value: PiEventContext["contextUsage"]): EngineUsage | undefined {
  if (!value || value.tokens === null) return undefined;
  return normalizeEngineUsage({
    input: value.tokens,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    reasoning: 0,
    source: value.source,
    cost: { status: "unknown" },
  });
}

function publicError(code: string, category: EngineErrorInfo["category"], message: string, retryable = false): EngineErrorInfo {
  return { code, category, message, retryable };
}

function lastAssistantMessage(event: Record<string, unknown>): Record<string, unknown> | undefined {
  const messages = Array.isArray(event.messages) ? event.messages : [];
  return [...messages].reverse().map(record).find((message) => message?.role === "assistant");
}

const QUIET_PI_EVENTS = new Set([
  "message_start",
  "message_end",
  "turn_start",
  "turn_end",
]);

export function mapPiEvent(raw: unknown, context: PiEventContext): PiEventMapping {
  const event = record(raw);
  const type = typeof event?.type === "string" ? event.type : "unknown";
  const base = context.base;

  if (type === "agent_start") {
    return { events: [{ ...base, type: "turn.started" }], recognized: true };
  }
  if (type === "message_update") {
    const increment = record(event?.assistantMessageEvent);
    const delta = typeof increment?.delta === "string" ? increment.delta : "";
    if (increment?.type === "text_delta" && delta) {
      return { events: [{ ...base, type: "content.delta", text: delta }], recognized: true };
    }
    if (increment?.type === "thinking_delta" && delta) {
      return { events: [{ ...base, type: "thinking.delta", text: delta }], recognized: true };
    }
    return { events: [], recognized: true };
  }
  if (type === "tool_execution_start") {
    return {
      events: [{
        ...base,
        type: "tool.started",
        toolCallId: String(event?.toolCallId ?? ""),
        name: String(event?.toolName ?? "unknown"),
        ...(event?.args === undefined ? {} : { input: event.args }),
      }],
      recognized: true,
    };
  }
  if (type === "tool_execution_update") {
    return {
      events: [{
        ...base,
        type: "tool.updated",
        toolCallId: String(event?.toolCallId ?? ""),
        name: String(event?.toolName ?? "unknown"),
        output: typeof event?.partialResult === "string" ? event.partialResult : String(event?.partialResult ?? ""),
      }],
      recognized: true,
    };
  }
  if (type === "tool_execution_end") {
    const common = {
      ...base,
      toolCallId: String(event?.toolCallId ?? ""),
      name: String(event?.toolName ?? "unknown"),
      ...(record(event?.metadata) ? { metadata: record(event?.metadata) } : {}),
    };
    return event?.isError === true
      ? {
          events: [{
            ...common,
            type: "tool.failed",
            error: publicError("tool_failed", "internal", "工具执行失败"),
          }],
          recognized: true,
        }
      : {
          events: [{
            ...common,
            type: "tool.completed",
            ...(typeof event?.result === "string" ? { output: event.result } : {}),
          }],
          recognized: true,
        };
  }
  if (type === "queue_update") {
    return {
      events: [{
        ...base,
        type: "queue.updated",
        steering: Array.isArray(event?.steering) ? event.steering.filter((item): item is string => typeof item === "string") : [],
        followUp: Array.isArray(event?.followUp) ? event.followUp.filter((item): item is string => typeof item === "string") : [],
      }],
      recognized: true,
    };
  }
  if (type === "compaction_start") {
    const before = usageFromContext(context.contextUsage);
    return {
      events: [{ ...base, type: "compaction.started", ...(before ? { before } : {}) }],
      compactionBefore: before,
      recognized: true,
    };
  }
  if (type === "compaction_end") {
    const failed = typeof event?.errorMessage === "string" || event?.aborted === true;
    if (failed) {
      return {
        events: [{
          ...base,
          type: "compaction.failed",
          error: publicError("compaction_failed", "internal", "上下文压缩失败", true),
        }],
        recognized: true,
      };
    }
    const after = usageFromContext(context.contextUsage);
    return {
      events: [{
        ...base,
        type: "compaction.completed",
        ...(context.compactionBefore ? { before: context.compactionBefore } : {}),
        ...(after ? { after } : {}),
      }],
      recognized: true,
    };
  }
  if (type === "agent_end") {
    const message = lastAssistantMessage(event ?? {});
    const usage = usageFromPi(message?.usage);
    const stopReason = message?.stopReason;
    const usageEvent: EngineEvent[] = usage ? [{ ...base, type: "usage.updated", usage }] : [];
    if (stopReason === "aborted") {
      return { events: [...usageEvent, { ...base, type: "turn.cancelled", reason: "aborted" }], terminal: "turn.cancelled", recognized: true };
    }
    if (stopReason === "error" || typeof message?.errorMessage === "string") {
      return {
        events: [...usageEvent, {
          ...base,
          type: "turn.failed",
          error: publicError("turn_failed", "provider", "模型响应失败", true),
        }],
        terminal: "turn.failed",
        recognized: true,
      };
    }
    return {
      events: [...usageEvent, { ...base, type: "turn.completed", ...(usage ? { usage } : {}) }],
      terminal: "turn.completed",
      recognized: true,
    };
  }
  if (QUIET_PI_EVENTS.has(type)) return { events: [], recognized: true };

  const safeType = type.slice(0, 80).replace(/[^A-Za-z0-9_.:-]/g, "?");
  return {
    events: [{
      ...base,
      type: "diagnostic",
      level: "warning",
      code: "pi_event_ignored",
      message: `忽略未识别的 PI 事件: ${safeType}`,
    }],
    recognized: false,
  };
}
