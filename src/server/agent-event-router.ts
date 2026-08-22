import type { AgentRuntime } from "../agent/index.js";
import type { AgentEngine, EngineEvent } from "../agent-engine/index.js";
import { reduceEngineEvent } from "./event-domain-reducer.js";
import { AssistantDomainReducer } from "./assistant-domain-reducer.js";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "fs";
import type { AssistantBlock, ChatStreamState, ChatTextInputState, ServerContext, TraceEvent } from "./routes/types.js";
import { writePresentationEvent } from "./presentation-events.js";
import { TaskLifecycle } from "./task-lifecycle.js";
import type { TaskLifecycleSnapshot } from "./task-lifecycle.js";
import { canonicalToolName } from "../agent/tool-identity.js";

export type SessionWriteAuthorizer = (sessionFile: string, source: string) => void;

export interface SessionPersistenceOptions {
  persist?: boolean;
  force?: boolean;
  minIntervalMs?: number;
  authorizeSessionWrite?: SessionWriteAuthorizer;
}

export function tagSessionHeader(
  sessionFile: string | undefined,
  ws: string,
  authorizeSessionWrite?: SessionWriteAuthorizer,
): void {
  if (!sessionFile) return
  try {
    authorizeSessionWrite?.(sessionFile, "sessions.header");
    const content = readFileSync(sessionFile, "utf-8")
    const lines = content.trim().split("\n")
    const header = JSON.parse(lines[0])
    if (header.workspace) return // 已有标记
    header.workspace = ws
    lines[0] = JSON.stringify(header)
    writeFileSync(sessionFile, lines.join("\n") + "\n")
  } catch {}
}

// ─── 路径（绝对路径）───────────────────────────────────────────────
export function appendAssistantSnapshot(aggregate: string, previousSnapshot: string | undefined, snapshot: string): { aggregate: string; snapshot: string; delta: string } {
  if (!snapshot) return { aggregate, snapshot: previousSnapshot || "", delta: "" };
  const delta = previousSnapshot && snapshot.startsWith(previousSnapshot)
    ? snapshot.slice(previousSnapshot.length)
    : (aggregate ? "\n\n" : "") + snapshot;
  return { aggregate: aggregate + delta, snapshot, delta };
}

/**
 * Node-flow diagnostics: 记录事件节点流中 text/thinking 节点的开启、关闭、
 * 写入与拒绝，用于排查"节点线性顺序被破坏 / 旧节点未关闭"问题。
 * 开启方式（PowerShell）：$env:DSH_NODEFLOW_LOG = "1"; $env:DSH_NODEFLOW_LOG_FILE = "E:\path\nodeflow.log"
 * 只设 DSH_NODEFLOW_LOG=1 时输出到 stderr（dev 终端可见）；
 * 同时设 DSH_NODEFLOW_LOG_FILE 时追加写入该文件（幂等，可在 Electron
 * 吞掉 stdout/stderr 的场景下可靠取日志）。
 */
function nodeFlowLog(message: string, ...args: unknown[]): void {
  if (process.env.DSH_NODEFLOW_LOG !== "1") return;
  const line = [`[nodeflow]`, message, ...args.map((arg) => {
    if (typeof arg === "string") return arg;
    try { return JSON.stringify(arg); } catch { return String(arg); }
  })].join(" ") + "\n";
  const filePath = process.env.DSH_NODEFLOW_LOG_FILE;
  if (filePath) {
    try {
      appendFileSync(filePath, line, "utf8");
      return;
    } catch { /* 文件写入失败时退回 stderr */ }
  }
  process.stderr.write(line);
}

/** Finalize a block (thinking/text) in the chat stream by marking it done. */
export function markBlockDone(chatStream: ChatStreamState, blockId: string): void {
  const index = chatStream.blocks.findIndex((block) => block.blockId === blockId);
  if (index < 0) return;
  const block = chatStream.blocks[index];
  if (block.type === "thinking" && block.status !== "done") {
    chatStream.blocks[index] = { ...block, status: "done" as const };
    nodeFlowLog("mark-done", blockId);
  }
}

interface IndexedInputSlot {
  active: ChatStreamState["activeTextInput"];
  generations: Record<string, number>;
}

/** Mutate one of the two independent node-input slots (text or thinking). */
function slotRef(
  chatStream: ChatStreamState,
  kind: "text" | "thinking",
): IndexedInputSlot {
  if (kind === "text") {
    chatStream.textBlockGenerations ??= {};
    return { active: chatStream.activeTextInput, generations: chatStream.textBlockGenerations };
  }
  chatStream.thinkingBlockGenerations ??= {};
  return { active: chatStream.activeThinkingInput, generations: chatStream.thinkingBlockGenerations };
}

