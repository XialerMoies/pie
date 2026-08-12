import { randomUUID } from "node:crypto";
import type {
  SubagentDelegationBatchResult,
  SubagentDelegationBatchResultStatus,
  SubagentDelegationModel,
  SubagentDelegationProfile,
  SubagentDelegationTask,
  SubagentDelegationTaskResult,
  SubagentDelegationTaskResultStatus,
  SubagentDelegationUsage,
} from "../agent/types.js";
import {
  createSubagentEvent,
  type SubagentEvent,
  type SubagentEventKind,
  type SubagentEventStatus,
} from "./subagent-events.js";

export type {
  SubagentDelegationBatchResult,
  SubagentDelegationBatchResultStatus,
  SubagentDelegationModel,
  SubagentDelegationProfile,
  SubagentDelegationTask,
  SubagentDelegationTaskResult,
  SubagentDelegationTaskResultStatus,
  SubagentDelegationUsage,
} from "../agent/types.js";

export const READ_ONLY_SUBAGENT_TOOLS = [
  "git-status",
  "search",
  "file_read",
  "explorer_list",
  "git_log",
  "file_outline",
] as const;

export type SubagentTaskStatus = "queued" | "running" | SubagentDelegationTaskResultStatus;

export type SubagentBatchStatus = "running" | SubagentDelegationBatchResultStatus;

export type SubagentModelRef = SubagentDelegationModel;

export type SubagentProfile = SubagentDelegationProfile;

export interface SubagentTaskInput extends Omit<SubagentDelegationTask, "profile"> {
  profile?: SubagentProfile;
}

export interface SubagentLimits {
  timeoutSeconds: number;
  maxTurns: number;
  maxToolCalls: number;
}

export type SubagentUsage = SubagentDelegationUsage;

export type SubagentTaskResult = SubagentDelegationTaskResult;

export type SubagentBatchResult = SubagentDelegationBatchResult;

interface SubagentSessionEvent {
  type?: string;
  message?: unknown;
}

interface SubagentSession {
  messages?: unknown[];
  subscribe(listener: (event: SubagentSessionEvent) => void): () => void;
  prompt(prompt: string): Promise<unknown>;
  abort(): Promise<unknown> | unknown;
  dispose(): Promise<unknown> | unknown;
}

export interface SubagentSessionFactoryOptions {
  batchId: string;
  taskId: string;
  workspace: string;
  task: SubagentTaskInput;
  model?: SubagentModelRef;
  tools: readonly string[];
  limits: SubagentLimits;
}

export type SubagentSessionFactory = (
  options: SubagentSessionFactoryOptions,
) => Promise<SubagentSession> | SubagentSession;

