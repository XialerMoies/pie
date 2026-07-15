/**
 * Chat routes — POST /api/chat, GET /api/chat/stream (SSE)
 */
import type { RouteHandler } from "./types";
import { processAttachments, buildContextBlock } from "./attach";

export const handleChat: RouteHandler = (req, res, ctx) => {
  const { url, method } = req;
  const cors = { "Access-Control-Allow-Origin": "*" };
  const { runtime, chatStream, paths: p } = ctx;

  // Switch workspace（重建整个 AgentSession）
  if (url === "/api/workspace/switch" && method === "POST") {
    let body = "";
    req.on("data", (chunk: Buffer) => { body += chunk.toString(); });
    req.on("end", async () => {
      try {
        const { workspace } = JSON.parse(body);
        if (workspace && runtime.currentWorkspace !== workspace) {
          console.log(`📂 Switching workspace: "${runtime.currentWorkspace}" → "${workspace}"`);
          await runtime.switchWorkspace(workspace);
          console.log(`✅ Workspace switched`);
        }
        res.writeHead(200, { "Content-Type": "application/json", ...cors });
        res.end(JSON.stringify({ ok: true }));
      } catch (err: unknown) { const msg = err instanceof Error ? (err as Error).message : String(err);
        console.log(`❌ Workspace switch error: ${msg}`);
        res.writeHead(400, { ...cors });
        res.end(JSON.stringify({ error: (err as Error).message }));
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
        const { message, workspace, attachments } = parsed;
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
          const { blocks } = processAttachments(attachments, ws);
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
          try {
            chatStream.response?.write(`data: ${JSON.stringify({ type: "error", message: msg })}\n\n`);
            chatStream.response?.end();
          } catch { /* ignore */ }
          chatStream.response = null;
        });
        res.writeHead(200, { "Content-Type": "application/json", ...cors });
        res.end(JSON.stringify({ ok: true }));
      } catch (err: unknown) {
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
        const { invalidateAllSections } = await import("../../agent/prompts")
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
    chatStream.response = res;
    console.log(`[chat] SSE connected`);
    req.on("close", () => {
      console.log(`[chat] SSE disconnected`);
      chatStream.response = null;
    });
    return true;
  }

  return false;
};
