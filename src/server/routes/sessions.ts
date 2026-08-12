/**
 * Session routes — CRUD for conversation sessions
 */
import type { RouteHandler, ServerContext } from "./types.js";
import { readFileSync, writeFileSync, existsSync, readdirSync, unlinkSync, statSync, mkdirSync, renameSync } from "fs";
import { resolve, basename, dirname } from "path";
import { randomUUID } from "crypto";
import { parseBody } from "./parse-body.js";
import { workspaceDataPaths, wsKey, wsDir } from "./session-dir.js";
import { reduceSubagentEventReplay } from "../subagent-events.js";
import { isPathGuardError, writePathGuardError } from "./path-guard.js";
import { authorizeRoutePath, isServerPermissionError, writeServerPermissionError } from "../permission-service.js";
import { authorizeWorkspacePath, runWithWorkspaceOwnership } from "./workspace-authorization.js";

// Re-export for backward compat (tests use mod.wsKey / mod.wsDir)
export { wsKey, wsDir } from "./session-dir.js";

const cors = { "Access-Control-Allow-Origin": "*" };

function usesCanonicalWorkspaceData(ctx: ServerContext): boolean {
  return !!ctx.paths.STARTUP?.dataRoot;
}

function sessionsDirForWorkspace(ctx: ServerContext, workspace: string): string {
  if (usesCanonicalWorkspaceData(ctx)) {
    return workspaceDataPaths(ctx.paths.DATA_DIR, workspace).sessionsDir;
  }
  return wsDir(ctx.paths.SESSIONS_DIR, workspace);
}

function activeSessionsDir(ctx: ServerContext): string {
  const workspace = ctx.runtime.currentWorkspace || ctx.paths.STARTUP?.workspace || ctx.paths.APP_ROOT;
  return usesCanonicalWorkspaceData(ctx)
    ? sessionsDirForWorkspace(ctx, workspace)
    : ctx.paths.SESSIONS_DIR;
}

function publishActiveSessionChanged(ctx: ServerContext): void {
  try { ctx.appEvents.publish("dashboard.changed"); } catch {}
  try { ctx.appEvents.publish("usage.changed"); } catch {}
}

/** 迁移会话: 从 sessions/ 根目录按 workspace 分类移入 by-project/ */
async function migrateOldSessions(ctx: ServerContext): Promise<void> {
  const baseDir = ctx.paths.SESSIONS_DIR;
  if (!existsSync(baseDir)) return;
  const authorizedBaseDir = await authorizeSessionPath(ctx, baseDir, "read", "sessions.auto-migrate.root");
  const entries = readdirSync(authorizedBaseDir, { withFileTypes: true });
  let moved = 0;
  for (const e of entries) {
    if (e.name === "by-project") continue;
    if (!e.name.endsWith(".jsonl")) continue;
    const fp = resolve(authorizedBaseDir, e.name);
    try {
      const sourceFile = await authorizeSessionPath(ctx, fp, "read", "sessions.auto-migrate.source");
      const content = readFileSync(sourceFile, "utf-8");
      const header = JSON.parse(content.trim().split("\n")[0] || "{}");
      const ws = header.workspace || "";
      const targetDir = ws ? wsDir(baseDir, ws) : resolve(baseDir, "by-project", "_legacy");
      const targetFile = await authorizeSessionPath(ctx, resolve(targetDir, e.name), "create", "sessions.auto-migrate.destination");
      const removableSource = await authorizeSessionPath(ctx, sourceFile, "remove", "sessions.auto-migrate.source");
      if (!existsSync(dirname(targetFile))) mkdirSync(dirname(targetFile), { recursive: true });
      renameSync(removableSource, targetFile);
      moved++;
    } catch (error) {
      if (isPathGuardError(error) || isServerPermissionError(error)) throw error;
    }
  }
  if (moved > 0) console.log(`📦 Migrated ${moved} session(s) to by-project/`);
}

