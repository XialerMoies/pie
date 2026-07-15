/**
 * Explorer routes — file system browsing and operations
 */
import type { RouteHandler } from "./types";
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync, renameSync, rmSync, mkdirSync } from "fs";
import { resolve, dirname } from "path";
import { parseBody } from "./parse-body";

const cors = { "Access-Control-Allow-Origin": "*" };

// ─── .gitignore parser (simplified) ───────────────────────────────
function loadGitignore(dir: string): ((name: string, isDir: boolean) => boolean) | null {
  const giFile = resolve(dir, ".gitignore");
  if (!existsSync(giFile)) return null;
  const content = readFileSync(giFile, "utf-8");
  const patterns: { negate: boolean; pattern: string; dirOnly: boolean; anchored: boolean }[] = [];
  for (let line of content.split("\n")) {
    line = line.trim();
    if (!line || line.startsWith("#")) continue;
    const negate = line.startsWith("!");
    if (negate) line = line.slice(1);
    const dirOnly = line.endsWith("/");
    const anchored = line.startsWith("/");
    const pattern = (anchored || dirOnly) ? line.replace(/^\/|\/$/g, "") : line;
    patterns.push({ negate, pattern, dirOnly, anchored });
  }
  return (name: string, isDir: boolean): boolean => {
    let ignored: boolean | null = null;
    for (const p of patterns) {
      if (p.dirOnly && !isDir) continue;
      const match = matchGitignore(p.pattern, name);
      if (match) ignored = !p.negate;
    }
    return ignored ?? false;
  };
}

function matchGitignore(pattern: string, name: string): boolean {
  if (pattern === name) return true;
  const reStr = "^" + pattern.replace(/\./g, "\\.").replace(/\*\*/g, "@@").replace(/\*/g, "[^/]*").replace(/@@/g, ".*") + "$";
  try { return new RegExp(reStr).test(name); } catch { return false; }
}

