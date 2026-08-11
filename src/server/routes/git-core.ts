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

export interface GitDiffHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: string[];
}

export interface GitDiffResult {
  filePath: string;
  type: "update" | "create" | "delete" | "rename";
  linesAdded: number;
  linesRemoved: number;
  structuredPatch: GitDiffHunk[];
  binary?: boolean;
  truncated?: boolean;
  omittedLines?: number;
  message?: string;
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

export function textLines(content: string): string[] {
  const lines = content.replaceAll("\r\n", "\n").replaceAll("\r", "\n").split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

export function createFileDiff(filePath: string, content: string, maxLines = 2000): GitDiffResult {
  const allLines = textLines(content);
  const visibleLines = allLines.slice(0, maxLines);
  const omittedLines = allLines.length - visibleLines.length;
  return {
    filePath,
    type: "create",
    linesAdded: allLines.length,
    linesRemoved: 0,
    structuredPatch: allLines.length === 0 ? [] : [{
      oldStart: 0,
      oldLines: 0,
      newStart: 1,
      newLines: allLines.length,
      lines: visibleLines.map(line => `+${line}`),
    }],
    ...(omittedLines > 0 ? { truncated: true, omittedLines } : {}),
  };
}

export function parseUnifiedDiff(output: string, filePath: string, maxLines = 2000): GitDiffResult {
  const normalized = output.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
  const sourceLines = normalized.split("\n");
  const binary = sourceLines.some(line => line.startsWith("Binary files ") || line === "GIT binary patch");
  const type: GitDiffResult["type"] = sourceLines.some(line => line.startsWith("rename from "))
    ? "rename"
    : sourceLines.some(line => line.startsWith("new file mode "))
      ? "create"
      : sourceLines.some(line => line.startsWith("deleted file mode "))
        ? "delete"
        : "update";
  const structuredPatch: GitDiffHunk[] = [];
  let current: GitDiffHunk | null = null;
  let totalChangedLines = 0;
  let visibleChangedLines = 0;
  let linesAdded = 0;
  let linesRemoved = 0;

  for (const line of sourceLines) {
    const hunk = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
    if (hunk) {
      current = {
        oldStart: Number(hunk[1]),
        oldLines: hunk[2] === undefined ? 1 : Number(hunk[2]),
        newStart: Number(hunk[3]),
        newLines: hunk[4] === undefined ? 1 : Number(hunk[4]),
        lines: [],
      };
      structuredPatch.push(current);
      continue;
    }
    if (!current || line === "\\ No newline at end of file") continue;
    if (!line.startsWith("+") && !line.startsWith("-") && !line.startsWith(" ")) continue;
    if (line.startsWith("+")) linesAdded += 1;
    if (line.startsWith("-")) linesRemoved += 1;
    totalChangedLines += 1;
    if (visibleChangedLines < maxLines) {
      current.lines.push(line);
      visibleChangedLines += 1;
    }
  }

  const omittedLines = totalChangedLines - visibleChangedLines;
  return {
    filePath,
    type,
    linesAdded,
    linesRemoved,
    structuredPatch,
    ...(binary ? { binary: true, message: "二进制文件已更改" } : {}),
    ...(omittedLines > 0 ? { truncated: true, omittedLines } : {}),
  };
}
