/**
 * Dashboard route — /api/dashboard, /api/paths, /layout-config, /api/usage/*
 */
import { resolveEngine, type RouteHandler, type ServerContext } from "./types.js";
import type { AgentEngine, EngineContextUsage } from "../../agent-engine/index.js";
import { readFileSync, readdirSync, statSync } from "fs";
import { resolve } from "path";
import { handleDashboardMcp } from "./dashboard-mcp.js";
import { existingAncestorForPath } from "./route-path-utils.js";
import { parseBody } from "./parse-body.js";
import { fullScanFiles, incrementalScanFiles, loadIndex, saveIndex } from "../usage-index.js";
import { authorizeRoutePath, writeServerPermissionError } from "../permission-service.js";
import { writePathGuardError } from "./path-guard.js";
import { workspaceDataPaths } from "./session-dir.js";

function activeWorkspaceStorage(ctx: ServerContext): { sessionsDir: string; usageIndexFile: string } {
  const { paths } = ctx.groups.storage;
  if (paths.STARTUP?.dataRoot) {
    const workspace = ctx.groups.core.runtime.currentWorkspace || paths.STARTUP.workspace || paths.APP_ROOT;
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

function readContextUsage(engine: AgentEngine): EngineContextUsage | null {
  try { return engine.getContextUsage() ?? null; } catch { return null; }
}

function serializeContextUsage(usage: EngineContextUsage): EngineContextUsage {
  const response: EngineContextUsage = {
    tokens: usage.tokens ?? null,
    contextWindow: usage.contextWindow ?? 200000,
    percent: usage.percent ?? null,
    source: usage.source,
  };
  if (usage.source) response.source = usage.source;
  if (typeof usage.exactTokens === "number") response.exactTokens = usage.exactTokens;
  if (typeof usage.estimatedTokens === "number") response.estimatedTokens = usage.estimatedTokens;
  return response;
}

export const handleDashboard: RouteHandler = async (req, res, ctx) => {
  const { url, method } = req;
  const cors = { "Access-Control-Allow-Origin": "*" };
  const { paths: p } = ctx.groups.storage;
  const engine = resolveEngine(ctx);

  if (url === "/api/bootstrap" && (method === "GET" || method === "HEAD")) {
    res.writeHead(200, { "Content-Type": "application/json", ...cors });
    if (method === "HEAD") res.end();
    else res.end(JSON.stringify({ ok: true, ...(p.STARTUP ? { startup: p.STARTUP } : {}) }));
    return true;
  }

  const sessionDependent = url === "/api/dashboard"
    || url === "/api/token-usage"
    || url === "/api/usage/current"
    || (url === "/api/compact" && method === "POST");
  if (sessionDependent) {
    try {
      await ctx.groups.core.runtime.waitForSessionReady?.();
    } catch {
      res.writeHead(503, { "Content-Type": "application/json", ...cors, "Retry-After": "1" });
      res.end(JSON.stringify({ ok: false, code: "SESSION_NOT_READY" }));
      return true;
    }
  }
  const session = sessionDependent ? engine.session : undefined;

  // Dashboard data
  if (url === "/api/dashboard") {
    const workspaceStorage = activeWorkspaceStorage(ctx);
    res.writeHead(200, { "Content-Type": "application/json", ...cors });
    res.end(JSON.stringify({
      modelProvider: session!.model?.provider ?? "N/A",
      modelId: session!.model?.id ?? "N/A",
      modelContextWindow: session!.model?.capabilities.contextWindow.status === "known" ? session!.model.capabilities.contextWindow.value : "N/A",
      modelMaxTokens: session!.model?.capabilities.maxOutputTokens.status === "known" ? session!.model.capabilities.maxOutputTokens.value : "N/A",
      thinkingLevel: session!.thinkingLevel ?? "off",
      runtime: process.uptime(),
      messagesCount: session!.messagesCount ?? 0,
      isIdle: !session!.isStreaming,
      tools: session!.tools ?? [],
      activeTools: session!.tools ?? [],
      dataDir: p.DATA_DIR,
      sessionsDir: workspaceStorage.sessionsDir,
      sessionId: session!.id,
      _debug: { sessionsDir: workspaceStorage.sessionsDir, cwd: process.cwd(), appRoot: p.APP_ROOT },
    }));
    return true;
  }

  // Token usage — context + session stats + cost + provider
  if (url === "/api/token-usage") {
    let cu: EngineContextUsage | null = null;
    let stats: { tokens: { input: number; output: number; cacheRead: number; cacheWrite: number }; cost: number | null } | null = null;
    cu = readContextUsage(engine);
    const engineStats = engine.getSessionStats();
    if (engineStats) stats = { tokens: engineStats.usage, cost: engineStats.usage.cost.status === "known" ? engineStats.usage.cost.amount : null };
    const provider = session!.model?.provider ?? "unknown";
    const out: { contextUsage: typeof cu; sessionStats: typeof stats; provider: string } = { contextUsage: null, sessionStats: null, provider };
    if (cu) out.contextUsage = serializeContextUsage(cu);
    if (stats) out.sessionStats = { tokens: stats.tokens ?? null, cost: stats.cost ?? null };
    res.writeHead(200, { "Content-Type": "application/json", ...cors });
    res.end(JSON.stringify(out));
    return true;
  }

  // GET /api/usage/current — 当前会话 usage 数据（Token Rail + Usage 面板）
  if (url === "/api/usage/current") {
    let cu: EngineContextUsage | null = null;
    let stats: SessionStatsLike | null = null;
    cu = readContextUsage(engine);
    const engineStats = engine.getSessionStats();
    if (engineStats) {
      stats = { tokens: engineStats.usage, cost: engineStats.usage.cost.status === "known" ? engineStats.usage.cost.amount : null };
    }

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
    const sessionId = session!.id;
    const isCompacting = session!.isCompacting;
    const compactCount = engineStats?.compactCount ?? 0;
    const lastCompactionAt = engineStats?.lastCompactionAt ?? null;
    const lastCompactionSummary = engineStats?.lastCompactionSummary ?? null;

    const provider = session!.model?.provider ?? "unknown";

    res.writeHead(200, { "Content-Type": "application/json", ...cors });
    res.end(JSON.stringify({
      sessionId,
      provider,
      hasActiveSession: !!sessionId,
      contextUsage: cu ? serializeContextUsage(cu) : null,
      tokens,
      cacheHitRate: hitRate,
      cost: stats?.cost ?? null,
      compactCount,
      lastCompactionAt,
      lastCompactionSummary,
      isStreaming: session!.isStreaming,
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
        if (session!.isStreaming) {
          res.writeHead(409, { "Content-Type": "application/json", ...cors });
          res.end(JSON.stringify({ ok: false, error: "Please wait for the current response to finish before compacting." }));
          return true;
        }
        if (session!.isCompacting) {
          res.writeHead(409, { "Content-Type": "application/json", ...cors });
          res.end(JSON.stringify({ ok: false, error: "Compaction is already in progress." }));
          return true;
        }

        let focus: string | undefined;
        try {
          const body = await parseBody(req);
          focus = body?.focus || undefined;
        } catch {}

        const workspaceStorage = activeWorkspaceStorage(ctx);
        const indexPath = workspaceStorage.usageIndexFile;
        const indexRoot = existingAncestorForPath(indexPath);
        const authorizedIndexPath = (await authorizeRoutePath(ctx, indexRoot, indexPath, "read", "usage.compact.index")).path;
        const authorizedFiles = await findAuthorizedUsageSessionFiles(ctx, workspaceStorage.sessionsDir, "usage.compact");
        const writableIndexPath = (await authorizeRoutePath(ctx, indexRoot, indexPath, "write", "usage.compact.index")).path;

        await engine.compact(focus);
        const existingIndex = loadIndex(authorizedIndexPath);
        const idx = existingIndex
          ? incrementalScanFiles(workspaceStorage.sessionsDir, authorizedFiles, existingIndex)
          : fullScanFiles(workspaceStorage.sessionsDir, authorizedFiles);
        saveIndex(writableIndexPath, idx);

        res.writeHead(200, { "Content-Type": "application/json", ...cors });
        res.end(JSON.stringify({
          ok: true,
          compacted: true,
          message: "Compaction completed",
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

  if (await handleDashboardMcp(req, res, ctx)) return true;

  return false;
};

/** Minimal type for what we use from SessionStats */
interface SessionStatsLike {
  tokens?: { input: number; output: number; cacheRead: number; cacheWrite: number };
  cost?: number | null;
}

function roundCost(n: number): number {
  return Math.round(n * 1_000_000) / 1_000_000;
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
