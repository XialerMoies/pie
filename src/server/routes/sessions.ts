/**
 * Session routes — CRUD for conversation sessions
 */
import type { RouteHandler } from "./types";
import { readFileSync, writeFileSync, existsSync, readdirSync, unlinkSync, statSync, mkdirSync, renameSync } from "fs";
import { resolve, basename, dirname } from "path";
import { randomUUID } from "crypto";
import { parseBody } from "./parse-body";
import { wsKey, wsDir } from "./session-dir";

// Re-export for backward compat (tests use mod.wsKey / mod.wsDir)
export { wsKey, wsDir } from "./session-dir";

const cors = { "Access-Control-Allow-Origin": "*" };

/** 迁移会话: 从 sessions/ 根目录按 workspace 分类移入 by-project/ */
function migrateOldSessions(baseDir: string): void {
  const entries = readdirSync(baseDir, { withFileTypes: true });
  let moved = 0;
  for (const e of entries) {
    if (e.name === "by-project") continue;
    if (!e.name.endsWith(".jsonl")) continue;
    const fp = resolve(baseDir, e.name);
    try {
      const content = readFileSync(fp, "utf-8");
      const header = JSON.parse(content.trim().split("\n")[0] || "{}");
      const ws = header.workspace || "";
      const targetDir = ws ? wsDir(baseDir, ws) : resolve(baseDir, "by-project", "_legacy");
      if (!existsSync(targetDir)) mkdirSync(targetDir, { recursive: true });
      renameSync(fp, resolve(targetDir, e.name));
      moved++;
    } catch {}
  }
  if (moved > 0) console.log(`📦 Migrated ${moved} session(s) to by-project/`);
}

