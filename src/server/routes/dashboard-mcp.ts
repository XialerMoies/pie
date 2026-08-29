import type { RouteHandler, ServerContext } from "./types.js";
import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { resolve, dirname } from "path";
import { parseBody } from "./parse-body.js";
import { disconnectServer, getMcpIntegrationRecords, getServersStatus, mcpServerComponentId, syncMcpServerComponent, uninstallMcpServerComponent } from "../../agent/mcp/MCPClientService.js";
import { capabilityComponentManager } from "../../agent/capability-components.js";
import { defaultGlobalConfigPath, getCandidatePaths, loadMcpConfigFromCandidates } from "../../agent/mcp/config.js";
import { MCP_CATALOG } from "../../agent/mcp/builtin-list.js";
import { isPathInside, normalizePermissionPath } from "../../agent/permissions.js";
import { TrustStore, hashServerCommand, defaultTrustStorePath } from "../../agent/mcp/trust-store.js";
import { authorizeRoutePath, isServerPermissionError, ServerPermissionError, writeServerPermissionError } from "../permission-service.js";
import { writePathGuardError } from "./path-guard.js";
import { updateLockedJson } from "../../data/locked-json-store.js";
import { existingAncestorForPath, pathExists } from "./route-path-utils.js";

function publishMcpChanged(ctx: ServerContext): void {
  try { ctx.groups.core.appEvents.publish("mcp.changed"); } catch {}
}

export const handleDashboardMcp: RouteHandler = async (req, res, ctx) => {
  const { url, method } = req;
  const cors = { "Access-Control-Allow-Origin": "*" };
  const { runtime } = ctx.groups.core;
  const { paths: p } = ctx.groups.storage;

  // MCP 状态：合并已配置 server + 运行时状态（脱敏返回）
  if (url === "/api/mcp/servers" && method === "GET") {
    return (async (): Promise<boolean> => {
      try {
        const workspace = (runtime as any).currentWorkspace || p.APP_ROOT;
        const runtimeStatus = getServersStatus();
        const configResult = await loadAuthorizedMcpConfig(ctx, workspace, "mcp.servers.config");
        const integrations = await getMcpIntegrationRecords(workspace, configResult.servers);
        const merged = configResult.servers.map((source) => {
          const runtime = runtimeStatus.find((s) => s.name === source.name);
          return {
            name: source.name,
            state: runtime?.state ?? (source.config.enabled === false ? "disconnected" : "connecting"),
            tools: runtime?.tools ?? [],
            error: runtime?.error,
            config: { command: source.config.command, args: source.config.args, url: source.config.url, transport: source.config.transport ?? "stdio", enabled: source.config.enabled ?? true },
            integration: integrations.find((integration) => integration.name === source.name),
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
        if (!newEnabled) await disconnectServer(name);
        const trusted = capabilityComponentManager.get(mcpServerComponentId(name))?.trusted === true;
        syncMcpServerComponent(workspace, { name, config: { ...source.config, enabled: newEnabled } }, trusted, getServersStatus().find((item) => item.name === name));
        publishMcpChanged(ctx);

        res.writeHead(200, { "Content-Type": "application/json", ...cors });
        res.end(JSON.stringify({ ok: true, name, enabled: newEnabled, restartNeeded: true, message: "请重启会话以应用更改" }));
      } catch (e: any) {
        console.error("[mcp toggle debug]", e);
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
        syncMcpServerComponent(workspace, source, true, getServersStatus().find((item) => item.name === name));
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
          await uninstallMcpServerComponent(name);
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

export async function loadAuthorizedMcpConfig(ctx: ServerContext, workspace: string, source: string) {
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
