/**
 * usage-index — session JSONL 用量索引
 *
 * 结构：data/pi/usage-index.json
 *   - version: 2
 *   - updatedAt: 上次全量扫描时间
 *   - sessions: Map<sessionId, SessionUsage>
 *
 * 策略：
 *   首次 → 全量扫描所有 .jsonl
 *   后续 → 按文件 mtime 增量更新
 *   compact 后 → 单文件更新
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync, readdirSync } from "fs";
import { resolve, relative, sep } from "path";

// ─── 类型 ───────────────────────────────────────────────

export interface SessionUsage {
  path: string;              // 相对于 SESSIONS_DIR
  updatedAt: string;         // 文件 mtime
  name: string;
  workspace: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  compactCount: number;
  lastCompactionAt: string | null;
}

export interface UsageIndex {
  version: number;
  updatedAt: string;
  sessions: Record<string, SessionUsage>;  // key = JSONL 首行 session id
}

// ─── I/O ─────────────────────────────────────────────────

const INDEX_VERSION = 2;

export function loadIndex(indexPath: string): UsageIndex | null {
  try {
    const raw = readFileSync(indexPath, "utf-8");
    const data = JSON.parse(raw);
    if (data?.version === INDEX_VERSION && data?.sessions) {
      return data as UsageIndex;
    }
  } catch {}
  return null;
}

export function saveIndex(indexPath: string, index: UsageIndex): void {
  const dir = indexPath.substring(0, indexPath.lastIndexOf(sep));
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(indexPath, JSON.stringify(index, null, 2));
}

// ─── 单 session 扫描 ────────────────────────────────────

/** scanSessionFile 返回 session id + usage 数据 */
export interface ScannedSession {
  id: string;
  usage: SessionUsage;
}

export function scanSessionFile(filePath: string): ScannedSession | null {
  try {
    const stat = statSync(filePath);
    const content = readFileSync(filePath, "utf-8");
    const lines = content.trim().split("\n");

    let id = "";
    let name = "";
    let workspace = "";
    let input = 0, output = 0, cacheRead = 0, cacheWrite = 0, cost = 0;
    let compactCount = 0;
    let lastCompactionAt: string | null = null;

    for (const line of lines) {
      try {
        const entry = JSON.parse(line);
        if (entry.type === "session") {
          id = id || entry.id || "";
          workspace = workspace || entry.workspace || entry.cwd || "";
        } else if (entry.type === "session_info") {
          if (typeof entry.name === "string" && entry.name.trim()) name = entry.name.trim();
        } else if (entry.type === "message" && entry.message) {
          const u = entry.message.usage;
          if (u) {
            input += u.input || 0;
            output += u.output || 0;
            cacheRead += u.cacheRead || 0;
            cacheWrite += u.cacheWrite || 0;
            if (u.cost != null) {
              if (typeof u.cost === "number") cost += u.cost;
              else cost += u.cost.total ?? 0;
            }
          }
        } else if (entry.type === "compaction") {
          compactCount++;
          if (entry.timestamp) lastCompactionAt = entry.timestamp;
        }
      } catch {}
    }

    if (!id) return null; // 无效 session 文件

    if (!name) name = deriveReplySummary(lines);

    return {
      id,
      usage: {
        path: "",
        updatedAt: stat.mtime?.toISOString() || "",
        name: name || "未命名",
        workspace,
        input,
        output,
        cacheRead,
        cacheWrite,
        cost: roundCost(cost),
        compactCount,
        lastCompactionAt,
      },
    };
  } catch {
    return null;
  }
}

function roundCost(n: number): number {
  return Math.round(n * 1_000_000) / 1_000_000;
}

function textFromBlocks(blocks: Array<{type: string; text?: string}>): string {
  return blocks.filter((c) => c.type === "text").map((c) => c.text || "").join(" ").trim();
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
      const blocks = (entry.message.content as Array<{type: string; text?: string}> | undefined) || [];
      const summary = extractReplyTitle(textFromBlocks(blocks));
      if (summary) return summary;
    } catch {}
  }
  return "";
}

// ─── 全量扫描 ────────────────────────────────────────────

/**
 * 全量扫描 sessions 目录，返回新索引。
 */
export function fullScan(sessionsDir: string): UsageIndex {
  let files: string[];
  try { files = findAllJsonl(sessionsDir); } catch { files = []; }
  const sessions: Record<string, SessionUsage> = {};

  for (const filePath of files) {
    const scanned = scanSessionFile(filePath);
    if (!scanned) continue;
    const relPath = relative(sessionsDir, filePath).replace(/\\/g, "/");
    scanned.usage.path = relPath;
    sessions[scanned.id] = scanned.usage;
  }

  return {
    version: INDEX_VERSION,
    updatedAt: new Date().toISOString(),
    sessions,
  };
}

// ─── 增量扫描 ────────────────────────────────────────────

/**
 * 只处理 mtime 比索引更新的文件；同时清理已删除的 session。
 */
export function incrementalScan(sessionsDir: string, index: UsageIndex): UsageIndex {
  let files: string[];
  try { files = findAllJsonl(sessionsDir); } catch { files = []; }
  const sessions = { ...index.sessions };
  let changed = false;

  // 清理已删除文件：记录当前存在的文件路径集合
  const activePaths = new Set(files.map(f => relative(sessionsDir, f).replace(/\\/g, "/")));
  for (const [id, s] of Object.entries(sessions)) {
    if (!activePaths.has(s.path)) {
      delete sessions[id];
      changed = true;
    }
  }

  for (const filePath of files) {
    const relPath = relative(sessionsDir, filePath).replace(/\\/g, "/");

    // 检查 mtime
    try {
      const mtime = statSync(filePath).mtimeMs;
      const existingId = findSessionIdByPath(sessions, relPath);
      if (existingId) {
        const existing = sessions[existingId];
        if (existing && new Date(existing.updatedAt).getTime() >= mtime) continue;
      }
    } catch { continue; }

    const scanned = scanSessionFile(filePath);
    if (!scanned) continue;
    scanned.usage.path = relPath;
    sessions[scanned.id] = scanned.usage;
    changed = true;
  }

  return {
    version: INDEX_VERSION,
    updatedAt: changed ? new Date().toISOString() : index.updatedAt,
    sessions,
  };
}

/** 通过 relPath 找到已有 session id（处理重命名场景） */
function findSessionIdByPath(sessions: Record<string, SessionUsage>, relPath: string): string | null {
  for (const [id, s] of Object.entries(sessions)) {
    if (s.path === relPath) return id;
  }
  return null;
}

// ─── 单文件更新（compact 后） ───────────────────────────

/**
 * 重新扫描单个 session 文件并更新索引。
 */
export function updateSessionInIndex(sessionsDir: string, filePath: string, index: UsageIndex): UsageIndex {
  const relPath = relative(sessionsDir, filePath).replace(/\\/g, "/");
  const sessions = { ...index.sessions };

  const scanned = scanSessionFile(filePath);
  if (scanned) {
    scanned.usage.path = relPath;
    sessions[scanned.id] = scanned.usage;
  }

  return {
    ...index,
    updatedAt: new Date().toISOString(),
    sessions,
  };
}

// ─── 辅助 ────────────────────────────────────────────────

function findAllJsonl(dir: string): string[] {
  const entries = readdirSync(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const e of entries) {
    if (e.isDirectory()) files.push(...findAllJsonl(resolve(dir, e.name)));
    else if (e.name.endsWith(".jsonl")) files.push(resolve(dir, e.name));
  }
  return files;
}
