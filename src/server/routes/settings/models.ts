import type { RouteHandler } from "../types.js";
import { existsSync, readFileSync } from "fs";
import { parseBody } from "../parse-body.js";
import { writePathGuardError } from "../path-guard.js";
import { authorizeRoutePath, writeServerPermissionError } from "../../permission-service.js";
import { updateLockedJson } from "../../../data/locked-json-store.js";
import { cors, publishDashboardChanged } from "./common.js";
import { hasProviderAuth } from "./auth.js";

export const handleModelSettings: RouteHandler = async (req, res, ctx) => {
  const { url, method } = req;
  const { runtime, paths: p } = ctx;
  const session = runtime.session;
  const modelRegistry = runtime.modelRegistry;

  // List available models (only those with configured API key in auth.json)
  if (url === "/api/models") {
    try {
      const all = modelRegistry.getAvailable();
      let authData: Record<string, unknown> = {};
      try {
        if (existsSync(p.PI_CONFIG_DIR)) {
          const authFile = (await authorizeRoutePath(ctx, p.PI_CONFIG_DIR, "auth.json", "read", "settings.models.auth")).path;
          if (existsSync(authFile)) {
            const authRaw = readFileSync(authFile, "utf-8");
            authData = JSON.parse(authRaw);
          }
        }
      } catch (err: unknown) {
        if (writeServerPermissionError(res, cors, err)) return true;
        if (writePathGuardError(res, cors, err)) return true;
        authData = {};
      }
      const providers = [...new Set(all.map((m: { provider: string }) => m.provider))];
      const configuredProviders = providers.filter((provider) => hasProviderAuth(runtime, provider, authData[provider]));
      const filtered = configuredProviders.length === 0
        ? all.map((m: { provider: string; id: string }) => ({ provider: (m as { provider: string; id: string }).provider, id: (m as { provider: string; id: string }).id }))
        : all.filter((m: { provider: string }) => configuredProviders.includes((m as { provider: string }).provider)).map((m: { provider: string; id: string }) => ({ provider: m.provider, id: m.id }));
      res.writeHead(200, { "Content-Type": "application/json", ...cors });
      res.end(JSON.stringify({ models: filtered }));
    } catch (err: unknown) {
      if (writeServerPermissionError(res, cors, err)) return true;
      if (writePathGuardError(res, cors, err)) return true;
      res.writeHead(400, { ...cors });
      res.end(JSON.stringify({ error: (err as Error).message }));
    }
    return true;
  }

  if (url === "/api/settings" && method === "POST") {
    try {
      const data = await parseBody(req);
      const settingsFile = (await authorizeRoutePath(ctx, p.PI_CONFIG_DIR, "settings.json", "write", "settings.save")).path;
      await updateLockedJson<Record<string, unknown>>(settingsFile, () => ({}), (settings) => {
        if (data.defaultProvider) settings.defaultProvider = data.defaultProvider;
        if (data.defaultModel) settings.defaultModel = data.defaultModel;
        return settings;
      }, { trailingNewline: false });
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

  if (url === "/api/model/switch" && method === "POST") {
    try {
      const { provider, modelId } = await parseBody(req);
      const model = modelRegistry.find(provider, modelId);
      if (!model) {
        res.writeHead(404, { ...cors });
        res.end(JSON.stringify({ error: "未找到模型: " + provider + "/" + modelId }));
        return true;
      }
      // Persist to settings
      const settingsFile = (await authorizeRoutePath(ctx, p.PI_CONFIG_DIR, "settings.json", "write", "settings.model-switch")).path;
      await updateLockedJson<Record<string, unknown>>(settingsFile, () => ({}), (settings) => {
        settings.defaultProvider = provider;
        settings.defaultModel = modelId;
        return settings;
      }, { trailingNewline: false });
      // Hot switch
      await session.setModel(model);
      publishDashboardChanged(ctx);
      res.writeHead(200, { "Content-Type": "application/json", ...cors });
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
