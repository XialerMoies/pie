export const CHAT_FLOW_ENGINE_EVENTS = [
  { version: 1, type: "turn.started", sessionId: "session-flow", turnId: "turn-flow", seq: 1, timestamp: 1 },
  { version: 1, type: "thinking.delta", sessionId: "session-flow", turnId: "turn-flow", seq: 2, timestamp: 2, text: "先分析" },
  { version: 1, type: "thinking.delta", sessionId: "session-flow", turnId: "turn-flow", seq: 3, timestamp: 3, text: "路径" },
  { version: 1, type: "tool.started", sessionId: "session-flow", turnId: "turn-flow", seq: 4, timestamp: 4, toolCallId: "call-flow", name: "search", input: { query: "event-flow" } },
  { version: 1, type: "tool.completed", sessionId: "session-flow", turnId: "turn-flow", seq: 5, timestamp: 5, toolCallId: "call-flow", name: "search", output: "找到结果" },
  { version: 1, type: "thinking.delta", sessionId: "session-flow", turnId: "turn-flow", seq: 6, timestamp: 6, text: "再验证" },
  { version: 1, type: "thinking.delta", sessionId: "session-flow", turnId: "turn-flow", seq: 7, timestamp: 7, text: "结论" },
  { version: 1, type: "content.delta", sessionId: "session-flow", turnId: "turn-flow", seq: 8, timestamp: 8, text: "最终正文" },
  { version: 1, type: "turn.completed", sessionId: "session-flow", turnId: "turn-flow", seq: 9, timestamp: 9 },
];

export const CHAT_FLOW_SSE_BLOCKS = [
  { type: "thinking", status: "streaming", text: "先分析", blockId: "thinking-flow-1", seq: 1 },
  { type: "thinking", status: "streaming", text: "先分析路径", blockId: "thinking-flow-1", seq: 1 },
  { type: "tool", status: "running", name: "search", input: { query: "event-flow" }, toolCallId: "call-flow", blockId: "tool-flow", seq: 2 },
  { type: "tool", status: "success", name: "search", input: { query: "event-flow" }, output: "找到结果", toolCallId: "call-flow", blockId: "tool-flow", seq: 2 },
  { type: "thinking", status: "streaming", text: "再验证", blockId: "thinking-flow-2", seq: 3 },
  { type: "thinking", status: "streaming", text: "再验证结论", blockId: "thinking-flow-2", seq: 3 },
  { type: "text", text: "最终正文", blockId: "text-flow", seq: 4 },
];

export function blockSnapshot(block) {
  return {
    blockId: block.blockId,
    type: block.type,
    seq: block.seq,
    status: block.status,
    text: block.text,
    toolCallId: block.toolCallId,
  };
}

export function latestBlocks(events) {
  const latest = new Map();
  for (const event of events) {
    if (event.type === "block" && event.block?.blockId) latest.set(event.block.blockId, event.block);
    if (event.type === "done" && Array.isArray(event.blocks)) {
      latest.clear();
      for (const block of event.blocks) latest.set(block.blockId, block);
    }
  }
  return [...latest.values()].sort((left, right) => left.seq - right.seq).map(blockSnapshot);
}
