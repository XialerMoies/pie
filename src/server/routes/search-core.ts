/**
 * Search core — 文件名/全文搜索纯逻辑，无 HTTP 依赖
 */
import { readFileSync, readdirSync, statSync } from "fs";
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

function isBinary(filePath: string): boolean {
  const ext = filePath.slice(filePath.lastIndexOf(".")).toLowerCase();
  return BINARY_EXT.has(ext);
}

function walkDir(
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
