/**
 * Search route — filename & full-text search
 *
 * 核心逻辑在 search-core.ts，此处仅 HTTP 路由分发。
 */
import type { RouteHandler } from "./types";
import { parseBody } from "./parse-body";
import { doSearch } from "./search-core";

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
      const data = doSearch(
        q,
        u.searchParams.get("root") || p.APP_ROOT,
        (u.searchParams.get("type") as any) || "filename",
        u.searchParams.get("caseSensitive") === "true",
        parseInt(u.searchParams.get("maxResults") || "200", 10) || 200,
      );
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
      const data = doSearch(
        query,
        root || p.APP_ROOT,
        type || "filename",
        caseSensitive || false,
        maxResults || 200,
      );
      res.writeHead(200, { "Content-Type": "application/json", ...cors });
      res.end(JSON.stringify(data));
    } catch (err: unknown) {
      res.writeHead(400, { ...cors });
      res.end(JSON.stringify({ error: (err as Error).message }));
    }
    return true;
  }

  return false;
};
