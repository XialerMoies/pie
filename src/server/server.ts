/**
 * My Code Agent — Pi 服务器
 * 作为子进程运行，通过 HTTP 提供仪表盘和对话 API
 *
 * 环境变量：
 *   PI_WORKSPACE       - initial workspace
 *   PI_DATA_ROOT       - persistent data root
 *   PI_INSTANCE_ID     - per-launch instance id
 */
import { initAgent, type AgentRuntime } from "../agent/index.js";
import { createServer, type IncomingMessage, type OutgoingHttpHeaders, type ServerResponse } from "http";
import { resolve, dirname } from "path";
import { fileURLToPath, pathToFileURL } from "url";
import { appendFileSync, readFileSync, writeFileSync, existsSync, mkdirSync, statSync } from "fs";
import { dispatchRoute } from "./routes/index.js";
import { cancelCommandConfirmationsForResponse, createCommandConfirmCallback } from "./routes/chat.js";
import type { ServerContext, ChatStreamState, TraceEvent, AssistantBlock } from "./routes/types.js";
import { TsserverManager } from "./ts-server.js";
import { mark, logTiming } from "./timing.js";
import { shellDialectFromEnv } from "../agent/tools/command/shell-parser.js";
import { createSessionPermissionState } from "../agent/permissions.js";
import {
  authorizeLocalApiRequest,
  cleanupStaleInstanceDirectories,
  clearDesktopSessionTokenEnv,
  createDesktopSecurityConfig,
  installSecurityHeaders,
  isApiPreflight,
  removeInstanceRuntimeDirectory,
  writeInstanceMetadata,
  writeSecurityError,
  type InstanceMetadata,
} from "./security.js";
import { authorizeRoutePath, ServerPermissionService } from "./permission-service.js";
import { authorizeWorkspacePath, runWithWorkspaceOwnership } from "./routes/workspace-authorization.js";
import { cancelPermissionConfirmationsForResponse, createPermissionConfirmCallback } from "./permission-confirmation.js";
import { FilePermissionAuditStore } from "./permission-audit-store.js";
import { FileWorkspacePermissionRuleStore } from "./permission-rule-store.js";
import { contentTypeForStaticAsset, resolveStaticAssetPath } from "./static-assets.js";
import { RootRegistry } from "./root-registry.js";
import { createPermissionModeController } from "./permission-mode.js";
import { writeChatEvent } from "./chat-stream.js";
import { AppEventHub } from "./app-events.js";
import { WorkspaceFileWatcher } from "./workspace-file-watcher.js";
import { getServersStatus, subscribeStatusChanges } from "../agent/mcp/MCPClientService.js";
import { resolveStartupPaths, startupPathsSnapshot } from "./startup-paths.js";
import { canonicalWorkspacePath } from "../data/data-layout.js";
import { recordOpenedWorkspace } from "../data/user-settings.js";
import { WorkspaceLockCoordinator } from "./workspace-lock.js";
import { workspaceDataPaths, writeWorkspaceMetadata } from "./routes/session-dir.js";
import { readWorkspaceUiState } from "./routes/ui-state.js";

export type SessionWriteAuthorizer = (sessionFile: string, source: string) => void;

export interface SessionPersistenceOptions {
  persist?: boolean;
  force?: boolean;
  minIntervalMs?: number;
  authorizeSessionWrite?: SessionWriteAuthorizer;
}

export function openAppEventStream(
  req: IncomingMessage,
  res: ServerResponse,
  appEvents: AppEventHub,
  cors: OutgoingHttpHeaders,
): void {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    ...cors,
  });
  res.write(`data: ${JSON.stringify({ type: "connected", revision: appEvents.revision() })}\n\n`);
  appEvents.addClient(res);
  req.on("close", () => {
    appEvents.removeClient(res);
  });
}