function setActiveInput(chatStream: ChatStreamState, kind: "text" | "thinking", input: ChatTextInputState | undefined): void {
  if (kind === "text") chatStream.activeTextInput = input;
  else chatStream.activeThinkingInput = input;
}

/** Close a node input. Returns the closed blockId when a node was open, else null. */
export function closeActiveInput(chatStream: ChatStreamState, kind: "text" | "thinking", allowImplicitStart = false): string | null {
  const slot = slotRef(chatStream, kind);
  if (!slot.active) return null;
  const closedBlockId = slot.active.blockId;
  slot.active.open = false;
  if (allowImplicitStart) slot.active.implicitStartAllowed = true;
  nodeFlowLog("close", kind, { blockId: closedBlockId, allowImplicitStart });
  return closedBlockId;
}

function openIndexedInput(
  chatStream: ChatStreamState,
  kind: "text" | "thinking",
  key: string,
): string {
  const slot = slotRef(chatStream, kind);
  const baseId = key;
  const generation = (slot.generations[baseId] || 0) + 1;
  slot.generations[baseId] = generation;
  const blockId = generation === 1 ? baseId : `${baseId}#${generation}`;
  setActiveInput(chatStream, kind, { key, blockId, open: true, implicitStartAllowed: false });
  return blockId;
}

/**
 * Resolve the blockId a node-input event (start/delta/end) targets, enforcing
 * one-write-per-node semantics: a started node may be updated by matching
 * deltas, an ended node rejects later deltas, and only a new *start* opens the
 * next generation. `startSuffix`/`deltaSuffix` are the event-type suffixes
 * ("text_start" vs "thinking_start"). Returns null when the event must be
 * dropped. When a start closes a previous node, the previous blockId is
 * reported so the caller can finalize it.
 */
export function resolveIndexedBlockInput(
  chatStream: ChatStreamState,
  kind: "text" | "thinking",
  key: string,
  eventType: string,
  startSuffix: string,
  deltaSuffix: string,
): { blockId: string; closed?: string } | null {
  const slot = slotRef(chatStream, kind);
  const active = slot.active;
  if (eventType === `${startSuffix}_start`) {
    const closed = closeActiveInput(chatStream, kind);
    const blockId = openIndexedInput(chatStream, kind, key);
    nodeFlowLog("open", kind, { key, blockId, closed: closed ?? undefined });
    return { blockId, ...(closed === null ? {} : { closed }) };
  }
  if (active?.open) {
    if (active.key !== key) {
      nodeFlowLog("reject", kind, { eventType, key, activeKey: active.key, reason: "key-mismatch" });
      return null;
    }
    if (eventType === `${deltaSuffix}_end`) {
      active.open = false;
      nodeFlowLog("end", kind, { blockId: active.blockId });
      return { blockId: active.blockId, closed: active.blockId };
    }
    return { blockId: active.blockId };
  }
  // A first delta may arrive without a start in older providers, and some
  // providers omit a start after a message/tool boundary. Explicitly ended
  // inputs never reopen: a subsequent start must establish a generation.
  if (active && !active.implicitStartAllowed) {
    nodeFlowLog("reject", kind, { eventType, key, reason: "closed-input" });
    return null;
  }
  if (eventType === `${deltaSuffix}_delta`) {
    const blockId = openIndexedInput(chatStream, kind, key);
    nodeFlowLog("open", kind, { key, blockId, implicit: true });
    return { blockId };
  }
  return null;
}

type TracePersistRecord = {
  fingerprint: string;
  lastWriteAt: number;
};

const tracePersistState = new Map<string, TracePersistRecord>();
const pendingTracePersist = new Map<string, TraceEvent>();
const pendingBlockPersist = new Map<string, AssistantBlock>();

export function stringifyTraceValue(value: unknown, max = 2400): string {
  if (typeof value === "string") {
    return value.length > max ? value.slice(0, max) + "\n... truncated" : value;
  }
  try {
    const text = JSON.stringify(value, null, 2);
    return text.length > max ? text.slice(0, max) + "\n... truncated" : text;
  } catch {
    return String(value);
  }
}

function tracePersistKey(trace: TraceEvent): string {
  return `${trace.turnId}:${trace.type}:${trace.id}`;
}