interface TimerApi {
  setTimeout(callback: () => void, delay: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface SubagentSupervisorOptions {
  sessionFactory: SubagentSessionFactory;
  timers?: TimerApi;
  onEvent?: (event: SubagentEvent) => void;
}

export interface StartSubagentBatchOptions {
  workspace: string;
  parentToolCallId?: string;
  tasks: SubagentTaskInput[];
  maxConcurrent?: number;
  timeoutSeconds?: number;
  maxTurns?: number;
  maxToolCalls?: number;
  model?: SubagentModelRef;
  onEvent?: (event: SubagentEvent) => void;
}

interface TaskHandle {
  batchId: string;
  taskId: string;
  input: SubagentTaskInput;
  status: SubagentTaskStatus;
  limit?: "maxTurns" | "maxToolCalls";
  error?: string;
  session?: SubagentSession;
  unsubscribe?: () => void;
  timeout?: unknown;
  stopPromise?: Promise<void>;
  result?: SubagentTaskResult;
  summary: string;
  findings: string[];
  evidence: string[];
  usage: SubagentUsage;
  completedTurns: number;
  assistantMessages: number;
  seenMessages: Set<object>;
}

interface BatchHandle {
  batchId: string;
  parentToolCallId: string;
  workspace: string;
  taskIds: string[];
  tasks: TaskHandle[];
  queue: TaskHandle[];
  maxConcurrent: number;
  active: number;
  cancelled: boolean;
  status: SubagentBatchStatus;
  limits: SubagentLimits;
  model?: SubagentModelRef;
  result: Promise<SubagentBatchResult>;
  resolveResult: (result: SubagentBatchResult) => void;
  settled: boolean;
  eventSeq: number;
  onEvent?: (event: SubagentEvent) => void;
}

const EMPTY_USAGE = (): SubagentUsage => ({
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  cost: 0,
  turns: 0,
  toolCalls: 0,
});

function clamp(value: number | undefined, fallback: number, minimum: number, maximum: number): number {
  const candidate = Number.isFinite(value) ? Math.trunc(value as number) : fallback;
  return Math.min(maximum, Math.max(minimum, candidate));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function readNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function extractText(message: Record<string, unknown>): string {
  if (typeof message.content === "string") return message.content;
  if (!Array.isArray(message.content)) return "";
  return message.content
    .map((part) => {
      if (!part || typeof part !== "object") return "";
      const text = (part as Record<string, unknown>).text;
      return typeof text === "string" ? text : "";
    })
    .join("");
}

function parseAssistantResult(text: string): {
  summary: string;
  findings: string[];
  evidence: string[];
} {
  const trimmed = text.trim();
  if (!trimmed) return { summary: "", findings: [], evidence: [] };

  let candidate = trimmed;
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fenced) candidate = fenced[1];

  try {
    const parsed = JSON.parse(candidate) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const record = parsed as Record<string, unknown>;
      return {
        summary: typeof record.summary === "string" ? record.summary : "",
        findings: readStringArray(record.findings),
        evidence: readStringArray(record.evidence),
      };
    }
  } catch {
    // Preserve useful partial output when a provider does not return the requested JSON shape.
  }

  return { summary: trimmed, findings: [], evidence: [] };
}

function isAssistantMessage(message: unknown): message is Record<string, unknown> {
  return !!message && typeof message === "object" && (message as Record<string, unknown>).role === "assistant";
}

function terminalStatus(status: SubagentTaskStatus): status is SubagentTaskResult["status"] {
  return status !== "queued" && status !== "running";
}

export class SubagentSupervisor {
  private readonly sessionFactory: SubagentSessionFactory;
  private readonly timers: TimerApi;
  private readonly onEvent?: (event: SubagentEvent) => void;
  private readonly batches = new Map<string, BatchHandle>();
  private readonly tasks = new Map<string, TaskHandle>();
  private disposed = false;
  private disposePromise?: Promise<void>;

  constructor(options: SubagentSupervisorOptions) {
    this.sessionFactory = options.sessionFactory;
    this.onEvent = options.onEvent;
    this.timers = options.timers ?? {
      setTimeout: (callback, delay) => setTimeout(callback, delay),
      clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    };
  }

  startBatch(options: StartSubagentBatchOptions): {
    batchId: string;
    taskIds: string[];
    result: Promise<SubagentBatchResult>;
  } {
    if (this.disposed) throw new Error("SubagentSupervisor has been disposed");

    const batchId = randomUUID();
    let resolveResult!: (result: SubagentBatchResult) => void;
    const result = new Promise<SubagentBatchResult>((resolve) => {
      resolveResult = resolve;
    });
    const tasks = options.tasks.map((sourceInput) => {
      const input = snapshotTaskInput(sourceInput);
      const task: TaskHandle = {
        batchId,
        taskId: randomUUID(),
        input,
        status: "queued",
        summary: "",
        findings: [],
        evidence: [],
        usage: EMPTY_USAGE(),
        completedTurns: 0,
        assistantMessages: 0,
        seenMessages: new Set(),
      };
      this.tasks.set(task.taskId, task);
      return task;
    });
    const batch: BatchHandle = {
      batchId,
      parentToolCallId: options.parentToolCallId ?? batchId,
      workspace: options.workspace,
      taskIds: tasks.map((task) => task.taskId),
      tasks,
      queue: [...tasks],
      maxConcurrent: clamp(options.maxConcurrent, 2, 1, 4),
      active: 0,
      cancelled: false,
      status: "running",
      limits: {
        timeoutSeconds: clamp(options.timeoutSeconds, 300, 30, 3600),
        maxTurns: clamp(options.maxTurns, 20, 1, 100),
        maxToolCalls: clamp(options.maxToolCalls, 50, 1, 500),
      },
      model: options.model,
      result,
      resolveResult,
      settled: false,
      eventSeq: 0,
      onEvent: options.onEvent ?? this.onEvent,
    };
    this.batches.set(batchId, batch);

    this.emitEvent(batch, null, "batch_started", "running", { taskCount: tasks.length });
    for (const task of tasks) {
      this.emitEvent(batch, task.taskId, "task_queued", "queued", {
        profile: task.input.profile ?? "general",
        prompt: task.input.prompt,
        focusPaths: task.input.focusPaths ?? [],
        deliverable: task.input.deliverable ?? "",
        model: task.input.model ?? batch.model ?? null,
      });
    }
    this.pump(batch);
    this.finishBatchIfSettled(batch);
    return { batchId, taskIds: [...batch.taskIds], result };
  }

