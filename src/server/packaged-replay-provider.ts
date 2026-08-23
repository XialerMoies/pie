import { appendFileSync, existsSync } from "node:fs";
import type { AgentRuntime } from "../agent/runtime.js";
import { emitBlock } from "./agent-event-router.js";
import { writeChatEvent } from "./chat-stream.js";
import type { ChatStreamState } from "./routes/types.js";

function waitForReplayProbe(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Deterministic, keyless provider used only by packaged Electron E2E tests.
 * The route owns HTTP/SSE concerns; this adapter owns the test-only
 * persistence setup needed to exercise the real session replay path.
 */
export async function runPackagedReplayTurn(runtime: AgentRuntime, chatStream: ChatStreamState): Promise<void> {
  const turnId = chatStream.turnId;
  const traceId = chatStream.traceId;
  const blocks = {
    thought: { type: "thinking" as const, status: "streaming" as const, text: "Replay thought", turnId, traceId, blockId: "replay-thought", seq: 1 },
    tool: { type: "tool" as const, status: "running" as const, name: "file_read", input: { path: "<replay>/result.txt" }, toolCallId: "replay-tool-call", turnId, traceId, blockId: "replay-tool", seq: 2 },
    text: { type: "text" as const, text: "Replay answer", turnId, traceId, blockId: "replay-text", seq: 3 },
  };

  // The keyless provider bypasses PI's model loop. Append a minimal assistant
  // entry so the real JSONL session file exists before block persistence.
  const replayMessageId = runtime.sessionManager.appendMessage({
    role: "assistant",
    content: [],
    api: "openai-completions",
    provider: "e2e-replay",
    model: "packaged-replay-provider",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: Date.now(),
  });
  const sessionFile = runtime.sessionManager.getSessionFile();
  emitBlock(runtime, chatStream, blocks.thought, { persist: false });
  await waitForReplayProbe(60);
  emitBlock(runtime, chatStream, { ...blocks.thought, status: "done" }, { persist: false });
  emitBlock(runtime, chatStream, blocks.tool, { persist: false });
  await waitForReplayProbe(60);
  const completedTool = { ...blocks.tool, status: "success" as const, output: "replay result" };
  emitBlock(runtime, chatStream, completedTool, { persist: false });
  emitBlock(runtime, chatStream, { ...blocks.text, text: "Replay" }, { persist: false });
  await waitForReplayProbe(60);
  const finalBlocks = [{ ...blocks.thought, status: "done" as const }, completedTool, blocks.text];
  emitBlock(runtime, chatStream, blocks.text, { persist: false });
  if (sessionFile && existsSync(sessionFile)) {
    for (const block of finalBlocks) {
      appendFileSync(sessionFile, JSON.stringify({
        type: "assistant_block",
        turnId: replayMessageId,
        block: { ...block, turnId: replayMessageId },
      }) + "\n");
    }
  }
  writeChatEvent(chatStream, { type: "done", turnId, text: blocks.text.text, blocks: finalBlocks, status: "done" });
  try { chatStream.response?.end(); } catch {}
  chatStream.response = null;
}
