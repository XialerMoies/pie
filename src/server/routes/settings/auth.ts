import type { RouteHandler } from "../types.js";
import type { AgentRuntime } from "../../../agent/index.js";
import { existsSync, readFileSync } from "fs";
import { parseBody } from "../parse-body.js";
import { writePathGuardError } from "../path-guard.js";
import { authorizeRoutePath, writeServerPermissionError } from "../../permission-service.js";
import { updateLockedJson } from "../../../data/locked-json-store.js";
import { cors } from "./common.js";

export function storedApiKey(value: unknown): string {
  if (!value || typeof value !== "object") return "";
  const record = value as Record<string, unknown>;
  // 新格式 {type:"api_key", key} 与旧格式 {apiKey} 都兼容（旧 auth.json 数据迁移后仍可读）
  if (record.type === "api_key" && typeof record.key === "string") return record.key;
  return typeof record.apiKey === "string" ? record.apiKey : "";
}

function authStatus(runtime: AgentRuntime, provider: string): { configured?: boolean; source?: string } | undefined {
  const modelRuntime = runtime.modelRuntime;
  if (typeof modelRuntime?.getProviderAuthStatus !== "function") return undefined;
  try { return modelRuntime.getProviderAuthStatus(provider); } catch { return undefined; }
}

export function hasProviderAuth(runtime: AgentRuntime, provider: string, stored: unknown): boolean {
  const status = authStatus(runtime, provider);
  return Boolean(storedApiKey(stored) || status?.configured || status?.source);
}

export const handleAuthSettings: RouteHandler = async (req, res, ctx) => {
  const { url, method } = req;
  const { runtime, paths: p } = ctx;
  const modelRegistry = runtime.modelRegistry;

  if (url === "/api/auth" && method === "GET") {
    try {
      const authFile = (await authorizeRoutePath(ctx, p.PI_CONFIG_DIR, "auth.json", "read", "settings.auth.read")).path;
      const authData = existsSync(authFile) ? JSON.parse(readFileSync(authFile, "utf-8")) : {};
      const availableProviders = typeof modelRegistry?.getAvailable === "function"
        ? modelRegistry.getAvailable().map((model: { provider: string }) => model.provider)
        : [];
      const providers = [...new Set([...Object.keys(authData), ...availableProviders])];
      const providerKeys = providers.map((provider) => {
        const apiKey = storedApiKey(authData[provider]);
        return {
          provider,
          hasKey: hasProviderAuth(runtime, provider, authData[provider]),
          canReveal: Boolean(apiKey),
          keyPreview: apiKey ? apiKey.slice(0, 8) + "..." : "",
        };
      });
      res.writeHead(200, { "Content-Type": "application/json", ...cors });
      res.end(JSON.stringify({ providers: providerKeys }));
    } catch (err: unknown) {
      if (writeServerPermissionError(res, cors, err)) return true;
      if (writePathGuardError(res, cors, err)) return true;
      res.writeHead(400, { ...cors });
      res.end(JSON.stringify({ error: (err as Error).message }));
    }
    return true;
  }

  if (url === "/api/auth/reveal" && method === "POST") {
    try {
      const { provider } = await parseBody(req);
      if (typeof provider !== "string" || !provider) {
        res.writeHead(400, { "Content-Type": "application/json", ...cors });
        res.end(JSON.stringify({ error: "provider required" }));
        return true;
      }
      const authFile = (await authorizeRoutePath(ctx, p.PI_CONFIG_DIR, "auth.json", "read", "settings.auth.reveal")).path;
      const authData = existsSync(authFile) ? JSON.parse(readFileSync(authFile, "utf-8")) : {};
      if (!hasProviderAuth(runtime, provider, authData[provider])) {
        res.writeHead(404, { "Content-Type": "application/json", ...cors });
        res.end(JSON.stringify({ error: "provider is not configured" }));
        return true;
      }
      const apiKey = storedApiKey(authData[provider]);
      if (!apiKey) {
        res.writeHead(404, { "Content-Type": "application/json", ...cors });
        res.end(JSON.stringify({ error: "provider key unavailable" }));
        return true;
      }
      res.writeHead(200, { "Content-Type": "application/json", ...cors });
      res.end(JSON.stringify({ ok: true, apiKey }));
    } catch (err: unknown) {
      if (writeServerPermissionError(res, cors, err)) return true;
      if (writePathGuardError(res, cors, err)) return true;
      res.writeHead(400, { "Content-Type": "application/json", ...cors });
      res.end(JSON.stringify({ error: (err as Error).message }));
    }
    return true;
  }

  if (url === "/api/auth" && method === "POST") {
    try {
      const { provider, apiKey } = await parseBody(req);
      if (!provider || !apiKey) { res.writeHead(400, { ...cors }); res.end(JSON.stringify({ error: "provider and apiKey required" })); return true; }
      const authFile = (await authorizeRoutePath(ctx, p.PI_CONFIG_DIR, "auth.json", "write", "settings.auth")).path;
      await updateLockedJson<Record<string, unknown>>(authFile, () => ({}), (authData) => {
        authData[provider] = { type: "api_key", key: apiKey };
        return authData;
      }, { trailingNewline: false });
      await runtime.modelRuntime.refresh({ providers: [provider], allowNetwork: false });
      res.writeHead(200, { ...cors });
      res.end(JSON.stringify({ ok: true }));
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
