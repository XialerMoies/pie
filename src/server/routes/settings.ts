/**
 * Settings routes — API keys, model switching, settings persistence
 */
import type { RouteHandler } from "./types.js";
import { readFileSync, writeFileSync, existsSync } from "fs";
import { parseBody } from "./parse-body.js";
import { writePathGuardError } from "./path-guard.js";
import { authorizeRoutePath, writeServerPermissionError } from "../permission-service.js";
import { readDataRootPointer, writeDataRootPointer } from "../../data/data-root-config.js";
import { updateLockedJson } from "../../data/locked-json-store.js";
import {
  LegacySessionPreviewMismatchError,
  migrateLegacySessions,
  previewLegacySessions,
} from "./session-dir.js";

const cors = { "Access-Control-Allow-Origin": "*" };

function publishDashboardChanged(ctx: Parameters<RouteHandler>[2]): void {
  try { ctx.appEvents.publish("dashboard.changed"); } catch {}
}

export const handleSettings: RouteHandler = async (req, res, ctx) => {
  const { url, method } = req;
  const { runtime, paths: p } = ctx;
  const session = runtime.session;
  const modelRegistry = runtime.modelRegistry;

  if (url === "/api/storage-location" && method === "GET") {
    const pointerFile = p.DATA_ROOT_POINTER_FILE;
    const configuredDataRoot = pointerFile
      ? readDataRootPointer(pointerFile, p.DATA_DIR)
      : p.DATA_DIR;
    res.writeHead(200, { "Content-Type": "application/json", ...cors });
    res.end(JSON.stringify({
      dataRoot: configuredDataRoot,
      activeDataRoot: p.DATA_DIR,
      restartRequired: configuredDataRoot !== p.DATA_DIR,
      workspace: runtime.currentWorkspace || p.STARTUP?.workspace || p.APP_ROOT,
      instanceId: p.STARTUP?.instanceId || "",
      workspaceLock: {
        status: ctx.workspaceLock?.owner ? "locked" : "unlocked",
        ...(ctx.workspaceLock?.owner ? { owner: ctx.workspaceLock.owner } : {}),
      },
    }));
    return true;
  }

  if (url === "/api/storage-migration/preview" && method === "GET") {
    try {
      const workspace = runtime.currentWorkspace || p.STARTUP?.workspace || p.APP_ROOT;
      const preview = previewLegacySessions(p.DATA_DIR, workspace);
      res.writeHead(200, { "Content-Type": "application/json", ...cors });
      res.end(JSON.stringify({ ok: true, ...preview }));
    } catch (err: unknown) {
      res.writeHead(400, { "Content-Type": "application/json", ...cors });
      res.end(JSON.stringify({ ok: false, error: (err as Error).message }));
    }
    return true;
  }

  if (url === "/api/storage-migration/confirm" && method === "POST") {
    try {
      const data = await parseBody(req);
      if (data.confirm !== true || typeof data.previewId !== "string") {
        res.writeHead(400, { "Content-Type": "application/json", ...cors });
        res.end(JSON.stringify({ ok: false, error: "Explicit migration confirmation and preview ID are required" }));
        return true;
      }
      const workspace = runtime.currentWorkspace || p.STARTUP?.workspace || p.APP_ROOT;
      const preview = previewLegacySessions(p.DATA_DIR, workspace);
      if (preview.previewId !== data.previewId) {
        res.writeHead(409, { "Content-Type": "application/json", ...cors });
        res.end(JSON.stringify({ ok: false, error: "Migration preview changed; review it again" }));
        return true;
      }
      const migration = migrateLegacySessions(p.DATA_DIR, workspace, data.previewId);
      res.writeHead(200, { "Content-Type": "application/json", ...cors });
      res.end(JSON.stringify({ ok: true, preview, migration }));
    } catch (err: unknown) {
      res.writeHead(err instanceof LegacySessionPreviewMismatchError ? 409 : 400, { "Content-Type": "application/json", ...cors });
      res.end(JSON.stringify({ ok: false, error: (err as Error).message }));
    }
    return true;
  }

  if (url === "/api/storage-location" && method === "POST") {
    try {
      if (!p.DATA_ROOT_POINTER_FILE) {
        throw new Error("Data-root bootstrap pointer is unavailable");
      }
      const data = await parseBody(req);
      const result = writeDataRootPointer(p.DATA_ROOT_POINTER_FILE, data.dataRoot, p.DATA_DIR);
      res.writeHead(200, { "Content-Type": "application/json", ...cors });
      res.end(JSON.stringify({ ok: true, ...result }));
    } catch (err: unknown) {
      res.writeHead(400, { "Content-Type": "application/json", ...cors });
      res.end(JSON.stringify({ ok: false, error: (err as Error).message }));
    }
    return true;
  }

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
      await updateLockedJson<Record<string, unknown>>(authFile, () => ({}), (authData) => {
        authData[provider] = { apiKey };
        return authData;
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
