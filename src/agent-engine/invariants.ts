import type { EngineEvent, EngineTerminalEvent } from "./contracts.js";

export type InvariantIssue = {
  code: string;
  index: number;
  message: string;
  eventType?: string;
  turnId?: string;
};

export type InvariantReport = {
  ok: boolean;
  issues: InvariantIssue[];
};

function issue(issues: InvariantIssue[], code: string, index: number, message: string, event?: EngineEvent): void {
  issues.push({ code, index, message, ...(event ? { eventType: event.type, turnId: event.turnId } : {}) });
}

const TERMINAL_EVENTS = new Set<EngineTerminalEvent>(["turn.completed", "turn.failed", "turn.cancelled"]);
const TURN_CONTROL_EVENTS = new Set(["turn.started", "turn.completed", "turn.failed", "turn.cancelled"]);

/**
 * Shared runtime event state-machine checks. This is deliberately a pure
 * observer: rejected input is reported, never reordered or repaired.
 */
export function inspectEngineEventSequence(events: readonly EngineEvent[]): InvariantReport {
  const issues: InvariantIssue[] = [];
  const seenSeq = new Set<number>();
  const startedTurns = new Set<string>();
  const terminalTurns = new Map<string, EngineTerminalEvent>();
  const toolStates = new Map<string, "running" | "completed" | "failed">();
  let previousSeq = 0;
  let sessionId: string | undefined;

  events.forEach((event, index) => {
    if (sessionId === undefined && event.sessionId) sessionId = event.sessionId;
    if (sessionId !== undefined && event.sessionId !== sessionId) issue(issues, "session_mismatch", index, "event sessionId changed within one sequence", event);
    if (!Number.isSafeInteger(event.seq) || event.seq < 1) issue(issues, "invalid_seq", index, "event seq must be a positive integer", event);
    if (seenSeq.has(event.seq)) issue(issues, "duplicate_seq", index, `event seq ${event.seq} was already observed`, event);
    if (event.seq <= previousSeq) issue(issues, "out_of_order_seq", index, `event seq ${event.seq} is not greater than ${previousSeq}`, event);
    seenSeq.add(event.seq);
    previousSeq = Math.max(previousSeq, event.seq);

    const turnId = event.turnId;
    if (event.type === "turn.started") {
      if (startedTurns.has(turnId) && !terminalTurns.has(turnId)) issue(issues, "duplicate_turn_start", index, "turn started twice without a terminal event", event);
      startedTurns.add(turnId);
      return;
    }
    if (turnId && !startedTurns.has(turnId) && !TURN_CONTROL_EVENTS.has(event.type)) issue(issues, "event_before_turn_start", index, "event arrived before turn.started", event);
    if (turnId && terminalTurns.has(turnId) && !TURN_CONTROL_EVENTS.has(event.type)) issue(issues, "late_event_after_terminal", index, "non-terminal event arrived after turn terminal", event);
    if (TERMINAL_EVENTS.has(event.type as EngineTerminalEvent)) {
      const terminal = event.type as EngineTerminalEvent;
      const previous = terminalTurns.get(turnId);
      if (previous) issue(issues, "duplicate_terminal", index, `turn already terminated as ${previous}`, event);
      else terminalTurns.set(turnId, terminal);
      const pending = [...toolStates.entries()].some(([key, state]) => key.startsWith(`${turnId}:`) && state === "running");
      if (pending) issue(issues, "pending_tool_at_terminal", index, "turn terminal arrived while a tool was still running", event);
      return;
    }

    if (event.type === "tool.started" || event.type === "tool.updated" || event.type === "tool.completed" || event.type === "tool.failed") {
      const key = `${turnId}:${event.toolCallId}`;
      const previous = toolStates.get(key);
      if (event.type === "tool.started") {
        if (previous) issue(issues, "duplicate_tool_start", index, "tool call started more than once", event);
        else toolStates.set(key, "running");
      } else if (!previous) {
        issue(issues, "tool_event_without_start", index, "tool update/result arrived before tool.started", event);
      } else if (previous !== "running") {
        issue(issues, "tool_event_after_terminal", index, "tool update/result arrived after tool terminal", event);
      } else if (event.type === "tool.updated") {
        // Keep the running state; partial output is allowed to repeat.
      } else {
        toolStates.set(key, event.type === "tool.failed" ? "failed" : "completed");
      }
    }
  });
  return { ok: issues.length === 0, issues };
}

