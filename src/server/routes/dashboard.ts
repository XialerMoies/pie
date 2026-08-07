/**
 * Dashboard route — /api/dashboard, /api/paths, /layout-config, /api/usage/*
 */
import type { RouteHandler, ServerContext } from "./types.js";
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, statSync } from "fs";
import { resolve, dirname } from "path";
import { parseBody } from "./parse-body.js";
import { fullScanFiles, incrementalScanFiles, loadIndex, saveIndex } from "../usage-index.js";
import { getServersStatus } from "../../agent/mcp/MCPClientService.js";
import { defaultGlobalConfigPath, getCandidatePaths, loadMcpConfigFromCandidates } from "../../agent/mcp/config.js";
import { MCP_CATALOG, type CatalogEntry } from "../../agent/mcp/builtin-list.js";
import { isPathInside, normalizePermissionPath } from "../../agent/permissions.js";
import { TrustStore, hashServerCommand, defaultTrustStorePath } from "../../agent/mcp/trust-store.js";
import { authorizeRoutePath, isServerPermissionError, ServerPermissionError, writeServerPermissionError } from "../permission-service.js";
import { writePathGuardError } from "./path-guard.js";
import { workspaceDataPaths } from "./session-dir.js";
import { updateLockedJson } from "../../data/locked-json-store.js";

function activeWorkspaceStorage(ctx: ServerContext): { sessionsDir: string; usageIndexFile: string } {
  const { paths, runtime } = ctx;
  if (paths.STARTUP?.dataRoot) {
    const workspace = runtime.currentWorkspace || paths.STARTUP.workspace || paths.APP_ROOT;
    const workspacePaths = workspaceDataPaths(paths.DATA_DIR, workspace);
    return {
      sessionsDir: workspacePaths.sessionsDir,
      usageIndexFile: workspacePaths.usageIndexFile,
    };
  }
  return {
    sessionsDir: paths.SESSIONS_DIR || "",
    usageIndexFile: paths.PI_CONFIG_DIR ? resolve(paths.PI_CONFIG_DIR, "usage-index.json") : "",
  };
}

function publishMcpChanged(ctx: ServerContext): void {
  try { ctx.appEvents.publish("mcp.changed"); } catch {}
}