/** 扫描所有项目的session目录 */
async function findAuthorizedProjectDirs(ctx: ServerContext, baseDir: string, source: string): Promise<string[]> {
  const projectsDir = resolve(baseDir, "by-project");
  if (!existsSync(projectsDir)) return [];
  const authorizedProjectsDir = await authorizeSessionPath(ctx, projectsDir, "read", source);
  return readdirSync(authorizedProjectsDir, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .map(d => resolve(authorizedProjectsDir, d.name));
}

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

async function findAuthorizedJsonl(ctx: ServerContext, dir: string, source: string): Promise<string[]> {
  if (!existsSync(dir)) return [];
  const authorizedDir = await authorizeSessionPath(ctx, dir, "read", `${source}.dir`);
  const entries = readdirSync(authorizedDir, { withFileTypes: true });
  const files: string[] = [];
  for (const e of entries) {
    const candidate = resolve(authorizedDir, e.name);
    if (e.isDirectory()) {
      files.push(...await findAuthorizedJsonl(ctx, candidate, source));
    } else if (e.name.endsWith(".jsonl")) {
      files.push(await authorizeSessionPath(ctx, candidate, "read", source));
    }
  }
  return files;
}

export async function findAuthorizedSessionFileById(
  ctx: ServerContext,
  id: string,
  source: string,
  workspace?: string,
): Promise<string | null> {
  if (typeof id !== "string" || !id.trim()) return null;
  const sessionsRoot = workspace ? sessionsDirForWorkspace(ctx, workspace) : activeSessionsDir(ctx);
  return findAuthorizedSessionFileInDir(ctx, sessionsRoot, id, source, sessionsRoot);
}

async function findAuthorizedSessionFileInDir(
  ctx: ServerContext,
  dir: string,
  id: string,
  source: string,
  sessionsRoot: string,
): Promise<string | null> {
  if (!existsSync(dir)) return null;
  const authorizedDir = await authorizeSessionPath(ctx, dir, "read", `${source}.dir`, sessionsRoot);
  const entries = readdirSync(authorizedDir, { withFileTypes: true });
  for (const e of entries) {
    const candidate = resolve(authorizedDir, e.name);
    if (e.isDirectory()) {
      const found = await findAuthorizedSessionFileInDir(ctx, candidate, id, source, sessionsRoot);
      if (found) return found;
      continue;
    }
    if (!e.name.endsWith(".jsonl")) continue;

    const authorizedFile = await authorizeSessionPath(ctx, candidate, "read", source, sessionsRoot);
    try {
      const headerLine = readFileSync(authorizedFile, "utf-8").trim().split("\n")[0];
      const header = JSON.parse(headerLine);
      if (header.id === id || e.name.includes(id)) return authorizedFile;
    } catch {}
  }
  return null;
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

type SessionBranchInfo = { id: string; name?: string };

type SessionMeta = {
  name: string;
  titleSource?: "auto" | "manual";
  pinned: boolean;
  archived?: boolean;
  branchFrom?: SessionBranchInfo;
};

function readSessionMeta(lines: string[]): SessionMeta {
  const meta: SessionMeta = { name: "", pinned: false };
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    try {
      const entry = JSON.parse(line);
      if (entry.type !== "session_info") continue;
      if (typeof entry.name === "string") meta.name = entry.name;
      if (entry.titleSource === "auto" || entry.titleSource === "manual") meta.titleSource = entry.titleSource;
      if (typeof entry.pinned === "boolean") meta.pinned = entry.pinned;
      if (typeof entry.archived === "boolean") meta.archived = entry.archived;
      if (entry.branchFrom && typeof entry.branchFrom.id === "string") {
        meta.branchFrom = {
          id: entry.branchFrom.id,
          name: typeof entry.branchFrom.name === "string" ? entry.branchFrom.name : undefined,
        };
      }
    } catch {}
  }
  return meta;
}

function appendSessionInfo(sessionFile: string, info: Record<string, unknown>): void {
  const content = readFileSync(sessionFile, "utf-8");
  const lines = content.trim().split("\n").filter(Boolean);
  lines.splice(1, 0, JSON.stringify({ type: "session_info", ...info, timestamp: new Date().toISOString() }));
  writeFileSync(sessionFile, lines.join("\n") + "\n");
}

async function authorizeSessionPath(
  ctx: ServerContext,
  targetPath: string,
  operation: "read" | "write" | "create" | "remove",
  source: string,
  sessionsRoot = activeSessionsDir(ctx),
): Promise<string> {
  return (await authorizeRoutePath(ctx, sessionsRoot, targetPath, operation, source)).path;
}

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

function deriveReplySummary(lines: string[]): string {
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

export const handleSessions: RouteHandler = async (req, res, ctx) => {
  const { url, method } = req;
  const { runtime, paths: p } = ctx;
  const session = runtime.session;

  // List sessions — filtered by workspace, with "other projects" section
  if ((url === "/api/sessions" || url?.startsWith("/api/sessions?")) && method === "GET") {
    try {
      const u = new URL(url, `http://${req.headers.host || "localhost"}`);
      const currentWs = await authorizeWorkspacePath(ctx, u.searchParams.get("workspace"), "sessions.list.workspace");
      const includeOther = u.searchParams.get("other") === "1";
      const curId = (session as any).sessionManager?.getSessionId?.() ?? "";

      // Canonical legacy copies are opt-in through the Settings migration flow.
      if (!usesCanonicalWorkspaceData(ctx)) {
        // Legacy contexts retain the old in-place migration behavior.
        await migrateOldSessions(ctx);
      }

      // Current workspace sessions dir
      const curSessionsDir = sessionsDirForWorkspace(ctx, currentWs || runtime.currentWorkspace);
      // Active session ID from runtime
      const activeSession = runtime.getActiveSession ? runtime.getActiveSession() : null;
      const runningSessionId = (session as any).isStreaming ? activeSession?.id || curId : "";

      // Helper to parse session from a dir
      async function readSessionsFromDir(dir: string): Promise<Array<Record<string, unknown>>> {
        if (!existsSync(dir)) return [];
        const records: Array<Record<string, unknown>> = [];
        for (const fullPath of await findAuthorizedJsonl(ctx, dir, "sessions.list")) {
          const stat = existsSync(fullPath) ? statSync(fullPath) : null;
          const content = readFileSync(fullPath, "utf-8");
          const lines = content.trim().split("\n");
          const header = lines[0] ? JSON.parse(lines[0]) : {};
          const id = header.id || basename(fullPath, ".jsonl");
          const meta = readSessionMeta(lines);
          const replySummary = meta.name ? "" : deriveReplySummary(lines);
          const hasError = lines.some((line: string) => line.includes('"isError":true') || line.includes('"status":"error"') || line.includes('"error"'));
          records.push({
            id, name: meta.name || replySummary || "新会话", active: id === curId,
            messageCount: lines.filter((l: string) => l.includes('"type":"message"')).length,
            createdAt: stat?.birthtime?.toISOString() || header.timestamp || "",
            updatedAt: stat?.mtime?.toISOString() || header.timestamp || "",
            file: basename(fullPath),
            workspace: header.workspace || "",
            pinned: meta.pinned,
            titleSource: meta.titleSource,
            archived: Boolean(meta.archived),
            hasError,
            isRunning: id === runningSessionId,
            branchFrom: meta.branchFrom,
          });
        }
        return records.sort((a: Record<string, unknown>, b: Record<string, unknown>) => String(b["updatedAt"] || b["createdAt"] || "").localeCompare(String(a["updatedAt"] || a["createdAt"] || "")));
      }

      const sessions = await readSessionsFromDir(curSessionsDir);

      // Other projects
      let other: { project: string; path: string; sessions: Record<string, unknown>[] }[] = [];
      if (includeOther && !usesCanonicalWorkspaceData(ctx)) {
        const allDirs = await findAuthorizedProjectDirs(ctx, p.SESSIONS_DIR, "sessions.list.projects");
        const curKey = wsKey(currentWs);
        for (const dir of allDirs) {
          const projName = basename(dir);
          if (projName === curKey) continue;
          const projSessions = await readSessionsFromDir(dir);
          if (projSessions.length > 0) {
            // Get workspace path from the first session's header
            const wsPath = (projSessions[0] as any)?.workspace || "";
            other.push({ project: projName === "_legacy" ? "未分类" : projName, path: wsPath, sessions: projSessions as any[] });
          }
        }
      }

      res.writeHead(200, { "Content-Type": "application/json", ...cors });
      res.end(JSON.stringify({ sessions, other, activeSessionId: activeSession?.id || null }));
    } catch (err: unknown) {
      if (writeServerPermissionError(res, cors, err)) return true;
      if (writePathGuardError(res, cors, err)) return true;
      res.writeHead(200, { ...cors });
      res.end(JSON.stringify({ sessions: [], other: [], error: (err as Error).message }));
    }
    return true;
  }

  // Create new session — 由 SessionManager.create() 创建文件，runtime 立即切到新 session
  if (url === "/api/sessions/new" && method === "POST") {
    try {
      const body = await parseBody(req).catch(() => ({}));
      const workspace = await authorizeWorkspacePath(ctx, body.workspace, "sessions.new.workspace");
      const targetWorkspace = workspace || runtime.currentWorkspace || "";
      const targetSessionsDir = sessionsDirForWorkspace(ctx, targetWorkspace);
      if (existsSync(targetSessionsDir)) {
        await authorizeSessionPath(ctx, targetSessionsDir, "create", "sessions.new.destination", targetSessionsDir);
      }
      // 如果 workspace 与当前不同，先切 workspace 再创建
      if (workspace && runtime.currentWorkspace !== workspace) {
        await runWithWorkspaceOwnership(ctx, workspace, () => runtime.switchWorkspace(workspace));
      }
      const id = await runtime.createNewSession();
      publishActiveSessionChanged(ctx);
      res.writeHead(200, { "Content-Type": "application/json", ...cors });
      res.end(JSON.stringify({ ok: true, id }));
    } catch (err: unknown) {
      if (writeServerPermissionError(res, cors, err)) return true;
      if (writePathGuardError(res, cors, err)) return true;
      res.writeHead(400, { ...cors });
      res.end(JSON.stringify({ error: (err as Error).message }));
    }
    return true;
  }

  // Migrate session to workspace (move from _legacy to project dir)
  if (url === "/api/sessions/migrate" && method === "POST") {
    try {
      const body = await parseBody(req);
      const { id } = body;
      const workspace = await authorizeWorkspacePath(ctx, body.workspace, "sessions.migrate.workspace");
      const sFile = await findAuthorizedSessionFileById(ctx, id, "sessions.migrate.lookup");
      if (!sFile) { res.writeHead(404, { ...cors }); res.end(JSON.stringify({ error: "not found" })); return true; }
      const sourceRoot = activeSessionsDir(ctx);
      const sourceFile = await authorizeSessionPath(ctx, sFile, "read", "sessions.migrate.source", sourceRoot);
      const targetDir = sessionsDirForWorkspace(ctx, workspace || runtime.currentWorkspace || "");
      const targetFile = await authorizeSessionPath(
        ctx,
        resolve(targetDir, basename(sourceFile)),
        "create",
        "sessions.migrate.destination",
        targetDir,
      );
      if (!existsSync(dirname(targetFile))) mkdirSync(dirname(targetFile), { recursive: true });
      // Read, tag, and move
      const content = readFileSync(sourceFile, "utf-8");
      const lines = content.trim().split("\n");
      const header = JSON.parse(lines[0]);
      header.workspace = workspace || "";
      lines[0] = JSON.stringify(header);
      writeFileSync(targetFile, lines.join("\n") + "\n");
      if (sourceFile !== targetFile) {
        const removeSource = await authorizeSessionPath(ctx, sourceFile, "remove", "sessions.migrate.source", sourceRoot);
        unlinkSync(removeSource);
      }
      console.log(`📦 Migrated session ${id} → by-project/${wsKey(workspace)}/`);
      res.writeHead(200, { "Content-Type": "application/json", ...cors });
      res.end(JSON.stringify({ ok: true }));
    } catch (err: unknown) {
      if (writeServerPermissionError(res, cors, err)) return true;
      if (writePathGuardError(res, cors, err)) return true;
      res.writeHead(400, { ...cors });
      res.end(JSON.stringify({ error: (err as Error).message }));
    }
    return true;
  }

  // Save session (no-op, auto-saved by PI)
  if (url === "/api/sessions/save" && method === "POST") {
    res.writeHead(200, { ...cors });
    res.end(JSON.stringify({ ok: true }));
    return true;
  }

  // Pin/unpin session — 追加 session_info 元数据，不改 PI message 记录
  if (url === "/api/sessions/pin" && method === "POST") {
    try {
      const { id, pinned } = await parseBody(req);
      const sessionFile = await findAuthorizedSessionFileById(ctx, id, "sessions.pin.lookup");
      if (!sessionFile) {
        res.writeHead(404, { ...cors });
        res.end(JSON.stringify({ error: "session not found" }));
        return true;
      }
      const authorizedFile = await authorizeSessionPath(ctx, sessionFile, "write", "sessions.pin");
      appendSessionInfo(authorizedFile, { pinned: Boolean(pinned) });
      res.writeHead(200, { "Content-Type": "application/json", ...cors });
      res.end(JSON.stringify({ ok: true, id, pinned: Boolean(pinned) }));
    } catch (err: unknown) {
      if (writeServerPermissionError(res, cors, err)) return true;
      if (writePathGuardError(res, cors, err)) return true;
      res.writeHead(400, { ...cors });
      res.end(JSON.stringify({ error: (err as Error).message }));
    }
    return true;
  }

  // Branch session — 复制现有历史为新 JSONL，换新 id 后立即激活
  if (url === "/api/sessions/branch" && method === "POST") {
    try {
      const { id, workspace: requestedWorkspace, name } = await parseBody(req);
      const workspace = await authorizeWorkspacePath(ctx, requestedWorkspace, "sessions.branch.workspace");
      const sourceFile = await findAuthorizedSessionFileById(ctx, id, "sessions.branch.lookup");
      if (!sourceFile) {
        res.writeHead(404, { ...cors });
        res.end(JSON.stringify({ error: "session not found" }));
        return true;
      }
      const authorizedSource = await authorizeSessionPath(ctx, sourceFile, "read", "sessions.branch.source");
      const sourceContent = readFileSync(authorizedSource, "utf-8");
      const sourceLines = sourceContent.trim().split("\n").filter(Boolean);
      const sourceHeader = sourceLines[0] ? JSON.parse(sourceLines[0]) : {};
      const sourceMeta = readSessionMeta(sourceLines);
      const newId = `branch-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
      const targetDir = dirname(authorizedSource);
      const targetFile = await authorizeSessionPath(ctx, resolve(targetDir, `${newId}.jsonl`), "create", "sessions.branch.destination");
      const branchName = typeof name === "string" && name.trim()
        ? name.trim()
        : `${sourceMeta.name || "未命名会话"} · 分支`;
      const branchHeader = {
        ...sourceHeader,
        id: newId,
        timestamp: new Date().toISOString(),
        workspace: workspace || sourceHeader.workspace || runtime.currentWorkspace || "",
      };
      const branchInfo = JSON.stringify({
        type: "session_info",
        name: branchName,
        pinned: false,
        branchFrom: { id, name: sourceMeta.name || "未命名会话" },
        timestamp: new Date().toISOString(),
      });
      writeFileSync(targetFile, [JSON.stringify(branchHeader), branchInfo, ...sourceLines.slice(1)].join("\n") + "\n");
      const targetWorkspace = workspace || runtime.currentWorkspace;
      await runWithWorkspaceOwnership(
        ctx,
        targetWorkspace,
        () => runtime.openSession(targetFile, targetWorkspace),
      );
      publishActiveSessionChanged(ctx);
      const readableTarget = await authorizeSessionPath(ctx, targetFile, "read", "sessions.branch.result");
      const messages = parseSessionMessages(readFileSync(readableTarget, "utf-8"));
      const activeSessionId = runtime.getActiveSession?.()?.id || newId;
      res.writeHead(200, { "Content-Type": "application/json", ...cors });
      res.end(JSON.stringify({ ok: true, id: newId, activeSessionId, messages }));
    } catch (err: unknown) {
      if (writeServerPermissionError(res, cors, err)) return true;
      if (writePathGuardError(res, cors, err)) return true;
      res.writeHead(400, { ...cors });
      res.end(JSON.stringify({ error: (err as Error).message }));
    }
    return true;
  }

  // Activate session — 让 runtime 加载该 session 作为活跃 session
  if (url === "/api/sessions/activate" && method === "POST") {
    try {
      const body = await parseBody(req);
      const { id } = body;
      const workspace = await authorizeWorkspacePath(ctx, body.workspace, "sessions.activate.workspace");
      const sessionFile = await findAuthorizedSessionFileById(ctx, id, "sessions.activate.lookup", workspace);
      if (!sessionFile) {
        const activeSession = runtime.getActiveSession?.();
        if (activeSession?.id === id) {
          res.writeHead(200, { "Content-Type": "application/json", ...cors });
          res.end(JSON.stringify({ ok: true, activeSessionId: id, messages: [] }));
          return true;
        }
        res.writeHead(404, { ...cors });
        res.end(JSON.stringify({ error: "session not found" }));
        return true;
      }
      // openSession 会重建 session，同 workspace 下切换不同 session 文件
      const targetSessionsDir = sessionsDirForWorkspace(ctx, workspace || runtime.currentWorkspace);
      const authorizedFile = await authorizeSessionPath(
        ctx,
        sessionFile,
        "read",
        "sessions.activate",
        targetSessionsDir,
      );
      const targetWorkspace = workspace || runtime.currentWorkspace;
      await runWithWorkspaceOwnership(
        ctx,
        targetWorkspace,
        () => runtime.openSession(authorizedFile, targetWorkspace),
      );
      publishActiveSessionChanged(ctx);
      const content = readFileSync(authorizedFile, "utf-8");
      const messages = parseSessionMessages(content);
      const activeSessionId = runtime.getActiveSession?.()?.id || "";
      res.writeHead(200, { "Content-Type": "application/json", ...cors });
      res.end(JSON.stringify({ ok: true, activeSessionId, messages }));
    } catch (err: unknown) {
      if (writeServerPermissionError(res, cors, err)) return true;
      if (writePathGuardError(res, cors, err)) return true;
      res.writeHead(400, { ...cors });
      res.end(JSON.stringify({ error: (err as Error).message }));
    }
    return true;
  }

  // Get session messages
  if (method === "GET" && url?.startsWith("/api/sessions/") && url?.endsWith("/messages")) {
    try {
      const idMatch = url.match(/\/api\/sessions\/(.+?)\/messages/);
      const sessionId = idMatch ? idMatch[1] : "";
      const sessionFile = await findAuthorizedSessionFileById(ctx, sessionId, "sessions.messages.lookup");
      if (!sessionFile) {
        res.writeHead(404, { ...cors });
        res.end(JSON.stringify({ error: "not found" }));
        return true;
      }
      const authorizedFile = await authorizeSessionPath(ctx, sessionFile, "read", "sessions.messages");
      const content = readFileSync(authorizedFile, "utf-8");
      const messages = parseSessionMessages(content);
      res.writeHead(200, { "Content-Type": "application/json", ...cors });
      res.end(JSON.stringify({ messages }));
    } catch (err: unknown) {
      if (writeServerPermissionError(res, cors, err)) return true;
      if (writePathGuardError(res, cors, err)) return true;
      res.writeHead(400, { ...cors });
      res.end(JSON.stringify({ error: (err as Error).message }));
    }
    return true;
  }

  // Rename session
  if (url === "/api/sessions/rename" && method === "POST") {
    try {
      const parsed = await parseBody(req);
      const { id, name } = parsed;
      const titleSource = parsed.titleSource === "auto" || parsed.titleSource === "manual" ? parsed.titleSource : undefined;
      const sessionFile = await findAuthorizedSessionFileById(ctx, id, "sessions.rename.lookup");
      if (sessionFile) {
        const authorizedFile = await authorizeSessionPath(ctx, sessionFile, "write", "sessions.rename");
        appendSessionInfo(authorizedFile, titleSource ? { name, titleSource } : { name });
      }
      res.writeHead(200, { ...cors });
      res.end(JSON.stringify({ ok: true }));
    } catch (err: unknown) {
      if (writeServerPermissionError(res, cors, err)) return true;
      if (writePathGuardError(res, cors, err)) return true;
      res.writeHead(400, { ...cors });
      res.end(JSON.stringify({ error: (err as Error).message }));
    }
    return true;
  }

  // Delete session
  if (url === "/api/sessions/delete" && method === "POST") {
    try {
      const { id } = await parseBody(req);
      const sessionFile = await findAuthorizedSessionFileById(ctx, id, "sessions.delete.lookup");
      if (sessionFile) {
        const authorizedFile = await authorizeSessionPath(ctx, sessionFile, "remove", "sessions.delete");
        unlinkSync(authorizedFile);
      }
      res.writeHead(200, { ...cors });
      res.end(JSON.stringify({ ok: true }));
    } catch (err: unknown) {
      if (writeServerPermissionError(res, cors, err)) return true;
      if (writePathGuardError(res, cors, err)) return true;
      res.writeHead(400, { ...cors });
      res.end(JSON.stringify({ error: (err as Error).message }));
    }
    return true;
  }

  return false;
};