/** 扫描所有项目的session目录 */
function findAllProjectDirs(baseDir: string): string[] {
  const projectsDir = resolve(baseDir, "by-project");
  if (!existsSync(projectsDir)) return [];
  return readdirSync(projectsDir, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .map(d => resolve(projectsDir, d.name));
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

export function findAllJsonl(dir: string): string[] {
  const entries = readdirSync(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const e of entries) {
    if (e.isDirectory()) files.push(...findAllJsonl(resolve(dir, e.name)));
    else if (e.name.endsWith(".jsonl")) files.push(resolve(dir, e.name));
  }
  return files;
}

export function findSessionFileById(baseDir: string, id: string): string | null {
  // Search all session files by reading header ID
  const searchDirs = [baseDir, resolve(baseDir, "by-project")];
  for (const dir of searchDirs) {
    if (!existsSync(dir)) continue;
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const e of entries) {
      if (e.isDirectory()) {
        // Recurse into subdirectories
        const found = findSessionFileById(resolve(dir, e.name), id);
        if (found) return found;
      } else if (e.name.endsWith(".jsonl")) {
        const fp = resolve(dir, e.name);
        try {
          const headerLine = readFileSync(fp, "utf-8").trim().split("\n")[0];
          const header = JSON.parse(headerLine);
          if (header.id === id || e.name.includes(id)) return fp;
        } catch {}
      }
    }
  }
  return null;
}

type SessionTrace =
  | { type: "thinking"; status: "streaming" | "done"; text: string; turnId?: string; id: string }
  | { type: "tool"; status: "running" | "success" | "error"; name: string; input?: unknown; output?: string; error?: string; turnId?: string; id: string }
  | { type: "step"; status: "info" | "success" | "error"; text: string; turnId?: string; id: string };

type SessionMessage = { role: string; content: string; thinking?: string; turnId?: string; trace?: SessionTrace[]; _compacted?: boolean };

type SessionBranchInfo = { id: string; name?: string };

type SessionMeta = {
  name: string;
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
      blocks.push({
        type: 'tool_use', toolCallId: t.id, name: t.name, input: t.input,
        status: terminalStatus,
        turnId: t.turnId || '', blockId: t.id + '_use', seq: seq++,
      });
      blocks.push({
        type: 'tool_result', toolUseId: t.id,
        output: isError ? (last.error || (last.status === 'running' ? '[中断]' : undefined)) : last.output,
        isError,
        turnId: t.turnId || '', blockId: t.id + '_result', seq: seq++,
      });
    }
  }

  // 如果有正文且没有 text block，添加一个 text block
  if (content && !blocks.some(b => b.type === 'text')) {
    blocks.push({ type: 'text', text: content, turnId: '', blockId: 'text-0', seq: seq++ });
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

  const blocksByTurn = new Map<string, any[]>();
  for (const entry of entries) {
    if (entry.type !== "assistant_block" || !entry.block) continue;
    const turnId = entry.turnId || entry.block.turnId || "";
    if (!turnId) continue;
    if (!blocksByTurn.has(turnId)) blocksByTurn.set(turnId, []);
    blocksByTurn.get(turnId)!.push(entry.block);
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
  for (const entry of entries) {
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
        // 优先使用 assistant_block 记录（新协议），按 turnId 精确匹配
        if (role === "assistant") {
          const tid = entry.turnId || entry.id;
          if (tid && blocksByTurn.has(tid)) {
            (message as any).blocks = blocksByTurn.get(tid)!.sort((a, b) => a.seq - b.seq);
            blocksByTurn.delete(tid);
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

  return messages;
}

export const handleSessions: RouteHandler = async (req, res, ctx) => {
  const { url, method } = req;
  const { runtime, paths: p } = ctx;
  const session = runtime.session;

  // List sessions — filtered by workspace, with "other projects" section
  if ((url === "/api/sessions" || url?.startsWith("/api/sessions?")) && method === "GET") {
    try {
      // Migrate old flat sessions -> by-project/
      migrateOldSessions(p.SESSIONS_DIR);

      const u = new URL(url, `http://${req.headers.host || "localhost"}`);
      const currentWs = u.searchParams.get("workspace") || "";
      const includeOther = u.searchParams.get("other") === "1";
      const curId = (session as any).sessionManager?.getSessionId?.() ?? "";

      // Current workspace sessions dir
      const curSessionsDir = wsDir(p.SESSIONS_DIR, currentWs);
      if (!existsSync(p.SESSIONS_DIR)) mkdirSync(p.SESSIONS_DIR, { recursive: true });
      if (!existsSync(curSessionsDir)) mkdirSync(curSessionsDir, { recursive: true });

      // Active session ID from runtime
      const activeSession = runtime.getActiveSession ? runtime.getActiveSession() : null;
      const runningSessionId = (session as any).isStreaming ? activeSession?.id || curId : "";

      // Helper to parse session from a dir
      function readSessionsFromDir(dir: string): Array<Record<string, unknown>> {
        if (!existsSync(dir)) return [];
        return findAllJsonl(dir).map((fullPath: string) => {
          const stat = existsSync(fullPath) ? statSync(fullPath) : null;
          const content = readFileSync(fullPath, "utf-8");
          const lines = content.trim().split("\n");
          const header = lines[0] ? JSON.parse(lines[0]) : {};
          const id = header.id || basename(fullPath, ".jsonl");
          const meta = readSessionMeta(lines);
          const replySummary = meta.name ? "" : deriveReplySummary(lines);
          const hasError = lines.some((line: string) => line.includes('"isError":true') || line.includes('"status":"error"') || line.includes('"error"'));
          return {
            id, name: meta.name || replySummary || "新会话", active: id === curId,
            messageCount: lines.filter((l: string) => l.includes('"type":"message"')).length,
            createdAt: stat?.birthtime?.toISOString() || header.timestamp || "",
            updatedAt: stat?.mtime?.toISOString() || header.timestamp || "",
            file: basename(fullPath),
            workspace: header.workspace || "",
            pinned: meta.pinned,
            archived: Boolean(meta.archived),
            hasError,
            isRunning: id === runningSessionId,
            branchFrom: meta.branchFrom,
          };
        }).sort((a: Record<string, unknown>, b: Record<string, unknown>) => String(b["updatedAt"] || b["createdAt"] || "").localeCompare(String(a["updatedAt"] || a["createdAt"] || "")));
      }

      const sessions = readSessionsFromDir(curSessionsDir);

      // Other projects
      let other: { project: string; path: string; sessions: Record<string, unknown>[] }[] = [];
      if (includeOther) {
        const allDirs = findAllProjectDirs(p.SESSIONS_DIR);
        const curKey = wsKey(currentWs);
        for (const dir of allDirs) {
          const projName = basename(dir);
          if (projName === curKey) continue;
          const projSessions = readSessionsFromDir(dir);
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
      res.writeHead(200, { ...cors });
      res.end(JSON.stringify({ sessions: [], other: [], error: (err as Error).message }));
    }
    return true;
  }

  // Create new session — 由 SessionManager.create() 创建文件，runtime 立即切到新 session
  if (url === "/api/sessions/new" && method === "POST") {
    try {
      const body = await parseBody(req).catch(() => ({}));
      const workspace = body.workspace || "";
      // 如果 workspace 与当前不同，先切 workspace 再创建
      if (workspace && runtime.currentWorkspace !== workspace) {
        await runtime.switchWorkspace(workspace);
      }
      const id = await runtime.createNewSession();
      res.writeHead(200, { "Content-Type": "application/json", ...cors });
      res.end(JSON.stringify({ ok: true, id }));
    } catch (err: unknown) {
      res.writeHead(400, { ...cors });
      res.end(JSON.stringify({ error: (err as Error).message }));
    }
    return true;
  }

  // Migrate session to workspace (move from _legacy to project dir)
  if (url === "/api/sessions/migrate" && method === "POST") {
    try {
      const body = await parseBody(req);
      const { id, workspace } = body;
      const sFile = findSessionFileById(p.SESSIONS_DIR, id);
      if (!sFile) { res.writeHead(404, { ...cors }); res.end(JSON.stringify({ error: "not found" })); return true; }
      const targetDir = wsDir(p.SESSIONS_DIR, workspace || "");
      if (!existsSync(targetDir)) mkdirSync(targetDir, { recursive: true });
      const targetFile = resolve(targetDir, basename(sFile));
      // Read, tag, and move
      const content = readFileSync(sFile, "utf-8");
      const lines = content.trim().split("\n");
      const header = JSON.parse(lines[0]);
      header.workspace = workspace || "";
      lines[0] = JSON.stringify(header);
      writeFileSync(targetFile, lines.join("\n") + "\n");
      if (sFile !== targetFile) unlinkSync(sFile);
      console.log(`📦 Migrated session ${id} → by-project/${wsKey(workspace)}/`);
      res.writeHead(200, { "Content-Type": "application/json", ...cors });
      res.end(JSON.stringify({ ok: true }));
    } catch (err: unknown) {
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
      const sessionFile = findSessionFileById(p.SESSIONS_DIR, id);
      if (!sessionFile) {
        res.writeHead(404, { ...cors });
        res.end(JSON.stringify({ error: "session not found" }));
        return true;
      }
      appendSessionInfo(sessionFile, { pinned: Boolean(pinned) });
      res.writeHead(200, { "Content-Type": "application/json", ...cors });
      res.end(JSON.stringify({ ok: true, id, pinned: Boolean(pinned) }));
    } catch (err: unknown) {
      res.writeHead(400, { ...cors });
      res.end(JSON.stringify({ error: (err as Error).message }));
    }
    return true;
  }

  // Branch session — 复制现有历史为新 JSONL，换新 id 后立即激活
  if (url === "/api/sessions/branch" && method === "POST") {
    try {
      const { id, workspace, name } = await parseBody(req);
      const sourceFile = findSessionFileById(p.SESSIONS_DIR, id);
      if (!sourceFile) {
        res.writeHead(404, { ...cors });
        res.end(JSON.stringify({ error: "session not found" }));
        return true;
      }
      const sourceContent = readFileSync(sourceFile, "utf-8");
      const sourceLines = sourceContent.trim().split("\n").filter(Boolean);
      const sourceHeader = sourceLines[0] ? JSON.parse(sourceLines[0]) : {};
      const sourceMeta = readSessionMeta(sourceLines);
      const newId = `branch-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
      const targetDir = dirname(sourceFile);
      const targetFile = resolve(targetDir, `${newId}.jsonl`);
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
      await runtime.openSession(targetFile, workspace || runtime.currentWorkspace);
      const messages = parseSessionMessages(readFileSync(targetFile, "utf-8"));
      const activeSessionId = runtime.getActiveSession?.()?.id || newId;
      res.writeHead(200, { "Content-Type": "application/json", ...cors });
      res.end(JSON.stringify({ ok: true, id: newId, activeSessionId, messages }));
    } catch (err: unknown) {
      res.writeHead(400, { ...cors });
      res.end(JSON.stringify({ error: (err as Error).message }));
    }
    return true;
  }

  // Activate session — 让 runtime 加载该 session 作为活跃 session
  if (url === "/api/sessions/activate" && method === "POST") {
    try {
      const body = await parseBody(req);
      const { id, workspace } = body;
      const sessionFile = findSessionFileById(p.SESSIONS_DIR, id);
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
      await runtime.openSession(sessionFile, workspace || runtime.currentWorkspace);
      const content = readFileSync(sessionFile, "utf-8");
      const messages = parseSessionMessages(content);
      const activeSessionId = runtime.getActiveSession?.()?.id || "";
      res.writeHead(200, { "Content-Type": "application/json", ...cors });
      res.end(JSON.stringify({ ok: true, activeSessionId, messages }));
    } catch (err: unknown) {
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
      const sessionFile = findSessionFileById(p.SESSIONS_DIR, sessionId);
      if (!sessionFile) {
        res.writeHead(404, { ...cors });
        res.end(JSON.stringify({ error: "not found" }));
        return true;
      }
      const content = readFileSync(sessionFile, "utf-8");
      const messages = parseSessionMessages(content);
      res.writeHead(200, { "Content-Type": "application/json", ...cors });
      res.end(JSON.stringify({ messages }));
    } catch (err: unknown) {
      res.writeHead(400, { ...cors });
      res.end(JSON.stringify({ error: (err as Error).message }));
    }
    return true;
  }

  // Rename session
  if (url === "/api/sessions/rename" && method === "POST") {
    try {
      const { id, name } = await parseBody(req);
      const sessionFile = findSessionFileById(p.SESSIONS_DIR, id);
      if (sessionFile) {
        appendSessionInfo(sessionFile, { name });
      }
      res.writeHead(200, { ...cors });
      res.end(JSON.stringify({ ok: true }));
    } catch (err: unknown) {
      res.writeHead(400, { ...cors });
      res.end(JSON.stringify({ error: (err as Error).message }));
    }
    return true;
  }

  // Delete session
  if (url === "/api/sessions/delete" && method === "POST") {
    try {
      const { id } = await parseBody(req);
      const sessionFile = findSessionFileById(p.SESSIONS_DIR, id);
      if (sessionFile) unlinkSync(sessionFile);
      res.writeHead(200, { ...cors });
      res.end(JSON.stringify({ ok: true }));
    } catch (err: unknown) {
      res.writeHead(400, { ...cors });
      res.end(JSON.stringify({ error: (err as Error).message }));
    }
    return true;
  }

  return false;
};
