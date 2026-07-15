/**
 * Git core — Git 状态/日志解析纯逻辑，无 HTTP 依赖
 */
import { execSync } from "child_process";
import { resolve } from "path";
import { existsSync } from "fs";

// ─── Types ───────────────────────────────────────────────────────

export interface GitStatusEntry {
  x: string;
  y: string;
  path: string;
  renamePath?: string;
}

export interface GitLogEntry {
  hash: string;
  date: string;
  message: string;
  author?: string;
}

// ─── Helpers ─────────────────────────────────────────────────────

export function findGitRoot(dir: string): string | null {
  let current = resolve(dir);
  for (let i = 0; i < 20; i++) {
    if (existsSync(resolve(current, ".git"))) return current;
    const parent = resolve(current, "..");
    if (parent === current) return null;
    current = parent;
  }
  return null;
}

export function parsePorcelain(output: string): GitStatusEntry[] {
  const entries: GitStatusEntry[] = [];
  for (const line of output.split("\n")) {
    if (!line.trim()) continue;
    const x = line[0] || " ";
    const y = line[1] || " ";
    const rest = line.slice(3).trim();
    if (rest.includes(" -> ")) {
      const [orig, renamed] = rest.split(" -> ");
      entries.push({ x, y, path: orig.trim(), renamePath: renamed?.trim() });
    } else {
      entries.push({ x, y, path: rest });
    }
  }
  return entries;
}

export function parseLog(output: string): GitLogEntry[] {
  const entries: GitLogEntry[] = [];
  for (const line of output.split("\n")) {
    if (!line.trim()) continue;
    const spaceIdx = line.indexOf(" ");
    if (spaceIdx === -1) continue;
    entries.push({ hash: line.slice(0, spaceIdx), date: "", message: line.slice(spaceIdx + 1) });
  }
  return entries;
}

/** Get full log with dates for detail display */
export function parseLogVerbose(output: string): GitLogEntry[] {
  const entries: GitLogEntry[] = [];
  let current: Partial<GitLogEntry> | null = null;
  for (const line of output.split("\n")) {
    if (line.startsWith("commit ")) {
      if (current?.hash) entries.push(current as GitLogEntry);
      current = { hash: line.slice(7).trim() };
    } else if (line.startsWith("Date:") && current) {
      current.date = line.slice(5).trim();
    } else if (line.startsWith("    ") && current) {
      current.message = (current.message || "") + line.trim() + " ";
    }
  }
  if (current?.hash) entries.push(current as GitLogEntry);
  return entries;
}

export const STATUS_LABELS: Record<string, string> = {
  M: "修改", A: "新增", D: "删除", R: "重命名",
  C: "复制", U: "未合并", "?": "未跟踪", "!": "忽略",
};

export function statusLabel(code: string): string {
  return STATUS_LABELS[code] || code;
}
