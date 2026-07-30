import type { ServerResponse } from "http";
import type { PermissionRule } from "../../agent/types";
import {
  ServerPermissionError,
  type ServerPermissionService,
  writeServerPermissionError,
  type PermissionRuleListName,
} from "../permission-service";
import { resolvePermissionConfirmation } from "../permission-confirmation";
import { parseBody } from "./parse-body";
import type { RouteHandler } from "./types";

const cors = { "Access-Control-Allow-Origin": "*" };
const RULE_LISTS = new Set<PermissionRuleListName>(["allow", "deny", "ask"]);

export const handlePermissions: RouteHandler = async (req, res, ctx) => {
  const { url, method } = req;

  if (url === "/api/permissions/confirm" && method === "POST") {
    try {
      const body = await parseBody(req);
      const id = typeof body?.id === "string" ? body.id : "";
      if (!id) {
        res.writeHead(400, { "Content-Type": "application/json", ...cors });
        res.end(JSON.stringify({ ok: false, code: "missing_confirmation_id", error: "Missing confirmation id" }));
        return true;
      }
      const allow = body?.allow === true;
      const scope = body?.scope === "once" ? "once" : "session";
      const settled = resolvePermissionConfirmation(id, allow ? { allow: true, scope } : { allow: false });
      res.writeHead(200, { "Content-Type": "application/json", ...cors });
      res.end(JSON.stringify({ ok: settled }));
    } catch (err) {
      writeRouteError(res, 400, "invalid_permission_confirmation", err);
    }
    return true;
  }

  if (url?.startsWith("/api/permissions/audit") && method === "GET") {
    const parsedUrl = new URL(url, `http://${req.headers.host || "localhost"}`);
    const rawLimit = parseInt(parsedUrl.searchParams.get("limit") || "100", 10);
    const audit = ctx.permissionService?.getAuditTrail(rawLimit) || [];
    res.writeHead(200, { "Content-Type": "application/json", ...cors });
    res.end(JSON.stringify({ audit, total: audit.length }));
    return true;
  }

  if (url === "/api/permissions/rules" && method === "GET") {
    try {
      const rules = ctx.permissionService?.getRulesSnapshot() || emptyRulesSnapshot();
      res.writeHead(200, { "Content-Type": "application/json", ...cors });
      res.end(JSON.stringify(rules));
    } catch (err) {
      if (writeServerPermissionError(res, cors, err)) return true;
      writeRouteError(res, 500, "permission_rules_error", err);
    }
    return true;
  }

  if (url === "/api/permissions/rules" && method === "POST") {
    try {
      const service = requirePermissionService(ctx.permissionService);
      const body = await parseBody(req);
      const list = normalizeRuleList(body?.list);
      const rule = normalizeRuleBody(body?.rule);
      const result = service.addSessionRule(list, rule);
      res.writeHead(200, { "Content-Type": "application/json", ...cors });
      res.end(JSON.stringify({
        ok: true,
        ...result,
        rules: service.getRulesSnapshot(),
      }));
    } catch (err) {
      if (writeServerPermissionError(res, cors, err)) return true;
      writeRouteError(res, 400, "invalid_permission_rule", err);
    }
    return true;
  }

  if (url?.startsWith("/api/permissions/rules") && method === "DELETE") {
    try {
      const service = requirePermissionService(ctx.permissionService);
      const parsedUrl = new URL(url, `http://${req.headers.host || "localhost"}`);
      let body: Record<string, unknown> = {};
      try { body = await parseBody(req); } catch {}
      const list = normalizeRuleList(body?.list ?? parsedUrl.searchParams.get("list"));
      const index = normalizeRuleIndex(body?.index ?? parsedUrl.searchParams.get("index"));
      const removed = service.removeSessionRule(list, index);
      if (!removed) {
        res.writeHead(404, { "Content-Type": "application/json", ...cors });
        res.end(JSON.stringify({
          ok: false,
          code: "permission_rule_not_found",
          error: "Permission rule not found",
        }));
        return true;
      }
      res.writeHead(200, { "Content-Type": "application/json", ...cors });
      res.end(JSON.stringify({
        ok: true,
        removed,
        rules: service.getRulesSnapshot(),
      }));
    } catch (err) {
      if (writeServerPermissionError(res, cors, err)) return true;
      writeRouteError(res, 400, "invalid_permission_rule", err);
    }
    return true;
  }

  if (url === "/api/permissions/rules/clear" && method === "POST") {
    try {
      const service = requirePermissionService(ctx.permissionService);
      const body = await parseBody(req);
      const rawList = body?.list;
      const list = rawList === undefined || rawList === "all" ? "all" : normalizeRuleList(rawList);
      const removed = service.clearSessionRules(list);
      res.writeHead(200, { "Content-Type": "application/json", ...cors });
      res.end(JSON.stringify({
        ok: true,
        removed,
        rules: service.getRulesSnapshot(),
      }));
    } catch (err) {
      if (writeServerPermissionError(res, cors, err)) return true;
      writeRouteError(res, 400, "invalid_permission_rule", err);
    }
    return true;
  }

  return false;
};

function emptyRulesSnapshot() {
  return {
    additionalWorkingDirectories: [],
    alwaysAllowRules: [],
    alwaysDenyRules: [],
    alwaysAskRules: [],
  };
}

function requirePermissionService(service: ServerPermissionService | undefined): ServerPermissionService {
  if (service) return service;
  throw new ServerPermissionError("Permission service is not available", 503, "permission_service_unavailable");
}

function normalizeRuleList(value: unknown): PermissionRuleListName {
  const list = String(value || "");
  if (RULE_LISTS.has(list as PermissionRuleListName)) return list as PermissionRuleListName;
  throw new Error("Invalid permission rule list");
}

function normalizeRuleIndex(value: unknown): number {
  const index = typeof value === "number" ? value : parseInt(String(value || ""), 10);
  if (Number.isInteger(index) && index >= 0) return index;
  throw new Error("Invalid permission rule index");
}

function normalizeRuleBody(value: unknown): PermissionRule {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Missing permission rule");
  }
  const raw = value as Record<string, unknown>;
  return {
    toolName: raw.toolName as PermissionRule["toolName"],
    ruleContent: String(raw.ruleContent || ""),
    match: raw.match as PermissionRule["match"],
  };
}

function writeRouteError(res: ServerResponse, status: number, code: string, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  res.writeHead(status, { "Content-Type": "application/json", ...cors });
  res.end(JSON.stringify({ ok: false, code, error: message }));
}
