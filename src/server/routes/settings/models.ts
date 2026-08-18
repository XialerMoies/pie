import { resolveEngine, type RouteHandler } from "../types.js";
import { existsSync, readFileSync } from "fs";
import { parseBody } from "../parse-body.js";
import { writePathGuardError } from "../path-guard.js";
import { authorizeRoutePath, writeServerPermissionError } from "../../permission-service.js";
import { updateLockedJson } from "../../../data/locked-json-store.js";
import { cors, publishDashboardChanged } from "./common.js";
import { hasProviderAuth } from "./auth.js";

export const handleModelSettings: RouteHandler = async (req, res, ctx) => {
  const { url, method } = req;
  const { paths: p } = ctx;
  const model = ctx.groups.providers.model;
  const engine = resolveEngine(ctx);

  // List available models (only those with configured API key in auth.json)
  if (url === "/api/models") {
    try {
      await model.syncModelProviders();
      const modelRegistry = model.modelRegistry;
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
      const configuredProviders = providers.filter((provider) => hasProviderAuth(model, provider, authData[provider]));
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
      if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("Invalid settings body");
      const { defaultProvider, defaultModel } = data as Record<string, unknown>;
      if (typeof defaultProvider !== "string" || typeof defaultModel !== "string") {
        throw new Error("defaultProvider and defaultModel are required");
      }
      const settingsFile = (await authorizeRoutePath(ctx, p.PI_CONFIG_DIR, "settings.json", "write", "settings.save")).path;
      const save = async () => {
        await model.syncModelProviders();
        const findModel = model.modelRegistry?.find;
        if (typeof findModel === "function" && !findModel.call(model.modelRegistry, defaultProvider, defaultModel)) {
          throw new Error("Default model is not available");
        }
        await updateLockedJson<Record<string, unknown>>(settingsFile, () => ({}), (settings) => {
          settings.defaultProvider = defaultProvider;
          settings.defaultModel = defaultModel;
          return settings;
        }, { trailingNewline: false });
      };
      if (ctx.providerReferenceLock) await ctx.providerReferenceLock.runExclusive(save);
      else await save();
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
      const settingsFile = (await authorizeRoutePath(ctx, p.PI_CONFIG_DIR, "settings.json", "write", "settings.model-switch")).path;
      let found = false;
      const switchModel = () => model.runWithStableSession(async () => {
        await model.syncModelProviders();
        const targetModel = model.modelRegistry.find(provider, modelId);
        if (!targetModel) return;
        found = true;
        const priorModel = engine.session.model;
        if (!priorModel) throw new Error("Current session has no active model");
        await engine.setModel(provider, modelId);
        try {
          await updateLockedJson<Record<string, unknown>>(settingsFile, () => ({}), (settings) => {
            settings.defaultProvider = provider;
            settings.defaultModel = modelId;
            return settings;
          }, { trailingNewline: false });
        } catch (persistenceError) {
          try {
            await engine.setModel(priorModel.provider, priorModel.id);
          } catch (rollbackError) {
            throw new AggregateError(
              [persistenceError, rollbackError],
              "Model settings persistence failed and model rollback failed",
            );
          }
          throw persistenceError;
        }
      });
      if (ctx.providerReferenceLock) await ctx.providerReferenceLock.runExclusive(switchModel);
      else await switchModel();
      if (!found) {
        res.writeHead(404, { ...cors });
        res.end(JSON.stringify({ error: "未找到模型: " + provider + "/" + modelId }));
        return true;
      }
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
