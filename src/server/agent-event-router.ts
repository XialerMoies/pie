import type { AgentRuntime } from "../agent/index.js";
import type { AgentEngine, EngineEvent } from "../agent-engine/index.js";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "fs";
import type { AssistantBlock, ChatStreamState, ChatTextInputState, ServerContext, TraceEvent } from "./routes/types.js";
import { writeChatEvent } from "./chat-stream.js";

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
function appendAssistantSnapshot(aggregate: string, previousSnapshot: string | undefined, snapshot: string): { aggregate: string; snapshot: string; delta: string } {
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
function markBlockDone(chatStream: ChatStreamState, blockId: string): void {
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
function closeActiveInput(chatStream: ChatStreamState, kind: "text" | "thinking", allowImplicitStart = false): string | null {
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
function resolveIndexedBlockInput(
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

function stringifyTraceValue(value: unknown, max = 2400): string {
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

function cleanupTracePersistState(turnId: string): void {
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
  if (idx >= 0) {
    // B-5：更新已存在的 block 时保留初始 seq，避免在事件流中"移动位置"（顺序漂移）。
    // 只有首次创建才分配新 seq；后续 text/thinking/tool 更新都不改变位置。
    chatStream.blocks[idx] = { ...block, seq: chatStream.blocks[idx].seq };
  } else {
    chatStream.blocks.push(block);
  }
  if (options?.persist !== false) {
    persistBlockEvent(runtime, block, options);
  }
  writeChatEvent(chatStream, { type: "block", block });
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
  const normalized = assignTraceSeq(chatStream, { ...trace, turnId } as TraceEvent);
  persistTraceEvent(runtime, normalized, options);
  writeChatEvent(chatStream, { type: "trace", trace: normalized });
}

export function attachSessionEvents(
  runtime: AgentRuntime,
  chatStream: ChatStreamState,
  ctx?: ServerContext,
): void {
  let lastStreamingUsagePublishAt = 0;
  const publishUsageChanged = (): void => {
    try { ctx?.appEvents.publish("usage.changed"); } catch {}
  };
  const publishStreamingUsageChanged = (): void => {
    const now = Date.now();
    if (now - lastStreamingUsagePublishAt < 500) return;
    lastStreamingUsagePublishAt = now;
    publishUsageChanged();
  };
  const publishLifecycleChanged = (): void => {
    try { ctx?.appEvents.publish("dashboard.changed"); } catch {}
    publishUsageChanged();
  };
  const publishLifecycleAfterIdle = (sourceSession?: AgentRuntime["session"]): void => {
    const sessionAtEnd = sourceSession ?? runtime.session;
    let sessionIdAtEnd: string | undefined;
    try { sessionIdAtEnd = sessionAtEnd?.sessionManager?.getSessionId?.() || undefined; } catch {}
    const isCurrentSession = (): boolean => {
      if (runtime.session !== sessionAtEnd) return false;
      if (!sessionIdAtEnd) return true;
      try { return runtime.session?.sessionManager?.getSessionId?.() === sessionIdAtEnd; } catch { return false; }
    };
    const publishForCurrentSession = (): void => {
      if (isCurrentSession()) publishLifecycleChanged();
    };
    const recordIdleError = (error: unknown): void => {
      try {
        console.warn(`[server] waitForIdle failed: ${error instanceof Error ? error.message : String(error)}`);
      } catch {}
    };
    const fallbackPublish = (error?: unknown): void => {
      if (error !== undefined) recordIdleError(error);
      queueMicrotask(publishForCurrentSession);
    };

    try {
      const agent = sessionAtEnd?.agent;
      if (typeof agent?.waitForIdle !== "function") {
        fallbackPublish();
        return;
      }
      void Promise.resolve(agent.waitForIdle()).then(
        publishForCurrentSession,
        (error) => {
          recordIdleError(error);
          publishForCurrentSession();
        },
      );
    } catch (error) {
      fallbackPublish(error);
    }
  };
  const authorizeSessionWrite: SessionWriteAuthorizer | undefined = ctx?.permissionService
    ? (sessionFile, source) => {
      ctx.permissionService!.authorizePathSync(ctx.paths.SESSIONS_DIR, sessionFile, "write", source);
    }
    : undefined;

  runtime.onEvent((event: any, sourceSession) => {
    if (sourceSession && runtime.session !== sourceSession) return;
    if (event.type === "queue_update") {
      writeChatEvent(chatStream, {
        type: "queue_update",
        steering: Array.isArray(event.steering) ? event.steering : [],
        followUp: Array.isArray(event.followUp) ? event.followUp : [],
      });
      return;
    }
    if (event.type === "agent_start") {
      publishLifecycleChanged();
      lastStreamingUsagePublishAt = Date.now();
    }
    if (event.type === "compaction_start") {
      if ((runtime.session as any).isCompacting) publishUsageChanged();
      else queueMicrotask(publishUsageChanged);
    }
    if (event.type === "compaction_end") queueMicrotask(publishUsageChanged);
    if (event.type === "agent_end" && !chatStream.turnId) {
      publishLifecycleAfterIdle(sourceSession);
      return;
    }

    const turnId = chatStream.turnId || (event.turnIndex !== undefined ? `turn-${event.turnIndex}` : "");
    const tid = (event.toolCallId || event.id || event.type) + "@" + turnId;

    // lifecycle 步骤不再生成 step 事件（旧 session 仍可回放，新 session 不再写入）
    if (event.type === "message_end" && event.message?.role === "toolResult") {
      flushPendingTracePersist(runtime, turnId, { authorizeSessionWrite });
    }
    if (event.type === "turn_end") {
      flushPendingTracePersist(runtime, turnId, { authorizeSessionWrite });
    }

    // B-5：assistant message 序号——工具调用后的新 assistant message 从 contentIndex 0 重新开始，
    // blockId 需带 message 前缀避免跨 message 冲突。
    if (event.type === "message_start" && event.message?.role === "assistant") {
      closeActiveInput(chatStream, "text", true);
      closeActiveInput(chatStream, "thinking", true);
      chatStream.messageSeq = (chatStream.messageSeq || 0) + 1;
    }

    // ─── Tool trace ─────────────────────────────────────────
    if (event.type === "tool_execution_start" && turnId) {
      closeActiveInput(chatStream, "text", true);
      closeActiveInput(chatStream, "thinking", true);
      if (!chatStream.emittedTraces.has(tid)) {
        chatStream.emittedTraces.add(tid);
        const trace: TraceEvent = {
          type: "tool", status: "running",
          name: event.toolName || "unknown",
          input: event.args,
          turnId,
          id: tid,
        };
        emitTrace(runtime, chatStream, trace, { force: true, authorizeSessionWrite });
        // B-5：tool 物理合并成一个 block（type:"tool"，含 input，运行中更新 output，
        // 结束时更新 status）。blockId 用 toolCallId 稳定，seq 首次分配、更新保留。
        // persist:false——running 态不落盘，只有 tool_execution_end 持久化最终态，
        // 避免同一 blockId 在 JSONL 里重复（刷新恢复出多个工具节点）。
        const block: AssistantBlock = {
          type: "tool", status: "running",
          toolCallId: event.toolCallId || "",
          name: event.toolName || "unknown",
          input: event.args,
          turnId,
          blockId: "tool-" + (event.toolCallId || nextBlockSeq(chatStream)),
          seq: nextBlockSeq(chatStream),
        };
        emitBlock(runtime, chatStream, block, { persist: false });
      }
    }

    if (event.type === "tool_execution_update" && turnId) {
      const trace: TraceEvent = {
        type: "tool",
        status: "running",
        name: event.toolName || "unknown",
        input: event.args,
        output: stringifyTraceValue(event.partialResult),
        turnId,
        id: tid,
      };
      emitTrace(runtime, chatStream, trace, { minIntervalMs: 250, authorizeSessionWrite });
      if (event.partialResult) {
        const toolBlock = chatStream.blocks.find(
          (b): b is AssistantBlock & { type: "tool" } => b.type === "tool" && b.toolCallId === event.toolCallId
        );
        if (toolBlock && !(toolBlock.output || "").includes("[截断")) {
          const chunk = String(event.partialResult ?? "");
          const merged = (toolBlock.output || "") + chunk;
          if (merged.length >= 50400) {
            emitBlock(runtime, chatStream, {
              ...toolBlock,
              output: merged.slice(0, 50370) + '\n... [截断: 输出超过 50KB]',
            } as AssistantBlock, { persist: false });
            return;
          }
          emitBlock(runtime, chatStream, {
            ...toolBlock,
            output: merged,
          } as AssistantBlock, { persist: false });
        }
      }
    }

    if (event.type === "tool_execution_end" && turnId) {
      if (!chatStream.emittedTraces.has(tid + "@end")) {
        chatStream.emittedTraces.add(tid + "@end");
        const trace: TraceEvent = {
          type: "tool",
          status: event.isError ? "error" : "success",
          name: event.toolName || "unknown",
          output: event.result,
          error: event.isError ? event.result : undefined,
          metadata: event.metadata,
          turnId,
          id: tid,
        };
        emitTrace(runtime, chatStream, trace, { force: true, authorizeSessionWrite });
        // B-5：tool 合并——更新已有 tool block 的 status/output/error，不单独生成 tool_result。
        // blockId 稳定，emitBlock 保留初始 seq。
        const flowBlock2 = chatStream.blocks.find(
          (b): b is AssistantBlock & { type: "tool" } =>
            b.type === "tool" && b.toolCallId === event.toolCallId
        );
        const flowOut = flowBlock2?.output || "";
        const block: AssistantBlock = {
          type: "tool",
          toolCallId: event.toolCallId || "",
          name: flowBlock2?.name || event.toolName || "unknown",
          input: flowBlock2?.input,
          output: event.result || flowOut || undefined,
          error: event.isError ? (event.result || flowOut) : undefined,
          metadata: event.metadata,
          status: event.isError ? "error" : "success",
          turnId,
          blockId: "tool-" + (event.toolCallId || flowBlock2?.blockId || nextBlockSeq(chatStream)),
          seq: nextBlockSeq(chatStream),
        };
        emitBlock(runtime, chatStream, block, { authorizeSessionWrite });
      }
    }

    // ─── Thinking trace / text & thinking block ──────────────
    if (event.type === "message_update" && turnId) {
      const msg = event.message;
      if (msg?.role === "assistant" && msg?.content) {
        publishStreamingUsageChanged();
        const fullThinking = msg.content.filter((c: any) => c.type === "thinking").map((c: any) => c.thinking || "").join("");
        const thinkingState = appendAssistantSnapshot(chatStream.thinkingBuffer, chatStream.currentThinkingSnapshot, fullThinking);
        chatStream.currentThinkingSnapshot = thinkingState.snapshot;

        // B-5：用 contentIndex 作 text/thinking 的稳定 blockId（content 数组结构稳定，
        // 同块多次 delta 的 contentIndex 恒定）。首次创建分配 seq，更新由 emitBlock 保留原 seq。
        // assistantMessageEvent 是单个增量（text_delta 等），contentIndex 指向对应 content 块。
        const inc = (event as any).assistantMessageEvent as
          | { type: string; contentIndex?: number; delta?: string }
          | undefined;
        const incIndex = typeof inc?.contentIndex === "number" ? inc.contentIndex : -1;

        if (inc?.type === "text_delta" || inc?.type === "text_end" || inc?.type === "text_start") {
          // contentIndex 是 content 数组的位置索引（pi-ai 组装时 content.length-1）。
          // content 块本身没有 index 字段，直接用下标取值。
          // blockId 带 message 前缀，避免工具前后不同 assistant message 的 contentIndex 冲突。
          const mprefix = `m${chatStream.messageSeq || 1}`;
          // 无 contentIndex 时（incIndex = -1）回退到正文段索引，避免非法 blockId（text--1）。
          const resolvedTextIndex = incIndex >= 0
            ? incIndex
            : msg.content.findIndex((c: any) => c.type === "text");
          const contentBlock = msg.content[incIndex];
          const curText = contentBlock?.type === "text" ? (contentBlock.text || "") : (inc.delta || "");
          const textKey = `${mprefix}:text-${resolvedTextIndex}`;
          // 正文输入到达时切断思考输入（同一 assistant 内容流里两者互斥）。
          const closedThinking = closeActiveInput(chatStream, "thinking");
          if (closedThinking !== null) markBlockDone(chatStream, closedThinking);
          const resolved = resolveIndexedBlockInput(chatStream, "text", textKey, inc.type, "text", "text");
          if (resolved !== null) {
            const block: AssistantBlock = {
              type: "text",
              text: curText,
              turnId,
              blockId: resolved.blockId,
              seq: nextBlockSeq(chatStream),
            };
            emitBlock(runtime, chatStream, block, { persist: false });
            if (inc.delta && inc.type === "text_delta") {
              // P2-1：done.text 应是全部正文拼接，不是只留最后一段。
              // 用当前 message 的完整文本更新 snapshot（累积），跨 message 由 messageSeq 区分。
              chatStream.textBuffer = curText;
              chatStream.currentTextSnapshot = curText;
              writeChatEvent(chatStream, { type: "delta", text: inc.delta });
            }
            if (resolved.closed !== undefined) markBlockDone(chatStream, resolved.closed);
          }
        } else if (inc?.type === "thinking_delta" || inc?.type === "thinking_end" || inc?.type === "thinking_start") {
          // B-5：thinking 独立成块——用 contentIndex 作稳定 blockId，多段思考各自独立。
          // 思考输入到达时切断正文输入（同一 assistant 内容流里两者互斥）。
          const closedText = closeActiveInput(chatStream, "text");
          if (closedText !== null) markBlockDone(chatStream, closedText);
          const mprefix = `m${chatStream.messageSeq || 1}`;
          // 无 contentIndex 时（incIndex = -1）回退到 thinking 段索引，避免非法 blockId。
          const resolvedThinkingIndex = incIndex >= 0
            ? incIndex
            : msg.content.findIndex((c: any) => c.type === "thinking");
          const contentBlock = msg.content[incIndex];
          const curThinking = contentBlock?.type === "thinking" ? (contentBlock.thinking || "") : (inc.delta || "");
          // 同步 thinkingBuffer（累积），供 done.thinking 与 thinking 收尾 trace 使用
          chatStream.thinkingBuffer = thinkingState.aggregate;
          const thinkingKey = `${mprefix}:thinking-${resolvedThinkingIndex}`;
          const resolved = resolveIndexedBlockInput(chatStream, "thinking", thinkingKey, inc.type, "thinking", "thinking");
          if (resolved !== null) {
            const trace: TraceEvent = {
              type: "thinking", status: "streaming",
              text: curThinking,
              turnId,
              id: resolved.blockId,
            };
            emitTrace(runtime, chatStream, trace, { minIntervalMs: 250, authorizeSessionWrite });
            const block: AssistantBlock = {
              type: "thinking",
              text: curThinking,
              status: inc.type === "thinking_end" ? "done" : "streaming",
              turnId,
              blockId: resolved.blockId,
              seq: nextBlockSeq(chatStream),
            };
            emitBlock(runtime, chatStream, block, { persist: false });
            // 思考结束（thinking_end）或新思考直接开启（thinking_start 未带
            // end 时，守卫返回被关闭的旧节点）：旧节点都必须立即标 done，
            // 不能因 LLM 未发 end 就一直保持 streaming。
            if (resolved.closed !== undefined) markBlockDone(chatStream, resolved.closed);
            if (inc.type === "thinking_end") markBlockDone(chatStream, resolved.blockId);
          }
        } else {
          // 无 contentIndex 的兼容路径：遍历 content 的 text 块，用块序号作 blockId。
          // 工具边界后 content 新增 text 块会生成新段；同段更新由 emitBlock 保留 seq。
          // 硬性不变式：兼容路径创建/更新任何节点前，先关闭 text 与 thinking
          // 的可写入状态，确保"开新节点必先关旧节点"，避免新旧节点并存写入。
          const closedCompatText = closeActiveInput(chatStream, "text");
          if (closedCompatText !== null) markBlockDone(chatStream, closedCompatText);
          const closedCompatThinking = closeActiveInput(chatStream, "thinking");
          if (closedCompatThinking !== null) markBlockDone(chatStream, closedCompatThinking);
          const textBlocks = msg.content
            .map((block: any, index: number) => ({ block, index }))
            .filter(({ block }: any) => block.type === "text");
          if (!chatStream.textSegments) chatStream.textSegments = [];
          const segCount = chatStream.textSegments.length;
          const totalText = textBlocks.map(({ block }: any) => block.text || "").join("");
          const textState = appendAssistantSnapshot(chatStream.textBuffer, chatStream.currentTextSnapshot, totalText);
          chatStream.currentTextSnapshot = textState.snapshot;
          chatStream.textBuffer = textState.aggregate;
          for (let i = 0; i < textBlocks.length; i++) {
            const curText = textBlocks[i].block.text || "";
            const prev = chatStream.textSegments[i] ?? "";
            const delta = curText.startsWith(prev) ? curText.slice(prev.length) : curText;
            if (delta || prev !== curText) {
              chatStream.textSegments[i] = curText;
              const block: AssistantBlock = {
                type: "text", text: curText, turnId,
                // 段索引 i 始终 ≥0，避免无 contentIndex 时出现非法 blockId（text--1）。
                blockId: `m${chatStream.messageSeq || 1}:text-${i}`, seq: nextBlockSeq(chatStream),
              };
              emitBlock(runtime, chatStream, block, { persist: false });
              if (i >= segCount || !prev) {
                writeChatEvent(chatStream, { type: "delta", text: delta || curText });
              }
            }
          }
          while (chatStream.textSegments.length > textBlocks.length) chatStream.textSegments.pop();
          // 兼容路径：thinking 也合并为单一 block（无 contentIndex 时）
          if (thinkingState.delta) {
            chatStream.thinkingBuffer = thinkingState.aggregate;
            const tidThinking = "thinking@" + turnId;
            if (!chatStream.emittedTraces.has(tidThinking)) {
              chatStream.emittedTraces.add(tidThinking);
            }
            const trace: TraceEvent = {
              type: "thinking", status: "streaming",
              text: chatStream.thinkingBuffer,
              turnId,
              id: tidThinking,
            };
            emitTrace(runtime, chatStream, trace, { minIntervalMs: 250, authorizeSessionWrite });
            const block: AssistantBlock = {
              type: "thinking",
              text: chatStream.thinkingBuffer,
              status: "streaming",
              turnId,
              blockId: tidThinking,
              seq: nextBlockSeq(chatStream),
            };
            emitBlock(runtime, chatStream, block, { persist: false });
          }
        }
      }
    }

    if (event.type === "agent_end") {
      const bufLen = chatStream.textBuffer.length;
      console.log(`[sse] agent_end — text=${bufLen}B thinking=${chatStream.thinkingBuffer.length}B`);
      const sessionId = runtime.session.sessionManager?.getSessionId?.() || "";
      const turnId = chatStream.turnId;
      const ws = chatStream.currentWorkspace || "";

      // 收尾 thinking trace
      const tidThinking = "thinking@" + turnId;
      if (chatStream.thinkingBuffer && turnId) {
        const trace: TraceEvent = { type: "thinking", status: "done", text: chatStream.thinkingBuffer, turnId, id: tidThinking };
        flushPendingTracePersist(runtime, turnId, { authorizeSessionWrite });
        emitTrace(runtime, chatStream, trace, { force: true, authorizeSessionWrite });
      }
      flushPendingTracePersist(runtime, turnId, { authorizeSessionWrite });

      // B-5 P1-3：indexed thinking 收尾——agent_end 时把仍是 streaming 的
      // thinking block（m<seq>:thinking-<idx>）更新为 done，避免回复结束后仍显示"进行中"。
      for (let i = 0; i < chatStream.blocks.length; i++) {
        const b = chatStream.blocks[i];
        if (b.type === "thinking" && b.status === "streaming") {
          chatStream.blocks[i] = { ...b, status: "done" as const };
        }
      }
      flushPendingBlockPersist(runtime, turnId, { authorizeSessionWrite });

      // B-5：末尾必须是正文节点（硬不变量）。
      // 若 blocks 末尾不是 text（纯工具调用/只有 thinking），补一个正文收尾节点：
      //  - textBuffer 有真实正文 → 补真实正文
      //  - 无正文 → 补占位正文（本轮未生成最终回复）
      //  - 错误/中断 → 说明未完成（不伪装成正常回复）
      const lastBlock = chatStream.blocks[chatStream.blocks.length - 1];
      if (lastBlock?.type !== "text") {
        // agent_end 事件用 messages 数组（SDK AgentEndEvent: { type, messages: AgentMessage[] }），
        // 取最后一个 assistant message 的错误信息判断中断/失败。
        const finalMsgs = (event as any).messages as
          | Array<{ role?: string; stopReason?: string; errorMessage?: string }>
          | undefined;
        const finalMsg = Array.isArray(finalMsgs)
          ? finalMsgs.filter((m) => m?.role === "assistant").pop()
          : undefined;
        const aborted = finalMsg?.stopReason === "error" || finalMsg?.stopReason === "aborted" || Boolean(finalMsg?.errorMessage);
        const realText = chatStream.textBuffer?.trim();
        let trailingText: string;
        if (aborted) {
          trailingText = (finalMsg?.errorMessage || "本轮回复未完成（发生错误或已中断）。").trim();
        } else if (realText) {
          trailingText = chatStream.textBuffer;
        } else {
          trailingText = "本轮未生成最终回复。";
        }
        const trailSeq = nextBlockSeq(chatStream);
        const trailBlock: AssistantBlock = {
          type: "text", text: trailingText, turnId,
          blockId: "text-trailing", seq: trailSeq,
        };
        // persist:false——由下方"持久化流式 text/thinking block"统一落盘一次，避免重复
        emitBlock(runtime, chatStream, trailBlock, { persist: false });
      }

      // 持久化 text / thinking block（流式 persist:false 与末尾兜底在此统一落盘一次）
      for (const block of chatStream.blocks) {
        if (block.type === "text" || block.type === "thinking") {
          persistBlockEvent(runtime, block, { authorizeSessionWrite });
        }
      }

      if (ws) {
        console.log(`  agent_end: tagging workspace "${ws}" session=${sessionId}`);
        tagSessionHeader(runtime.session.sessionFile, ws, authorizeSessionWrite);
      }

      // P2-1：done.text 应为全部正文拼接（多段正文/多 message 的完整内容），
      // 不依赖可能被单段覆盖的 textBuffer。从 blocks 收集所有 text block 按 seq 拼接。
      const fullText = chatStream.blocks
        .filter((b) => b.type === "text")
        .sort((a, b) => a.seq - b.seq)
        .map((b) => b.text || "")
        .join("\n\n");

      writeChatEvent(chatStream, {
          type: "done",
          text: fullText || chatStream.textBuffer,
          thinking: chatStream.thinkingBuffer || undefined,
          turnId,
          sessionId,
          blocks: chatStream.blocks,
      });
      try { chatStream.response?.end(); } catch { /* ignore */ }
      chatStream.response = null;
      chatStream.textBuffer = "";
      chatStream.thinkingBuffer = "";
      chatStream.currentTextSnapshot = "";
      chatStream.currentThinkingSnapshot = "";
      cleanupTracePersistState(turnId);
      chatStream.turnId = "";
      chatStream.emittedTraces = new Set();
      chatStream.blocks = [];
      chatStream.blockSeq = 0;
      chatStream.textSegments = [];
      chatStream.activeTextInput = undefined;
      chatStream.textBlockGenerations = {};
      chatStream.activeThinkingInput = undefined;
      chatStream.thinkingBlockGenerations = {};
      chatStream.currentWorkspace = "";
      publishLifecycleAfterIdle(sourceSession);
    }
  });
}

/**
 * Engine-owned event bridge used by the desktop server. The legacy PI bridge above
 * remains available for replay fixtures, but new runtime events never cross this
 * boundary as raw PI objects.
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
  /** per-generation thinking 起点：key = `thinking-${turnId}`, value = 该 generation 在 thinkingBuffer 中的起始偏移 */
  const thinkingGenStarts = new Map<string, number>();

  const currentTurn = (event: EngineEvent): string => event.turnId || chatStream.turnId;
  const upsertTextBlock = (type: "text" | "thinking", text: string, turnId: string): void => {
    // 硬性不变式：Normalized 引擎事件桥同样必须"切换节点类型前关闭旧类型"。
    // 写入 text 时若 thinking 节点存在则标 done，写入 thinking 时若 text 节点
    // 存在则视为已结束（text 无 done 标记，但不再被更新）。
    // 引擎桥不维护 active 状态，因此直接操作 blocks 实现互斥。
    if (type === "text") {
      const openThinking = chatStream.blocks.find(
        (block): block is Extract<AssistantBlock, { type: "thinking" }> =>
          block.type === "thinking" && block.status === "streaming",
      );
      if (openThinking !== undefined) {
        markBlockDone(chatStream, openThinking.blockId);
        nodeFlowLog("engine-cutoff", "text", { thinkingBlock: openThinking.blockId });
      }
    } else {
      const existingText = chatStream.blocks.find((block) => block.type === "text");
      if (existingText !== undefined) {
        nodeFlowLog("engine-cutoff", "thinking", { textBlock: existingText.blockId });
      }
    }
    // thinking generation：工具边界（或正文）标 done 后，后续 thinking.delta
    // 若继续写同一 block 会覆盖已关闭的旧节点。检测到最新 thinking 已 done 时
    // 开新的 generation 节点；仍在 streaming 的 thinking 保持其当前 blockId。
    // 节点文本用分段累积：每 generation 记录其在 thinkingBuffer 中的起点，
    // 节点文本 = thinkingBuffer.slice(起点)，只含本段内容；thinkingBuffer
    // 仍全局累积，供 done.thinking 汇总。
    chatStream.thinkingBlockGenerations ??= {};
    const baseId = `${type}-${turnId}`;
    let blockId = baseId;
    if (type === "thinking") {
      const latestThinking = [...chatStream.blocks]
        .filter((block): block is Extract<AssistantBlock, { type: "thinking" }> =>
          block.type === "thinking" && block.blockId.startsWith(baseId))
        .sort((a, b) => b.seq - a.seq)[0];
      if (latestThinking !== undefined) {
        if (latestThinking.status === "done") {
          // 已关闭的旧节点：开新 generation。起点 = 上一段（done）在
          // thinkingBuffer 中的终点 = 上一段起点 + 上一段文本长度。此时 text
          // 已含新 delta，不能直接用 text.length 作为起点，否则会把新段内容
          // 也计入起点导致新节点文本为空。
          const prevStart = thinkingGenStarts.get(latestThinking.blockId) ?? 0;
          const nextStart = prevStart + latestThinking.text.length;
          const currentGen = chatStream.thinkingBlockGenerations[baseId] || 0;
          const nextGen = currentGen + 1;
          chatStream.thinkingBlockGenerations[baseId] = nextGen;
          blockId = nextGen === 1 ? `${baseId}#2` : `${baseId}#${nextGen + 1}`;
          thinkingGenStarts.set(blockId, nextStart);
          nodeFlowLog("engine-newgen", "thinking", { from: latestThinking.blockId, to: blockId, gen: nextGen, start: nextStart });
        } else {
          // 仍在 streaming：保持当前 generation 的 blockId，不切回 baseId。
          blockId = latestThinking.blockId;
        }
      } else {
        chatStream.thinkingBlockGenerations[baseId] = 0;
        thinkingGenStarts.set(baseId, 0);
      }
    }
    // 分段文本：thinking 节点只显示本 generation 起点之后的内容。
    const genStart = type === "thinking" ? (thinkingGenStarts.get(blockId) ?? 0) : 0;
    const nodeText = type === "thinking" && genStart > 0 && text.length >= genStart
      ? text.slice(genStart)
      : text;
    nodeFlowLog("upsert", type, { turnId, textLen: text.length, blockId, nodeTextLen: nodeText.length });
    const existing = chatStream.blocks.find((block): block is Extract<AssistantBlock, { type: typeof type }> => block.type === type && block.blockId === blockId);
    emitBlock(runtime, chatStream, {
      type,
      text: nodeText,
      ...(type === "thinking" ? { status: "streaming" as const } : {}),
      turnId,
      blockId,
      seq: existing?.seq ?? nextBlockSeq(chatStream),
    } as AssistantBlock, { persist: false });
  };

  const finish = (event: Extract<EngineEvent, { type: "turn.completed" | "turn.failed" | "turn.cancelled" }>): void => {
    const turnId = currentTurn(event);
    if (!turnId) return;
    if (completedTurns.has(turnId)) return;
    completedTurns.add(turnId);
    for (const block of [...chatStream.blocks]) {
      if (block.type === "thinking" && block.status === "streaming") {
        emitBlock(runtime, chatStream, { ...block, status: "done" }, { persist: false });
      }
    }
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
    const status = event.type === "turn.completed" ? "done" : event.type === "turn.cancelled" ? "cancelled" : "error";
    if (event.type === "turn.cancelled") {
      writeChatEvent(chatStream, { type: "cancelled", turnId, sessionId, reason: event.reason });
    } else {
      writeChatEvent(chatStream, {
        type: "done",
        text: fullText || chatStream.textBuffer,
        thinking: chatStream.thinkingBuffer || undefined,
        turnId,
        sessionId,
        status,
        ...(event.type === "turn.completed" && event.usage ? { usage: event.usage } : {}),
        ...(event.type === "turn.failed" ? { error: event.error.message } : {}),
        blocks: chatStream.blocks,
      });
    }
    try { chatStream.response?.end(); } catch {}
    chatStream.response = null;
    chatStream.textBuffer = "";
    chatStream.thinkingBuffer = "";
    chatStream.currentTextSnapshot = "";
    chatStream.currentThinkingSnapshot = "";
    cleanupTracePersistState(turnId);
    chatStream.turnId = "";
    chatStream.emittedTraces = new Set();
    chatStream.blocks = [];
    chatStream.blockSeq = 0;
    chatStream.textSegments = [];
    chatStream.thinkingBlockGenerations = {};
    thinkingGenStarts.clear();
    chatStream.currentWorkspace = "";
    publishLifecycleChanged();
  };

  return engine.subscribe((event) => {
    const turnId = currentTurn(event);
    if (event.type === "turn.started") {
      chatStream.turnId = event.turnId || chatStream.turnId;
      publishLifecycleChanged();
      lastStreamingUsagePublishAt = Date.now();
      return;
    }
    if (event.type === "queue.updated") {
      writeChatEvent(chatStream, { type: "queue_update", steering: event.steering, followUp: event.followUp });
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
      chatStream.textBuffer += event.text;
      upsertTextBlock("text", chatStream.textBuffer, turnId);
      writeChatEvent(chatStream, { type: "delta", text: event.text });
      return;
    }
    if (event.type === "thinking.delta" && turnId) {
      chatStream.thinkingBuffer += event.text;
      upsertTextBlock("thinking", chatStream.thinkingBuffer, turnId);
      writeChatEvent(chatStream, { type: "thinking", text: event.text });
      return;
    }
    if (event.type === "tool.started" && turnId) {
      // 工具执行 = text/thinking 段落边界：引擎桥不维护 active，直接标 blocks 里
      // 仍在 streaming 的 thinking 为 done，避免工具后仍显示"思考进行中"。
      for (const openBlock of chatStream.blocks) {
        if (openBlock.type === "thinking" && openBlock.status === "streaming") {
          markBlockDone(chatStream, openBlock.blockId);
          nodeFlowLog("tool-boundary", "thinking", { blockId: openBlock.blockId });
        }
      }
      const id = `${event.toolCallId}@${turnId}`;
      const trace: TraceEvent = { type: "tool", status: "running", name: event.name, input: event.input, turnId, id };
      emitTrace(runtime, chatStream, trace, { force: true, authorizeSessionWrite });
      emitBlock(runtime, chatStream, {
        type: "tool", toolCallId: event.toolCallId, name: event.name, input: event.input,
        status: "running", turnId, blockId: `tool-${event.toolCallId}`, seq: nextBlockSeq(chatStream),
      }, { persist: false });
      return;
    }
    if (event.type === "tool.updated" && turnId) {
      const block = chatStream.blocks.find((item): item is Extract<AssistantBlock, { type: "tool" }> => item.type === "tool" && item.toolCallId === event.toolCallId);
      if (block) emitBlock(runtime, chatStream, { ...block, output: event.output }, { persist: false });
      emitTrace(runtime, chatStream, { type: "tool", status: "running", name: event.name, output: event.output, turnId, id: `${event.toolCallId}@${turnId}` }, { minIntervalMs: 250, authorizeSessionWrite });
      return;
    }
    if (event.type === "tool.completed" || event.type === "tool.failed") {
      if (!turnId) return;
      const block = chatStream.blocks.find((item): item is Extract<AssistantBlock, { type: "tool" }> => item.type === "tool" && item.toolCallId === event.toolCallId);
      const permissionFailure = event.metadata?.permissionFailure;
      const failed = event.type === "tool.failed" || (permissionFailure !== null && typeof permissionFailure === "object");
      const failureMessage = event.type === "tool.failed"
        ? event.error.message
        : typeof (permissionFailure as { message?: unknown } | undefined)?.message === "string"
          ? (permissionFailure as { message: string }).message
          : undefined;
      emitBlock(runtime, chatStream, {
        type: "tool", toolCallId: event.toolCallId, name: event.name, input: block?.input,
        output: event.type === "tool.completed" ? event.output : undefined,
        error: failed ? failureMessage : undefined,
        metadata: event.metadata,
        status: failed ? "error" : "success", turnId,
        blockId: `tool-${event.toolCallId}`, seq: block?.seq ?? nextBlockSeq(chatStream),
      }, { authorizeSessionWrite });
      emitTrace(runtime, chatStream, {
        type: "tool", status: failed ? "error" : "success", name: event.name,
        output: event.type === "tool.completed" ? event.output : undefined,
        error: failed ? failureMessage : undefined, metadata: event.metadata, turnId, id: `${event.toolCallId}@${turnId}`,
      }, { force: true, authorizeSessionWrite });
      return;
    }
    if (event.type === "turn.completed" || event.type === "turn.failed" || event.type === "turn.cancelled") {
      finish(event);
    }
  });
}