export function attachMcpEvents(appEvents: Pick<AppEventHub, "publish">): () => void {
  const toolsKey = (snapshot: ReturnType<typeof getServersStatus>): string => JSON.stringify(
    snapshot
      .map((status) => ({ name: status.name, tools: status.tools }))
      .sort((left, right) => left.name.localeCompare(right.name)),
  );
  let previousTools = toolsKey(getServersStatus());
  return subscribeStatusChanges((snapshot) => {
    try { appEvents.publish("mcp.changed"); } catch {}
    const nextTools = toolsKey(snapshot);
    if (nextTools !== previousTools) {
      previousTools = nextTools;
      try { appEvents.publish("dashboard.changed"); } catch {}
    }
  });
}

// 不再移动活跃 session 文件——只在 header 标记 workspace
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
const __dirname = dirname(fileURLToPath(import.meta.url));
const APP_ROOT = resolve(__dirname, "..", "..");
const STARTUP = resolveStartupPaths({ appRoot: APP_ROOT, argv: process.argv.slice(2), env: process.env });
const STARTUP_SNAPSHOT = startupPathsSnapshot(STARTUP);
const DATA_DIR = STARTUP.dataRoot;
const PI_CONFIG_DIR = STARTUP.layout.userRoot;
const SESSIONS_DIR = STARTUP.layout.sessionsDir;
const SETTINGS_FILE = STARTUP.layout.settingsFile;
const DATA_ROOT_POINTER_FILE = process.env.PI_DESKTOP_DATA_ROOT_POINTER || "";
const FRONTEND_DIR = resolve(APP_ROOT, "dist", "frontend");
const FRONTEND_ENTRY_FILE = "dashboard.html";
const HAS_BUILT_FRONTEND = existsSync(resolve(FRONTEND_DIR, FRONTEND_ENTRY_FILE));
const FRONTEND_SRC_DIR = resolve(APP_ROOT, "src", "frontend");
const TRANSIENT_EMPTY_WORKSPACE = STARTUP.workspace === canonicalWorkspacePath(
  resolve(STARTUP.layout.instanceRoot, "empty-workspace"),
);
let activeWorkspaceLock: WorkspaceLockCoordinator | null = null;
let activeWorkspaceLockRelease: Promise<void> | null = null;

async function releaseActiveWorkspaceLock(): Promise<void> {
  if (activeWorkspaceLockRelease) return activeWorkspaceLockRelease;
  const lock = activeWorkspaceLock;
  if (!lock) return;
  activeWorkspaceLockRelease = lock.release()
    .then(() => {
      if (activeWorkspaceLock === lock) activeWorkspaceLock = null;
    })
    .finally(() => {
      activeWorkspaceLockRelease = null;
    });
  await activeWorkspaceLockRelease;
}

