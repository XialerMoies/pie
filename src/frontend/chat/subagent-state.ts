export type FrontendSubagentStatus =
  | 'queued'
  | 'running'
  | 'completed'
  | 'partial'
  | 'failed'
  | 'aborted'
  | 'timed_out'
  | 'limit_reached'
  | 'interrupted';

export interface FrontendSubagentEvent {
  type: 'subagent_event';
  protocolVersion: 1;
  parentToolCallId: string;
  batchId: string;
  taskId: string | null;
  seq: number;
  kind: 'batch_started' | 'task_queued' | 'task_started' | 'task_progress' | 'task_completed' | 'batch_completed';
  status: Exclude<FrontendSubagentStatus, 'interrupted'>;
  timestamp: string;
  payload: Record<string, unknown>;
}

export interface FrontendSubagentTask {
  taskId: string;
  status: FrontendSubagentStatus;
  profile?: string;
  prompt?: string;
  summary?: string;
  findings: string[];
  evidence: string[];
  events: FrontendSubagentEvent[];
}

export interface FrontendSubagentBatch {
  batchId: string;
  parentToolCallId: string;
  status: FrontendSubagentStatus;
  events: FrontendSubagentEvent[];
  tasks: FrontendSubagentTask[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isEvent(value: unknown): value is FrontendSubagentEvent {
  if (!isRecord(value) || value.type !== 'subagent_event' || value.protocolVersion !== 1) return false;
  return typeof value.parentToolCallId === 'string' && !!value.parentToolCallId
    && typeof value.batchId === 'string' && !!value.batchId
    && (value.taskId === null || (typeof value.taskId === 'string' && !!value.taskId))
    && Number.isSafeInteger(value.seq) && Number(value.seq) > 0
    && typeof value.kind === 'string'
    && typeof value.status === 'string'
    && isRecord(value.payload);
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

export function reduceFrontendSubagentEvents(values: readonly unknown[]): FrontendSubagentBatch[] {
  const unique = new Map<string, FrontendSubagentEvent>();
  for (const value of values) {
    if (!isEvent(value)) continue;
    const key = `${value.batchId}\u0000${value.taskId ?? '<batch>'}\u0000${value.seq}`;
    if (!unique.has(key)) unique.set(key, value);
  }

  const byBatch = new Map<string, FrontendSubagentEvent[]>();
  for (const event of unique.values()) {
    const events = byBatch.get(event.batchId) ?? [];
    events.push(event);
    byBatch.set(event.batchId, events);
  }

  return [...byBatch.entries()].map(([batchId, events]) => {
    events.sort((left, right) => left.seq - right.seq);
    const taskEvents = new Map<string, FrontendSubagentEvent[]>();
    for (const event of events) {
      if (!event.taskId) continue;
      const list = taskEvents.get(event.taskId) ?? [];
      list.push(event);
      taskEvents.set(event.taskId, list);
    }
    const terminal = [...events].reverse().find((event) => event.kind === 'batch_completed');
    const tasks = [...taskEvents.entries()].map(([taskId, history]) => {
      const queued = history.find((event) => event.kind === 'task_queued');
      const completed = [...history].reverse().find((event) => event.kind === 'task_completed');
      const result = isRecord(completed?.payload.result) ? completed?.payload.result : {};
      return {
        taskId,
        status: (completed?.status ?? history[history.length - 1].status) as FrontendSubagentStatus,
        profile: typeof queued?.payload.profile === 'string' ? queued.payload.profile : undefined,
        prompt: typeof queued?.payload.prompt === 'string' ? queued.payload.prompt : undefined,
        summary: typeof result.summary === 'string' ? result.summary : undefined,
        findings: stringList(result.findings),
        evidence: stringList(result.evidence),
        events: history,
      } satisfies FrontendSubagentTask;
    });
    return {
      batchId,
      parentToolCallId: events[0].parentToolCallId,
      status: (terminal?.status ?? 'running') as FrontendSubagentStatus,
      events,
      tasks,
    } satisfies FrontendSubagentBatch;
  }).sort((left, right) => (left.events[0]?.timestamp || '').localeCompare(right.events[0]?.timestamp || ''));
}

export function selectSubagentBatchesForTool(
  batches: readonly FrontendSubagentBatch[] | undefined,
  toolCallId: string | undefined,
): FrontendSubagentBatch[] {
  if (!toolCallId) return [];
  return (batches ?? []).filter((batch) => batch.parentToolCallId === toolCallId);
}
