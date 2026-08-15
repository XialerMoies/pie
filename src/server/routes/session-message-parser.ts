import { reduceSubagentEventReplay } from "../subagent-events.js";

/** 从历史消息中剥离已知的指令前缀（与前端 chat-mode.ts 保持一致） */
function stripInstruction(text: string): string {
  const prefixes = [
    // MODE_INSTRUCTIONS
    '仅解释，不要修改任何文件或执行命令。',
    '不要执行任何操作。输出结构化方案：目标 → 步骤 → 涉及文件 → 风险。',
    // EFFORT_INSTRUCTIONS
    '简要回答即可。',
    '请深入分析，考虑边界情况。',
    '请进行深度分析，考虑多种可能性和边界情况。',
    '请穷尽所有可能性，进行彻底分析和验证。',
  ].sort((a, b) => b.length - a.length);
  for (const prefix of prefixes) {
    if (text.startsWith(prefix)) {
      const stripped = text.slice(prefix.length).replace(/^\n+/, '');
      if (stripped.trim().length > 0) return stripped;
    }
  }
  return text;
}

function fixSurrogates(s: string): string {
  return s.replace(/[\uD800-\uDBFF]([^\uDC00-\uDFFF]|$)/g, "").replace(/(^|[^\uD800-\uDBFF])([\uDC00-\uDFFF])/g, "");
}

type SessionTrace =
  | { type: "thinking"; status: "streaming" | "done"; text: string; turnId?: string; id: string }
  | { type: "tool"; status: "running" | "success" | "error"; name: string; input?: unknown; output?: string; error?: string; metadata?: Record<string, unknown>; turnId?: string; id: string }
  | { type: "step"; status: "info" | "success" | "error"; text: string; turnId?: string; id: string };

type SessionMessage = {
  role: string;
  content: string;
  thinking?: string;
  turnId?: string;
  trace?: SessionTrace[];
  blocks?: any[];
  subagentBatches?: ReturnType<typeof reduceSubagentEventReplay>["batches"];
  _compacted?: boolean;
};

function textFromBlocks(blocks: Array<{type: string; text?: string; thinking?: string}>): string {
  return blocks.filter((c) => c.type === "text").map((c) => fixSurrogates(c.text || "")).join(" ").trim() || "";
}