export const handleExplorer: RouteHandler = async (req, res, ctx) => {
  const { url, method } = req;
  const { paths: p } = ctx;

  // List directory contents
  if (url?.startsWith("/api/explorer") && method === "GET") {
    try {
      const parsedUrl = new URL(url, `http://${req.headers.host || "localhost"}`);
      const rootDir = parsedUrl.searchParams.get("root") || p.APP_ROOT;
      const rawPath = parsedUrl.searchParams.get("path") || "";
      const targetDir = rawPath ? resolve(rootDir, rawPath) : rootDir;

      if (!targetDir.startsWith(rootDir)) {
        res.writeHead(403, { ...cors });
        res.end(JSON.stringify({ error: "Access denied" }));
        return true;
      }
      if (!existsSync(targetDir)) {
        res.writeHead(404, { ...cors });
        res.end(JSON.stringify({ error: "目录不存在: " + targetDir }));
        return true;
      }

      const entries = readdirSync(targetDir, { withFileTypes: true });
      const doFilter = parsedUrl.searchParams.get("filter") === "1";
      const giFilter = doFilter ? loadGitignore(targetDir) : null;

      const items = entries
        .filter(e => {
          if (!doFilter) return true;
          if (e.name.startsWith(".") && e.name !== ".gitignore") return false;
          if (e.name === "node_modules" && e.isDirectory()) return false;
          if (giFilter && giFilter(e.name, e.isDirectory())) return false;
          return true;
        })
        .map(e => {
          const fullPath = resolve(targetDir, e.name)
          let size = 0, mtime = ""
          try { const s = statSync(fullPath); size = s.size; mtime = s.mtime.toISOString() } catch {}
          return {
            name: e.name,
            path: rawPath ? rawPath + "/" + e.name : e.name,
            isDir: e.isDirectory(),
            size,
            mtime,
          }
        });
      items.sort((a, b) => {
        if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
        return a.name.localeCompare(b.name);
      });

      res.writeHead(200, { "Content-Type": "application/json", ...cors });
      res.end(JSON.stringify({ rootDir, relativePath: rawPath || "", items }));
    } catch (err: unknown) {
      res.writeHead(400, { ...cors });
      res.end(JSON.stringify({ error: (err as Error).message }));
    }
    return true;
  }

  // Read file content (modes: content, toc)
  if (url?.startsWith("/api/file/read") && method === "GET") {
    try {
      const parsedUrl = new URL(url, `http://${req.headers.host || "localhost"}`);
      const filePath = parsedUrl.searchParams.get("path") || "";
      const rootDir = parsedUrl.searchParams.get("root") || p.APP_ROOT;
      const mode = parsedUrl.searchParams.get("mode") || "content";
      const resolvedPath = resolve(rootDir, filePath);

      if (!resolvedPath.startsWith(rootDir)) {
        res.writeHead(403, { ...cors });
        res.end(JSON.stringify({ error: "Access denied" }));
        return true;
      }
      if (!existsSync(resolvedPath)) {
        res.writeHead(404, { ...cors });
        res.end(JSON.stringify({ error: "File not found" }));
        return true;
      }
      if (statSync(resolvedPath).isDirectory()) {
        res.writeHead(400, { ...cors });
        res.end(JSON.stringify({ error: "Is a directory" }));
        return true;
      }

      const binExt = new Set([".png", ".jpg", ".jpeg", ".gif", ".ico", ".woff", ".woff2", ".ttf", ".eot", ".otf", ".pdf", ".zip", ".rar", ".7z", ".exe", ".dll", ".bin", ".o", ".a", ".so", ".dylib"]);
      const ext = resolvedPath.slice(resolvedPath.lastIndexOf(".")).toLowerCase();
      const isText = !binExt.has(ext);

      // TOC mode: 只扫描函数/类型签名，不返回全文
      if (mode === "toc") {
        if (!isText) {
          res.writeHead(200, { ...cors });
          res.end(JSON.stringify({ mode: "toc", path: resolvedPath, symbols: [], error: "binary" }));
          return true;
        }
        const content = readFileSync(resolvedPath, "utf-8");
        const lines = content.split("\n");
        const symbols: { kind: string; name: string; line: number }[] = [];

        // 通用正则：按语言匹配
        const patterns: [RegExp, string][] = [
          // Go
          [/^\s*func\s+(\([^)]+\)\s*)?\w+/g, "func"],
          [/^\s*type\s+\w+\s+(struct|interface)\s*/g, "type"],
          // TypeScript / JavaScript
          [/^\s*export\s+(default\s+)?(function|class|interface|type|enum|abstract\s+class|async\s+function)\s+\w+/g, "export"],
          [/^\s*(export\s+)?const\s+\w+\s*[:=]\s*(\(|async|[{(])/g, "const"],
          [/^\s*(export\s+)?function\s+\w+/g, "func"],
          [/^\s*(export\s+)?class\s+\w+/g, "class"],
          [/^\s*(export\s+)?interface\s+\w+/g, "interface"],
          [/^\s*(export\s+)?type\s+\w+\s*=/g, "type"],
          [/^\s*(export\s+)?enum\s+\w+/g, "enum"],
          [/^\s*(public|private|protected|static)\s+(readonly\s+)?\w+\s*\(/g, "method"],
          // Python
          [/^\s*def\s+\w+/g, "def"],
          [/^\s*class\s+\w+/g, "class"],
          // Rust
          [/^\s*fn\s+\w+/g, "fn"],
          [/^\s*(pub\s+)?(struct|enum|trait|impl|type|fn|const|macro_rules!)\s+\w+/g, "rs"],
          // General: 方法签名
          [/^\s*\w+\s*\([^)]*\)\s*\{/g, "method"],
        ];

        const signatureLines = /^\s*(\/\/|#|\/\*|\*\/)/; // skip comments

        for (let i = 0; i < lines.length; i++) {
          const line = lines[i];
          if (signatureLines.test(line)) continue;
          if (line.trimEnd().endsWith("*/")) continue;
          for (const [re, kind] of patterns) {
            re.lastIndex = 0;
            if (re.test(line)) {
              const name = line.trim().replace(/[;{].*$/, "").trim();
              symbols.push({ kind, name: name.slice(0, 120), line: i + 1 });
              break;
            }
          }
        }

        res.writeHead(200, { "Content-Type": "application/json", ...cors });
        res.end(JSON.stringify({ mode: "toc", path: resolvedPath, symbols, total: symbols.length }));
        return true;
      }

      const content = isText ? readFileSync(resolvedPath, "utf-8") : readFileSync(resolvedPath, "base64");
      const encoding = isText ? "text" : "base64";

      const st = statSync(resolvedPath);
      res.writeHead(200, { "Content-Type": "application/json", ...cors });
      res.end(JSON.stringify({ content, encoding, path: resolvedPath, size: st.size, mtime: st.mtime.toISOString() }));
    } catch (err: unknown) {
      res.writeHead(500, { ...cors });
      res.end(JSON.stringify({ error: (err as Error).message }));
    }
    return true;
  }

  // Create file/folder
  if (url?.startsWith("/api/file/new") && method === "POST") {
    try {
      const { root, path } = await parseBody(req);
      const fullPath = resolve(root, path);
      if (!fullPath.startsWith(resolve(root))) { res.writeHead(403, { ...cors }); res.end(JSON.stringify({ error: "Access denied" })); return true; }
      if (path.endsWith("/")) mkdirSync(fullPath, { recursive: true });
      else { mkdirSync(dirname(fullPath), { recursive: true }); writeFileSync(fullPath, "", "utf-8"); }
      res.writeHead(200, { ...cors }); res.end(JSON.stringify({ ok: true }));
    } catch (e: unknown) { const msg = e instanceof Error ? (e as Error).message : String(e); res.writeHead(400, { ...cors }); res.end(JSON.stringify({ error: msg })); }
    return true;
  }

  // Rename file/folder
  if (url?.startsWith("/api/file/rename") && method === "POST") {
    try {
      const { root, path, newPath } = await parseBody(req);
      const oldFull = resolve(root, path);
      const newFull = resolve(root, newPath || "");
      if (!oldFull.startsWith(resolve(root)) || !newFull.startsWith(resolve(root))) { res.writeHead(403, { ...cors }); res.end(JSON.stringify({ error: "Access denied" })); return true; }
      renameSync(oldFull, newFull);
      res.writeHead(200, { ...cors }); res.end(JSON.stringify({ ok: true }));
    } catch (e: unknown) { const msg = e instanceof Error ? (e as Error).message : String(e); res.writeHead(400, { ...cors }); res.end(JSON.stringify({ error: msg })); }
    return true;
  }

  // Delete file/folder
  if (url?.startsWith("/api/file/delete") && method === "POST") {
    try {
      const { root, path } = await parseBody(req);
      const fullPath = resolve(root, path);
      if (!fullPath.startsWith(resolve(root))) { res.writeHead(403, { ...cors }); res.end(JSON.stringify({ error: "Access denied" })); return true; }
      rmSync(fullPath, { recursive: true, force: true });
      res.writeHead(200, { ...cors }); res.end(JSON.stringify({ ok: true }));
    } catch (e: unknown) { const msg = e instanceof Error ? (e as Error).message : String(e); res.writeHead(400, { ...cors }); res.end(JSON.stringify({ error: msg })); }
    return true;
  }

  // Move file (drag-drop)
  if (url?.startsWith("/api/file/move") && method === "POST") {
    try {
      const { root, path, newPath } = await parseBody(req);
      const srcFull = resolve(root, path);
      const dstFull = resolve(root, newPath || "");
      if (!srcFull.startsWith(resolve(root)) || !dstFull.startsWith(resolve(root))) { res.writeHead(403, { ...cors }); res.end(JSON.stringify({ error: "Access denied" })); return true; }
      renameSync(srcFull, dstFull);
      res.writeHead(200, { ...cors }); res.end(JSON.stringify({ ok: true }));
    } catch (e: unknown) { const msg = e instanceof Error ? (e as Error).message : String(e); res.writeHead(400, { ...cors }); res.end(JSON.stringify({ error: msg })); }
    return true;
  }

  // Write file content
  if (url?.startsWith("/api/file/write") && method === "POST") {
    try {
      const { root, path, content } = await parseBody(req);
      const fullPath = resolve(root, path);
      if (!fullPath.startsWith(resolve(root))) { res.writeHead(403, { ...cors }); res.end(JSON.stringify({ error: "Access denied" })); return true; }
      writeFileSync(fullPath, content, "utf-8");
      res.writeHead(200, { ...cors }); res.end(JSON.stringify({ ok: true }));
    } catch (e: unknown) { const msg = e instanceof Error ? (e as Error).message : String(e); res.writeHead(400, { ...cors }); res.end(JSON.stringify({ error: msg })); }
    return true;
  }

  return false;
};
