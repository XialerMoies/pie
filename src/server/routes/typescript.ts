/**
 * TypeScript API routes — 通过真实的 tsserver 提供 TS 语言服务
 *
 *   POST /api/ts/open   { file, content? }
 *   POST /api/ts/change { file, content }
 *   POST /api/ts/close  { file }
 *   POST /api/ts/completions        { file, line, offset }
 *   POST /api/ts/completionDetails  { file, line, offset, names }
 *   POST /api/ts/quickinfo          { file, line, offset }
 *   POST /api/ts/definition         { file, line, offset }
 *   POST /api/ts/references         { file, line, offset }
 *   GET  /api/ts/diagnostics?file=...&projectRoot=...
 */
import type { RouteHandler } from "./types";
import { parseBody } from "./parse-body";

const cors = { "Access-Control-Allow-Origin": "*" };

async function getTsServer(ctx: import("./types").ServerContext): Promise<import("../ts-server").TsserverManager> {
  const tsServer = ctx.tsServer;
  if (!tsServer) throw new Error("TSServer not available");
  if (!tsServer.isRunning()) {
    const startPromise = tsServer.start(ctx.paths.APP_ROOT);
    const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error("tsserver startup timeout")), 8000));
    await Promise.race([startPromise, timeout]);
    // 初始化：发送 configure + compilerOptionsForInferredProjects
    // 告诉 tsserver 用推断项目，避免 tsconfig.json 的 rootDir 限制导致 Debug Failure
    if (tsServer.isRunning()) {
      await tsServer.init(ctx.paths.APP_ROOT).catch(() => {});
    }
  }
  if (!tsServer.isRunning()) throw new Error("tsserver failed to start");
  return tsServer;
}

export const handleTypeScript: RouteHandler = async (req, res, ctx) => {
  const { url, method } = req;

  if (!url?.startsWith("/api/ts/")) return false;

  // GET /api/ts/diagnostics?file=... — 同步诊断
  if (url.startsWith("/api/ts/diagnostics") && method === "GET") {
    try {
      const ts = await getTsServer(ctx);
      const u = new URL(url, `http://${req.headers.host || "localhost"}`);
      const file = u.searchParams.get("file") || "";
      if (!file) { res.writeHead(400, { ...cors }); res.end(JSON.stringify({ error: "Missing 'file'" })); return true; }

      const [semantic, syntactic] = await Promise.all([
        ts.sendRequest("semanticDiagnosticsSync", { file }).catch(() => []),
        ts.sendRequest("syntacticDiagnosticsSync", { file }).catch(() => []),
      ]);
      const all = [...(semantic || []), ...(syntactic || [])];
      res.writeHead(200, { "Content-Type": "application/json", ...cors });
      res.end(JSON.stringify(all));
    } catch (err: unknown) {
      res.writeHead(200, { ...cors });
      res.end(JSON.stringify({ success: false, error: (err as Error).message }));
    }
    return true;
  }

  if (method !== "POST") return false;

  try {
    const ts = await getTsServer(ctx);
    const body = await parseBody(req);
    const file = body.file;

    switch (true) {
      case url === "/api/ts/open": {
        const result = await ts.sendRequest("open", {
          file,
          fileContent: body.content || "",
          scriptKindName: body.scriptKindName || "TS",
          projectRootPath: ctx.paths.APP_ROOT,
        });
        res.writeHead(200, { ...cors });
        res.end(JSON.stringify({ ok: true }));
        return true;
      }

      case url === "/api/ts/change": {
        const lines = (body.content || "").split("\n");
        const endLine = lines.length;
        const endOffset = (lines[lines.length - 1] || "").length + 1;
        await ts.sendRequest("change", {
          file,
          line: 1,
          offset: 1,
          endLine,
          endOffset,
          insertString: body.content,
        });
        res.writeHead(200, { ...cors });
        res.end(JSON.stringify({ ok: true }));
        return true;
      }

      case url === "/api/ts/close": {
        await ts.sendRequest("close", { file });
        res.writeHead(200, { ...cors });
        res.end(JSON.stringify({ ok: true }));
        return true;
      }

      case url === "/api/ts/completions": {
        const result = await ts.sendRequest("completionInfo", {
          file,
          line: body.line,
          offset: body.offset,
          triggerKind: body.triggerKind || 0,
        });
        res.writeHead(200, { "Content-Type": "application/json", ...cors });
        res.end(JSON.stringify(result || { entries: [] }));
        return true;
      }

      case url === "/api/ts/completionDetails": {
        const result = await ts.sendRequest("completionEntryDetails", {
          file,
          line: body.line,
          offset: body.offset,
          entryNames: body.names || [],
        });
        res.writeHead(200, { ...cors });
        res.end(JSON.stringify(result || []));
        return true;
      }

      case url === "/api/ts/quickinfo": {
        const result = await ts.sendRequest("quickinfo", {
          file,
          line: body.line,
          offset: body.offset,
        });
        res.writeHead(200, { ...cors });
        res.end(JSON.stringify(result));
        return true;
      }

      case url === "/api/ts/definition": {
        const result = await ts.sendRequest("definitionAndBoundSpan", {
          file,
          line: body.line,
          offset: body.offset,
        });
        res.writeHead(200, { ...cors });
        res.end(JSON.stringify(result));
        return true;
      }

      case url === "/api/ts/references": {
        const result = await ts.sendRequest("references", {
          file,
          line: body.line,
          offset: body.offset,
        });
        res.writeHead(200, { ...cors });
        res.end(JSON.stringify(result));
        return true;
      }

      default:
        return false;
    }
  } catch (err: unknown) {
    res.writeHead(200, { ...cors });
    res.end(JSON.stringify({ success: false, error: (err as Error).message }));
    return true;
  }
};
