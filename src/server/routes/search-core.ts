/**
 * Search core — 文件名/全文搜索纯逻辑，无 HTTP 依赖
 */
import { readFileSync, writeFileSync, readdirSync, statSync } from "fs";
import { resolve, relative, sep } from "path";

// ─── Types ───────────────────────────────────────────────────────

export interface SearchMatch {
  line: number;
  column: number;
  text: string;
  length: number;
}

export interface SearchResult {
  file: string;
  absolutePath: string;
  matches: SearchMatch[];
}

export interface SearchResponse {
  results: SearchResult[];
  total: number;
  truncated: boolean;
}

// ─── Replace types ─────────────────────────────────────────────

export interface ReplaceMatch {
  line: number;
  column: number;
  oldText: string;
  newText: string;
}

export interface ReplaceFileResult {
  file: string;
  absolutePath: string;
  matches: ReplaceMatch[];
}

export interface ReplaceResponse {
  files: ReplaceFileResult[];
  totalChanges: number;
  preview: boolean;
}

export interface ReplaceOptions {
  query: string;
  replacement: string;
  rootDir: string;
  caseSensitive: boolean;
  regex: boolean;
  previewOnly: boolean;
}

// ─── Binary extensions & skip dirs ──────────────────────────────

export const BINARY_EXT = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".ico", ".svg",
  ".woff", ".woff2", ".ttf", ".eot", ".otf",
  ".pdf", ".zip", ".rar", ".7z", ".gz", ".tar",
  ".exe", ".dll", ".bin", ".o", ".a", ".so", ".dylib",
  ".mp3", ".mp4", ".avi", ".mov", ".wmv",
  ".pyc", ".class", ".jar",
]);

export const SKIP_DIRS = new Set([
  "node_modules", ".git", ".svn", ".claude",
  "dist", "dist-electron", ".vscode", "data",
]);

export const MAX_FILE_SIZE = 1 * 1024 * 1024;  // 1 MB

// ─── Helpers ─────────────────────────────────────────────────────

export function isBinary(filePath: string): boolean {
  const ext = filePath.slice(filePath.lastIndexOf(".")).toLowerCase();
  return BINARY_EXT.has(ext);
}

export function walkDir(
  dir: string,
  maxResults: number,
  collect: (fullPath: string) => void,
): boolean {
  let entries: string[];
  try { entries = readdirSync(dir); } catch { return false; }

  for (const name of entries) {
    const fullPath = resolve(dir, name);
    let st: ReturnType<typeof statSync>;
    try { st = statSync(fullPath); } catch { continue; }

    if (st.isDirectory()) {
      if (SKIP_DIRS.has(name)) continue;
      if (walkDir(fullPath, maxResults, collect)) return true;
    } else if (st.isFile() && st.size <= MAX_FILE_SIZE) {
      collect(fullPath);
    }
  }
  return false;
}

function matchFileName(name: string, query: string, cs: boolean): boolean {
  const n = cs ? name : name.toLowerCase();
  const q = cs ? query : query.toLowerCase();
  return n.includes(q);
}

function searchInFile(
  filePath: string,
  query: string,
  cs: boolean,
  maxPerFile = 50,
): SearchMatch[] {
  try {
    if (isBinary(filePath)) return [];
    const content = readFileSync(filePath, "utf-8");
    const lines = content.split("\n");
    const matches: SearchMatch[] = [];
    const q = cs ? query : query.toLowerCase();

    for (let i = 0; i < lines.length && matches.length < maxPerFile; i++) {
      const line = lines[i];
      const testLine = cs ? line : line.toLowerCase();
      let idx = testLine.indexOf(q);
      while (idx !== -1 && matches.length < maxPerFile) {
        matches.push({ line: i + 1, column: idx + 1, text: line.slice(0, 200).trimEnd(), length: query.length });
        idx = testLine.indexOf(q, idx + 1);
      }
    }
    return matches;
  } catch { return []; }
}

// ─── Core search ─────────────────────────────────────────────────