export function inspectPresentationBlocks(blocks: readonly { blockId?: string; seq?: number; type?: string; status?: string }[]): InvariantReport {
  const issues: InvariantIssue[] = [];
  const ids = new Set<string>();
  const seqs = new Set<number>();
  let previous = 0;
  blocks.forEach((block, index) => {
    if (!block.blockId) issue(issues, "missing_block_id", index, "presentation block has no blockId");
    else if (ids.has(block.blockId)) issue(issues, "duplicate_block_id", index, `blockId ${block.blockId} is duplicated`);
    else ids.add(block.blockId);
    if (!Number.isSafeInteger(block.seq) || (block.seq as number) < 1) issue(issues, "invalid_block_seq", index, "presentation block seq must be a positive integer");
    else {
      if (seqs.has(block.seq as number)) issue(issues, "duplicate_block_seq", index, `block seq ${block.seq} is duplicated`);
      if ((block.seq as number) <= previous) issue(issues, "block_order_drift", index, `block seq ${block.seq} is not increasing`);
      seqs.add(block.seq as number);
      previous = Math.max(previous, block.seq as number);
    }
    if (!block.type) issue(issues, "missing_block_type", index, "presentation block has no type");
  });
  return { ok: issues.length === 0, issues };
}

export function inspectPresentationTransitions(snapshots: readonly (readonly { blockId?: string; seq?: number; status?: string; text?: string }[])[]): InvariantReport {
  const issues: InvariantIssue[] = [];
  const prior = new Map<string, { seq?: number; status?: string; text?: string }>();
  snapshots.forEach((snapshot, snapshotIndex) => {
    const report = inspectPresentationBlocks(snapshot);
    for (const item of report.issues) issues.push({ ...item, index: snapshotIndex });
    for (const block of snapshot) {
      if (!block.blockId) continue;
      const old = prior.get(block.blockId);
      if (old && old.seq !== block.seq) issue(issues, "block_seq_changed", snapshotIndex, `block ${block.blockId} changed position during streaming`);
      if (old?.status === "done" && (old.text !== block.text || block.status !== "done")) issue(issues, "closed_block_reopened", snapshotIndex, `closed block ${block.blockId} changed after completion`);
      prior.set(block.blockId, { seq: block.seq, status: block.status, text: block.text });
    }
  });
  return { ok: issues.length === 0, issues };
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (!value || typeof value !== "object") return JSON.stringify(value);
  return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`).join(",")}}`;
}

export function inspectReplayConvergence(live: unknown, replay: unknown): InvariantReport {
  return canonical(live) === canonical(replay)
    ? { ok: true, issues: [] }
    : { ok: false, issues: [{ code: "replay_drift", index: 0, message: "live and replay state differ" }] };
}

export function inspectEvidenceEntries(entries: readonly { evidenceId?: string; status?: string; complete?: boolean; duplicateOf?: string; payloadHash?: string }[]): InvariantReport {
  const issues: InvariantIssue[] = [];
  const ids = new Set<string>();
  entries.forEach((entry, index) => {
    if (!entry.evidenceId || ids.has(entry.evidenceId)) issue(issues, "duplicate_evidence_id", index, "evidenceId must be unique");
    else ids.add(entry.evidenceId);
    if (!entry.payloadHash) issue(issues, "missing_payload_hash", index, "evidence entry must carry payloadHash");
    if (entry.status === "success" && entry.complete !== true) issue(issues, "incomplete_success", index, "success evidence must be complete");
    if (entry.status !== "success" && entry.complete === true) issue(issues, "failed_evidence_complete", index, "failed/unverified evidence cannot be complete");
    if (entry.duplicateOf && !ids.has(entry.duplicateOf)) issue(issues, "invalid_duplicate_reference", index, "duplicateOf must reference an earlier entry");
  });
  return { ok: issues.length === 0, issues };
}

export function assertInvariantReport(report: InvariantReport, label = "invariant"): void {
  if (!report.ok) throw new Error(`${label} failed: ${report.issues.map((entry) => `${entry.code}@${entry.index}`).join(", ")}`);
}

/** Return the smallest prefix that still violates the supplied checker. */
export function minimizeFailingSequence<T>(items: readonly T[], check: (candidate: readonly T[]) => InvariantReport): T[] {
  let current = [...items];
  if (check(current).ok) return [];
  let changed = true;
  while (changed && current.length > 1) {
    changed = false;
    for (let index = 0; index < current.length; index += 1) {
      const candidate = current.slice(0, index).concat(current.slice(index + 1));
      if (!check(candidate).ok) {
        current = candidate;
        changed = true;
        break;
      }
    }
  }
  return current;
}
