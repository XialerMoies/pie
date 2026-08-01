/**
 * Chat routes — POST /api/chat, GET /api/chat/stream (SSE)
 */
import type { ServerResponse } from "http";
import type { ChatStreamState, RouteHandler } from "./types.js";
import { processAttachments, buildContextBlock } from "./attach.js";
import type { CommandConfirmationRequest, CommandConfirmationResult } from "../../agent/types.js";
import { writeServerPermissionError } from "../permission-service.js";
import { writePathGuardError } from "./path-guard.js";
import { authorizeWorkspacePath, switchAuthorizedWorkspace } from "./workspace-authorization.js";
import { replayChatEvents, resetChatEventHistory, writeChatEvent, writeChatStreamBaseline } from "../chat-stream.js";

const COMMAND_CONFIRM_TIMEOUT_MS = 120_000;

type PendingCommandConfirmation = {
  response: ServerResponse;
  resolve: (decision: CommandConfirmationResult) => void;
  timeout: ReturnType<typeof setTimeout>;
};

const pendingCommandConfirmations = new Map<string, PendingCommandConfirmation>();

function commandConfirmationId(): string {
  return "cmd-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8);
}

export function createCommandConfirmCallback(chatStream: ChatStreamState) {
  return async (cmd: string, reason: string, request?: CommandConfirmationRequest): Promise<CommandConfirmationResult> => {
    const response = chatStream.response;
    if (!response) return { allow: false };

    const id = commandConfirmationId();
    return new Promise<CommandConfirmationResult>((resolve) => {
      const finish = (decision: CommandConfirmationResult) => {
        const pending = pendingCommandConfirmations.get(id);
        if (pending) {
          clearTimeout(pending.timeout);
          pendingCommandConfirmations.delete(id);
        }
        resolve(decision.allow === true ? decision : { allow: false });
      };
      const timeout = setTimeout(() => finish({ allow: false }), COMMAND_CONFIRM_TIMEOUT_MS);
      pendingCommandConfirmations.set(id, { response, resolve: finish, timeout });

      try {
        writeChatEvent(chatStream, {
          type: "command_confirm",
          id,
          command: cmd,
          reason,
          permissionSuggestions: request?.permissionSuggestions ?? [],
        });
      } catch {
        finish({ allow: false });
      }
    });
  };
}

export function resolveCommandConfirmation(id: string, decision: CommandConfirmationResult): boolean {
  const pending = pendingCommandConfirmations.get(id);
  if (!pending) return false;
  pending.resolve(decision.allow === true ? decision : { allow: false });
  return true;
}

export function cancelCommandConfirmationsForResponse(response: ServerResponse): void {
  for (const [id, pending] of pendingCommandConfirmations) {
    if (pending.response === response) {
      clearTimeout(pending.timeout);
      pendingCommandConfirmations.delete(id);
      pending.resolve({ allow: false });
    }
  }
}

export const handleChat: RouteHandler = (req, res, ctx) => {
  const { url, method } = req;
  const cors = { "Access-Control-Allow-Origin": "*" };
  const { runtime, chatStream, paths: p } = ctx;

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

  // Switch workspace（重建整个 AgentSession）
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
        resetChatEventHistory(chatStream);
        console.log(`[chat] POST message="${message?.slice(0, 60)}${(message?.length || 0) > 60 ? "…" : ""}" ws="${workspace || "?"}" atts=${attachments?.length || 0}`);
        chatStream.textBuffer = "";
        chatStream.thinkingBuffer = "";
        chatStream.currentTextSnapshot = "";
        chatStream.currentThinkingSnapshot = "";
        chatStream.turnId = "turn-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 6);
        chatStream.traceSeq = 0;
        chatStream.blockSeq = 0;
        chatStream.blocks = [];
        chatStream.emittedTraces = new Set();
        if (workspace) chatStream.currentWorkspace = workspace;
        // 切换 agent 工作目录到当前项目（重建 AgentSession）
        if (workspace && runtime.currentWorkspace !== workspace) {
          console.log(`📂 Chat with workspace: ${workspace} (was: ${runtime.currentWorkspace})`);
          await runtime.switchWorkspace(workspace);
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
        // 立即返回，不 await prompt()，SSE 流式推送 + agent_end 处理 workspace 标记
        console.log(`[chat] → session.prompt()`);
        const promptStart = Date.now();
        runtime.session.prompt(finalMessage).catch((err: unknown) => {
          const msg = err instanceof Error ? err.message : String(err);
          const stack = err instanceof Error ? err.stack : "";
          console.log(`[chat] ❌ session.prompt error after ${Date.now() - promptStart}ms: ${msg}`);
          if (stack) { console.log(`[chat]   stack:`, stack.split("\n").slice(0, 6).join("\n[chat]       ")); }
          // 通过 SSE 把错误推给前端，避免只显示空 "Pi"
          writeChatEvent(chatStream, { type: "error", message: msg });
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
    if (reconnecting) replayChatEvents(chatStream, res, lastEventId as string);
    else writeChatStreamBaseline(chatStream, res);
    req.on("close", () => {
      console.log(`[chat] SSE disconnected`);
      if (chatStream.response === res) chatStream.response = null;
    });
    return true;
  }

  return false;
};