  getTask(taskId: string): { taskId: string; batchId: string; status: SubagentTaskStatus; limit?: string } | undefined {
    const task = this.tasks.get(taskId);
    if (!task) return undefined;
    return { taskId: task.taskId, batchId: task.batchId, status: task.status, ...(task.limit ? { limit: task.limit } : {}) };
  }

  getBatch(batchId: string): { batchId: string; taskIds: string[]; status: SubagentBatchStatus } | undefined {
    const batch = this.batches.get(batchId);
    if (!batch) return undefined;
    return { batchId, taskIds: [...batch.taskIds], status: batch.status };
  }

  async abortTask(taskId: string): Promise<boolean> {
    const task = this.tasks.get(taskId);
    if (!task || terminalStatus(task.status)) return false;
    const batch = this.batches.get(task.batchId);
    if (!batch) return false;

    if (task.status === "queued") {
      task.status = "aborted";
      task.result = this.buildTaskResult(task);
      this.emitTaskCompleted(batch, task);
      this.finishBatchIfSettled(batch);
      return true;
    }

    await this.stopTask(task, "aborted");
    return true;
  }

  async abortBatch(batchId: string): Promise<boolean> {
    const batch = this.batches.get(batchId);
    if (!batch || batch.settled) return false;
    batch.cancelled = true;

    const stops: Promise<boolean>[] = [];
    for (const task of batch.tasks) {
      if (terminalStatus(task.status)) continue;
      stops.push(this.abortTask(task.taskId));
    }
    await Promise.all(stops);
    this.finishBatchIfSettled(batch);
    return true;
  }

  releaseBatch(batchId: string): boolean {
    const batch = this.batches.get(batchId);
    if (!batch?.settled) return false;
    this.batches.delete(batchId);
    for (const taskId of batch.taskIds) this.tasks.delete(taskId);
    return true;
  }

  dispose(): Promise<void> {
    if (this.disposePromise) return this.disposePromise;
    this.disposed = true;
    this.disposePromise = this.disposeAll();
    return this.disposePromise;
  }

  private async disposeAll(): Promise<void> {
    const activeBatches = [...this.batches.values()].filter((batch) => !batch.settled);
    await Promise.all(activeBatches.map((batch) => this.abortBatch(batch.batchId)));
    await Promise.all(activeBatches.map((batch) => batch.result));
    this.tasks.clear();
    this.batches.clear();
  }

  private pump(batch: BatchHandle): void {
    while (!batch.cancelled && batch.active < batch.maxConcurrent) {
      const task = batch.queue.shift();
      if (!task) break;
      if (task.status !== "queued") continue;
      task.status = "running";
      batch.active += 1;
      this.emitEvent(batch, task.taskId, "task_started", "running", {});
      void this.runTask(batch, task).finally(() => {
        batch.active -= 1;
        this.pump(batch);
        this.finishBatchIfSettled(batch);
      });
    }
  }

