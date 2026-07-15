/**
 * Settings routes — API keys, model switching, settings persistence
 */
import type { RouteHandler } from "./types";
import { readFileSync, writeFileSync, existsSync } from "fs";
import { resolve } from "path";
import { parseBody } from "./parse-body";

const cors = { "Access-Control-Allow-Origin": "*" };

export const handleSettings: RouteHandler = async (req, res, ctx) => {
  const { url, method } = req;
  const { runtime, paths: p } = ctx;
  const session = runtime.session;
  const modelRegistry = runtime.modelRegistry;

  // List available models (only those with configured API key in auth.json)
  if (url === "/api/models") {
    const all = modelRegistry.getAvailable();
    // Read auth.json to see which providers have keys configured in storage (not env vars)
    let configuredProviders: string[] = [];
    try {
      const authRaw = readFileSync(resolve(p.DATA_DIR, "pi", "auth.json"), "utf-8");
      const auth = JSON.parse(authRaw);
      configuredProviders = Object.keys(auth).filter(k => auth[k]?.apiKey);
    } catch { /* no auth.json yet */ }
    const filtered = configuredProviders.length === 0
      ? all.map((m: { provider: string; id: string }) => ({ provider: (m as { provider: string; id: string }).provider, id: (m as { provider: string; id: string }).id }))  // first run: show all
      : all.filter((m: { provider: string }) => configuredProviders.includes((m as { provider: string }).provider)).map((m: { provider: string; id: string }) => ({ provider: m.provider, id: m.id }));
    res.writeHead(200, { "Content-Type": "application/json", ...cors });
    res.end(JSON.stringify({ models: filtered }));
    return true;
  }

  // Save settings
  if (url === "/api/settings" && method === "POST") {
    try {
      const data = await parseBody(req);
      let settings: Record<string, unknown> = {};
      if (existsSync(p.SETTINGS_FILE)) {
        settings = JSON.parse(readFileSync(p.SETTINGS_FILE, "utf-8"));
      }
      if (data.defaultProvider) settings.defaultProvider = data.defaultProvider;
      if (data.defaultModel) settings.defaultModel = data.defaultModel;
      writeFileSync(p.SETTINGS_FILE, JSON.stringify(settings, null, 2));
      res.writeHead(200, { ...cors });
      res.end(JSON.stringify({ ok: true }));
    } catch (err: unknown) {
      res.writeHead(400, { ...cors });
      res.end(JSON.stringify({ error: (err as Error).message }));
    }
    return true;
  }

  // Get auth keys
  if (url === "/api/auth" && method === "GET") {
    try {
      const authFile = resolve(p.PI_CONFIG_DIR, "auth.json");
      const authData = existsSync(authFile) ? JSON.parse(readFileSync(authFile, "utf-8")) : {};
      const providerKeys = Object.keys(authData).map((provider) => ({
        provider,
        hasKey: !!authData[provider]?.apiKey,
        keyPreview: authData[provider]?.apiKey ? authData[provider].apiKey.slice(0, 8) + "..." : "",
        keyFull: authData[provider]?.apiKey || "",
      }));
      res.writeHead(200, { "Content-Type": "application/json", ...cors });
      res.end(JSON.stringify({ providers: providerKeys }));
    } catch (err: unknown) {
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
      const authFile = resolve(p.PI_CONFIG_DIR, "auth.json");
      let authData: Record<string, unknown> = {};
      if (existsSync(authFile)) authData = JSON.parse(readFileSync(authFile, "utf-8"));
      authData[provider] = { apiKey };
      writeFileSync(authFile, JSON.stringify(authData, null, 2));
      res.writeHead(200, { ...cors });
      res.end(JSON.stringify({ ok: true }));
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
      let settings: Record<string, unknown> = {};
      if (existsSync(p.SETTINGS_FILE)) {
        settings = JSON.parse(readFileSync(p.SETTINGS_FILE, "utf-8"));
      }
      settings.defaultProvider = provider;
      settings.defaultModel = modelId;
      writeFileSync(p.SETTINGS_FILE, JSON.stringify(settings, null, 2));
      // Hot switch
      await session.setModel(model);
      res.writeHead(200, { "Content-Type": "application/json", ...cors });
      res.end(JSON.stringify({ ok: true }));
    } catch (err: unknown) {
      res.writeHead(400, { ...cors });
      res.end(JSON.stringify({ error: (err as Error).message }));
    }
    return true;
  }

  // Layout config save
  if (url === "/api/layout-config" && method === "POST") {
    try {
      const data = await parseBody(req);
      const layoutPath = resolve(p.APP_ROOT, "src", "layout-config.json");
      writeFileSync(layoutPath, JSON.stringify(data, null, 2));
      res.writeHead(200, { ...cors });
      res.end(JSON.stringify({ ok: true }));
    } catch (err: unknown) {
      res.writeHead(400, { ...cors });
      res.end(JSON.stringify({ error: (err as Error).message }));
    }
    return true;
  }

  return false;
};