function assignTraceSeq(chatStream: ChatStreamState, trace: TraceEvent): TraceEvent {
  if (trace.seq !== undefined) return trace;
  chatStream.traceSeq = (chatStream.traceSeq || 0) + 1;
  return { ...trace, seq: chatStream.traceSeq };
}

function traceFingerprint(trace: TraceEvent): string {
  if (trace.type === "tool") {
    return JSON.stringify({
      type: trace.type,
      status: trace.status,
      name: trace.name,
      input: trace.input,
      output: trace.output,
      error: trace.error,
      metadata: trace.metadata,
      turnId: trace.turnId,
      id: trace.id,
    });
  }
  return JSON.stringify({
    type: trace.type,
    status: trace.status,
    text: trace.text,
    turnId: trace.turnId,
    id: trace.id,
  });
}

export function cleanupTracePersistState(turnId: string): void {
  if (!turnId) return;
  for (const key of tracePersistState.keys()) {
    if (key.startsWith(`${turnId}:`)) tracePersistState.delete(key);
  }
  for (const key of pendingTracePersist.keys()) {
    if (key.startsWith(`${turnId}:`)) pendingTracePersist.delete(key);
  }
  for (const key of pendingBlockPersist.keys()) {
    if (key.startsWith(`${turnId}:`)) pendingBlockPersist.delete(key);
  }
}

export function flushPendingTracePersist(
  runtime: AgentRuntime,
  turnId: string,
  options?: SessionPersistenceOptions,
): void {
  if (!turnId) return;
  const entries = [...pendingTracePersist.entries()]
    .filter(([key]) => key.startsWith(`${turnId}:`))
    .map(([, trace]) => trace)
    .sort((a, b) => (a.seq || 0) - (b.seq || 0));
  for (const trace of entries) {
    persistTraceEvent(runtime, trace, { ...options, force: true });
    pendingTracePersist.delete(tracePersistKey(trace));
  }
}

/** 获取下一个 block 序号（预增，保证 block 内编号一致） */
export function nextBlockSeq(chatStream: ChatStreamState): number {
  return ++chatStream.blockSeq;
}

function blockPersistKey(block: AssistantBlock): string {
  return `${block.turnId}:${block.blockId}`;
}

export function persistBlockEvent(
  runtime: AgentRuntime,
  block: AssistantBlock,
  options?: SessionPersistenceOptions,
): boolean {
  const sessionFile = runtime.session.sessionFile;
  if (!sessionFile || !block.turnId) return false;
  const sessionFlushed = Boolean((runtime.session.sessionManager as any)?.flushed);
  if (!sessionFlushed || !existsSync(sessionFile)) {
    pendingBlockPersist.set(blockPersistKey(block), block);
    return false;
  }
  try {
    options?.authorizeSessionWrite?.(sessionFile, "sessions.assistant_block");
    appendFileSync(sessionFile, JSON.stringify({
      type: "assistant_block",
      turnId: block.turnId,
      block,
      timestamp: new Date().toISOString(),
    }) + "\n");
    pendingBlockPersist.delete(blockPersistKey(block));
    return true;
  } catch { /* ignore */ }
  pendingBlockPersist.set(blockPersistKey(block), block);
  return false;
}

export function flushPendingBlockPersist(
  runtime: AgentRuntime,
  turnId: string,
  options?: SessionPersistenceOptions,
): void {
  if (!turnId) return;
  const entries = [...pendingBlockPersist.entries()]
    .filter(([key]) => key.startsWith(`${turnId}:`))
    .map(([, block]) => block)
    .sort((a, b) => (a.seq || 0) - (b.seq || 0));
  for (const block of entries) {
    persistBlockEvent(runtime, block, options);
  }
}

export function emitBlock(
  runtime: AgentRuntime,
  chatStream: ChatStreamState,
  block: AssistantBlock,
  options?: SessionPersistenceOptions,
): void {
  const idx = chatStream.blocks.findIndex(b => b.blockId === block.blockId);
  let emittedBlock: AssistantBlock = chatStream.traceId && !block.traceId
    ? { ...block, traceId: chatStream.traceId }
    : block;
  if (idx >= 0) {
    // B-5：更新已存在的 block 时保留初始 seq，避免在事件流中"移动位置"（顺序漂移）。
    // 只有首次创建才分配新 seq；后续 text/thinking/tool 更新都不改变位置。
    emittedBlock = { ...block, seq: chatStream.blocks[idx].seq };
    chatStream.blocks[idx] = emittedBlock;
  } else {
    // Keep the in-memory protocol canonical even when an adapter delivers a
    // completed event after a later-started block. Persistence and SSE both
    // consume this array, so never expose completion order as logical order.
    const insertAt = chatStream.blocks.findIndex((existing) => existing.seq > emittedBlock.seq);
    if (insertAt < 0) chatStream.blocks.push(emittedBlock);
    else chatStream.blocks.splice(insertAt, 0, emittedBlock);
  }
  if (options?.persist !== false) {
    persistBlockEvent(runtime, emittedBlock, options);
  }
  writePresentationEvent(chatStream, { type: "block", block: emittedBlock });
}

