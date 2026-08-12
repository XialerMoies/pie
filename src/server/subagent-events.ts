import type { ChatStreamState } from "./routes/types.js";
import { writeChatEvent } from "./chat-stream.js";

export const MAX_SUBAGENT_EVENT_PAYLOAD_BYTES = 8 * 1024;
export const MAX_SUBAGENT_PROGRESS_EVENTS_PER_BATCH = 200;
export const MAX_SUBAGENT_REPLAY_EVENTS = 512;

export type SubagentTaskTerminalStatus =
  | "completed"
  | "failed"
  | "aborted"
  | "timed_out"
  | "limit_reached";

export type SubagentBatchTerminalStatus = "completed" | "partial" | "failed" | "aborted";
export type SubagentEventStatus =
  | "queued"
  | "running"
  | SubagentTaskTerminalStatus
  | SubagentBatchTerminalStatus;

export type SubagentEventKind =
  | "batch_started"
  | "task_queued"
  | "task_started"
  | "task_progress"
  | "task_completed"
  | "batch_completed";

export interface SubagentEvent {
  type: "subagent_event";
  protocolVersion: 1;
  parentToolCallId: string;
  batchId: string;
  taskId: string | null;
  seq: number;
  kind: SubagentEventKind;
  status: SubagentEventStatus;
  timestamp: string;
  payload: Record<string, unknown>;
}

export interface CreateSubagentEventInput extends Omit<SubagentEvent, "type" | "payload"> {
  payload?: unknown;
}

export type SubagentReplayStatus = SubagentEventStatus | "interrupted";

export interface SubagentReplayTask {
  taskId: string;
  status: SubagentReplayStatus;
  events: SubagentEvent[];
}

export interface SubagentReplayBatch {
  batchId: string;
  parentToolCallId: string;
  status: SubagentReplayStatus;
  events: SubagentEvent[];
  tasks: SubagentReplayTask[];
}

export interface SubagentEventReplay {
  batches: SubagentReplayBatch[];
}

interface SubagentEventSinkRuntime {
  session?: {
    sessionManager?: {
      appendCustomEntry?: (customType: string, data?: unknown) => unknown;
    };
  };
}

export interface SubagentEventSinkOptions {
  runtime: SubagentEventSinkRuntime;
  chatStream: ChatStreamState;
  warn?: (message: string) => void;
}

const TASK_TERMINAL = new Set<SubagentEventStatus>([
  "completed",
  "failed",
  "aborted",
  "timed_out",
  "limit_reached",
]);

