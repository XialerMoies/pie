/**
 * Search route — filename & full-text search
 *
 * 核心逻辑在 search-core.ts，此处仅 HTTP 路由分发。
 */
import type { RouteHandler } from "./types.js";
import { existsSync, readdirSync } from "fs";
import { resolve } from "path";
import { parseBody } from "./parse-body.js";
import { doSearch, doReplace, searchConversationFiles } from "./search-core.js";
import { writePathGuardError } from "./path-guard.js";
import { authorizeRoutePath, writeServerPermissionError } from "../permission-service.js";

const cors = { "Access-Control-Allow-Origin": "*" };

async function findAuthorizedConversationFiles(ctx: Parameters<RouteHandler>[2]): Promise<string[]> {
  const sessionsDir = ctx.paths.SESSIONS_DIR;
  const byProjectDir = resolve(sessionsDir, "by-project");
  if (!existsSync(byProjectDir)) return [];

  const authorizedByProjectDir = (await authorizeRoutePath(
    ctx,
    sessionsDir,
    byProjectDir,
    "read",
    "search.conversations.root",
  )).path;

  const files: string[] = [];
  for (const project of readdirSync(authorizedByProjectDir, { withFileTypes: true })) {
    if (!project.isDirectory()) continue;
    const projectDir = (await authorizeRoutePath(
      ctx,
      sessionsDir,
      resolve(authorizedByProjectDir, project.name),
      "read",
      "search.conversations.project",
    )).path;

    for (const entry of readdirSync(projectDir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
      files.push((await authorizeRoutePath(
        ctx,
        sessionsDir,
        resolve(projectDir, entry.name),
        "read",
        "search.conversations.file",
      )).path);
    }
  }

  return files;
}

export const handleSearch: RouteHandler = async (req, res, ctx) => {
  const { url, method } = req;
  const { paths: p } = ctx;

  // GET /api/search?q=...&type=filename&root=...
  if (url?.startsWith("/api/search") && method === "GET") {
    try {
      const u = new URL(url!, `http://${req.headers.host || "localhost"}`);
      const q = u.searchParams.get("q") || "";
      if (!q) {
        res.writeHead(400, { ...cors });
        res.end(JSON.stringify({ error: "Missing 'q'" }));
        return true;
      }
      const requestedRoot = u.searchParams.get("root") || p.APP_ROOT;
      if (!requestedRoot) {
        res.writeHead(200, { "Content-Type": "application/json", ...cors });
        res.end(JSON.stringify({ error: "Missing root", results: [], total: 0, truncated: false }));
        return true;
      }
      const rootDir = (await authorizeRoutePath(ctx, requestedRoot, "", "read", "search.get")).path;
      const data = doSearch(
        q,
        rootDir,
        (u.searchParams.get("type") as any) || "filename",
        u.searchParams.get("caseSensitive") === "true",
        parseInt(u.searchParams.get("maxResults") || "200", 10) || 200,
      );
      res.writeHead(200, { "Content-Type": "application/json", ...cors });
      res.end(JSON.stringify(data));
    } catch (err: unknown) {
      if (writeServerPermissionError(res, cors, err)) return true;
      if (writePathGuardError(res, cors, err)) return true;
      res.writeHead(400, { ...cors });
      res.end(JSON.stringify({ error: (err as Error).message }));
    }
    return true;
  }

  // POST /api/search/replace   Body: { query, replacement, root?, type?, caseSensitive?, regex?, previewOnly? }
  if (url === "/api/search/replace" && method === "POST") {
    try {
      const body = await parseBody(req);
      const { query, replacement, root, type, caseSensitive, regex, previewOnly } = body;
      if (!query) {
        res.writeHead(400, { ...cors });
        res.end(JSON.stringify({ error: "Missing 'query'" }));
        return true;
      }
      if (replacement === undefined) {
        res.writeHead(400, { ...cors });
        res.end(JSON.stringify({ error: "Missing 'replacement'" }));
        return true;
      }
      if (type !== "text") {
        res.writeHead(400, { ...cors });
        res.end(JSON.stringify({ error: "Replace only supports 'text' type" }));
        return true;
      }
      const rootDir = root || p.APP_ROOT;
      const guardedRoot = (await authorizeRoutePath(ctx, p.APP_ROOT, rootDir, previewOnly === false ? "write" : "read", "search.replace")).path;
      const data = doReplace({
        query,
        replacement,
        rootDir: guardedRoot,
        caseSensitive: caseSensitive ?? false,
        regex: regex ?? false,
        previewOnly: previewOnly !== false,
      });
      res.writeHead(200, { "Content-Type": "application/json", ...cors });
      res.end(JSON.stringify(data));
    } catch (err: unknown) {
      if (writeServerPermissionError(res, cors, err)) return true;
      if (writePathGuardError(res, cors, err)) return true;
      res.writeHead(400, { ...cors });
      res.end(JSON.stringify({ error: (err as Error).message }));
    }
    return true;
  }

  // POST /api/search/conversations   Body: { query, caseSensitive? }
  if (url === "/api/search/conversations" && method === "POST") {
    try {
      const { query, caseSensitive } = await parseBody(req);
      if (!query) {
        res.writeHead(400, { ...cors });
        res.end(JSON.stringify({ error: "Missing 'query'" }));
        return true;
      }
      const files = await findAuthorizedConversationFiles(ctx);
      const data = searchConversationFiles(query, p.SESSIONS_DIR, files, caseSensitive || false);
      res.writeHead(200, { "Content-Type": "application/json", ...cors });
      res.end(JSON.stringify(data));
    } catch (err: unknown) {
      if (writeServerPermissionError(res, cors, err)) return true;
      if (writePathGuardError(res, cors, err)) return true;
      res.writeHead(400, { ...cors });
      res.end(JSON.stringify({ error: (err as Error).message }));
    }
    return true;
  }

  // POST /api/search   Body: { query, root?, type?, caseSensitive?, maxResults? }
  if (url === "/api/search" && method === "POST") {
    try {
      const { query, root, type, caseSensitive, maxResults } = await parseBody(req);
      if (!query) {
        res.writeHead(400, { ...cors });
        res.end(JSON.stringify({ error: "Missing 'query'" }));
        return true;
      }
      const requestedRoot = root || p.APP_ROOT;
      if (!requestedRoot) {
        res.writeHead(200, { "Content-Type": "application/json", ...cors });
        res.end(JSON.stringify({ error: "Missing root", results: [], total: 0, truncated: false }));
        return true;
      }
      const rootDir = (await authorizeRoutePath(ctx, requestedRoot, "", "read", "search.post")).path;
      const data = doSearch(
        query,
        rootDir,
        type || "filename",
        caseSensitive || false,
        maxResults || 200,
      );
      res.writeHead(200, { "Content-Type": "application/json", ...cors });
      res.end(JSON.stringify(data));
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