/** Persist the terminal task contract so refresh/replay can inspect why a turn completed. */
export function persistTaskLifecycle(
  runtime: AgentRuntime,
  task: TaskLifecycleSnapshot,
  options?: SessionPersistenceOptions,
): boolean {
  const sessionFile = runtime.session.sessionFile;
  if (!sessionFile || !task.turnId) return false;
  const sessionFlushed = Boolean((runtime.session.sessionManager as any)?.flushed);
  if (!sessionFlushed || !existsSync(sessionFile)) return false;
  try {
    options?.authorizeSessionWrite?.(sessionFile, "sessions.task_lifecycle");
    appendFileSync(sessionFile, JSON.stringify({
      type: "task_lifecycle",
      turnId: task.turnId,
      task,
      timestamp: new Date().toISOString(),
    }) + "\n");
    return true;
  } catch { return false; }
}

export function recordUserNoteBlock(
  runtime: AgentRuntime,
  chatStream: ChatStreamState,
  note: { noteId: string; message: string; mode: "steer" | "followUp" },
  options?: SessionPersistenceOptions,
): boolean {
  if (!chatStream.turnId) return false;
  const block: AssistantBlock = {
    type: "user_note",
    noteId: note.noteId,
    mode: note.mode,
    text: note.message,
    status: "delivered",
    turnId: chatStream.turnId,
    blockId: "note-" + note.noteId,
    seq: nextBlockSeq(chatStream),
  };
  emitBlock(runtime, chatStream, block, options);
  return true;
}
export function persistTraceEvent(
  runtime: AgentRuntime,
  trace: TraceEvent,
  options?: SessionPersistenceOptions,
): boolean {
  if (options?.persist === false) return false;
  const sessionFile = runtime.session.sessionFile;
  if (!sessionFile || !trace.turnId) return false;
  const sessionFlushed = Boolean((runtime.session.sessionManager as any)?.flushed);
  if (!sessionFlushed || !existsSync(sessionFile)) {
    pendingTracePersist.set(tracePersistKey(trace), trace);
    return false;
  }
  const now = Date.now();
  const key = tracePersistKey(trace);
  const fingerprint = traceFingerprint(trace);
  const last = tracePersistState.get(key);
  const force = options?.force === true;
  const minIntervalMs = options?.minIntervalMs || 0;

  if (!force && last && last.fingerprint === fingerprint) return false;
  if (!force && minIntervalMs > 0 && last && now - last.lastWriteAt < minIntervalMs) return false;

  try {
    options?.authorizeSessionWrite?.(sessionFile, "sessions.trace");
    appendFileSync(sessionFile, JSON.stringify({
      type: "trace",
      turnId: trace.turnId,
      event: trace,
      timestamp: new Date().toISOString(),
    }) + "\n");
    tracePersistState.set(key, { fingerprint, lastWriteAt: now });
    pendingTracePersist.delete(key);
    return true;
  } catch { /* ignore */ }
  pendingTracePersist.set(key, trace);
  return false;
}

export function emitTrace(
  runtime: AgentRuntime,
  chatStream: ChatStreamState,
  trace: TraceEvent,
  options?: SessionPersistenceOptions,
): void {
  const turnId = trace.turnId || chatStream.turnId;
  if (!turnId) return;
  const normalized = assignTraceSeq(chatStream, {
    ...trace,
    turnId,
    ...(chatStream.traceId && !trace.traceId ? { traceId: chatStream.traceId } : {}),
  } as TraceEvent);
  persistTraceEvent(runtime, normalized, options);
}

/**
 * Engine-owned event bridge used by the desktop server. Runtime events are
 * reduced before this bridge emits the canonical presentation protocol.
 */
