/**
 * Chat routes — POST /api/chat, GET /api/chat/stream (SSE)
 */
import { resolveEngine, type ChatStreamState, type RouteHandler } from "./types.js";
import { processAttachments, buildContextBlock } from "./attach.js";
import type { CommandConfirmationRequest, CommandConfirmationResult } from "../../agent/types.js";
import { writeServerPermissionError } from "../permission-service.js";
import { writePathGuardError } from "./path-guard.js";
import { WorkspaceLockConflictError } from "../workspace-lock.js";
import { authorizeWorkspacePath, switchAuthorizedWorkspace } from "./workspace-authorization.js";
import { replayChatEvents, resetChatEventHistory, writeChatEvent, writeChatStreamBaseline } from "../chat-stream.js";
import { serverConfirmationRegistry } from "../confirmation-registry.js";
import { expandTaskRequirements, formatExecutionContractGuidance, inferTaskRequirements } from "../task-lifecycle.js";
import { randomUUID } from "node:crypto";

const COMMAND_CONFIRM_TIMEOUT_MS = 120_000;
const MODEL_PROVIDER_SYNC_ERROR = "模型提供商同步失败，请重试。";

const E2E_LONG_TOOL_MESSAGE = "__my_code_agent_e2e_long_tool__";

function waitForE2EProbe(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runE2ELongToolTurn(chatStream: ChatStreamState): Promise<void> {
  const turnId = chatStream.turnId;
  const traceId = chatStream.traceId;
  const toolCallId = `e2e-tool-${Date.now().toString(36)}`;
  const thinkingBlock = { type: "thinking" as const, status: "streaming" as const, text: "准备长工具", turnId, traceId, blockId: "e2e-thought", seq: 1 };
  const toolBlock = { type: "tool" as const, status: "running" as const, name: "command", input: { command: "long-e2e-command" }, toolCallId, turnId, traceId, blockId: "e2e-tool", seq: 2 };
  const textBlock = { type: "text" as const, text: "长工具执行完成", turnId, traceId, blockId: "e2e-text", seq: 3 };
  writeChatEvent(chatStream, { type: "block", block: thinkingBlock });
  writeChatEvent(chatStream, { type: "block", block: toolBlock });
  // Keep the tool block open long enough to overlap the independent desktop requests.
  await waitForE2EProbe(1_200);
  const completedTool = { ...toolBlock, status: "success" as const, output: "long tool result" };
  const completedThought = { ...thinkingBlock, status: "done" as const };
  const terminalBlocks = [completedThought, completedTool, textBlock];
  writeChatEvent(chatStream, { type: "block", block: completedTool });
  writeChatEvent(chatStream, { type: "block", block: textBlock });
  writeChatEvent(chatStream, { type: "done", turnId, text: textBlock.text, blocks: terminalBlocks });
}

function terminateChatTurn(chatStream: ChatStreamState, message: string): void {
  writeChatEvent(chatStream, { type: "error", message });
  try { chatStream.response?.end(); } catch { /* ignore */ }
  chatStream.response = null;
  chatStream.textBuffer = "";
  chatStream.thinkingBuffer = "";
  chatStream.currentTextSnapshot = "";
  chatStream.currentThinkingSnapshot = "";
  chatStream.turnId = "";
  chatStream.traceId = "";
  chatStream.correlation = undefined;
  chatStream.traceSeq = 0;
  chatStream.blockSeq = 0;
  chatStream.blocks = [];
  chatStream.textSegments = [];
  chatStream.activeTextInput = undefined;
  chatStream.textBlockGenerations = {};
  chatStream.activeThinkingInput = undefined;
  chatStream.thinkingBlockGenerations = {};
  chatStream.emittedTraces = new Set();
  chatStream.currentWorkspace = "";
}

export function createCommandConfirmCallback(chatStream: ChatStreamState) {
  return async (cmd: string, reason: string, request?: CommandConfirmationRequest): Promise<CommandConfirmationResult> => {
    const response = chatStream.response;
    if (!response) return { allow: false };

    const pending = serverConfirmationRegistry.begin("command", [response], COMMAND_CONFIRM_TIMEOUT_MS);
    try {
      writeChatEvent(chatStream, {
        type: "command_confirm",
        id: pending.id,
        command: cmd,
        reason,
        permissionSuggestions: request?.permissionSuggestions ?? [],
      });
    } catch {
      serverConfirmationRegistry.resolve(pending.id, "command", { allow: false });
    }
    return pending.result;
  };
}

export function resolveCommandConfirmation(id: string, decision: CommandConfirmationResult): boolean {
  return serverConfirmationRegistry.resolve(id, "command", decision);
}

export function cancelCommandConfirmationsForResponse(response: import("http").ServerResponse): void {
  serverConfirmationRegistry.removeResponse(response, "command");
}

export const handleChat: RouteHandler = (req, res, ctx) => {
  const { url, method } = req;
  const cors = { "Access-Control-Allow-Origin": "*" };
  const { runtime, chatStream, paths: p } = ctx;
  const engine = resolveEngine(ctx);

  if (url === "/api/chat/command-confirm" && method === "POST") {
    let body = "";
    req.on("data", (chunk: Buffer) => { body += chunk.toString(); });
    req.on("end", () => {
      try {
        const parsed = JSON.parse(body || "{}");
        const id = typeof parsed.id === "string" ? parsed.id : "";
        if (!id) {
          res.writeHead(400, { "Content-Type": "application/json", ...cors });
          res.end(JSON.stringify({ ok: false, error: "Missing confirmation id" }));
          return;
        }
        const allow = parsed.allow === true;
        const scope = parsed.scope === "workspace"
          ? "workspace"
          : parsed.scope === "once" ? "once" : "session";
        const settled = resolveCommandConfirmation(id, allow ? { allow: true, scope } : { allow: false });
        res.writeHead(200, { "Content-Type": "application/json", ...cors });
        res.end(JSON.stringify({ ok: settled }));
      } catch (err: unknown) {
        res.writeHead(400, { "Content-Type": "application/json", ...cors });
        res.end(JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) }));
      }
    });
    return true;
  }

  // Queue a user note into the currently running SDK session without starting a second prompt.
  if (url === "/api/chat/note" && method === "POST") {
    let body = "";
    req.on("data", (chunk: Buffer) => { body += chunk.toString(); });
    return new Promise<boolean>((done) => req.on("end", async () => {
      try {
        const parsed = JSON.parse(body || "{}");
        const message = typeof parsed.message === "string" ? parsed.message.trim() : "";
        const mode = parsed.mode === undefined ? "steer" : parsed.mode;
        const noteId = typeof parsed.noteId === "string" && parsed.noteId.trim()
          ? parsed.noteId.trim()
          : "note-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8);
        if (!message || (mode !== "steer" && mode !== "followUp")) {
          res.writeHead(400, { "Content-Type": "application/json", ...cors });
          res.end(JSON.stringify({ ok: false, error: "message and mode are invalid" }));
          return;
        }
        if (!engine.session.isStreaming) {
          res.writeHead(409, { "Content-Type": "application/json", ...cors });
          res.end(JSON.stringify({ ok: false, error: "No active streaming session" }));
          return;
        }
        if (mode === "followUp") await engine.followUp(message);
        else await engine.steer(message);
        ctx.recordUserNote?.({ noteId, message, mode });
        res.writeHead(200, { "Content-Type": "application/json", ...cors });
        res.end(JSON.stringify({ ok: true, mode, noteId }));
      } catch (err: unknown) {
        res.writeHead(400, { "Content-Type": "application/json", ...cors });
        res.end(JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) }));
      } finally {
        done(true);
      }
    }));
  }

  // Stop is separate from the send/note action while the composer remains usable.
  if (url === "/api/chat/abort" && method === "POST") {
    try {
      void engine.cancel(chatStream.turnId || undefined);
      res.writeHead(200, { "Content-Type": "application/json", ...cors });
      res.end(JSON.stringify({ ok: true }));
    } catch (err: unknown) {
      res.writeHead(409, { "Content-Type": "application/json", ...cors });
      res.end(JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) }));
    }
    return true;
  }

  if (url === "/api/workspace/switch" && method === "POST") {
    let body = "";
    req.on("data", (chunk: Buffer) => { body += chunk.toString(); });
    req.on("end", async () => {
      try {
        const { workspace: requestedWorkspace } = JSON.parse(body);
        const result = await switchAuthorizedWorkspace(ctx, requestedWorkspace);
        res.writeHead(200, { "Content-Type": "application/json", ...cors });
        res.end(JSON.stringify({ ok: true, workspace: result.workspace, switched: result.switched }));
      } catch (err: unknown) { const msg = err instanceof Error ? (err as Error).message : String(err);
        console.log(`❌ Workspace switch error: ${msg}`);
        if (err instanceof WorkspaceLockConflictError) {
          res.writeHead(err.statusCode, { "Content-Type": "application/json", ...cors });
          res.end(JSON.stringify({ error: err.message, code: err.code, owner: err.owner }));
          return;
        }
        if (writeServerPermissionError(res, cors, err)) return;
        if (writePathGuardError(res, cors, err)) return;
        res.writeHead(400, { ...cors });
        res.end(JSON.stringify({ error: msg }));
      }
    });
    return true;
  }

  // Send chat message
  if (url === "/api/chat" && method === "POST") {
    let body = "";
    req.on("data", (chunk: Buffer) => { body += chunk.toString(); });
    req.on("end", async () => {
      try {
        const parsed = JSON.parse(body);
        const { message, workspace: requestedWorkspace, attachments } = parsed;
        const workspace = await authorizeWorkspacePath(ctx, requestedWorkspace, "chat.workspace");
        if (workspace && engine.session.workspace !== workspace) {
          console.log(`📂 Chat with workspace: ${workspace} (was: ${engine.session.workspace})`);
          await switchAuthorizedWorkspace(ctx, workspace, "chat.workspace");
        }
        resetChatEventHistory(chatStream);
        console.log(`[chat] POST message="${message?.slice(0, 60)}${(message?.length || 0) > 60 ? "…" : ""}" ws="${workspace || "?"}" atts=${attachments?.length || 0}`);
        chatStream.textBuffer = "";
        chatStream.thinkingBuffer = "";
        chatStream.currentTextSnapshot = "";
        chatStream.currentThinkingSnapshot = "";
        chatStream.turnId = "turn-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 6);
        chatStream.traceId = randomUUID();
        chatStream.correlation = { traceId: chatStream.traceId, turnId: chatStream.turnId, sessionId: engine.session.id };
        chatStream.traceSeq = 0;
        chatStream.blockSeq = 0;
        chatStream.blocks = [];
        chatStream.textSegments = [];
        chatStream.activeTextInput = undefined;
        chatStream.textBlockGenerations = {};
        chatStream.activeThinkingInput = undefined;
        chatStream.thinkingBlockGenerations = {};
        chatStream.emittedTraces = new Set();
        chatStream.executionContractAttempts = new Set();
        const requestMessage = typeof message === "string" ? message : "";
        chatStream.taskRequirements = expandTaskRequirements(chatStream.taskRequirements, requestMessage)
          || inferTaskRequirements(requestMessage);
        chatStream.taskLifecycle = undefined;
        if (workspace) chatStream.currentWorkspace = workspace;
        if (process.env.MY_CODE_AGENT_E2E_CONCURRENCY === "1" && requestMessage === E2E_LONG_TOOL_MESSAGE) {
          void runE2ELongToolTurn(chatStream).catch((error: unknown) => {
            writeChatEvent(chatStream, { type: "error", message: error instanceof Error ? error.message : String(error) });
          });
          res.writeHead(200, { "Content-Type": "application/json", ...cors });
          res.end(JSON.stringify({ ok: true, e2e: "long_tool" }));
          return;
        }
        // 处理引用文件附件
        let finalMessage = message;
        if (attachments && Array.isArray(attachments) && attachments.length > 0) {
          const ws = workspace || p.APP_ROOT;
          console.log(`📎 Processing ${attachments.length} attachment(s)`);
          const { blocks } = await processAttachments(attachments, ws, ctx.permissionService);
          const contextBlock = buildContextBlock(blocks);
          if (contextBlock) {
            finalMessage = message + contextBlock;
            console.log(`📎 Added ${blocks.length} file(s) to context`);
          }
        }
        const contractGuidance = formatExecutionContractGuidance(chatStream.taskRequirements);
        if (contractGuidance) finalMessage = `${finalMessage}\n\n${contractGuidance}`;
        try {
          await engine.syncModelProviders();
        } catch {
          terminateChatTurn(chatStream, MODEL_PROVIDER_SYNC_ERROR);
          res.writeHead(503, { "Content-Type": "application/json", ...cors });
          res.end(JSON.stringify({ error: MODEL_PROVIDER_SYNC_ERROR }));
          return;
        }
        // 立即返回，不 await prompt()，SSE 流式推送 + agent_end 处理 workspace 标记
        console.log(`[chat] → engine.prompt()`);
        const promptStart = Date.now();
        engine.prompt({ message: finalMessage, turnId: chatStream.turnId }).catch((err: unknown) => {
          const msg = err instanceof Error ? err.message : String(err);
          const stack = err instanceof Error ? err.stack : "";
          const permissionFailure = (err as { metadata?: { permissionFailure?: { message?: unknown } } })?.metadata?.permissionFailure;
          const visibleMessage = typeof permissionFailure?.message === "string" ? permissionFailure.message : msg;
          console.log(`[chat] ❌ engine.prompt error after ${Date.now() - promptStart}ms: ${msg}`);
          if (stack) { console.log(`[chat]   stack:`, stack.split("\n").slice(0, 6).join("\n[chat]       ")); }
          // 通过 SSE 把错误推给前端，避免只显示空 "Pi"
          writeChatEvent(chatStream, {
            type: "error",
            message: visibleMessage,
            ...(permissionFailure ? { failure: permissionFailure } : {}),
          });
          try { chatStream.response?.end(); } catch { /* ignore */ }
          chatStream.response = null;
        });
        res.writeHead(200, { "Content-Type": "application/json", ...cors });
        res.end(JSON.stringify({ ok: true }));
      } catch (err: unknown) {
        if (writeServerPermissionError(res, cors, err)) return;
        if (writePathGuardError(res, cors, err)) return;
        res.writeHead(400, { ...cors });
        res.end(JSON.stringify({ error: (err as Error).message }));
      }
    });
    return true;
  }

  // Clear cache — 使 prompt sections 失效并刷新 system prompt
  if (url === "/api/clear" && method === "POST") {
    console.log(`🧹 /api/clear`);
    (async () => {
      try {
        const { invalidateAllSections } = await import("../../agent/prompts.js")
        invalidateAllSections()
        await runtime.refreshSystemPrompt()
        res.writeHead(200, { "Content-Type": "application/json", ...cors });
        res.end(JSON.stringify({ ok: true }));
      } catch (err: unknown) {
        res.writeHead(400, { ...cors });
        res.end(JSON.stringify({ error: (err as Error).message }));
      }
    })();
    return true;
  }

  // SSE chat stream
  if (url === "/api/chat/stream") {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
      ...cors,
    });
    const lastEventId = req.headers["last-event-id"];
    const reconnecting = typeof lastEventId === "string" && lastEventId.length > 0;
    if (chatStream.response && chatStream.response !== res && !reconnecting) {
      cancelCommandConfirmationsForResponse(chatStream.response);
    }
    chatStream.response = res;
    console.log(`[chat] SSE connected`);
    if (reconnecting) {
      replayChatEvents(chatStream, res, lastEventId as string);
    } else {
      writeChatStreamBaseline(chatStream, res);
      // The prompt can fail before the browser's first SSE request arrives.
      // Replay only a buffered terminal event. Replaying the whole history on
      // a fresh connection would duplicate already-rendered deltas/blocks.
      const lastEvent = chatStream.eventHistory?.at(-1);
      if (lastEvent && /"type":"(?:error|done|cancelled)"/.test(lastEvent.data)) {
        try { res.write(lastEvent.data); } catch { /* Client disconnected during setup. */ }
      }
    }
    req.on("close", () => {
      console.log(`[chat] SSE disconnected`);
      // A disconnected browser can no longer answer a command confirmation.
      // Remove its waiters immediately instead of keeping them until timeout.
      cancelCommandConfirmationsForResponse(res);
      if (chatStream.response === res) chatStream.response = null;
    });
    return true;
  }

  return false;
};