  private async runTask(batch: BatchHandle, task: TaskHandle): Promise<void> {
    task.timeout = this.timers.setTimeout(() => {
      void this.stopTask(task, "timed_out");
    }, batch.limits.timeoutSeconds * 1000);
    try {
      const session = await this.sessionFactory({
        batchId: batch.batchId,
        taskId: task.taskId,
        workspace: batch.workspace,
        task: task.input,
        model: task.input.model ?? batch.model,
        tools: READ_ONLY_SUBAGENT_TOOLS,
        limits: { ...batch.limits },
      });
      task.session = session;

      if (task.status !== "running") {
        await this.stopTask(task, task.status as SubagentTaskResult["status"]);
        return;
      }

      task.unsubscribe = session.subscribe((event) => this.handleEvent(task, event));

      try {
        await session.prompt(buildDelegatedPrompt(task.input));
        if (task.status === "running") task.status = "completed";
      } catch (error) {
        if (task.status === "running") {
          task.status = "failed";
          task.error = errorMessage(error);
        }
      }
    } catch (error) {
      if (task.status === "running") {
        task.status = "failed";
        task.error = errorMessage(error);
      }
    } finally {
      this.captureSessionMessages(task);
      if (task.timeout !== undefined) {
        this.timers.clearTimeout(task.timeout);
        task.timeout = undefined;
      }
      try {
        task.unsubscribe?.();
      } catch {
        // Continue releasing the session even if a third-party listener cleanup fails.
      }
      task.unsubscribe = undefined;
      if (task.session) {
        try {
          await task.session.dispose();
        } catch {
          // A completed result should survive best-effort session cleanup.
        }
      }
      task.session = undefined;
      task.seenMessages.clear();
      if (!terminalStatus(task.status)) task.status = "failed";
      task.result = this.buildTaskResult(task);
      this.emitTaskCompleted(batch, task);
    }
  }

  private handleEvent(task: TaskHandle, event: SubagentSessionEvent): void {
    if (event.type === "message_end") {
      this.captureAssistantMessage(task, event.message);
      if (isAssistantMessage(event.message)) {
        this.emitEvent(this.batchFor(task), task.taskId, "task_progress", "running", {
          phase: "assistant",
          summary: task.summary,
        });
      }
      return;
    }
    if (event.type === "turn_end") {
      task.completedTurns += 1;
      task.usage.turns = Math.max(task.usage.turns, task.completedTurns);
      this.emitEvent(this.batchFor(task), task.taskId, "task_progress", "running", {
        phase: "turn",
        turns: task.completedTurns,
      });
      if (task.completedTurns >= this.batchFor(task).limits.maxTurns) {
        task.limit = "maxTurns";
        void this.stopTask(task, "limit_reached");
      }
      return;
    }
    if (event.type === "tool_execution_start") {
      task.usage.toolCalls += 1;
      this.emitEvent(this.batchFor(task), task.taskId, "task_progress", "running", {
        phase: "tool",
        toolName: typeof (event as Record<string, unknown>).toolName === "string"
          ? (event as Record<string, unknown>).toolName
          : "unknown",
        toolCalls: task.usage.toolCalls,
      });
      if (task.usage.toolCalls >= this.batchFor(task).limits.maxToolCalls) {
        task.limit = "maxToolCalls";
        void this.stopTask(task, "limit_reached");
      }
    }
  }

  private batchFor(task: TaskHandle): BatchHandle {
    const batch = this.batches.get(task.batchId);
    if (!batch) throw new Error(`Unknown subagent batch: ${task.batchId}`);
    return batch;
  }

  private async stopTask(task: TaskHandle, status: SubagentTaskResult["status"]): Promise<void> {
    if (terminalStatus(task.status)) return;
    task.status = status;
    if (!task.session) return;
    if (!task.stopPromise) {
      try {
        task.stopPromise = Promise.resolve(task.session.abort()).then(() => undefined, () => undefined);
      } catch {
        task.stopPromise = Promise.resolve();
      }
    }
    await task.stopPromise;
  }

  private captureSessionMessages(task: TaskHandle): void {
    for (const message of task.session?.messages ?? []) this.captureAssistantMessage(task, message);
  }