// ─── 启动 Pi ──────────────────────────────────────────────────────
function appendAssistantSnapshot(aggregate: string, previousSnapshot: string | undefined, snapshot: string): { aggregate: string; snapshot: string; delta: string } {
  if (!snapshot) return { aggregate, snapshot: previousSnapshot || "", delta: "" };
  const delta = previousSnapshot && snapshot.startsWith(previousSnapshot)
    ? snapshot.slice(previousSnapshot.length)
    : (aggregate ? "\n\n" : "") + snapshot;
  return { aggregate: aggregate + delta, snapshot, delta };
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
  const publishUsageChanged = (): void => {
    try { ctx?.appEvents.publish("usage.changed"); } catch {}
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
    if (event.type === "agent_start") publishLifecycleChanged();
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
      chatStream.messageSeq = (chatStream.messageSeq || 0) + 1;
    }

    // ─── Tool trace ─────────────────────────────────────────
    if (event.type === "tool_execution_start" && turnId) {
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
          const contentBlock = msg.content[incIndex];
          const curText = contentBlock?.type === "text" ? (contentBlock.text || "") : (inc.delta || "");
          const block: AssistantBlock = {
            type: "text",
            text: curText,
            turnId,
            blockId: `${mprefix}:text-${incIndex}`,
            seq: nextBlockSeq(chatStream),
          };
          emitBlock(runtime, chatStream, block, { persist: false });
          if (inc.delta) {
            // P2-1：done.text 应是全部正文拼接，不是只留最后一段。
            // 用当前 message 的完整文本更新 snapshot（累积），跨 message 由 messageSeq 区分。
            chatStream.textBuffer = curText;
            chatStream.currentTextSnapshot = curText;
            writeChatEvent(chatStream, { type: "delta", text: inc.delta });
          }
        } else if (inc?.type === "thinking_delta" || inc?.type === "thinking_end" || inc?.type === "thinking_start") {
          // B-5：thinking 独立成块——用 contentIndex 作稳定 blockId，多段思考各自独立。
          const mprefix = `m${chatStream.messageSeq || 1}`;
          const contentBlock = msg.content[incIndex];
          const curThinking = contentBlock?.type === "thinking" ? (contentBlock.thinking || "") : (inc.delta || "");
          // 同步 thinkingBuffer（累积），供 done.thinking 与 thinking 收尾 trace 使用
          chatStream.thinkingBuffer = thinkingState.aggregate;
          const trace: TraceEvent = {
            type: "thinking", status: "streaming",
            text: curThinking,
            turnId,
            id: `${mprefix}:thinking-${incIndex}`,
          };
          emitTrace(runtime, chatStream, trace, { minIntervalMs: 250, authorizeSessionWrite });
          const block: AssistantBlock = {
            type: "thinking",
            text: curThinking,
            status: "streaming",
            turnId,
            blockId: `${mprefix}:thinking-${incIndex}`,
            seq: nextBlockSeq(chatStream),
          };
          emitBlock(runtime, chatStream, block, { persist: false });
        } else {
          // 无 contentIndex 的兼容路径：遍历 content 的 text 块，用块序号作 blockId。
          // 工具边界后 content 新增 text 块会生成新段；同段更新由 emitBlock 保留 seq。
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
            const contentIndex = textBlocks[i].index;
            const prev = chatStream.textSegments[i] ?? "";
            const delta = curText.startsWith(prev) ? curText.slice(prev.length) : curText;
            if (delta || prev !== curText) {
              chatStream.textSegments[i] = curText;
              const block: AssistantBlock = {
                type: "text", text: curText, turnId,
                blockId: `m${chatStream.messageSeq || 1}:text-${contentIndex}`, seq: nextBlockSeq(chatStream),
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
      chatStream.currentWorkspace = "";
      publishLifecycleAfterIdle(sourceSession);
    }
  });
}