export function doSearch(
  q: string,
  rootDir: string,
  type: "filename" | "text",
  cs: boolean,
  maxResults: number,
): SearchResponse {
  const results: SearchResult[] = [];
  let truncated = false;

  walkDir(rootDir, maxResults, (fullPath) => {
    if (results.length >= maxResults) { truncated = true; return; }
    const name = fullPath.split(sep).pop() || "";

    if (type === "filename") {
      if (matchFileName(name, q, cs)) {
        results.push({ file: relative(rootDir, fullPath).replace(/\\/g, "/"), absolutePath: fullPath, matches: [] });
      }
      return;
    }

    const matches = searchInFile(fullPath, q, cs);
    if (matches.length > 0) {
      results.push({ file: relative(rootDir, fullPath).replace(/\\/g, "/"), absolutePath: fullPath, matches });
    }
  });

  return { results, total: results.reduce((s, r) => s + r.matches.length, 0), truncated };
}

// ─── Replace helpers ─────────────────────────────────────────────

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Build line-start offset map: lineMap[i] = byte offset of line i+1 (0-based) */
function buildLineMap(content: string): number[] {
  const map: number[] = [0];
  for (let i = 0; i < content.length; i++) {
    if (content[i] === "\n") map.push(i + 1);
  }
  return map;
}

/** Convert byte offset to 1-based line/column using line-start map */
function offsetToLineCol(offset: number, lineMap: number[]): { line: number; column: number } {
  let lo = 0, hi = lineMap.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (lineMap[mid] <= offset) lo = mid;
    else hi = mid - 1;
  }
  return { line: lo + 1, column: offset - lineMap[lo] + 1 };
}

/** Convert 1-based line/column to byte offset using line-start map */
function lineColToOffset(line: number, column: number, lineMap: number[]): number {
  return lineMap[line - 1] + column - 1;
}

/** Apply regex capture-group references ($1, $&, $$) in replacement string */
function applyReplacement(replacement: string, match: RegExpExecArray): string {
  return replacement.replace(/\$(\d+|\$|&)/g, (_, ref) => {
    if (ref === "$") return "$";
    if (ref === "&") return match[0];
    const idx = parseInt(ref, 10);
    return match[idx] ?? "";
  });
}

// ─── Core replace ────────────────────────────────────────────────

export function doReplace(opts: ReplaceOptions): ReplaceResponse {
  const escapedQuery = opts.regex ? opts.query : escapeRegExp(opts.query);
  const flags = opts.caseSensitive ? "g" : "gi";
  const pattern = new RegExp(escapedQuery, flags);
  const files: ReplaceFileResult[] = [];

  walkDir(opts.rootDir, Infinity, (fullPath) => {
    if (isBinary(fullPath)) return;
    try {
      const content = readFileSync(fullPath, "utf-8");
      const lineMap = buildLineMap(content);
      pattern.lastIndex = 0;
      const matches: ReplaceMatch[] = [];

      let m: RegExpExecArray | null;
      while ((m = pattern.exec(content)) !== null) {
        const oldText = m[0];
        const newText = opts.regex ? applyReplacement(opts.replacement, m) : opts.replacement;
        const { line, column } = offsetToLineCol(m.index, lineMap);
        matches.push({ line, column, oldText, newText });

        // Prevent infinite loop on zero-length matches
        if (m.index === pattern.lastIndex) pattern.lastIndex++;
      }

      if (matches.length === 0) return;

      if (!opts.previewOnly) {
        // Apply in reverse offset order to preserve positions
        let newContent = content;
        for (let i = matches.length - 1; i >= 0; i--) {
          const r = matches[i];
          const off = lineColToOffset(r.line, r.column, lineMap);
          newContent = newContent.slice(0, off) + r.newText + newContent.slice(off + r.oldText.length);
        }
        writeFileSync(fullPath, newContent, "utf-8");
      }

      files.push({
        file: relative(opts.rootDir, fullPath).replace(/\\/g, "/"),
        absolutePath: fullPath,
        matches,
      });
    } catch {
      // Skip unreadable files
    }
  });

  const totalChanges = files.reduce((s, f) => s + f.matches.length, 0);
  return { files, totalChanges, preview: opts.previewOnly };
}
