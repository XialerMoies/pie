import type { IncomingMessage } from "node:http";
import type { RouteHandler } from "./types.js";
import { diagnosticsSnapshot } from "../observability.js";

const cors = { "Access-Control-Allow-Origin": "*" };

export const handleDiagnostics: RouteHandler = async (req, res, ctx) => {
  if (req.url !== "/api/diagnostics" || req.method !== "GET") return false;
  if (!ctx.observability) {
    res.writeHead(503, { "Content-Type": "application/json", ...cors });
    res.end(JSON.stringify({ ok: false, error: "Diagnostics are unavailable" }));
    return true;
  }
  const requestContext = (req as IncomingMessage & { requestContext?: { requestId?: string } }).requestContext;
  const requestId = requestContext?.requestId || (Array.isArray(req.headers["x-request-id"])
    ? req.headers["x-request-id"][0]
    : req.headers["x-request-id"]);
  const payload = diagnosticsSnapshot(
    ctx.observability,
    requestId,
    ctx.runtime.currentWorkspace,
    ctx.paths.STARTUP?.instanceId,
  );
  res.writeHead(200, { "Content-Type": "application/json", ...cors });
  res.end(JSON.stringify(payload));
  return true;
};