const BATCH_TERMINAL = new Set<SubagentEventStatus>([
  "completed",
  "partial",
  "failed",
  "aborted",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function hasValidKindStatus(
  kind: SubagentEventKind,
  status: SubagentEventStatus,
  taskId: string | null,
): boolean {
  if (kind === "batch_started") return taskId === null && status === "running";
  if (kind === "batch_completed") return taskId === null && BATCH_TERMINAL.has(status);
  if (!taskId) return false;
  if (kind === "task_queued") return status === "queued";
  if (kind === "task_started" || kind === "task_progress") return status === "running";
  return kind === "task_completed" && TASK_TERMINAL.has(status);
}

export function isSubagentEvent(value: unknown): value is SubagentEvent {
  if (!isRecord(value) || value.type !== "subagent_event") return false;
  if (value.protocolVersion !== 1) return false;
  if (typeof value.parentToolCallId !== "string" || !value.parentToolCallId) return false;
  if (typeof value.batchId !== "string" || !value.batchId) return false;
  if (value.taskId !== null && (typeof value.taskId !== "string" || !value.taskId)) return false;
  if (!Number.isSafeInteger(value.seq) || (value.seq as number) < 1) return false;
  if (typeof value.kind !== "string" || ![
    "batch_started",
    "task_queued",
    "task_started",
    "task_progress",
    "task_completed",
    "batch_completed",
  ].includes(value.kind)) return false;
  if (typeof value.status !== "string" || ![
    "queued",
    "running",
    "completed",
    "partial",
    "failed",
    "aborted",
    "timed_out",
    "limit_reached",
  ].includes(value.status)) return false;
  if (typeof value.timestamp !== "string" || !Number.isFinite(Date.parse(value.timestamp))) return false;
  if (!isRecord(value.payload)) return false;
  return hasValidKindStatus(
    value.kind as SubagentEventKind,
    value.status as SubagentEventStatus,
    value.taskId as string | null,
  );
}

export function createSubagentEvent(input: CreateSubagentEventInput): SubagentEvent {
  const event: SubagentEvent = {
    type: "subagent_event",
    protocolVersion: input.protocolVersion,
    parentToolCallId: input.parentToolCallId,
    batchId: input.batchId,
    taskId: input.taskId,
    seq: input.seq,
    kind: input.kind,
    status: input.status,
    timestamp: input.timestamp,
    payload: boundPayload(input.payload),
  };
  if (!isSubagentEvent(event)) throw new Error("Invalid subagent_event");
  return event;
}

export function createSubagentEventSink(options: SubagentEventSinkOptions): (event: SubagentEvent) => void {
  const warn = options.warn ?? ((message: string) => console.warn(message));
  const sessionManager = options.runtime.session?.sessionManager;
  const progressCounts = new Map<string, number>();
  return (event): void => {
    if (!isSubagentEvent(event)) {
      warn("[subagent] ignored invalid subagent_event");
      return;
    }

    let shouldPersist = true;
    if (event.kind === "task_progress") {
      const count = progressCounts.get(event.batchId) ?? 0;
      shouldPersist = count < MAX_SUBAGENT_PROGRESS_EVENTS_PER_BATCH;
      if (shouldPersist) progressCounts.set(event.batchId, count + 1);
    }

    writeChatEvent(options.chatStream, { type: "subagent_event", event });
    if (shouldPersist) {
      try {
        const append = sessionManager?.appendCustomEntry;
        if (typeof append !== "function") throw new Error("session manager does not support custom entries");
        const persisted = append.call(sessionManager, "subagent_event", event);
        if (persisted && typeof (persisted as PromiseLike<unknown>).then === "function") {
          void Promise.resolve(persisted).catch((error) => warnPersistenceFailure(warn, error));
        }
      } catch (error) {
        warnPersistenceFailure(warn, error);
      }
    }
    if (event.kind === "batch_completed") progressCounts.delete(event.batchId);
  };
}

export function reduceSubagentEventReplay(
  entries: readonly unknown[],
  options: { activeTaskIds?: Iterable<string> } = {},
): SubagentEventReplay {
  const activeTaskIds = new Set(options.activeTaskIds ?? []);
  const unique = new Map<string, SubagentEvent>();
  for (const entry of entries) {
    const event = unwrapSubagentEvent(entry);
    if (!event) continue;
    const key = `${event.batchId}\u0000${event.taskId ?? "<batch>"}\u0000${event.seq}`;
    if (!unique.has(key)) unique.set(key, event);
  }

  const grouped = new Map<string, SubagentEvent[]>();
  for (const event of unique.values()) {
    const events = grouped.get(event.batchId) ?? [];
    events.push(event);
    grouped.set(event.batchId, events);
  }

  const batches = [...grouped.entries()].map(([batchId, sourceEvents]) => {
    const events = boundReplayEvents(sourceEvents.sort(compareEvents));
    const taskEvents = new Map<string, SubagentEvent[]>();
    for (const event of events) {
      if (!event.taskId) continue;
      const current = taskEvents.get(event.taskId) ?? [];
      current.push(event);
      taskEvents.set(event.taskId, current);
    }

    const terminal = [...events].reverse().find((event) => event.kind === "batch_completed");
    const started = events.some((event) => event.kind === "batch_started");
    const hasActiveTask = [...taskEvents.keys()].some((taskId) => activeTaskIds.has(taskId));
    const interrupted = started && !terminal && !hasActiveTask;
    const tasks = [...taskEvents.entries()].map(([taskId, taskHistory]) => {
      const last = taskHistory[taskHistory.length - 1];
      const status = interrupted && !TASK_TERMINAL.has(last.status) ? "interrupted" : last.status;
      return { taskId, status, events: taskHistory } satisfies SubagentReplayTask;
    });

    return {
      batchId,
      parentToolCallId: events[0]?.parentToolCallId ?? "",
      status: terminal?.status ?? (interrupted ? "interrupted" : "running"),
      events,
      tasks,
    } satisfies SubagentReplayBatch;
  });

  batches.sort((left, right) => compareEvents(left.events[0], right.events[0]));
  return { batches };
}

function unwrapSubagentEvent(entry: unknown): SubagentEvent | undefined {
  if (isSubagentEvent(entry)) return entry;
  if (!isRecord(entry) || entry.customType !== "subagent_event") return undefined;
  return isSubagentEvent(entry.data) ? entry.data : undefined;
}

function compareEvents(left: SubagentEvent | undefined, right: SubagentEvent | undefined): number {
  if (!left) return right ? -1 : 0;
  if (!right) return 1;
  if (left.batchId !== right.batchId) return left.timestamp.localeCompare(right.timestamp);
  if (left.seq !== right.seq) return left.seq - right.seq;
  return (left.taskId ?? "").localeCompare(right.taskId ?? "");
}

function boundReplayEvents(events: SubagentEvent[]): SubagentEvent[] {
  if (events.length <= MAX_SUBAGENT_REPLAY_EVENTS) return events;
  const lifecycle = events.filter((event) => event.kind !== "task_progress");
  const lifecycleKeys = new Set(lifecycle.map(eventIdentity));
  const available = Math.max(0, MAX_SUBAGENT_REPLAY_EVENTS - lifecycle.length);
  const progress = events
    .filter((event) => !lifecycleKeys.has(eventIdentity(event)))
    .slice(-available);
  return [...lifecycle, ...progress].sort(compareEvents).slice(-MAX_SUBAGENT_REPLAY_EVENTS);
}

function eventIdentity(event: SubagentEvent): string {
  return `${event.taskId ?? "<batch>"}\u0000${event.seq}`;
}

function boundPayload(value: unknown): Record<string, unknown> {
  const normalized = normalizePayload(value, 0);
  const record = isRecord(normalized) ? normalized : { value: normalized };
  if (payloadBytes(record) <= MAX_SUBAGENT_EVENT_PAYLOAD_BYTES) return record;

  const serialized = JSON.stringify(record);
  const payload: Record<string, unknown> = { truncated: true, preview: "" };
  const overhead = payloadBytes(payload);
  payload.preview = truncateUtf8(serialized, MAX_SUBAGENT_EVENT_PAYLOAD_BYTES - overhead - 8);
  while (payloadBytes(payload) > MAX_SUBAGENT_EVENT_PAYLOAD_BYTES && payload.preview) {
    payload.preview = (payload.preview as string).slice(0, -1);
  }
  return payload;
}

function normalizePayload(value: unknown, depth: number): unknown {
  if (depth >= 5) return "[depth-truncated]";
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : String(value);
  if (typeof value === "string") return value.length <= 2048 ? value : `${value.slice(0, 2048)}...[truncated]`;
  if (Array.isArray(value)) return value.slice(0, 32).map((item) => normalizePayload(item, depth + 1));
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).slice(0, 32).map(([key, item]) => [key, normalizePayload(item, depth + 1)]),
    );
  }
  return value === undefined ? null : String(value);
}

function payloadBytes(payload: Record<string, unknown>): number {
  return Buffer.byteLength(JSON.stringify(payload), "utf8");
}

function truncateUtf8(value: string, maximumBytes: number): string {
  if (maximumBytes <= 0) return "";
  let result = "";
  let size = 0;
  for (const character of value) {
    const next = Buffer.byteLength(character, "utf8");
    if (size + next > maximumBytes) break;
    result += character;
    size += next;
  }
  return result;
}

function warnPersistenceFailure(warn: (message: string) => void, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  warn(`[subagent] failed to persist subagent_event: ${message}`);
}
