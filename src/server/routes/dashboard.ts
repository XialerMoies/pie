/**
 * Dashboard route — /api/dashboard, /api/paths, /layout-config, /api/usage/*
 */
import type { RouteHandler, ServerContext } from "./types";
import { readFileSync, writeFileSync } from "fs";
import { resolve } from "path";
import { parseBody } from "./parse-body";
import { fullScan, incrementalScan, updateSessionInIndex, loadIndex, saveIndex, type UsageIndex } from "../usage-index";
import { getServersStatus } from "../../agent/mcp/MCPClientService";
import { loadMcpConfig } from "../../agent/mcp/config";
import { MCP_CATALOG, type CatalogEntry } from "../../agent/mcp/builtin-list";

export const handleDashboard: RouteHandler = (req, res, ctx) => {
  const { url, method } = req;
  const cors = { "Access-Control-Allow-Origin": "*" };
  const { runtime, paths: p } = ctx;
  const session = runtime.session;

  // Dashboard data
  if (url === "/api/dashboard") {
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
      sessionsDir: p.SESSIONS_DIR,
      sessionId: (session as any).sessionManager?.getSessionId?.() ?? "",
      _debug: { sessionsDir: p.SESSIONS_DIR, cwd: process.cwd(), appRoot: p.APP_ROOT },
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
    const hitRate = (tokens.cacheRead + tokens.cacheWrite) > 0
      ? Math.round(tokens.cacheRead / (tokens.cacheRead + tokens.cacheWrite) * 100)
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
    const indexPath = resolve(p.PI_CONFIG_DIR, "usage-index.json");

    // 加载既有索引，增量扫描
    let index: UsageIndex | null = loadIndex(indexPath);
    if (index) {
      index = incrementalScan(p.SESSIONS_DIR, index);
    } else {
      index = fullScan(p.SESSIONS_DIR);
    }
    saveIndex(indexPath, index);

    // 汇总
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
      // 从路径估算消息数（每个 message line 的 usage 通常在 assistant 上）
      const totalTokens = s.input + s.output + s.cacheRead + s.cacheWrite;
      topSessions.push({ id, name: s.name, workspace: s.workspace, totalTokens, updatedAt: s.updatedAt });
    }

    topSessions.sort((a, b) => b.totalTokens - a.totalTokens);
    const top5 = topSessions.slice(0, 5);

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
      topSessions: top5,
    }));
    return true;
  }

  // Path info
  if (url === "/api/paths") {
    res.writeHead(200, { "Content-Type": "application/json", ...cors });
    res.end(JSON.stringify({
      dataDir: p.DATA_DIR,
      configDir: p.PI_CONFIG_DIR,
      sessionsDir: p.SESSIONS_DIR,
    }));
    return true;
  }

  // Read layout config
  if (url === "/layout-config.json") {
    const layoutPath = resolve(p.APP_ROOT, "src", "layout-config.json");
    let content = "{}";
    try { content = readFileSync(layoutPath, "utf-8"); } catch {}
    res.writeHead(200, { "Content-Type": "application/json", ...cors });
    res.end(content);
    return true;
  }

  // POST /api/compact — 手动压缩上下文
  if (url === "/api/compact" && method === "POST") {
    return (async (): Promise<boolean> => {
      try {
        if ((session as any).isStreaming) {
          res.writeHead(409, { "Content-Type": "application/json", ...cors });
          res.end(JSON.stringify({ ok: false, error: "请等待当前回复完成后再压缩" }));
          return true;
        }
        if ((session as any).isCompacting) {
          res.writeHead(409, { "Content-Type": "application/json", ...cors });
          res.end(JSON.stringify({ ok: false, error: "正在压缩中，请稍候" }));
          return true;
        }

        let focus: string | undefined;
        try {
          const body = await parseBody(req);
          focus = body?.focus || undefined;
        } catch {}

        if (typeof (session as any).compact !== "function") {
          res.writeHead(400, { "Content-Type": "application/json", ...cors });
          res.end(JSON.stringify({ ok: false, error: "当前会话不支持压缩" }));
          return true;
        }

        const result = await (session as any).compact(focus);

        // 更新 usage-index（不存在则创建）
        try {
          const indexPath = resolve(p.PI_CONFIG_DIR, "usage-index.json");
          let idx = loadIndex(indexPath);
          if (!idx) idx = fullScan(p.SESSIONS_DIR);
          if ((session as any).sessionFile) {
            idx = updateSessionInIndex(p.SESSIONS_DIR, (session as any).sessionFile, idx);
            saveIndex(indexPath, idx);
          }
        } catch {}

        res.writeHead(200, { "Content-Type": "application/json", ...cors });
        res.end(JSON.stringify({
          ok: true,
          compacted: true,
          message: result?.summary ? "压缩完成" : "压缩完成",
        }));
        return true;
      } catch (err: any) {
        const msg = err?.message || "压缩失败";
        // "Already compacted" 和 "Nothing to compact" 是预期内非错误
        if (msg.includes("Already compacted") || msg.includes("Nothing to compact")) {
          res.writeHead(200, { "Content-Type": "application/json", ...cors });
          res.end(JSON.stringify({ ok: true, compacted: false, message: msg }));
          return true;
        }
        res.writeHead(500, { "Content-Type": "application/json", ...cors });
        res.end(JSON.stringify({ ok: false, error: msg }));
        return true;
      }
    })();
  }

  // MCP 状态：合并已配置 server + 运行时状态（脱敏返回）
  if (url === "/api/mcp/servers" && method === "GET") {
    const workspace = (runtime as any).currentWorkspace || p.APP_ROOT;
    const runtimeStatus = getServersStatus();
    const configResult = loadMcpConfig({ projectRoot: workspace });

    // 每个已配置的 server 与运行时状态合并
    const rootConfigPath = resolve(workspace, ".mcp.json");
    const merged = configResult.servers.map((source) => {
      const runtime = runtimeStatus.find((s) => s.name === source.name);
      return {
        name: source.name,
        state: runtime?.state ?? (source.config.enabled === false ? "disconnected" : "connecting"),
        tools: runtime?.tools ?? [],
        error: runtime?.error,
        config: { command: source.config.command, args: source.config.args, url: source.config.url, transport: source.config.transport ?? "stdio", enabled: source.config.enabled ?? true },
        canDelete: source.sourcePath === rootConfigPath,
      };
    });

    res.writeHead(200, { "Content-Type": "application/json", ...cors });
    res.end(JSON.stringify(merged));
    return true;
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
        const result = loadMcpConfig({ projectRoot: workspace });
        const source = result.servers.find((s) => s.name === name);
        if (!source) { res.writeHead(404, {"Content-Type":"application/json",...cors}); res.end(JSON.stringify({ok:false,error:"未找到 server"})); return true; }

        // 修改 .mcp.json 中的 enabled 字段
        const filePath = source.sourcePath;
        const content = JSON.parse(readFileSync(filePath, "utf-8"));
        const current = content.servers?.[name]?.enabled;
        const newEnabled = current === false ? true : false;
        content.servers[name].enabled = newEnabled;
        writeFileSync(filePath, JSON.stringify(content, null, 2) + "\n", "utf-8");

        res.writeHead(200, { "Content-Type": "application/json", ...cors });
        res.end(JSON.stringify({ ok: true, name, enabled: newEnabled, restartNeeded: true, message: "请重启会话以应用更改" }));
      } catch (e: any) {
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

  // POST /api/mcp/install — 从目录安装 MCP server（写入 .mcp.json）
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
        const configPath = resolve(workspace, ".mcp.json");

        let config: any = {};
        try { config = JSON.parse(readFileSync(configPath, "utf-8")); } catch {}
        if (!config.servers) config.servers = {};

        config.servers[entry.id] = { command: entry.command, args: entry.args };
        writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n", "utf-8");

        const hint = entry.postInstallHint ? `提示: ${entry.postInstallHint}` : "";
        res.writeHead(200, { "Content-Type": "application/json", ...cors });
        res.end(JSON.stringify({ ok: true, name: entry.name, restartNeeded: true, message: `已添加 ${entry.name}，请重启会话以应用更改。${hint}` }));
      } catch (e: any) {
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
        const result = loadMcpConfig({ projectRoot: workspace });
        const source = result.servers.find((s) => s.name === name);

        if (!source) {
          res.writeHead(404, { "Content-Type": "application/json", ...cors });
          res.end(JSON.stringify({ ok: false, error: `未找到 server "${name}"` }));
          return true;
        }

        // 只允许删除 workspace 根目录的 .mcp.json 中的条目
        const rootConfigPath = resolve(workspace, ".mcp.json");
        if (source.sourcePath !== rootConfigPath) {
          res.writeHead(403, { "Content-Type": "application/json", ...cors });
          res.end(JSON.stringify({ ok: false, error: `"${name}" 定义在 ${source.sourcePath}，请在对应文件中手动删除` }));
          return true;
        }

        const config = JSON.parse(readFileSync(rootConfigPath, "utf-8"));
        if (config.servers?.[name]) {
          delete config.servers[name];
          writeFileSync(rootConfigPath, JSON.stringify(config, null, 2) + "\n", "utf-8");
        }

        res.writeHead(200, { "Content-Type": "application/json", ...cors });
        res.end(JSON.stringify({ ok: true, name, restartNeeded: true, message: `已移除 ${name}，请重启会话以应用更改` }));
      } catch (e: any) {
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
