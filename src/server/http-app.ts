import { createServer, type IncomingMessage, type ServerResponse } from "http";
import { existsSync, readFileSync, statSync } from "fs";
import { dirname, resolve } from "path";
import { fileURLToPath } from "url";
import type { AppEventHub } from "./app-events.js";
import type { ServerContext } from "./routes/types.js";
import { dispatchRoute } from "./routes/index.js";
import { cancelCommandConfirmationsForResponse } from "./routes/chat.js";
import {
  authorizeLocalApiRequest,
  installSecurityHeaders,
  isApiPreflight,
  writeSecurityError,
} from "./security.js";
import { contentTypeForStaticAsset, resolveStaticAssetPath } from "./static-assets.js";
import { createRequestContext, safeRequestUrl, type StructuredLogger } from "./observability.js";

const FRONTEND_ENTRY_FILE = "dashboard.html";

export function openAppEventStream(
  req: IncomingMessage,
  res: ServerResponse,
  appEvents: AppEventHub,
  cors: Record<string, string>,
  correlation?: { requestId: string; traceId: string },
): void {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    ...cors,
  });
  res.write(`data: ${JSON.stringify({ type: "connected", revision: appEvents.revision(), ...(correlation ?? {}) })}\n\n`);
  appEvents.addClient(res);
  req.on("close", () => appEvents.removeClient(res));
}

export interface HttpAppOptions {
  ctx: ServerContext;
  logger: StructuredLogger;
  frontendDir: string;
  frontendSourceDir: string;
  hasBuiltFrontend: boolean;
  appEvents: AppEventHub;
  listenPort?: number;
}

export function createHttpApp(options: HttpAppOptions) {
  const { ctx, logger, frontendDir, frontendSourceDir, hasBuiltFrontend, appEvents } = options;
  return createServer(async (req, res) => {
    const url = req.url ?? "/";
    const requestContext = createRequestContext(req);
    const requestStartedAt = Date.now();
    (req as IncomingMessage & { requestContext?: typeof requestContext }).requestContext = requestContext;
    res.setHeader("X-Request-Id", requestContext.requestId);
    res.setHeader("X-Trace-Id", requestContext.traceId);
    logger.info("http.request.start", { method: req.method, url: safeRequestUrl(url) }, requestContext);
    res.once("finish", () => logger.info("http.request.finish", {
      method: req.method, url: safeRequestUrl(url), status: res.statusCode,
      durationMs: Math.max(0, Date.now() - requestStartedAt),
    }, requestContext));
    res.once("close", () => {
      if (!res.writableEnded) logger.warn("http.request.aborted", {
        method: req.method, url: safeRequestUrl(url), durationMs: Math.max(0, Date.now() - requestStartedAt),
      }, requestContext);
    });

    const cors = { "Access-Control-Allow-Origin": "*" };
    installSecurityHeaders(req, res, ctx.security);
    const securityDecision = authorizeLocalApiRequest(req, ctx.security);
    if (!securityDecision.ok) { writeSecurityError(res, securityDecision); return; }
    if (isApiPreflight(req)) { res.writeHead(204); res.end(); return; }
    if (url === "/favicon.ico") { res.writeHead(200, { "Content-Type": "image/x-icon" }); res.end(); return; }

    const reqPath = url.includes("?") ? url.slice(0, url.indexOf("?")) : url;
    if (reqPath.startsWith("/icons/") && reqPath.endsWith(".svg")) {
      try {
        const iconRoot = hasBuiltFrontend ? frontendDir : frontendSourceDir;
        const content = readFileSync(resolveStaticAssetPath(iconRoot, reqPath));
        res.writeHead(200, { "Content-Type": "image/svg+xml", "Cache-Control": "max-age=3600" });
        res.end(content);
      } catch { res.writeHead(404); res.end("Not found"); }
      return;
    }

    if (hasBuiltFrontend) {
      const filePath = reqPath === "/" ? `/${FRONTEND_ENTRY_FILE}` : reqPath;
      const fullPath = resolveStaticAssetPath(frontendDir, filePath);
      if (existsSync(fullPath) && statSync(fullPath).isFile()) {
        res.writeHead(200, { "Content-Type": contentTypeForStaticAsset(fullPath) });
        res.end(readFileSync(fullPath));
        return;
      }
    } else {
      const pathname = reqPath;
      const staticPrefix = ["/dashboard", "/ui/", "/pane/", "/service/", "/devicon", "/fonts/", "/devicon-colors", "/icons/", "/core/", "/shell/", "/services/"];
      const staticExt = [".css", ".js", ".svg", ".woff", ".woff2"];
      if (staticPrefix.some((prefix) => pathname.startsWith(prefix)) && staticExt.some((ext) => pathname.endsWith(ext))) {
        try {
          const filePath = resolveStaticAssetPath(frontendSourceDir, pathname);
          const ext = pathname.endsWith(".css") ? "css" : pathname.endsWith(".svg") ? "svg+xml" : pathname.endsWith(".woff") ? "font/woff" : pathname.endsWith(".woff2") ? "font/woff2" : "javascript";
          const isText = ext === "css" || ext === "javascript" || ext === "svg+xml";
          res.writeHead(200, { "Content-Type": isText ? `text/${ext}; charset=utf-8` : ext });
          res.end(readFileSync(filePath, isText ? "utf-8" : undefined));
        } catch { res.writeHead(404); res.end("Not found"); }
        return;
      }
    }

    if (url === "/" || url === "/index.html") {
      const html = hasBuiltFrontend
        ? readFileSync(resolve(frontendDir, FRONTEND_ENTRY_FILE), "utf-8")
        : readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "..", "frontend", FRONTEND_ENTRY_FILE), "utf-8");
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(html);
      return;
    }
    if (url === "/api/events" && req.method === "GET") {
      openAppEventStream(req, res, appEvents, cors, requestContext);
      return;
    }

    try {
      if (await dispatchRoute(req, res, ctx)) return;
    } catch (error) {
      logger.error("http.request.error", {
        method: req.method, url: safeRequestUrl(url), error: error instanceof Error ? error.message : String(error),
      }, requestContext);
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "Internal server error", requestId: requestContext.requestId }));
      } else { try { res.end(); } catch {} }
      return;
    }
    res.writeHead(404);
    res.end("Not found");
  });
}