async function main() {
  mark("server_start");
  console.log("Starting Pi server...");

  await cleanupStaleInstanceDirectories(STARTUP.dataRoot, STARTUP.instanceId);
  for (const directory of [
    STARTUP.layout.dataRoot,
    STARTUP.layout.userRoot,
    STARTUP.layout.workspaceRoot,
    STARTUP.layout.sessionsDir,
    STARTUP.layout.instanceRoot,
    STARTUP.layout.cacheDir,
  ]) {
    mkdirSync(directory, { recursive: true });
  }
  try {
    writeFileSync(STARTUP.layout.authFile, JSON.stringify({}, null, 2), { encoding: "utf8", flag: "wx" });
  } catch (error: any) {
    if (error?.code !== "EEXIST") throw error;
  }
  const instanceMetadata: InstanceMetadata = {
    version: 1,
    instanceId: STARTUP.instanceId,
    pid: process.pid,
    port: 0,
    workspace: STARTUP.workspace,
    startedAt: Date.now(),
  };
  await writeInstanceMetadata(STARTUP.layout.portFile, instanceMetadata);

  const workspaceLock = new WorkspaceLockCoordinator({
    dataRoot: STARTUP.dataRoot,
    instanceId: STARTUP.instanceId,
  });
  activeWorkspaceLock = workspaceLock;
  await workspaceLock.acquireInitial(STARTUP.workspace);
  try {
    await recordOpenedWorkspace(SETTINGS_FILE, STARTUP.workspace, {
      transientWorkspace: resolve(STARTUP.layout.instanceRoot, "empty-workspace"),
    });
  } catch (error) {
    console.warn("Failed to record opened workspace:", error);
  }
  writeWorkspaceMetadata(DATA_DIR, STARTUP.workspace);

  // ─── 共享可变状态 ────────────────────────────────────────────
  const chatStream: ChatStreamState = { textBuffer: "", thinkingBuffer: "", currentTextSnapshot: "", currentThinkingSnapshot: "", response: null, turnId: "", traceSeq: 0, emittedTraces: new Set(), blocks: [], blockSeq: 0, eventSeq: 0, eventHistory: [] };
  const appEvents = new AppEventHub();
  appEvents.subscribeClientRemoved(cancelPermissionConfirmationsForResponse);
  const unsubscribeMcpEvents = attachMcpEvents(appEvents);
  const sessionPermissionState = createSessionPermissionState();
  let runtime: AgentRuntime;
  const security = createDesktopSecurityConfig();
  clearDesktopSessionTokenEnv();
  const rootRegistry = new RootRegistry();
  const permissionService = new ServerPermissionService({
    sessionPermissionState,
    workspaceRootProvider: () => runtime?.currentWorkspace || STARTUP.workspace,
    rootRegistry,
    confirmPermission: createPermissionConfirmCallback(appEvents),
    auditStore: new FilePermissionAuditStore(STARTUP.layout.permissionAuditFile, { maxEntries: 2000 }),
    permissionRuleStore: new FileWorkspacePermissionRuleStore(STARTUP.layout.permissionRulesFile),
  });
  const permissionMode = createPermissionModeController("standard", (mode) => {
    permissionService.recordPermissionModeChange(mode, "permissions.mode");
  });

  runtime = await initAgent({
    agentDir: PI_CONFIG_DIR,
    cwd: STARTUP.workspace,
    sessionsDir: SESSIONS_DIR,
    sessionsDirForWorkspace: (workspace) => workspaceDataPaths(DATA_DIR, workspace).sessionsDir,
    authFile: STARTUP.layout.authFile,
    modelsFile: STARTUP.layout.modelsFile,
    getPermissionMode: () => permissionMode.get(),
    shellDialect: shellDialectFromEnv(),
    confirmCommand: createCommandConfirmCallback(chatStream),
    desktopApiToken: security.token,
    sessionPermissionState,
    authorizePath: (root, target, operation, source) => permissionService.authorizePath(root, target, operation, source),
    authorizeTool: (request) => permissionService.authorizeTool(request),
    applyPermissionSuggestions: async (suggestions, scope) => {
      await permissionService.applyPermissionSuggestions(suggestions, scope);
    },
  });

  for (const [root, source] of [
    [APP_ROOT, "app-data"],
    [DATA_DIR, "app-data"],
    [PI_CONFIG_DIR, "app-data"],
    [SESSIONS_DIR, "session"],
    [STARTUP.layout.workspaceRoot, "app-data"],
    [STARTUP.layout.instanceRoot, "app-data"],
  ] as const) {
    try {
      rootRegistry.register(root, {
        source,
        operations: ["read", "write", "create", "remove"],
      });
    } catch {
      // Optional data roots may not exist until the agent initializes them.
    }
  }
  try {
    rootRegistry.setWorkspaceRoot(runtime.currentWorkspace || STARTUP.workspace);
  } catch {
    // Permission checks remain fail-closed if the initial workspace is unavailable.
  }

  console.log("Pi session ready");
  mark("agent_ready");

  const baseCtx: ServerContext = {
    runtime,
    chatStream,
    appEvents,
    security,
    permissionService,
    permissionMode,
    workspaceLock,
    rootRegistry,
    recordUserNote: (note) => recordUserNoteBlock(runtime, chatStream, note, {
      authorizeSessionWrite: (sessionFile, source) => {
        const sessionsDir = workspaceDataPaths(DATA_DIR, runtime.currentWorkspace || STARTUP.workspace).sessionsDir;
        permissionService.authorizePathSync(sessionsDir, sessionFile, "write", source);
      },
    }),
    paths: {
      APP_ROOT,
      DATA_DIR,
      PI_CONFIG_DIR,
      SESSIONS_DIR,
      SETTINGS_FILE,
      DATA_ROOT_POINTER_FILE,
      STARTUP: STARTUP_SNAPSHOT,
      FRONTEND_DIR,
      FRONTEND_SRC_DIR,
      HAS_BUILT_FRONTEND,
    },
  };

  // ─── 启动恢复：只恢复本实例显式指定的 workspace ─────────────
  try {
    const state = await readWorkspaceUiState(baseCtx, STARTUP.workspace);
    if (state.activeView?.type === "session" && state.activeView.id) {
      console.log(`[startup] 恢复 workspace: "${STARTUP.workspace}", session: ${state.activeView.id}`);
      const { findAuthorizedSessionFileById } = await import("./routes/sessions.js");
      const sessionFile = await findAuthorizedSessionFileById(baseCtx, state.activeView.id, "sessions.startup.restore");
      if (sessionFile) await runtime.openSession(sessionFile, STARTUP.workspace);
    }
  } catch (e) {
    console.log(`[startup] 恢复失败: ${e}`);
  }

  const workspaceWatcher = new WorkspaceFileWatcher({
    appRoot: APP_ROOT,
    onChange: (file) => appEvents.publish("explorer.changed", { file }),
    onWatching: (workspace) => console.log("[watcher] watching " + workspace),
    onError: (error) => console.log("[watcher] not available: " + error.message),
  });
  let openedWorkspaceRecordTail = Promise.resolve();
  const enqueueOpenedWorkspaceRecord = (workspace: string): void => {
    openedWorkspaceRecordTail = openedWorkspaceRecordTail
      .then(() => recordOpenedWorkspace(SETTINGS_FILE, workspace, {
        transientWorkspace: resolve(STARTUP.layout.instanceRoot, "empty-workspace"),
      }))
      .then(
        () => undefined,
        (error) => { console.warn("Failed to record opened workspace:", error); },
      );
  };
  const unsubscribeWorkspaceWatcher = runtime.onWorkspaceChange((workspace) => {
    instanceMetadata.workspace = workspace;
    void writeInstanceMetadata(STARTUP.layout.portFile, instanceMetadata).catch((error) => {
      console.error("Failed to update instance workspace metadata:", error);
    });
    const workspacePaths = workspaceDataPaths(DATA_DIR, workspace);
    mkdirSync(workspacePaths.sessionsDir, { recursive: true });
    writeWorkspaceMetadata(DATA_DIR, workspace);
    try {
      rootRegistry.register(workspacePaths.workspaceRoot, {
        source: "app-data",
        operations: ["read", "write", "create", "remove"],
      });
      rootRegistry.register(workspacePaths.sessionsDir, {
        source: "session",
        operations: ["read", "write", "create", "remove"],
      });
      rootRegistry.setWorkspaceRoot(workspace);
    } catch {}
    workspaceWatcher.watchWorkspace(workspace);
    enqueueOpenedWorkspaceRecord(workspace);
  });
  workspaceWatcher.watchWorkspace(runtime.currentWorkspace || STARTUP.workspace);

  attachSessionEvents(runtime, chatStream, baseCtx);

  // ─── tsserver（TypeScript 语言服务，延迟启动）────────────────────
  const tsServer = new TsserverManager();

  // ─── 上下文对象 ──────────────────────────────────────────────────
  const ctx: ServerContext = {
    ...baseCtx,
    tsServer,
  };

  // ─── HTTP 服务器 ─────────────────────────────────────────────
  const server = createServer(async (req, res) => {
    const url = req.url ?? "/";
    const cors = { "Access-Control-Allow-Origin": "*" };
    installSecurityHeaders(req, res, ctx.security);

    const securityDecision = authorizeLocalApiRequest(req, ctx.security);
    if (!securityDecision.ok) {
      writeSecurityError(res, securityDecision);
      return;
    }
    if (isApiPreflight(req)) {
      res.writeHead(204);
      res.end();
      return;
    }

    // favicon — 返回空内容避免控制台 404 报错
    if (url === "/favicon.ico") {
      res.writeHead(200, { "Content-Type": "image/x-icon" });
      res.end();
      return;
    }

    // 图标文件 — 始终从 src/frontend/icons/ 提供
    const reqPath = url.includes("?") ? url.slice(0, url.indexOf("?")) : url;
    if (reqPath.startsWith("/icons/") && reqPath.endsWith(".svg")) {
      try {
        const iconRoot = HAS_BUILT_FRONTEND ? FRONTEND_DIR : FRONTEND_SRC_DIR;
        const iconFile = resolveStaticAssetPath(iconRoot, reqPath);
        const content = readFileSync(iconFile);
        res.writeHead(200, { "Content-Type": "image/svg+xml", "Cache-Control": "max-age=3600" });
        res.end(content);
      } catch {
        res.writeHead(404);
        res.end("Not found");
      }
      return;
    }

    // 静态文件 — 构建产物优先，无则从 src/ 回退
    if (HAS_BUILT_FRONTEND) {
      const filePath = reqPath === "/" ? `/${FRONTEND_ENTRY_FILE}` : reqPath;
      const fullPath = resolveStaticAssetPath(FRONTEND_DIR, filePath);
      if (existsSync(fullPath) && statSync(fullPath).isFile()) {
        const content = readFileSync(fullPath);
        res.writeHead(200, { "Content-Type": contentTypeForStaticAsset(fullPath) });
        res.end(content);
        return;
      }
    } else {
      // 开发模式：从 src/ 直接服务静态文件
      const pathname = url.includes("?") ? url.slice(0, url.indexOf("?")) : url;
      if ((pathname.startsWith("/dashboard") || pathname.startsWith("/ui/") || pathname.startsWith("/pane/") || pathname.startsWith("/service/") || pathname.startsWith("/devicon") || pathname.startsWith("/fonts/") || pathname.startsWith("/devicon-colors") || pathname.startsWith("/icons/") || pathname.startsWith("/core/") || pathname.startsWith("/shell/") || pathname.startsWith("/services/")) && (pathname.endsWith(".css") || pathname.endsWith(".js") || pathname.endsWith(".svg") || pathname.endsWith(".woff") || pathname.endsWith(".woff2"))) {
        const ext = pathname.endsWith(".css") ? "css" : pathname.endsWith(".svg") ? "svg+xml" : pathname.endsWith(".woff") ? "font/woff" : pathname.endsWith(".woff2") ? "font/woff2" : "javascript";
                const isText = ext === "css" || ext === "javascript" || ext === "svg+xml";
                try {
                  const filePath = resolveStaticAssetPath(FRONTEND_SRC_DIR, pathname);
          if (isText) {
            const content = readFileSync(filePath, "utf-8");
            res.writeHead(200, { "Content-Type": `text/${ext}; charset=utf-8` });
            res.end(content);
          } else {
            const content = readFileSync(filePath);
            res.writeHead(200, { "Content-Type": ext });
            res.end(content);
          }
        } catch {
          res.writeHead(404);
          res.end("Not found");
        }
        return;
      }
    }

    // 主页
    if (url === "/" || url === "/index.html") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(getDashboardHTML(ctx));
      return;
    }

    // SSE: 文件变更事件
    if (url === "/api/events" && req.method === "GET") {
      openAppEventStream(req, res, appEvents, cors);
      return;
    }

    // 领域路由分发
    const handled = await dispatchRoute(req, res, ctx);
    if (handled) return;

    // 404
    res.writeHead(404);
    res.end("Not found");
  });

  const devPort = parseInt(process.env.PI_DEV_PORT || "0", 10);
  server.listen(devPort || 0, "127.0.0.1", () => {
    const addr = server.address();
    if (addr && typeof addr === "object") {
      const port = addr.port;
      process.env.SERVER_PORT = String(port);
      void workspaceLock.updatePort(port).then(async () => {
        instanceMetadata.port = port;
        await writeInstanceMetadata(STARTUP.layout.portFile, instanceMetadata);
        console.log(`SERVER_PORT:${port}`);
        mark("http_listening");
        logTiming();
        console.log(`Pi Desktop server: http://127.0.0.1:${port}`);
      }).catch((error) => {
        console.error("Failed to update workspace lock:", error);
        server.close();
        void releaseActiveWorkspaceLock()
          .catch((releaseError) => console.error("Failed to release workspace lock:", releaseError))
          .finally(() => process.exit(1));
      });
    }
    // ─── 文件系统监听 ──────────────────────────────────────────
  });

  let releaseInstancePromise: Promise<void> | null = null;
  const closeInstanceStreams = () => {
    appEvents.closeAll();
    const response = chatStream.response;
    if (!response) return;
    cancelCommandConfirmationsForResponse(response);
    try { response.end(); } catch {}
    if (chatStream.response === response) chatStream.response = null;
  };
  const releaseInstanceResources = (removeRuntimeData: boolean): Promise<void> => {
    if (releaseInstancePromise) return releaseInstancePromise;
    releaseInstancePromise = (async () => {
      closeInstanceStreams();
      unsubscribeMcpEvents();
      unsubscribeWorkspaceWatcher();
      workspaceWatcher.close();
      tsServer.stop();
      try {
        await permissionService.flushAuditWrites();
      } catch (error) {
        console.error("Failed to flush permission audit:", error);
      }
      try {
        await openedWorkspaceRecordTail;
      } catch (error) {
        console.warn("Failed to finish opened workspace recording:", error);
      }
      runtime.dispose();
      try {
        await releaseActiveWorkspaceLock();
      } catch (error) {
        console.error("Failed to release workspace lock:", error);
      }
      if (removeRuntimeData) {
        try {
          await removeInstanceRuntimeDirectory(STARTUP.layout.instanceRoot);
        } catch (error) {
          console.error("Failed to remove instance runtime data:", error);
        }
        if (TRANSIENT_EMPTY_WORKSPACE) {
          try {
            await removeInstanceRuntimeDirectory(STARTUP.layout.workspaceRoot);
          } catch (error) {
            console.error("Failed to remove transient workspace data:", error);
          }
        }
      }
    })();
    return releaseInstancePromise;
  };

  server.on("close", () => {
    void releaseInstanceResources(false);
  });
  server.on("error", (error) => {
    console.error("Server error:", error);
    void releaseInstanceResources(false)
      .finally(() => process.exit(1));
  });

  let shuttingDown = false;
  const shutdown = (signal: NodeJS.Signals | "stdin") => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[server] ${signal}, shutting down`);
    closeInstanceStreams();
    server.close();
    void releaseInstanceResources(true).finally(() => process.exit(0));
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    if (String(chunk).split(/\r?\n/).includes("PI_SERVER_SHUTDOWN")) shutdown("stdin");
  });
  if (process.env.PI_ELECTRON_PARENTED === "1") {
    process.stdin.once("end", () => shutdown("stdin"));
    process.stdin.once("close", () => shutdown("stdin"));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(async (err) => {
    console.error("Fatal error:", err);
    try {
      await releaseActiveWorkspaceLock();
    } catch (releaseError) {
      console.error("Failed to release workspace lock:", releaseError);
    }
    process.exitCode = 1;
  });
}

// ═══════════════════════════════════════════════════════════════════
//  HTML TEMPLATE — 从独立文件读取
// ═══════════════════════════════════════════════════════════════════

function getDashboardHTML(ctx: ServerContext): string {
  if (ctx.paths.HAS_BUILT_FRONTEND) {
    return readFileSync(resolve(ctx.paths.FRONTEND_DIR, FRONTEND_ENTRY_FILE), "utf-8");
  }
  return readFileSync(
    resolve(dirname(fileURLToPath(import.meta.url)), "..", "frontend", "dashboard.html"),
    "utf-8"
  );
}
