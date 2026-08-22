/**
 * A-08/a deterministic event script. Every consumer must replay this exact
 * sequence; assertions are made after each event instead of only at terminal.
 */
export const DETERMINISTIC_EVENT_SCRIPT = [
  { id: "turn-start", event: { version: 1, type: "turn.started", seq: 1, timestamp: 1 } },
  { id: "thought-start", event: { version: 1, type: "thinking.delta", seq: 2, timestamp: 2, messageSeq: 1, contentIndex: 0, phase: "start", text: "先" } },
  { id: "thought-delta", event: { version: 1, type: "thinking.delta", seq: 3, timestamp: 3, messageSeq: 1, contentIndex: 0, phase: "delta", text: "分析" } },
  { id: "tool-start", event: { version: 1, type: "tool.started", seq: 4, timestamp: 4, toolCallId: "call-script", name: "file_read", input: { path: "e:/workspace/SKILL.md" } } },
  { id: "tool-result", event: { version: 1, type: "tool.completed", seq: 5, timestamp: 5, toolCallId: "call-script", name: "file_read", output: "事实内容" } },
  { id: "thought-end", event: { version: 1, type: "thinking.delta", seq: 6, timestamp: 6, messageSeq: 1, contentIndex: 0, phase: "end", text: "" } },
  { id: "thought-2-start", event: { version: 1, type: "thinking.delta", seq: 7, timestamp: 7, messageSeq: 2, contentIndex: 0, phase: "start", text: "再" } },
  { id: "thought-2-delta", event: { version: 1, type: "thinking.delta", seq: 8, timestamp: 8, messageSeq: 2, contentIndex: 0, phase: "delta", text: "验证" } },
  { id: "thought-2-end", event: { version: 1, type: "thinking.delta", seq: 9, timestamp: 9, messageSeq: 2, contentIndex: 0, phase: "end", text: "" } },
  { id: "text-start", event: { version: 1, type: "content.delta", seq: 10, timestamp: 10, messageSeq: 2, contentIndex: 1, phase: "start", text: "最终" } },
  { id: "text-delta", event: { version: 1, type: "content.delta", seq: 11, timestamp: 11, messageSeq: 2, contentIndex: 1, phase: "delta", text: "正文" } },
  { id: "text-end", event: { version: 1, type: "content.delta", seq: 12, timestamp: 12, messageSeq: 2, contentIndex: 1, phase: "end", text: "" } },
  { id: "turn-complete", event: { version: 1, type: "turn.completed", seq: 13, timestamp: 13 } },
];

export const DETERMINISTIC_IDS = {
  firstThought: "m1:thinking-0",
  tool: "tool-call-script",
  secondThought: "m2:thinking-0",
  text: "m2:text-1",
};

export const DETERMINISTIC_FINAL_BLOCKS = [
  { type: "thinking", blockId: DETERMINISTIC_IDS.firstThought, seq: 1, status: "done", text: "先分析" },
  { type: "tool", blockId: DETERMINISTIC_IDS.tool, seq: 2, status: "success", toolCallId: "call-script", output: "事实内容" },
  { type: "thinking", blockId: DETERMINISTIC_IDS.secondThought, seq: 3, status: "done", text: "再验证" },
  { type: "text", blockId: DETERMINISTIC_IDS.text, seq: 4, text: "最终正文" },
];

export function withSession(event, sessionId = "script-session", turnId = "script-turn") {
  return { ...event, sessionId, turnId };
}

export function eventScriptFor(sessionId = "script-session", turnId = "script-turn") {
  return DETERMINISTIC_EVENT_SCRIPT.map((step) => ({
    ...step,
    event: withSession(step.event, sessionId, turnId),
  }));
}

export function snapshotBlocks(blocks) {
  return blocks.map((block) => ({
    type: block.type,
    blockId: block.blockId,
    seq: block.seq,
    status: block.status,
    text: block.text,
    toolCallId: block.toolCallId,
    output: block.output,
  }));
}

export function assertLinearBlocks(blocks, assert) {
  const ordered = [...blocks].sort((left, right) => left.seq - right.seq);
  assert.deepEqual(ordered.map((block) => block.seq), ordered.map((_block, index) => index + 1));
  assert.equal(new Set(ordered.map((block) => block.blockId)).size, ordered.length);
  return ordered;
}

