/**
 * My Code Agent — Pi 服务器
 * 作为子进程运行，通过 HTTP 提供仪表盘和对话 API
 *
 * 环境变量：
 *   PI_DESKTOP_DATA    - 数据目录
 *   PI_DESKTOP_CONFIG  - pi 配置目录
 *   PI_DESKTOP_SESSIONS - 会话目录
 */
import { initAgent, type AgentRuntime } from "../agent/index";
import { createServer } from "http";
import { resolve, dirname } from "path";
import { fileURLToPath, pathToFileURL } from "url";
import { appendFileSync, readFileSync, writeFileSync, existsSync, statSync, watch } from "fs";
import { dispatchRoute } from "./routes/index";
import type { ServerContext, ChatStreamState, TraceEvent, AssistantBlock } from "./routes/types";
import { TsserverManager } from "./ts-server";
// 不再移动活跃 session 文件——只在 header 标记 workspace
export function tagSessionHeader(sessionFile: string | undefined, ws: string): void {
  if (!sessionFile) return
  try {
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
const DATA_DIR = process.env.PI_DESKTOP_DATA || resolve(APP_ROOT, "data");
const PI_CONFIG_DIR = process.env.PI_DESKTOP_CONFIG || resolve(APP_ROOT, "data", "pi");
const SESSIONS_DIR = process.env.PI_DESKTOP_SESSIONS || resolve(APP_ROOT, "data", "pi", "sessions");
const SETTINGS_FILE = resolve(PI_CONFIG_DIR, "settings.json");
const FRONTEND_DIR = resolve(APP_ROOT, "dist", "frontend");
const HAS_BUILT_FRONTEND = existsSync(resolve(FRONTEND_DIR, "index.html"));
const FRONTEND_SRC_DIR = resolve(APP_ROOT, "src", "frontend");

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

export function flushPendingTracePersist(runtime: AgentRuntime, turnId: string): void {
  if (!turnId) return;
  const entries = [...pendingTracePersist.entries()]
    .filter(([key]) => key.startsWith(`${turnId}:`))
    .map(([, trace]) => trace)
    .sort((a, b) => (a.seq || 0) - (b.seq || 0));
  for (const trace of entries) {
    persistTraceEvent(runtime, trace, { force: true });
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

export function persistBlockEvent(runtime: AgentRuntime, block: AssistantBlock): boolean {
  const sessionFile = runtime.session.sessionFile;
  if (!sessionFile || !block.turnId) return false;
  const sessionFlushed = Boolean((runtime.session.sessionManager as any)?.flushed);
  if (!sessionFlushed || !existsSync(sessionFile)) {
    pendingBlockPersist.set(blockPersistKey(block), block);
    return false;
  }
  try {
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

export function flushPendingBlockPersist(runtime: AgentRuntime, turnId: string): void {
  if (!turnId) return;
  const entries = [...pendingBlockPersist.entries()]
    .filter(([key]) => key.startsWith(`${turnId}:`))
    .map(([, block]) => block)
    .sort((a, b) => (a.seq || 0) - (b.seq || 0));
  for (const block of entries) {
    persistBlockEvent(runtime, block);
  }
}

export function emitBlock(runtime: AgentRuntime, chatStream: ChatStreamState, block: AssistantBlock, options?: { persist?: boolean }): void {
  const idx = chatStream.blocks.findIndex(b => b.blockId === block.blockId);
  if (idx >= 0) chatStream.blocks[idx] = block;
  else chatStream.blocks.push(block);
  if (options?.persist !== false) {
    persistBlockEvent(runtime, block);
  }
  try {
    chatStream.response?.write(`data: ${JSON.stringify({ type: "block", block })}\n\n`);
  } catch { /* ignore */ }
}
export function persistTraceEvent(runtime: AgentRuntime, trace: TraceEvent, options?: { force?: boolean; minIntervalMs?: number }): boolean {
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

export function emitTrace(runtime: AgentRuntime, chatStream: ChatStreamState, trace: TraceEvent, options?: { force?: boolean; minIntervalMs?: number }): void {
  const turnId = trace.turnId || chatStream.turnId;
  if (!turnId) return;
  const normalized = assignTraceSeq(chatStream, { ...trace, turnId } as TraceEvent);
  persistTraceEvent(runtime, normalized, options);
  try {
    chatStream.response?.write(`data: ${JSON.stringify({ type: "trace", trace: normalized })}\n\n`);
  } catch { /* ignore */ }
}

export function attachSessionEvents(runtime: AgentRuntime, chatStream: ChatStreamState): void {
  runtime.onEvent((event: any) => {
    if (!chatStream.response && event.type !== "agent_end") return;

    const turnId = chatStream.turnId || (event.turnIndex !== undefined ? `turn-${event.turnIndex}` : "");
    const tid = (event.toolCallId || event.id || event.type) + "@" + turnId;

    // lifecycle 步骤不再生成 step 事件（旧 session 仍可回放，新 session 不再写入）
    if (event.type === "message_end" && event.message?.role === "toolResult") {
      flushPendingTracePersist(runtime, turnId);
    }
    if (event.type === "turn_end") {
      flushPendingTracePersist(runtime, turnId);
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
        emitTrace(runtime, chatStream, trace, { force: true });
        const seq = nextBlockSeq(chatStream);
        const block: AssistantBlock = {
          type: "tool_use", status: "running",
          toolCallId: event.toolCallId || "",
          name: event.toolName || "unknown",
          input: event.args,
          turnId,
          blockId: "tool-" + seq,
          seq,
        };
        emitBlock(runtime, chatStream, block);
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
      emitTrace(runtime, chatStream, trace, { minIntervalMs: 250 });
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
          turnId,
          id: tid,
        };
        emitTrace(runtime, chatStream, trace, { force: true });
        const seq = nextBlockSeq(chatStream);
        const block: AssistantBlock = {
          type: "tool_result", toolUseId: event.toolCallId || "",
          output: event.result,
          isError: event.isError === true,
          turnId,
          blockId: "result-" + seq,
          seq,
        };
        emitBlock(runtime, chatStream, block);
      }
    }

    // ─── Thinking trace ──────────────────────────────────────
    if (event.type === "message_update" && turnId) {
      if (!chatStream.response) return;
      const msg = event.message;
      if (msg?.role === "assistant" && msg?.content) {
        const fullText = msg.content.filter((c: any) => c.type === "text").map((c: any) => c.text || "").join("");
        const fullThinking = msg.content.filter((c: any) => c.type === "thinking").map((c: any) => c.thinking || "").join("");

        const textState = appendAssistantSnapshot(chatStream.textBuffer, chatStream.currentTextSnapshot, fullText);
        const thinkingState = appendAssistantSnapshot(chatStream.thinkingBuffer, chatStream.currentThinkingSnapshot, fullThinking);

        chatStream.currentTextSnapshot = textState.snapshot;
        chatStream.currentThinkingSnapshot = thinkingState.snapshot;

        if (textState.delta) {
          chatStream.textBuffer = textState.aggregate;
          try {
            chatStream.response.write(`data: ${JSON.stringify({ type: "delta", text: textState.delta })}\n\n`);
          } catch { /* ignore */ }
          // 同步更新 text block（流式不持久化）
          if (chatStream.textBuffer) {
            const block: AssistantBlock = {
              type: "text",
              text: chatStream.textBuffer,
              turnId,
              blockId: "text-0",
              seq: nextBlockSeq(chatStream),
            };
            emitBlock(runtime, chatStream, block, { persist: false });
          }
        }
        if (thinkingState.delta) {
          chatStream.thinkingBuffer = thinkingState.aggregate;
          // 每收到一段 thinking 都发一条 trace 更新
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
          emitTrace(runtime, chatStream, trace, { minIntervalMs: 250 });
          // 同步更新 thinking block（流式不持久化）
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
        flushPendingTracePersist(runtime, turnId);
        emitTrace(runtime, chatStream, trace, { force: true });
      }
      flushPendingTracePersist(runtime, turnId);
      flushPendingBlockPersist(runtime, turnId);

      // 持久化流式 text / thinking block（之前 persist: false 未落盘）
      for (const block of chatStream.blocks) {
        if (block.type === "text" || block.type === "thinking") {
          persistBlockEvent(runtime, block);
        }
      }

      if (ws) {
        console.log(`  agent_end: tagging workspace "${ws}" session=${sessionId}`);
        tagSessionHeader(runtime.session.sessionFile, ws);
      }

      try {
        chatStream.response?.write(`data: ${JSON.stringify({
          type: "done",
          text: chatStream.textBuffer,
          thinking: chatStream.thinkingBuffer || undefined,
          turnId,
          sessionId,
          blocks: chatStream.blocks,
        })}\n\n`);
        chatStream.response?.end();
      } catch { /* ignore */ }
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
      chatStream.currentWorkspace = "";
    }
  });
}

async function main() {
  console.log("Starting Pi server...");

  const runtime = await initAgent({
    agentDir: PI_CONFIG_DIR,
    cwd: APP_ROOT,
    sessionsDir: SESSIONS_DIR,
    authFile: resolve(PI_CONFIG_DIR, "auth.json"),
    modelsFile: resolve(PI_CONFIG_DIR, "models.json"),
  });

  console.log("Pi session ready");

  // ─── 共享可变状态 ────────────────────────────────────────────
  const chatStream: ChatStreamState = { textBuffer: "", thinkingBuffer: "", currentTextSnapshot: "", currentThinkingSnapshot: "", response: null, turnId: "", traceSeq: 0, emittedTraces: new Set(), blocks: [], blockSeq: 0 };
  attachSessionEvents(runtime, chatStream);

  // ─── SSE 客户端集合（用于文件变更推送）──────────────────────────
  const sseClients: import("http").ServerResponse[] = [];

  // ─── tsserver（TypeScript 语言服务，延迟启动）────────────────────
  const tsServer = new TsserverManager();

  // ─── 上下文对象 ──────────────────────────────────────────────────
  const ctx: ServerContext = {
    runtime,
    chatStream,
    sseClients,
    tsServer,
    paths: {
      APP_ROOT,
      DATA_DIR,
      PI_CONFIG_DIR,
      SESSIONS_DIR,
      SETTINGS_FILE,
      FRONTEND_DIR,
      FRONTEND_SRC_DIR,
      HAS_BUILT_FRONTEND,
    },
  };

  // ─── HTTP 服务器 ─────────────────────────────────────────────
  const server = createServer(async (req, res) => {
    const url = req.url ?? "/";
    const cors = { "Access-Control-Allow-Origin": "*" };

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
        const iconFile = resolve(FRONTEND_SRC_DIR, reqPath.slice(1));
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
      const filePath = url === "/" ? "/index.html" : url;
      const fullPath = resolve(FRONTEND_DIR, filePath.slice(1));
      if (existsSync(fullPath) && statSync(fullPath).isFile()) {
        const ext = fullPath.endsWith(".css") ? "css" : "javascript";
        const content = readFileSync(fullPath, fullPath.endsWith(".html") ? "utf-8" : "utf-8");
        res.writeHead(200, { "Content-Type": `text/${ext}; charset=utf-8` });
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
          const filePath = resolve(FRONTEND_SRC_DIR, pathname.slice(1));
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
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        ...cors,
      });
      res.write("data: {\"type\":\"connected\"}\n\n");
      sseClients.push(res);
      req.on("close", () => {
        const idx = sseClients.indexOf(res);
        if (idx !== -1) sseClients.splice(idx, 1);
      });
      return;
    }

    // 领域路由分发
    const handled = await dispatchRoute(req, res, ctx);
    if (handled) return;

    // 404
    res.writeHead(404);
    res.end("Not found");
  });

  let watchTimer: ReturnType<typeof setTimeout> | null = null;

  const devPort = parseInt(process.env.PI_DEV_PORT || "0", 10);
  server.listen(devPort || 0, "127.0.0.1", () => {
    const addr = server.address();
    if (addr && typeof addr === "object") {
      const port = addr.port;
      process.env.SERVER_PORT = String(port);
      console.log(`SERVER_PORT:${port}`);
      console.log(`Pi Desktop server: http://127.0.0.1:${port}`);
    }
    // ─── 文件系统监听 ──────────────────────────────────────────
    try {
      watch(APP_ROOT, { recursive: true }, (eventType: string, filename: string | null) => {
        if (!filename) return;
        const normalized = filename.replace(/\\/g, "/");
        if (normalized.startsWith("data/") || normalized.startsWith("node_modules/") || normalized.startsWith(".git/") || normalized.startsWith(".claude/") || normalized.startsWith("dist/") || normalized.startsWith("example/") || normalized.startsWith("src/frontend/gen/")) return;
        if (watchTimer) clearTimeout(watchTimer);
        watchTimer = setTimeout(() => {
          const msg = `data: ${JSON.stringify({ type: "refresh", file: filename })}\n\n`;
          for (const client of sseClients) {
            try { client.write(msg); } catch { /* ignore */ }
          }
        }, 500);
      });
      console.log("[watcher] watching " + APP_ROOT);
    } catch (e: unknown) { const msg = e instanceof Error ? (e as Error).message : String(e);
      console.log("[watcher] not available: " + msg);
    }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error("Fatal error:", err);
    process.exit(1);
  });
}

// ═══════════════════════════════════════════════════════════════════
//  HTML TEMPLATE — 从独立文件读取
// ═══════════════════════════════════════════════════════════════════

function getDashboardHTML(ctx: ServerContext): string {
  if (ctx.paths.HAS_BUILT_FRONTEND) {
    return readFileSync(resolve(ctx.paths.FRONTEND_DIR, "index.html"), "utf-8");
  }
  return readFileSync(
    resolve(dirname(fileURLToPath(import.meta.url)), "..", "frontend", "dashboard.html"),
    "utf-8"
  );
}
