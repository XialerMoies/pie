/**
 * Settings routes — API keys, model switching, settings persistence
 */
import type { RouteHandler } from "./types.js";
import { readFileSync, writeFileSync, existsSync } from "fs";
import { parseBody } from "./parse-body.js";
import { writePathGuardError } from "./path-guard.js";
import { authorizeRoutePath, writeServerPermissionError } from "../permission-service.js";

const cors = { "Access-Control-Allow-Origin": "*" };

function publishDashboardChanged(ctx: Parameters<RouteHandler>[2]): void {
  try { ctx.appEvents.publish("dashboard.changed"); } catch {}
}

export const handleSettings: RouteHandler = async (req, res, ctx) => {
  const { url, method } = req;
  const { runtime, paths: p } = ctx;
  const session = runtime.session;
  const modelRegistry = runtime.modelRegistry;

  // List available models (only those with configured API key in auth.json)
  if (url === "/api/models") {
    try {
      const all = modelRegistry.getAvailable();
      // Read auth.json to see which providers have keys configured in storage (not env vars)
      let configuredProviders: string[] = [];
      try {
        if (existsSync(p.PI_CONFIG_DIR)) {
          const authFile = (await authorizeRoutePath(ctx, p.PI_CONFIG_DIR, "auth.json", "read", "settings.models.auth")).path;
          if (existsSync(authFile)) {
            const authRaw = readFileSync(authFile, "utf-8");
            const auth = JSON.parse(authRaw);
            configuredProviders = Object.keys(auth).filter(k => auth[k]?.apiKey);
          }
        }
      } catch (err: unknown) {
        if (writeServerPermissionError(res, cors, err)) return true;
        if (writePathGuardError(res, cors, err)) return true;
        configuredProviders = [];
      }
      const filtered = configuredProviders.length === 0
        ? all.map((m: { provider: string; id: string }) => ({ provider: (m as { provider: string; id: string }).provider, id: (m as { provider: string; id: string }).id }))  // first run: show all
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

  // Save settings
  if (url === "/api/settings" && method === "POST") {
    try {
      const data = await parseBody(req);
      const settingsFile = (await authorizeRoutePath(ctx, p.PI_CONFIG_DIR, "settings.json", "write", "settings.save")).path;
      let settings: Record<string, unknown> = {};
      if (existsSync(settingsFile)) {
        settings = JSON.parse(readFileSync(settingsFile, "utf-8"));
      }
      if (data.defaultProvider) settings.defaultProvider = data.defaultProvider;
      if (data.defaultModel) settings.defaultModel = data.defaultModel;
      writeFileSync(settingsFile, JSON.stringify(settings, null, 2));
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

  // Get auth keys
  if (url === "/api/auth" && method === "GET") {
    try {
      const authFile = (await authorizeRoutePath(ctx, p.PI_CONFIG_DIR, "auth.json", "read", "settings.auth.read")).path;
      const authData = existsSync(authFile) ? JSON.parse(readFileSync(authFile, "utf-8")) : {};
      const providerKeys = Object.keys(authData).map((provider) => ({
        provider,
        hasKey: !!authData[provider]?.apiKey,
        keyPreview: authData[provider]?.apiKey ? authData[provider].apiKey.slice(0, 8) + "..." : "",
      }));
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

  // Save auth key
  if (url === "/api/auth" && method === "POST") {
    try {
      const { provider, apiKey } = await parseBody(req);
      if (!provider || !apiKey) { res.writeHead(400, { ...cors }); res.end(JSON.stringify({ error: "provider and apiKey required" })); return true; }
      const authFile = (await authorizeRoutePath(ctx, p.PI_CONFIG_DIR, "auth.json", "write", "settings.auth")).path;
      let authData: Record<string, unknown> = {};
      if (existsSync(authFile)) authData = JSON.parse(readFileSync(authFile, "utf-8"));
      authData[provider] = { apiKey };
      writeFileSync(authFile, JSON.stringify(authData, null, 2));
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

  // Thinking level
  if (url === "/api/thinking-level" && method === "GET") {
    const session = ctx.runtime.session;
    const extended = (session as any).getAvailableThinkingLevels?.() ?? ["low", "medium", "high"];
    // "off" 不在 extended levels 中（由 reasoning 开关控制），手动补上
    const available = ["off", ...extended.filter((l: string) => l !== "off")];
    res.writeHead(200, { "Content-Type": "application/json", ...cors });
    res.end(JSON.stringify({
      level: session.thinkingLevel ?? "off",
      availableLevels: available,
      supportsThinking: extended.length > 0,
    }));
    return true;
  }

  if (url === "/api/thinking-level" && method === "POST") {
    try {
      const { level } = await parseBody(req);
      const session = ctx.runtime.session;
      session.setThinkingLevel(level);
      const extended = (session as any).getAvailableThinkingLevels?.() ?? ["low", "medium", "high"];
      const available = ["off", ...extended.filter((l: string) => l !== "off")];
      const supportsThinking = (session as any).supportsThinking?.() ?? available.some((item: string) => item !== "off");
      publishDashboardChanged(ctx);
      res.writeHead(200, { "Content-Type": "application/json", ...cors });
      res.end(JSON.stringify({
        ok: true,
        level: session.thinkingLevel,
        availableLevels: available,
        supportsThinking,
      }));
    } catch (err: unknown) {
      res.writeHead(400, { ...cors });
      res.end(JSON.stringify({ error: (err as Error).message }));
    }
    return true;
  }

  // Hot-switch model
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
      let settings: Record<string, unknown> = {};
      if (existsSync(settingsFile)) {
        settings = JSON.parse(readFileSync(settingsFile, "utf-8"));
      }
      settings.defaultProvider = provider;
      settings.defaultModel = modelId;
      writeFileSync(settingsFile, JSON.stringify(settings, null, 2));
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

  // Layout config save
  if (url === "/api/layout-config" && method === "POST") {
    try {
      const data = await parseBody(req);
      const layoutPath = (await authorizeRoutePath(ctx, p.APP_ROOT, "src/layout-config.json", "write", "settings.layout-config")).path;
      writeFileSync(layoutPath, JSON.stringify(data, null, 2));
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