export function attachEngineEvents(
  engine: AgentEngine,
  runtime: AgentRuntime,
  chatStream: ChatStreamState,
  ctx?: ServerContext,
): () => void {
  let lastStreamingUsagePublishAt = 0;
  const completedTurns = new Set<string>();
  const publishUsageChanged = (): void => { try { ctx?.appEvents.publish("usage.changed"); } catch {} };
  const publishLifecycleChanged = (): void => {
    try { ctx?.appEvents.publish("dashboard.changed"); } catch {}
    publishUsageChanged();
  };
  const authorizeSessionWrite: SessionWriteAuthorizer | undefined = ctx?.permissionService
    ? (sessionFile, source) => ctx.permissionService!.authorizePathSync(ctx.paths.SESSIONS_DIR, sessionFile, "write", source)
    : undefined;
  const presentationKinds = new Set([
    "content", "thinking", "tool_started", "tool_updated", "tool_completed",
    "tool_failed", "terminal", "queue",
  ]);
  const taskLifecycle = new TaskLifecycle();
  const abortRequestedTurns = new Set<string>();

  const recordCorrelation = (stage: "runtime.event" | "task.transition" | "session.persisted", eventType: string, details?: Record<string, unknown>, failureKind?: string): void => {
    const correlation = chatStream.correlation;
    if (!ctx?.observability?.correlationLedger || !correlation?.traceId) return;
    ctx.observability.correlationLedger.record({
      ...correlation,
      stage,
      eventType,
      ...(chatStream.taskLifecycle?.status ? { status: chatStream.taskLifecycle.status } : {}),
      ...(failureKind ? { failureKind } : {}),
      ...(details ? { details } : {}),
    });
  };

  const currentTurn = (event: EngineEvent): string => event.turnId || chatStream.turnId;
  const domainReducer = new AssistantDomainReducer(chatStream, {
    markBlockDone: (blockId) => markBlockDone(chatStream, blockId),
    closeActiveInput: (kind) => closeActiveInput(chatStream, kind),
    resolveIndexedBlockInput: (kind, key, eventType, startSuffix, deltaSuffix) =>
      resolveIndexedBlockInput(chatStream, kind, key, eventType, startSuffix, deltaSuffix),
    nextBlockSeq: () => nextBlockSeq(chatStream),
    emitBlock: (block, persist) => emitBlock(runtime, chatStream, block, { persist }),
    log: nodeFlowLog,
  });

  const finish = (event: Extract<EngineEvent, { type: "turn.completed" | "turn.failed" | "turn.cancelled" }>): void => {
    const turnId = currentTurn(event);
    if (!turnId) return;
    if (completedTurns.has(turnId)) return;
    completedTurns.add(turnId);
    const openToolBlocks = chatStream.blocks.filter((block): block is Extract<AssistantBlock, { type: "tool" | "tool_use" }> =>
      (block.type === "tool" || block.type === "tool_use") && block.status === "running",
    );
    // A provider terminal event can race with sibling tool calls. Never expose
    // those calls as still running, and do not let turn.completed claim success
    // while a tool is unresolved.
    if (openToolBlocks.length > 0 && event.type === "turn.completed") {
      taskLifecycle.fail("tool_incomplete_at_terminal");
    }
    for (const block of [...chatStream.blocks]) {
      if (block.type === "thinking" && block.status === "streaming") {
        emitBlock(runtime, chatStream, { ...block, status: "done" }, { persist: false });
      }
    }
    const hasOriginalFinalText = chatStream.blocks.some((block) => block.type === "text") || Boolean(chatStream.textBuffer.trim());
    const toolCallIds = chatStream.blocks
      .filter((block): block is Extract<AssistantBlock, { type: "tool" | "tool_use" }> => block.type === "tool" || block.type === "tool_use")
      .map((block) => block.toolCallId);
    const evidence = ctx?.observability?.evidenceLedger
      ?.getSuccessfulFacts(toolCallIds)
      .map((entry) => ({
        evidenceId: entry.evidenceId,
        toolCallId: entry.toolCallId,
        canonicalTool: entry.canonicalTool,
        requestScope: entry.requestScope,
        payloadHash: entry.payloadHash,
        createdAt: entry.createdAt,
        ...(entry.evidenceFields?.length ? { evidenceFields: entry.evidenceFields } : {}),
      }));
    const evidenceCount = evidence?.length ?? 0;
    if (event.type === "turn.completed") {
      if (openToolBlocks.length === 0) taskLifecycle.complete(hasOriginalFinalText, evidenceCount);
    } else if (event.type === "turn.failed") {
      const details = event.error.details;
      const detailReason = details && typeof details === "object" && typeof (details as { reason?: unknown }).reason === "string"
        ? (details as { reason: string }).reason
        : undefined;
      taskLifecycle.fail(detailReason || event.error.code || event.error.category);
    }
    else taskLifecycle.cancel(event.reason || "cancelled");
    chatStream.taskLifecycle = taskLifecycle.snapshot();
    const terminalReason = chatStream.taskLifecycle.reason || (event.type === "turn.failed" ? event.error.message : undefined) || "turn_ended_before_tool_completed";
    for (const block of openToolBlocks) {
      if (block.type === "tool") {
        emitBlock(runtime, chatStream, { ...block, status: "error", error: terminalReason }, { persist: false });
      } else {
        emitBlock(runtime, chatStream, { ...block, status: "error" }, { persist: false });
      }
    }
    const taskPersisted = persistTaskLifecycle(runtime, chatStream.taskLifecycle, { authorizeSessionWrite });
    // A thought-only normalized turn must not become the visible final answer.
    // Keep the Thought block for inspection, but require a separate text block
    // so the same terminal invariant applies to both event bridges.
    if (event.type !== "turn.cancelled" && !chatStream.blocks.some((block) => block.type === "text")) {
      const trailingText = event.type === "turn.failed"
        ? "本轮回复未完成（发生错误或已中断）。"
        : "本轮未生成最终回复。";
      emitBlock(runtime, chatStream, {
        type: "text",
        text: trailingText,
        turnId,
        blockId: "text-trailing",
        seq: nextBlockSeq(chatStream),
      }, { persist: false });
    }
    chatStream.blocks.sort((left, right) => left.seq - right.seq);
    for (const block of chatStream.blocks) {
      if (block.type === "text" || block.type === "thinking") persistBlockEvent(runtime, block, { authorizeSessionWrite });
    }
    flushPendingTracePersist(runtime, turnId, { authorizeSessionWrite });
    flushPendingBlockPersist(runtime, turnId, { authorizeSessionWrite });
    const sessionId = engine.session.id;
    const fullText = chatStream.blocks
      .filter((block) => block.type === "text")
      .sort((left, right) => left.seq - right.seq)
      .map((block) => block.text)
      .join("\n\n");
    const task = taskLifecycle.snapshot();
    const strictVerification = chatStream.taskRequirements?.contract?.kind === "fact_verification"
      || chatStream.taskRequirements?.requiresEvidence === true;
    const finalText = strictVerification && task.status !== "completed"
      ? `未验证：${task.missingEvidence?.length ? `缺少证据字段：${task.missingEvidence.join("、")}` : task.reason || "没有获得足够的成功证据。"}`
      : fullText || chatStream.textBuffer;
    // A cancellation requested by the runtime after a hard tool failure is
    // presented as a failed/blocked turn, not as a successful user cancel.
    if (event.type === "turn.cancelled" && task.status !== "blocked") {
      writePresentationEvent(chatStream, { type: "cancelled", turnId, sessionId, reason: event.reason });
    } else {
      writePresentationEvent(chatStream, {
        type: "done",
        text: finalText,
        turnId,
        sessionId,
        status: event.type === "turn.completed" && task.status === "completed" ? "done" : "error",
        ...(event.type === "turn.completed" && event.usage ? { usage: event.usage } : {}),
        ...(task.status !== "completed"
          ? { error: task.reason || (event.type === "turn.failed" ? event.error.message : event.type === "turn.cancelled" ? event.reason : undefined) || "Agent turn failed" }
          : {}),
        blocks: chatStream.blocks,
        ...(evidence && evidence.length > 0 ? { evidence } : {}),
        task,
      });
    }
    try { chatStream.response?.end(); } catch {}
    chatStream.response = null;
    chatStream.textBuffer = "";
    chatStream.thinkingBuffer = "";
    chatStream.currentTextSnapshot = "";
    chatStream.currentThinkingSnapshot = "";
    cleanupTracePersistState(turnId);
    recordCorrelation("task.transition", event.type, {
      terminal: true,
      taskStatus: task.status,
      evidenceCount,
    });
    recordCorrelation("session.persisted", "task_lifecycle", { taskStatus: task.status, persisted: taskPersisted });
    chatStream.turnId = "";
    chatStream.emittedTraces = new Set();
    chatStream.blocks = [];
    chatStream.blockSeq = 0;
    chatStream.textSegments = [];
    chatStream.thinkingBlockGenerations = {};
    domainReducer.reset();
    chatStream.currentWorkspace = "";
    publishLifecycleChanged();
  };

  return engine.subscribe((event) => {
    const domainEvent = reduceEngineEvent(event);
    // Debug and explicitly non-user runtime events are never a presentation
    // source. Lifecycle/usage bookkeeping remains internal to the bridge, but
    // content/tool/terminal transitions require user visibility.
    if (domainEvent.kind === "debug"
      || (presentationKinds.has(domainEvent.kind) && !domainEvent.presentationEligible)) return;
    const turnId = currentTurn(event);
    if (event.type === "turn.started") {
      completedTurns.delete(turnId);
    } else if (turnId && completedTurns.has(turnId)) {
      // A terminal event closes the protocol generation. Late provider events
      // must not recreate blocks after the stream has been finalized.
      return;
    }
    // Once a tool failure has put the task in a terminal state, provider
    // events arriving before the abort completes must not create more work,
    // visible blocks, or evidence. Terminal turn events are still accepted so
    // the normal persistence/presentation finalizer can run exactly once.
    const lifecycleStatus = taskLifecycle.snapshot().status;
    if (turnId
      && lifecycleStatus !== "running"
      && event.type !== "turn.started"
      && event.type !== "turn.completed"
      && event.type !== "turn.failed"
      && event.type !== "turn.cancelled") return;
    if (event.type === "turn.started") {
      if (chatStream.correlation?.turnId !== event.turnId) chatStream.traceId = `trace-${event.turnId || chatStream.turnId}`;
      chatStream.traceId ||= `trace-${event.turnId || chatStream.turnId}`;
      chatStream.turnId = event.turnId || chatStream.turnId;
      chatStream.sessionId = engine.session.id;
      chatStream.correlation = { traceId: chatStream.traceId, turnId: chatStream.turnId, sessionId: chatStream.sessionId };
      recordCorrelation("runtime.event", event.type);
      taskLifecycle.start(chatStream.turnId, chatStream.taskRequirements, { traceId: chatStream.traceId, sessionId: chatStream.sessionId });
      chatStream.taskLifecycle = taskLifecycle.snapshot();
      recordCorrelation("task.transition", event.type, { phase: chatStream.taskLifecycle.phase });
      domainReducer.reset();
      chatStream.activeTextInput = undefined;
      chatStream.activeThinkingInput = undefined;
      publishLifecycleChanged();
      lastStreamingUsagePublishAt = Date.now();
      return;
    }
    if (turnId) recordCorrelation("runtime.event", event.type);
    if (event.type === "queue.updated") {
      writePresentationEvent(chatStream, { type: "queue_update", steering: event.steering, followUp: event.followUp });
      return;
    }
    if (event.type === "usage.updated") {
      const now = Date.now();
      if (now - lastStreamingUsagePublishAt >= 500) {
        lastStreamingUsagePublishAt = now;
        publishUsageChanged();
      }
      return;
    }
    if (event.type === "compaction.started" || event.type === "compaction.completed" || event.type === "compaction.failed") {
      publishUsageChanged();
      return;
    }
    if (event.type === "content.delta" && turnId) {
      taskLifecycle.contentDelta(event.text);
      chatStream.taskLifecycle = taskLifecycle.snapshot();
      chatStream.textBuffer += event.text;
      const structured = event.phase !== undefined || event.messageSeq !== undefined || event.contentIndex !== undefined;
      domainReducer.upsertTextBlock("text", structured ? event.text : chatStream.textBuffer, turnId, structured ? {
        contentIndex: event.contentIndex,
        messageSeq: event.messageSeq,
        phase: event.phase || "delta",
      } : undefined);
      return;
    }
    if (event.type === "thinking.delta" && turnId) {
      chatStream.thinkingBuffer += event.text;
      const structured = event.phase !== undefined || event.messageSeq !== undefined || event.contentIndex !== undefined;
      domainReducer.upsertTextBlock("thinking", structured ? event.text : chatStream.thinkingBuffer, turnId, structured ? {
        contentIndex: event.contentIndex,
        messageSeq: event.messageSeq,
        phase: event.phase || "delta",
      } : undefined);
      return;
    }
    if (event.type === "tool.started" && turnId) {
      const toolName = canonicalToolName(event.name);
      taskLifecycle.toolStarted(event.toolCallId, toolName, event.input);
      chatStream.taskLifecycle = taskLifecycle.snapshot();
      recordCorrelation("task.transition", event.type, { tool: toolName, toolCallId: event.toolCallId });
      // Tool execution closes an in-flight Thought node before opening its tool block.
      domainReducer.closeThinkingAtToolBoundary();
      const id = `${event.toolCallId}@${turnId}`;
      const trace: TraceEvent = { type: "tool", status: "running", name: toolName, input: event.input, turnId, id };
      emitTrace(runtime, chatStream, trace, { force: true, authorizeSessionWrite });
      emitBlock(runtime, chatStream, {
        type: "tool", toolCallId: event.toolCallId, name: toolName, input: event.input,
        status: "running", turnId, blockId: `tool-${event.toolCallId}`, seq: nextBlockSeq(chatStream),
      }, { persist: false });
      return;
    }
    if (event.type === "tool.updated" && turnId) {
      const toolName = canonicalToolName(event.name);
      const block = chatStream.blocks.find((item): item is Extract<AssistantBlock, { type: "tool" }> => item.type === "tool" && item.toolCallId === event.toolCallId);
      if (block) emitBlock(runtime, chatStream, { ...block, output: event.output }, { persist: false });
      // Partial tool output is an SSE concern. Only the terminal tool frame
      // is persisted, avoiding repeated synchronous writes of growing output.
      emitTrace(runtime, chatStream, { type: "tool", status: "running", name: toolName, output: event.output, turnId, id: `${event.toolCallId}@${turnId}` }, { persist: false });
      return;
    }
    if (event.type === "tool.completed" || event.type === "tool.failed") {
      if (!turnId) return;
      const toolName = canonicalToolName(event.name);
      const block = chatStream.blocks.find((item): item is Extract<AssistantBlock, { type: "tool" }> => item.type === "tool" && item.toolCallId === event.toolCallId);
      const permissionFailure = event.metadata?.permissionFailure;
      const failed = event.type === "tool.failed" || (permissionFailure !== null && typeof permissionFailure === "object");
      const failureMessage = event.type === "tool.failed"
        ? event.error.message
        : typeof (permissionFailure as { message?: unknown } | undefined)?.message === "string"
          ? (permissionFailure as { message: string }).message
          : undefined;
      if (event.type === "tool.completed" && !failed) {
        const evidenceAvailable = Boolean(ctx?.observability?.evidenceLedger?.getSuccessfulFacts([event.toolCallId]).length);
        const evidenceFields = Array.isArray(event.metadata?.evidenceFields)
          ? event.metadata.evidenceFields.filter((field): field is string => typeof field === "string")
          : [];
        taskLifecycle.toolCompleted(event.toolCallId, evidenceAvailable, evidenceFields);
      } else {
        const error = event.type === "tool.failed"
          ? event.error
          : {
              category: "permission" as const,
              kind: "permission_denied" as const,
              code: typeof (permissionFailure as { code?: unknown } | undefined)?.code === "string"
                ? (permissionFailure as { code: string }).code
                : "permission_denied",
              retryable: false,
              message: failureMessage || "Permission denied",
              details: permissionFailure,
            };
        taskLifecycle.toolFailed(event.toolCallId, toolName, error);
      }
      chatStream.taskLifecycle = taskLifecycle.snapshot();
      recordCorrelation("task.transition", event.type, { tool: toolName, toolCallId: event.toolCallId, status: failed ? "failed" : "completed" }, event.type === "tool.failed" ? event.error.kind : undefined);
      emitBlock(runtime, chatStream, {
        type: "tool", toolCallId: event.toolCallId, name: toolName, input: block?.input,
        output: event.type === "tool.completed" ? event.output : undefined,
        error: failed ? failureMessage : undefined,
        metadata: event.metadata,
        status: failed ? "error" : "success", turnId,
        blockId: `tool-${event.toolCallId}`, seq: block?.seq ?? nextBlockSeq(chatStream),
      }, { authorizeSessionWrite });
      emitTrace(runtime, chatStream, {
        type: "tool", status: failed ? "error" : "success", name: toolName,
        output: event.type === "tool.completed" ? event.output : undefined,
        error: failed ? failureMessage : undefined, metadata: event.metadata, turnId, id: `${event.toolCallId}@${turnId}`,
      }, { force: true, authorizeSessionWrite });
      if (chatStream.taskLifecycle.status === "blocked" && turnId && !abortRequestedTurns.has(turnId)) {
        abortRequestedTurns.add(turnId);
        persistTaskLifecycle(runtime, chatStream.taskLifecycle, { authorizeSessionWrite });
        try {
          void Promise.resolve(engine.cancel(turnId)).catch(() => undefined);
        } catch {
          // The terminal provider event remains the fallback finalizer.
        }
      }
      return;
    }
    if (event.type === "turn.completed" || event.type === "turn.failed" || event.type === "turn.cancelled") {
      finish(event);
    }
  });
}