function summarizeText(text: string, max = 36): string {
  const clean = text
    .replace(/[`*_#>]/g, "")
    .replace(/\s+/g, " ")
    .replace(/^[\-•·\d.、)\s]+/, "")
    .trim();
  if (!clean) return "";
  return clean.length > max ? clean.slice(0, max).trimEnd() + "…" : clean;
}

function normalizeTitleLine(line: string): string {
  return line
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/^#{1,6}\s*/, "")
    .replace(/^>\s*/, "")
    .replace(/^[\-•·]\s*/, "")
    .replace(/^\d+[.)、]\s*/, "")
    .replace(/^[A-Z]\d+[.)、]?\s*/i, "")
    .trim();
}

function isGenericReplyIntro(line: string): boolean {
  return /^(好[，,、\s]*)?(全部代码|我已经|我已|下面|以下|先说|总体|整体|结论是|可以|已完成|收到)/.test(line)
    || /^(位置|代码|示例|说明|注意)[:：]/.test(line);
}

function scoreTitleLine(line: string): number {
  if (!line || line.length < 4 || isGenericReplyIntro(line)) return -10;
  let score = 0;
  if (/[：:]/.test(line)) score += 5;
  if (/[A-Za-z_][\w]*(?:\.[A-Za-z_][\w]*)?/.test(line)) score += 3;
  if (/(问题|根因|风险|缺陷|竞争|并发|失败|错误|修复|优化|清理|支付|订单|订阅|回调)/.test(line)) score += 3;
  if (line.length >= 8 && line.length <= 42) score += 2;
  if (line.length > 90) score -= 3;
  return score;
}

function extractReplyTitle(text: string): string {
  const lines = text
    .replace(/```[\s\S]*?```/g, "\n")
    .split(/\r?\n+/)
    .map(normalizeTitleLine)
    .filter(Boolean);
  let best = "";
  let bestScore = -Infinity;
  for (const line of lines.slice(0, 24)) {
    const score = scoreTitleLine(line);
    if (score > bestScore) {
      best = line;
      bestScore = score;
    }
  }
  return summarizeText(bestScore > -10 ? best : text);
}

export function deriveReplySummary(lines: string[]): string {
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const entry = JSON.parse(lines[i]);
      if (entry.type !== "message" || entry.message?.role !== "assistant") continue;
      const blocks = (entry.message.content as Array<{type: string; text?: string; thinking?: string}> | undefined) || [];
      const text = textFromBlocks(blocks);
      const summary = extractReplyTitle(text);
      if (summary) return summary;
    } catch {}
  }
  return "";
}

function thinkingFromBlocks(blocks: Array<{type: string; text?: string; thinking?: string}>): string | undefined {
  return blocks.filter((c) => c.type === "thinking").map((c) => fixSurrogates(c.thinking || "")).join("\n").trim() || undefined;
}

/**
 * 将 trace 事件数组转为 AssistantBlock 格式。
 * 用于旧会话（只有 trace 记录、没有 assistant_block 记录）的回放兼容。
 */
function convertTracesToBlocks(traces: SessionTrace[], content?: string): any[] {
  const blocks: any[] = [];
  let seq = 0;

  // 先收集 tool 事件按 id 分组（一条 tool 在 trace 里以 running→success/error 出现）
  const toolGroups = new Map<string, SessionTrace[]>();
  for (const t of traces) {
    if (t.type === 'tool') {
      if (!toolGroups.has(t.id)) toolGroups.set(t.id, []);
      toolGroups.get(t.id)!.push(t);
    }
  }

  // 按原始顺序遍历，同一 tool id 只在第一次出现时输出 tool_use + tool_result
  const emittedTools = new Set<string>();
  for (const t of traces) {
    if (t.type === 'thinking') {
      blocks.push({ type: 'thinking', text: t.text, status: t.status, turnId: t.turnId || '', blockId: t.id || `thinking-${seq}`, seq: seq++ });
    } else if (t.type === 'step') {
      blocks.push({ type: 'step', text: t.text, status: t.status, turnId: t.turnId || '', blockId: t.id || `step-${seq}`, seq: seq++ });
    } else if (t.type === 'tool') {
      if (emittedTools.has(t.id)) continue;
      emittedTools.add(t.id);
      const group = toolGroups.get(t.id)!;
      // 取最后一条的状态决定结果
      // running-only（中断/崩溃）→ 标记为 error，避免伪装成 success
      const last = group[group.length - 1] as SessionTrace & { type: "tool"; error?: string; output?: string };
      const isError = last.status === 'error' || last.status === 'running';
      const terminalStatus = isError ? 'error' : 'success';
      // B-5：tool 合并成一个 block（一个 seq）
      blocks.push({
        type: 'tool', toolCallId: t.id, name: t.name, input: t.input,
        output: isError ? undefined : last.output,
        error: isError ? (last.error || (last.status === 'running' ? '[中断]' : undefined)) : undefined,
        metadata: last.metadata,
        status: terminalStatus,
        turnId: t.turnId || '', blockId: t.id, seq: seq++,
      });
    }
  }

  // B-5：末尾必须是正文节点（硬不变量，与实时流规则一致）。
  //  - 有正文但末尾不是 text → 末尾补一个 text（正文若被 tool 截断，正文本身已在尾部）
  //  - 无正文 → 补占位正文（本轮未生成最终回复）
  //  - 错误/中断 → 说明未完成（不伪装成正常回复）
  const lastBlock = blocks[blocks.length - 1];
  const hasTrailingText = lastBlock?.type === 'text';
  if (!hasTrailingText) {
    const hadError = traces.some((t: SessionTrace & { status?: string; error?: string }) =>
      t.status === 'error' || Boolean(t.error));
    let text: string;
    if (content && content.trim()) {
      text = content;
    } else if (hadError) {
      text = '本轮回复未完成（发生错误或已中断）。';
    } else {
      text = '本轮未生成最终回复。';
    }
    blocks.push({ type: 'text', text, turnId: '', blockId: 'text-trailing', seq: seq++ });
  }

  return blocks;
}

/** 从 .jsonl 内容解析可显示的消息列表（与前端 dashboard-sessions.ts 兼容） */
export function parseSessionMessages(content: string): SessionMessage[] {
  const lines = content.trim().split("\n");
  const messages: SessionMessage[] = [];
  let pendingTrace: SessionTrace[] = [];

  const entries: any[] = [];
  for (const line of lines) {
    try {
      entries.push(JSON.parse(line));
    } catch {}
  }
  const subagentBatches = reduceSubagentEventReplay(entries).batches;

  const blocksByTurn = new Map<string, any[]>();
  for (const entry of entries) {
    if (entry.type !== "assistant_block" || !entry.block) continue;
    const turnId = entry.turnId || entry.block.turnId || "";
    if (!turnId) continue;
    // B-5：同一 blockId 可能出现多次（流式更新时多份落盘/历史遗留）——
    // 按 blockId 合并：保留第一次的 seq（位置），用最后一次的内容（最新状态）。
    const list = blocksByTurn.get(turnId) || [];
    const prevIdx = list.findIndex((b: any) => b.blockId === entry.block.blockId);
    if (prevIdx === -1) {
      list.push(entry.block);
    } else {
      list[prevIdx] = { ...entry.block, seq: list[prevIdx].seq };
    }
    blocksByTurn.set(turnId, list);
  }
  const runtimeNoteCounts = new Map<string, number>();
  for (const blocks of blocksByTurn.values()) {
    for (const block of blocks) {
      if (block.type === "user_note" && typeof block.text === "string") {
        runtimeNoteCounts.set(block.text, (runtimeNoteCounts.get(block.text) || 0) + 1);
      }
    }
  }
  const runtimeNoteEntryIndexes = new Set<number>();
  if (runtimeNoteCounts.size > 0) {
    const userIndexesByText = new Map<string, number[]>();
    for (const [index, entry] of entries.entries()) {
      if (entry.type !== "message" || entry.message?.role !== "user") continue;
      const text = stripInstruction(textFromBlocks(entry.message.content || []));
      const indexes = userIndexesByText.get(text) || [];
      indexes.push(index);
      userIndexesByText.set(text, indexes);
    }
    for (const [text, count] of runtimeNoteCounts) {
      const indexes = userIndexesByText.get(text) || [];
      for (const index of indexes.slice(Math.max(0, indexes.length - count))) runtimeNoteEntryIndexes.add(index);
    }
  }
  const mergeTrace = (trace: SessionTrace[], item: SessionTrace): SessionTrace[] => {
    const idx = trace.findIndex((existing) => existing.id === item.id);
    if (idx === -1) return [...trace, item];
    const prev = trace[idx] as any;
    const next = item as any;
    const merged = { ...prev, ...next };
    if (prev.input !== undefined && next.input === undefined) merged.input = prev.input;
    if (prev.output !== undefined && next.output === undefined) merged.output = prev.output;
    if (prev.error !== undefined && next.error === undefined) merged.error = prev.error;
    return trace.map((existing, i) => i === idx ? merged : existing);
  };
  const appendTrace = (trace: SessionTrace[], items: SessionTrace[]): SessionTrace[] => {
    return items.reduce((acc, item) => mergeTrace(acc, item), trace);
  };
  const pushMessage = (message: SessionMessage) => {
    const last = messages[messages.length - 1];
    // 不合并 _compacted 消息（compaction 卡片不应吞并/被吞并普通 assistant 消息）
    if (message._compacted || (last as any)?._compacted) {
      messages.push(message);
      return;
    }
    if (message.role === "assistant" && last?.role === "assistant") {
      last.content = [last.content, message.content].filter(Boolean).join("\n\n");
      last.thinking = [last.thinking, message.thinking].filter(Boolean).join("\n\n") || undefined;
      last.trace = appendTrace(last.trace || [], message.trace || []);
      if (message.blocks?.length) {
        const blocks = [...((last as any).blocks || [])];
        for (const block of message.blocks) {
          const idx = blocks.findIndex((existing: any) => existing.blockId === block.blockId);
          if (idx === -1) blocks.push(block);
          else blocks[idx] = { ...block, seq: blocks[idx].seq };
        }
        (last as any).blocks = blocks.sort((a: any, b: any) => (a.seq || 0) - (b.seq || 0));
      }
      if (!last.turnId && message.turnId) last.turnId = message.turnId;
      return;
    }
    messages.push(message);
  };
  const attachTrace = (trace: SessionTrace[]) => {
    if (trace.length === 0) return;
    const last = messages[messages.length - 1];
    if (last?.role === "assistant" && !(last as any)._compacted) {
      last.trace = appendTrace(last.trace || [], trace);
      const turnId = trace.find((item) => item.turnId)?.turnId;
      if (!last.turnId && turnId) last.turnId = turnId;
    } else {
      pendingTrace = appendTrace(pendingTrace, trace);
    }
  };
  for (const [entryIndex, entry] of entries.entries()) {
    try {
      if (entry.type === "assistant_block" && entry.block) {
        continue;
      }
      if (entry.type === "trace" && entry.event) {
        attachTrace([{ ...entry.event, turnId: entry.event.turnId || entry.turnId }]);
        continue;
      }
      if (entry.type === "compaction") {
        const summary = entry.summary || "";
        const tokensBefore = entry.tokensBefore || 0;
        const content = `📦 **上下文已压缩** — 原 ${tokensBefore} tokens\n\n${summary}`;
        messages.push({ role: "assistant", content, _compacted: true });
        continue;
      }
      if (entry.type === "message" && entry.message) {
        const role = entry.message.role;
        const blocks = (entry.message.content as Array<{type: string; text?: string; thinking?: string}> | undefined) || [];
        if (role === "toolResult") {
          const output = textFromBlocks(blocks);
          const isError = Boolean(entry.message.isError);
          attachTrace([{
            type: "tool",
            status: isError ? "error" : "success",
            name: entry.message.toolName || "tool",
            output: isError ? undefined : output,
            error: isError ? output : undefined,
            id: entry.message.toolCallId || entry.id || `tool-${pendingTrace.length}`,
          }]);
          continue;
        }
        if (role !== "user" && role !== "assistant") continue;
        const textContent = textFromBlocks(blocks);
        if (!textContent && role !== "assistant") continue;
        const displayContent = role === "user" ? stripInstruction(textContent) : textContent;
        if (role === "user" && runtimeNoteEntryIndexes.has(entryIndex)) continue;
        if (!displayContent && role !== "assistant") continue;
        if (!displayContent && role === "assistant") {
          // 无正文的 assistant 消息可能有 block 记录，保留
          const turnId = entry.turnId || entry.id;
          const hasBlocks = turnId ? ((blocksByTurn.get(turnId)?.length ?? 0) > 0) : false;
          if (!hasBlocks) continue;
        }
        const thinkingContent = role === "assistant" ? thinkingFromBlocks(blocks) : undefined;
        const trace = role === "assistant"
          ? [
              ...pendingTrace,
              ...(thinkingContent ? [{ type: "thinking" as const, status: "done" as const, text: thinkingContent, id: `${entry.id || messages.length}-thinking` }] : []),
            ]
          : undefined;
        pendingTrace = role === "assistant" ? [] : pendingTrace;
        const message: SessionMessage = { role, content: displayContent };
        const traceTurnId = trace?.find((item) => item.turnId)?.turnId;
        if (role === "assistant" && traceTurnId) message.turnId = traceTurnId;
        if (thinkingContent) message.thinking = thinkingContent;
        if (trace && trace.length > 0) message.trace = trace;
        // 优先使用 assistant_block 记录（新协议）。真实 PI message 记录没有
        // turnId，需用本消息之前挂起的 trace 中的 turnId 关联当前 assistant。
        if (role === "assistant") {
          const candidateTurnIds = new Set<string>();
          if (entry.turnId) candidateTurnIds.add(entry.turnId);
          if (entry.id) candidateTurnIds.add(entry.id);
          for (const item of trace || []) {
            if (item.turnId) candidateTurnIds.add(item.turnId);
          }
          const matchedBlocks: any[] = [];
          for (const tid of candidateTurnIds) {
            const turnBlocks = blocksByTurn.get(tid);
            if (!turnBlocks) continue;
            matchedBlocks.push(...turnBlocks);
            blocksByTurn.delete(tid);
          }
          if (matchedBlocks.length > 0) {
            (message as any).blocks = matchedBlocks.sort((a, b) => a.seq - b.seq);
          }
        }
        pushMessage(message);
      }
    } catch {}
  }
  if (pendingTrace.length > 0) {
    const last = messages[messages.length - 1];
    if (last?.role === "assistant") last.trace = [...(last.trace || []), ...pendingTrace];
  }

  // Stage ②: 旧会话无 assistant_block 记录时，将 trace 数据转为 block 格式
  for (const msg of messages) {
    if (msg.role === "assistant" && !(msg as any).blocks && msg.trace && msg.trace.length > 0) {
      (msg as any).blocks = convertTracesToBlocks(msg.trace, msg.content);
    }
  }

  for (const batch of subagentBatches) {
    const target = messages.find((message) => message.role === "assistant" && message.blocks?.some((block) =>
      block?.name === "delegate_tasks" && block?.toolCallId === batch.events[0]?.parentToolCallId
    ));
    if (!target) continue;
    (target.subagentBatches ??= []).push(batch);
  }

  return messages;
}