  private captureAssistantMessage(task: TaskHandle, message: unknown): void {
    if (!isAssistantMessage(message)) return;
    if (task.seenMessages.has(message)) return;
    task.seenMessages.add(message);
    task.assistantMessages += 1;

    const extracted = parseAssistantResult(extractText(message));
    task.summary = extracted.summary;
    task.findings = extracted.findings;
    task.evidence = extracted.evidence;
    task.usage.turns = Math.max(task.completedTurns, task.assistantMessages);

    const usage = message.usage;
    if (!usage || typeof usage !== "object") return;
    const record = usage as Record<string, unknown>;
    task.usage.input += readNumber(record.input);
    task.usage.output += readNumber(record.output);
    task.usage.cacheRead += readNumber(record.cacheRead);
    task.usage.cacheWrite += readNumber(record.cacheWrite);
    const cost = record.cost;
    if (cost && typeof cost === "object") {
      task.usage.cost += readNumber((cost as Record<string, unknown>).total);
    } else {
      task.usage.cost += readNumber(cost);
    }
  }

  private buildTaskResult(task: TaskHandle): SubagentTaskResult {
    if (!terminalStatus(task.status)) throw new Error(`Subagent task ${task.taskId} is not settled`);
    return {
      taskId: task.taskId,
      status: task.status,
      summary: task.summary,
      findings: [...task.findings],
      evidence: [...task.evidence],
      usage: { ...task.usage },
      ...(task.error ? { error: task.error } : {}),
      ...(task.limit ? { limit: task.limit } : {}),
    };
  }

  private finishBatchIfSettled(batch: BatchHandle): void {
    if (batch.settled || batch.tasks.some((task) => !terminalStatus(task.status) || !task.result)) return;

    const tasks = batch.tasks.map((task) => task.result as SubagentTaskResult);
    const completed = tasks.filter((task) => task.status === "completed").length;
    let status: SubagentBatchResult["status"];
    if (completed === tasks.length) status = "completed";
    else if (tasks.every((task) => task.status === "aborted")) status = "aborted";
    else if (completed === 0) status = "failed";
    else status = "partial";

    const usage = tasks.reduce<SubagentUsage>((total, task) => ({
      input: total.input + task.usage.input,
      output: total.output + task.usage.output,
      cacheRead: total.cacheRead + task.usage.cacheRead,
      cacheWrite: total.cacheWrite + task.usage.cacheWrite,
      cost: total.cost + task.usage.cost,
      turns: total.turns + task.usage.turns,
      toolCalls: total.toolCalls + task.usage.toolCalls,
    }), EMPTY_USAGE());

    batch.status = status;
    batch.settled = true;
    const result = { batchId: batch.batchId, status, tasks, usage };
    this.emitEvent(batch, null, "batch_completed", status, { result });
    batch.resolveResult(result);
  }

  private emitTaskCompleted(batch: BatchHandle, task: TaskHandle): void {
    if (!task.result) return;
    this.emitEvent(batch, task.taskId, "task_completed", task.result.status, { result: task.result });
  }

  private emitEvent(
    batch: BatchHandle,
    taskId: string | null,
    kind: SubagentEventKind,
    status: SubagentEventStatus,
    payload: unknown,
  ): void {
    if (!batch.onEvent) return;
    const event = createSubagentEvent({
      protocolVersion: 1,
      parentToolCallId: batch.parentToolCallId,
      batchId: batch.batchId,
      taskId,
      seq: ++batch.eventSeq,
      kind,
      status,
      timestamp: new Date().toISOString(),
      payload,
    });
    try {
      batch.onEvent(event);
    } catch {
      // Observability must never change delegated task execution.
    }
  }
}

function buildDelegatedPrompt(task: SubagentTaskInput): string {
  const parts = [task.prompt]
  if (task.focusPaths?.length) {
    parts.push(`Focus paths:\n${task.focusPaths.map((path) => `- ${path}`).join("\n")}`)
  }
  if (task.deliverable?.trim()) parts.push(`Deliverable:\n${task.deliverable.trim()}`)
  return parts.join("\n\n")
}

function snapshotTaskInput(task: SubagentTaskInput): SubagentTaskInput {
  return {
    ...task,
    ...(task.focusPaths ? { focusPaths: [...task.focusPaths] } : {}),
    ...(task.model ? { model: { ...task.model } } : {}),
  }
}
