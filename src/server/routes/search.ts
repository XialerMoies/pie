/**
 * Search route — filename & full-text search
 *
 * 核心逻辑在 search-core.ts，此处仅 HTTP 路由分发。
 */
import type { RouteHandler } from "./types";
import { parseBody } from "./parse-body";
import { doSearch, doReplace, searchConversations } from "./search-core";
import { writePathGuardError } from "./path-guard";
import { authorizeRoutePath, writeServerPermissionError } from "../permission-service";

const cors = { "Access-Control-Allow-Origin": "*" };

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
      const data = searchConversations(query, p.SESSIONS_DIR, caseSensitive || false);
      res.writeHead(200, { "Content-Type": "application/json", ...cors });
      res.end(JSON.stringify(data));
    } catch (err: unknown) {
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