export const handleDashboard: RouteHandler = async (req, res, ctx) => {
  const { url, method } = req;
  const cors = { "Access-Control-Allow-Origin": "*" };
  const { runtime, paths: p } = ctx;

  if (url === "/api/bootstrap" && (method === "GET" || method === "HEAD")) {
    res.writeHead(200, { "Content-Type": "application/json", ...cors });
    if (method === "HEAD") res.end();
    else res.end(JSON.stringify({ ok: true, ...(p.STARTUP ? { startup: p.STARTUP } : {}) }));
    return true;
  }

  let session;
  try {
    session = typeof (runtime as any).waitForSessionReady === "function"
      ? await runtime.waitForSessionReady()
      : runtime.session;
  } catch {
    res.writeHead(503, { "Content-Type": "application/json", ...cors, "Retry-After": "1" });
    res.end(JSON.stringify({ ok: false, code: "SESSION_NOT_READY" }));
    return true;
  }

  // Dashboard data
  if (url === "/api/dashboard") {
    const workspaceStorage = activeWorkspaceStorage(ctx);
    res.writeHead(200, { "Content-Type": "application/json", ...cors });
    res.end(JSON.stringify({
      modelProvider: session.model?.provider ?? "N/A",
      modelId: session.model?.id ?? "N/A",
      modelContextWindow: session.model?.contextWindow ?? "N/A",
      modelMaxTokens: session.model?.maxTokens ?? "N/A",
      thinkingLevel: session.thinkingLevel ?? "off",
      runtime: process.uptime(),
      messagesCount: session.messages?.length ?? 0,
      isIdle: !session.isStreaming,
      tools: ((session.agent?.state?.tools as Array<{name: string}> | undefined) || []).map((t) => t.name),
      activeTools: ((session.agent?.state?.tools as Array<{name: string}> | undefined) || []).map((t) => t.name),
      dataDir: p.DATA_DIR,
      sessionsDir: workspaceStorage.sessionsDir,
      sessionId: (session as any).sessionManager?.getSessionId?.() ?? "",
      _debug: { sessionsDir: workspaceStorage.sessionsDir, cwd: process.cwd(), appRoot: p.APP_ROOT },
    }));
    return true;
  }

  // Token usage — context + session stats + cost + provider
  if (url === "/api/token-usage") {
    let cu: { tokens: number; contextWindow: number; percent: number } | null = null;
    let stats: { tokens: { input: number; output: number; cacheRead: number; cacheWrite: number }; cost: number } | null = null;
    try { cu = (session as any).getContextUsage?.(); } catch {}
    try { stats = (session as any).getSessionStats?.(); } catch {}
    const provider = session.model?.provider ?? "unknown";
    const out: { contextUsage: typeof cu; sessionStats: typeof stats; provider: string } = { contextUsage: null, sessionStats: null, provider };
    if (cu) out.contextUsage = { tokens: cu.tokens ?? null, contextWindow: cu.contextWindow ?? 200000, percent: cu.percent ?? null };
    if (stats) out.sessionStats = { tokens: stats.tokens ?? null, cost: stats.cost ?? null };
    res.writeHead(200, { "Content-Type": "application/json", ...cors });
    res.end(JSON.stringify(out));
    return true;
  }

  // GET /api/usage/current — 当前会话 usage 数据（Token Rail + Usage 面板）
  if (url === "/api/usage/current") {
    let cu: { tokens: number | null; contextWindow: number; percent: number | null } | null = null;
    let stats: SessionStatsLike | null = null;
    try { cu = (session as any).getContextUsage?.(); } catch {}
    try { stats = (session as any).getSessionStats?.(); } catch {}

    const tokens = stats?.tokens ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    // B-4：命中率口径 = 缓存命中 / 全部输入。input 已是"非缓存输入"
    // （pi-ai 各 provider 映射统一：Anthropic input_tokens 不含缓存；
    //  OpenAI/DeepSeek 侧 prompt_tokens 已扣 cached_tokens/miss 部分），
    // 故总输入 = input + cacheRead + cacheWrite。
    // 旧公式 cacheRead/(cacheRead+cacheWrite) 漏掉 input：
    //  - DeepSeek 无 cacheWrite（恒 0）→ 命中一次后分母只剩 cacheRead，永远 100%
    //  - 例：input=10000 cacheRead=5000 cacheWrite=2000 → 真实 29%，旧口径报 71%
    const totalInput = tokens.input + tokens.cacheRead + tokens.cacheWrite;
    const hitRate = totalInput > 0
      ? Math.round(tokens.cacheRead / totalInput * 100)
      : 0;
    const sessionId = (session as any).sessionManager?.getSessionId?.() ?? "";
    const isCompacting = !!(session as any).isCompacting;

    // 从 session entries 统计 compact 次数和摘要
    let compactCount = 0;
    let lastCompactionAt: string | null = null;
    let lastCompactionSummary: string | null = null;
    try {
      const entries = (session as any).sessionManager?.getBranch?.() ?? [];
      for (const e of entries) {
        if (e.type === "compaction") {
          compactCount++;
          lastCompactionAt = e.timestamp || null;
          lastCompactionSummary = e.summary || null;
        }
      }
    } catch {}

    const provider = session.model?.provider ?? "unknown";

    res.writeHead(200, { "Content-Type": "application/json", ...cors });
    res.end(JSON.stringify({
      sessionId,
      provider,
      hasActiveSession: !!sessionId,
      contextUsage: cu ? {
        tokens: cu.tokens,
        contextWindow: cu.contextWindow,
        percent: cu.percent,
      } : null,
      tokens,
      cacheHitRate: hitRate,
      cost: stats?.cost ?? 0,
      compactCount,
      lastCompactionAt,
      lastCompactionSummary,
      isStreaming: !!(session as any).isStreaming,
      isCompacting,
    }));
    return true;
  }

  // GET /api/usage/summary — 全部会话累计统计（基于 usage-index 增量扫描）
  if (url === "/api/usage/summary") {
    return (async (): Promise<boolean> => {
      try {
        const workspaceStorage = activeWorkspaceStorage(ctx);
        const indexPath = workspaceStorage.usageIndexFile;
        const indexRoot = existingAncestorForPath(indexPath);
        const authorizedIndexPath = (await authorizeRoutePath(ctx, indexRoot, indexPath, "read", "usage.summary.index")).path;
        const authorizedFiles = await findAuthorizedUsageSessionFiles(ctx, workspaceStorage.sessionsDir, "usage.summary");
        const existingIndex = loadIndex(authorizedIndexPath);
        const index = existingIndex
          ? incrementalScanFiles(workspaceStorage.sessionsDir, authorizedFiles, existingIndex)
          : fullScanFiles(workspaceStorage.sessionsDir, authorizedFiles);
        const writableIndexPath = (await authorizeRoutePath(ctx, indexRoot, indexPath, "write", "usage.summary.index")).path;
        saveIndex(writableIndexPath, index);

        const sessions = Object.keys(index.sessions).length;
        let totalInput = 0, totalOutput = 0, totalCacheRead = 0, totalCacheWrite = 0;
        let totalCost = 0, totalCompact = 0;
        let lastUpdatedAt = "";
        const topSessions: Array<{
          id: string; name: string; workspace: string;
          totalTokens: number; messageCount?: number; updatedAt: string;
        }> = [];

        for (const [id, s] of Object.entries(index.sessions)) {
          totalInput += s.input;
          totalOutput += s.output;
          totalCacheRead += s.cacheRead;
          totalCacheWrite += s.cacheWrite;
          totalCost += s.cost;
          totalCompact += s.compactCount;
          if (s.updatedAt > lastUpdatedAt) lastUpdatedAt = s.updatedAt;
          const totalTokens = s.input + s.output + s.cacheRead + s.cacheWrite;
          topSessions.push({ id, name: s.name, workspace: s.workspace, totalTokens, updatedAt: s.updatedAt });
        }

        topSessions.sort((a, b) => b.totalTokens - a.totalTokens);

        res.writeHead(200, { "Content-Type": "application/json", ...cors });
        res.end(JSON.stringify({
          sessions,
          tokens: {
            input: totalInput,
            output: totalOutput,
            cacheRead: totalCacheRead,
            cacheWrite: totalCacheWrite,
          },
          cost: roundCost(totalCost),
          compactCount: totalCompact,
          lastUpdatedAt,
          topSessions: topSessions.slice(0, 5),
        }));
      } catch (err) {
        if (writeServerPermissionError(res, cors, err)) return true;
        if (writePathGuardError(res, cors, err)) return true;
        res.writeHead(400, { ...cors });
        res.end(JSON.stringify({ error: (err as Error).message }));
      }
      return true;
    })();
  }

  // Path info
  if (url === "/api/paths") {
    const workspaceStorage = activeWorkspaceStorage(ctx);
    res.writeHead(200, { "Content-Type": "application/json", ...cors });
    res.end(JSON.stringify({
      dataDir: p.DATA_DIR,
      configDir: p.PI_CONFIG_DIR,
      sessionsDir: workspaceStorage.sessionsDir,
    }));
    return true;
  }

  // Read layout config
  if (url === "/layout-config.json") {
    return (async (): Promise<boolean> => {
      try {
        const layoutPath = (await authorizeRoutePath(ctx, p.APP_ROOT, "src/layout-config.json", "read", "dashboard.layout-config")).path;
        let content = "{}";
        try { content = readFileSync(layoutPath, "utf-8"); } catch {}
        res.writeHead(200, { "Content-Type": "application/json", ...cors });
        res.end(content);
      } catch (err: unknown) {
        if (writeServerPermissionError(res, cors, err)) return true;
        if (writePathGuardError(res, cors, err)) return true;
        res.writeHead(400, { "Content-Type": "application/json", ...cors });
        res.end(JSON.stringify({ ok: false, error: (err as Error).message }));
      }
      return true;
    })();
  }

  // POST /api/compact — 手动压缩上下文
  if (url === "/api/compact" && method === "POST") {
    return (async (): Promise<boolean> => {
      try {
        if ((session as any).isStreaming) {
          res.writeHead(409, { "Content-Type": "application/json", ...cors });
          res.end(JSON.stringify({ ok: false, error: "Please wait for the current response to finish before compacting." }));
          return true;
        }
        if ((session as any).isCompacting) {
          res.writeHead(409, { "Content-Type": "application/json", ...cors });
          res.end(JSON.stringify({ ok: false, error: "Compaction is already in progress." }));
          return true;
        }

        let focus: string | undefined;
        try {
          const body = await parseBody(req);
          focus = body?.focus || undefined;
        } catch {}

        if (typeof (session as any).compact !== "function") {
          res.writeHead(400, { "Content-Type": "application/json", ...cors });
          res.end(JSON.stringify({ ok: false, error: "The current session does not support compaction." }));
          return true;
        }

        const workspaceStorage = activeWorkspaceStorage(ctx);
        const indexPath = workspaceStorage.usageIndexFile;
        const indexRoot = existingAncestorForPath(indexPath);
        const authorizedIndexPath = (await authorizeRoutePath(ctx, indexRoot, indexPath, "read", "usage.compact.index")).path;
        const authorizedFiles = await findAuthorizedUsageSessionFiles(ctx, workspaceStorage.sessionsDir, "usage.compact");
        const writableIndexPath = (await authorizeRoutePath(ctx, indexRoot, indexPath, "write", "usage.compact.index")).path;

        const result = await (session as any).compact(focus);
        const existingIndex = loadIndex(authorizedIndexPath);
        const idx = existingIndex
          ? incrementalScanFiles(workspaceStorage.sessionsDir, authorizedFiles, existingIndex)
          : fullScanFiles(workspaceStorage.sessionsDir, authorizedFiles);
        saveIndex(writableIndexPath, idx);

        res.writeHead(200, { "Content-Type": "application/json", ...cors });
        res.end(JSON.stringify({
          ok: true,
          compacted: true,
          message: result?.summary ? "Compaction completed" : "Compaction completed",
        }));
        return true;
      } catch (err: any) {
        const msg = err?.message || "Compaction failed";
        if (msg.includes("Already compacted") || msg.includes("Nothing to compact")) {
          res.writeHead(200, { "Content-Type": "application/json", ...cors });
          res.end(JSON.stringify({ ok: true, compacted: false, message: msg }));
          return true;
        }
        if (writeServerPermissionError(res, cors, err)) return true;
        if (writePathGuardError(res, cors, err)) return true;
        res.writeHead(500, { "Content-Type": "application/json", ...cors });
        res.end(JSON.stringify({ ok: false, error: msg }));
        return true;
      }
    })();
  }

  // MCP 状态：合并已配置 server + 运行时状态（脱敏返回）
  if (url === "/api/mcp/servers" && method === "GET") {
    return (async (): Promise<boolean> => {
      try {
        const workspace = (runtime as any).currentWorkspace || p.APP_ROOT;
        const runtimeStatus = getServersStatus();
        const configResult = await loadAuthorizedMcpConfig(ctx, workspace, "mcp.servers.config");
        const merged = configResult.servers.map((source) => {
          const runtime = runtimeStatus.find((s) => s.name === source.name);
          return {
            name: source.name,
            state: runtime?.state ?? (source.config.enabled === false ? "disconnected" : "connecting"),
            tools: runtime?.tools ?? [],
            error: runtime?.error,
            config: { command: source.config.command, args: source.config.args, url: source.config.url, transport: source.config.transport ?? "stdio", enabled: source.config.enabled ?? true },
            canDelete: true,
          };
        });

        res.writeHead(200, { "Content-Type": "application/json", ...cors });
        res.end(JSON.stringify(merged));
      } catch (e: any) {
        if (writeServerPermissionError(res, cors, e)) return true;
        if (writePathGuardError(res, cors, e)) return true;
        res.writeHead(500, { "Content-Type": "application/json", ...cors });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
      return true;
    })();
  }

  // POST /api/mcp/servers/:name/toggle — 切换 server 启用状态（修改 .mcp.json）
  if (url?.startsWith("/api/mcp/servers/") && url.endsWith("/toggle") && method === "POST") {
    return (async () => {
      try {
        const rawName = url.slice("/api/mcp/servers/".length, -"/toggle".length);
        const name = decodeURIComponent(rawName);
        if (!name) { res.writeHead(400, {"Content-Type":"application/json",...cors}); res.end(JSON.stringify({ok:false,error:"缺少 server 名"})); return true; }

        // 从当前 workspace 查找
        const workspace = (runtime as any).currentWorkspace || p.APP_ROOT;
        const result = await loadAuthorizedMcpConfig(ctx, workspace, "mcp.toggle.config");
        const source = result.servers.find((s) => s.name === name);
        if (!source) { res.writeHead(404, {"Content-Type":"application/json",...cors}); res.end(JSON.stringify({ok:false,error:"未找到 server"})); return true; }

        // 修改 .mcp.json 中的 enabled 字段
        const filePath = await authorizeMcpConfigFileWrite(ctx, workspace, source.sourcePath, "mcp.toggle");
        let newEnabled = false;
        await updateMcpConfigFile(filePath, (content) => {
          const current = content.servers?.[name]?.enabled;
          newEnabled = current === false;
          content.servers[name].enabled = newEnabled;
          return content;
        });
        publishMcpChanged(ctx);

        res.writeHead(200, { "Content-Type": "application/json", ...cors });
        res.end(JSON.stringify({ ok: true, name, enabled: newEnabled, restartNeeded: true, message: "请重启会话以应用更改" }));
      } catch (e: any) {
        if (writeServerPermissionError(res, cors, e)) return true;
        res.writeHead(500, { "Content-Type": "application/json", ...cors });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
      return true;
    })();
  }

  // POST /api/mcp/servers/:name/trust — 信任一个 server
  if (url?.startsWith("/api/mcp/servers/") && url.endsWith("/trust") && method === "POST") {
    return (async () => {
      try {
        const rawName = url.slice("/api/mcp/servers/".length, -"/trust".length);
        const name = decodeURIComponent(rawName);
        if (!name) { res.writeHead(400, {"Content-Type":"application/json",...cors}); res.end(JSON.stringify({ok:false,error:"缺少 server 名"})); return true; }

        const workspace = (runtime as any).currentWorkspace || p.APP_ROOT;
        const result = await loadAuthorizedMcpConfig(ctx, workspace, "mcp.trust.config");
        const source = result.servers.find((s) => s.name === name);
        if (!source) { res.writeHead(404, {"Content-Type":"application/json",...cors}); res.end(JSON.stringify({ok:false,error:"未找到 server"})); return true; }

        const trustStore = await createAuthorizedTrustStore(ctx, "mcp.trust");
        const hash = hashServerCommand(source.config);
        await trustStore.addTrust(workspace, hash, source.name);
        publishMcpChanged(ctx);

        res.writeHead(200, { "Content-Type": "application/json", ...cors });
        res.end(JSON.stringify({ ok: true, name, restartNeeded: true, message: `已信任 ${name}，请重启会话以加载工具` }));
      } catch (e: any) {
        if (writeServerPermissionError(res, cors, e)) return true;
        res.writeHead(500, { "Content-Type": "application/json", ...cors });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
      return true;
    })();
  }

  // GET /api/mcp/catalog — 内置精选 MCP server 目录
  if (url === "/api/mcp/catalog" && method === "GET") {
    res.writeHead(200, { "Content-Type": "application/json", ...cors });
    res.end(JSON.stringify(MCP_CATALOG));
    return true;
  }

  // POST /api/mcp/install/custom — 自定义安装（写入全局 ~/.pi/agent/mcp.json，默认禁用）
  if (url === "/api/mcp/install/custom" && method === "POST") {
    return (async () => {
      try {
        const body = await parseBody(req);
        const { name, command, args } = body || {};
        if (!name || !command) {
          res.writeHead(400, { "Content-Type": "application/json", ...cors });
          res.end(JSON.stringify({ ok: false, error: "缺少 name 或 command" }));
          return true;
        }

        const workspace = (runtime as any).currentWorkspace || p.APP_ROOT;
        const globalPath = await authorizeMcpConfigFileWrite(ctx, workspace, defaultGlobalConfigPath(), "mcp.install.custom");
        await updateMcpConfigFile(globalPath, (config) => {
          if (!config.servers) config.servers = {};
          config.servers[name] = { command, args: args || [], enabled: false };
          return config;
        }, true);

        // 自动预信任（用户主动安装视为同意）
        try {
          const workspace = (runtime as any).currentWorkspace || p.APP_ROOT;
          const store = await createAuthorizedTrustStore(ctx, "mcp.install.custom.trust");
          await store.addTrust(workspace, hashServerCommand({ command, args: args || [], transport: "stdio" }), name);
        } catch {}
        publishMcpChanged(ctx);

        res.writeHead(200, { "Content-Type": "application/json", ...cors });
        res.end(JSON.stringify({ ok: true, name, isGlobal: true, restartNeeded: true, message: `已全局安装 ${name}，在项目 MCP 面板中启用即可使用` }));
      } catch (e: any) {
        if (writeServerPermissionError(res, cors, e)) return true;
        res.writeHead(500, { "Content-Type": "application/json", ...cors });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
      return true;
    })();
  }

  // POST /api/mcp/install — 从目录安装 MCP server（写入全局 ~/.pi/agent/mcp.json）
  if (url === "/api/mcp/install" && method === "POST") {
    return (async () => {
      try {
        const body = await parseBody(req);
        const { id } = body || {};
        if (!id) {
          res.writeHead(400, { "Content-Type": "application/json", ...cors });
          res.end(JSON.stringify({ ok: false, error: "缺少 id" }));
          return true;
        }

        const entry = MCP_CATALOG.find((e) => e.id === id);
        if (!entry) {
          res.writeHead(400, { "Content-Type": "application/json", ...cors });
          res.end(JSON.stringify({ ok: false, error: `未知的 MCP: ${id}` }));
          return true;
        }

        const workspace = (runtime as any).currentWorkspace || p.APP_ROOT;
        const globalPath = await authorizeMcpConfigFileWrite(ctx, workspace, defaultGlobalConfigPath(), "mcp.install");
        await updateMcpConfigFile(globalPath, (config) => {
          if (!config.servers) config.servers = {};
          config.servers[entry.id] = { command: entry.command, args: entry.args, enabled: false };
          return config;
        }, true);

        // 自动预信任（用户主动安装视为同意）
        try {
          const trustStore = await createAuthorizedTrustStore(ctx, "mcp.install.trust");
          const srvConfig: import("../../agent/mcp/types.js").McpServerConfig = {
            command: entry.command, args: entry.args, transport: "stdio",
          };
          const hash = hashServerCommand(srvConfig);
          await trustStore.addTrust(workspace, hash, entry.name);
        } catch {}
        publishMcpChanged(ctx);

        const hint = entry.postInstallHint ? `提示: ${entry.postInstallHint}` : "";
        res.writeHead(200, { "Content-Type": "application/json", ...cors });
        res.end(JSON.stringify({ ok: true, name: entry.name, isGlobal: true, message: `已全局安装 ${entry.name}，在项目 MCP 面板中启用即可使用。${hint}` }));
      } catch (e: any) {
        if (writeServerPermissionError(res, cors, e)) return true;
        res.writeHead(500, { "Content-Type": "application/json", ...cors });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
      return true;
    })();
  }

  // POST /api/mcp/uninstall — 移除 MCP server（从配置来源的 .mcp.json 删除）
  if (url === "/api/mcp/uninstall" && method === "POST") {
    return (async () => {
      try {
        const body = await parseBody(req);
        const { name } = body || {};
        if (!name) {
          res.writeHead(400, { "Content-Type": "application/json", ...cors });
          res.end(JSON.stringify({ ok: false, error: "缺少 name" }));
          return true;
        }

        const workspace = (runtime as any).currentWorkspace || p.APP_ROOT;

        // 从配置源中找到这个 server 所在的文件
        const result = await loadAuthorizedMcpConfig(ctx, workspace, "mcp.uninstall.config");
        const source = result.servers.find((s) => s.name === name);

        if (!source) {
          res.writeHead(404, { "Content-Type": "application/json", ...cors });
          res.end(JSON.stringify({ ok: false, error: `未找到 server "${name}"` }));
          return true;
        }

        // 从配置来源的 .mcp.json 中删除
        const configPath = await authorizeMcpConfigFileWrite(ctx, workspace, source.sourcePath, "mcp.uninstall");
        let removed = false;
        await updateMcpConfigFile(configPath, (config) => {
          if (config.servers?.[name]) {
            delete config.servers[name];
            removed = true;
          }
          return config;
        });
        if (removed) {
          publishMcpChanged(ctx);
        }

        res.writeHead(200, { "Content-Type": "application/json", ...cors });
        res.end(JSON.stringify({ ok: true, name, restartNeeded: true, message: `已移除 ${name}，请重启会话以应用更改` }));
      } catch (e: any) {
        if (writeServerPermissionError(res, cors, e)) return true;
        res.writeHead(500, { "Content-Type": "application/json", ...cors });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
      return true;
    })();
  }

  return false;
};

/** Minimal type for what we use from SessionStats */
interface SessionStatsLike {
  tokens?: { input: number; output: number; cacheRead: number; cacheWrite: number };
  cost?: number;
}

function roundCost(n: number): number {
  return Math.round(n * 1_000_000) / 1_000_000;
}

async function authorizeMcpConfigFileWrite(ctx: ServerContext, workspace: string, filePath: string, source: string): Promise<string> {
  const resolvedFile = resolve(filePath);
  if (isPathInside(resolvedFile, workspace)) {
    return (await authorizeRoutePath(ctx, workspace, resolvedFile, "write", source)).path;
  }

  const globalPath = resolve(defaultGlobalConfigPath());
  if (normalizePermissionPath(resolvedFile) === normalizePermissionPath(globalPath)) {
    return (await authorizeRoutePath(ctx, existingAncestorForPath(globalPath), resolvedFile, "write", source)).path;
  }

  throw new ServerPermissionError("MCP config path is outside workspace/global config roots", 403, "permission_denied");
}

async function authorizeMcpConfigFileRead(ctx: ServerContext, workspace: string, filePath: string, source: string): Promise<string> {
  const resolvedFile = resolve(filePath);
  if (isPathInside(resolvedFile, workspace)) {
    return (await authorizeRoutePath(ctx, workspace, resolvedFile, "read", source)).path;
  }

  const globalPath = resolve(defaultGlobalConfigPath());
  if (normalizePermissionPath(resolvedFile) === normalizePermissionPath(globalPath)) {
    return (await authorizeRoutePath(ctx, existingAncestorForPath(globalPath), resolvedFile, "read", source)).path;
  }

  throw new ServerPermissionError("MCP config path is outside workspace/global config roots", 403, "permission_denied");
}

async function loadAuthorizedMcpConfig(ctx: ServerContext, workspace: string, source: string) {
  const candidates = [];
  for (const candidate of getCandidatePaths(workspace)) {
    if (!pathExists(candidate.path)) continue;
    let authorizedPath: string;
    try {
      authorizedPath = await authorizeMcpConfigFileRead(ctx, workspace, candidate.path, source);
    } catch (error) {
      if (candidate.priority === 2 && !isServerPermissionError(error)) continue;
      throw error;
    }
    if (pathExists(authorizedPath)) {
      candidates.push({ ...candidate, path: authorizedPath });
    }
  }
  return loadMcpConfigFromCandidates(candidates);
}

async function createAuthorizedTrustStore(ctx: ServerContext, source: string): Promise<TrustStore> {
  const trustPath = defaultTrustStorePath();
  const authorizedPath = (await authorizeRoutePath(ctx, existingAncestorForPath(trustPath), trustPath, "write", source)).path;
  return new TrustStore({ filePath: authorizedPath });
}

async function updateMcpConfigFile(
  filePath: string,
  updater: (config: any) => any,
  recoverInvalidJson = false,
): Promise<void> {
  if (normalizePermissionPath(resolve(filePath)) === normalizePermissionPath(resolve(defaultGlobalConfigPath()))) {
    await updateLockedJson<any>(filePath, () => ({}), updater, { recoverInvalidJson });
    return;
  }

  let config: any;
  try {
    config = JSON.parse(readFileSync(filePath, "utf8"));
  } catch (error) {
    if (!recoverInvalidJson) throw error;
    config = {};
  }
  const updated = updater(config);
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(updated, null, 2)}\n`, "utf8");
}

function existingAncestorForPath(filePath: string): string {
  let current = dirname(resolve(filePath));
  while (!pathExists(current)) {
    const parent = dirname(current);
    if (parent === current) return current;
    current = parent;
  }
  return current;
}

function pathExists(filePath: string): boolean {
  try {
    return existsSync(filePath);
  } catch {
    return false;
  }
}

async function findAuthorizedUsageSessionFiles(
  ctx: ServerContext,
  sessionsDir: string,
  sourcePrefix: string,
): Promise<string[]> {
  const root = (await authorizeRoutePath(
    ctx,
    existingAncestorForPath(sessionsDir),
    sessionsDir,
    "read",
    `${sourcePrefix}.root`,
  )).path;
  return collectAuthorizedUsageSessionFiles(ctx, root, root, sourcePrefix);
}

async function collectAuthorizedUsageSessionFiles(
  ctx: ServerContext,
  sessionsRoot: string,
  currentDir: string,
  sourcePrefix: string,
): Promise<string[]> {
  let entries;
  try {
    entries = readdirSync(currentDir, { withFileTypes: true });
  } catch {
    return [];
  }

  const files: string[] = [];
  for (const entry of entries) {
    const entryPath = resolve(currentDir, entry.name);

    if (entry.isDirectory() || entry.isSymbolicLink()) {
      const guarded = (await authorizeRoutePath(
        ctx,
        sessionsRoot,
        entryPath,
        "read",
        `${sourcePrefix}.project`,
      )).path;

      let stat;
      try {
        stat = statSync(guarded);
      } catch {
        continue;
      }

      if (stat.isDirectory()) {
        files.push(...await collectAuthorizedUsageSessionFiles(ctx, sessionsRoot, guarded, sourcePrefix));
      } else if (entry.name.endsWith(".jsonl")) {
        files.push(guarded);
      }
      continue;
    }

    if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
    files.push((await authorizeRoutePath(
      ctx,
      sessionsRoot,
      entryPath,
      "read",
      `${sourcePrefix}.file`,
    )).path);
  }

  return files;
}
