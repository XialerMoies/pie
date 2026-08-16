/**
 * My Code Agent — Pi 服务器
 * 作为子进程运行，通过 HTTP 提供仪表盘和对话 API
 *
 * 环境变量：
 *   PI_WORKSPACE       - initial workspace
 *   PI_DATA_ROOT       - persistent data root
 *   PI_INSTANCE_ID     - per-launch instance id
 */
import { initAgent, type AgentRuntime } from "../agent/index.js";
import { createServer, type IncomingMessage, type OutgoingHttpHeaders, type ServerResponse } from "http";
import { resolve, dirname } from "path";
import { fileURLToPath, pathToFileURL } from "url";
import { readFileSync, writeFileSync, existsSync, mkdirSync, statSync } from "fs";
import { dispatchRoute } from "./routes/index.js";
import { cancelCommandConfirmationsForResponse, createCommandConfirmCallback } from "./routes/chat.js";
import type { ServerContext, ChatStreamState } from "./routes/types.js";
import { TsserverManager } from "./ts-server.js";
import { mark, logTiming } from "./timing.js";
import { shellDialectFromEnv } from "../agent/tools/command/shell-parser.js";
import { createSessionPermissionState } from "../agent/permissions.js";
import {
  authorizeLocalApiRequest,
  cleanupStaleInstanceDirectories,
  clearDesktopSessionTokenEnv,
  createDesktopSecurityConfig,
  installSecurityHeaders,
  isApiPreflight,
  removeInstanceRuntimeDirectory,
  writeInstanceMetadata,
  writeSecurityError,
  type InstanceMetadata,
} from "./security.js";
import { ServerPermissionService } from "./permission-service.js";
import { authorizeWorkspacePath, runWithWorkspaceOwnership } from "./routes/workspace-authorization.js";
import { cancelPermissionConfirmationsForResponse, createPermissionConfirmCallback } from "./permission-confirmation.js";
import { FilePermissionAuditStore } from "./permission-audit-store.js";
import { FileWorkspacePermissionRuleStore } from "./permission-rule-store.js";
import { contentTypeForStaticAsset, resolveStaticAssetPath } from "./static-assets.js";
import { RootRegistry } from "./root-registry.js";
import { createPermissionModeController } from "./permission-mode.js";
import { AppEventHub } from "./app-events.js";
import { WorkspaceFileWatcher } from "./workspace-file-watcher.js";
import { getServersStatus, subscribeStatusChanges } from "../agent/mcp/MCPClientService.js";
import { resolveStartupPaths, startupPathsSnapshot } from "./startup-paths.js";
import { canonicalWorkspacePath } from "../data/data-layout.js";
import { readUserPreferences, readUserSettings, recordOpenedWorkspace } from "../data/user-settings.js";
import { readSubagentDefinitions } from "../data/subagent-config.js";
import { WorkspaceLockCoordinator } from "./workspace-lock.js";
import { workspaceDataPaths, writeWorkspaceMetadata } from "./routes/session-dir.js";
import { readWorkspaceUiState } from "./routes/ui-state.js";
import {
  createSubagentDelegationBridge,
  createRuntimeSubagentHost,
  type SubagentDelegationHost,
} from "./subagent-delegation.js";
import { createSubagentEventSink } from "./subagent-events.js";
import { CustomProviderStore } from "../model-provider/custom-provider-store.js";
import { PiCustomProviderAdapter } from "../model-provider/pi-custom-provider-adapter.js";
import { CustomProviderRuntimeCoordinator } from "../model-provider/runtime-coordinator.js";
import { ProviderReferenceChecker } from "../model-provider/provider-reference-checker.js";
import { CustomProviderService } from "../model-provider/custom-provider-service.js";

import { attachSessionEvents, recordUserNoteBlock } from "./agent-event-router.js";
export { attachSessionEvents, emitBlock, emitTrace, flushPendingBlockPersist, flushPendingTracePersist, nextBlockSeq, persistBlockEvent, persistTraceEvent, recordUserNoteBlock, tagSessionHeader } from "./agent-event-router.js";

export function openAppEventStream(
  req: IncomingMessage,
  res: ServerResponse,
  appEvents: AppEventHub,
  cors: OutgoingHttpHeaders,
): void {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    ...cors,
  });
  res.write(`data: ${JSON.stringify({ type: "connected", revision: appEvents.revision() })}\n\n`);
  appEvents.addClient(res);
  req.on("close", () => {
    appEvents.removeClient(res);
  });
}

export function attachMcpEvents(appEvents: Pick<AppEventHub, "publish">): () => void {
  const toolsKey = (snapshot: ReturnType<typeof getServersStatus>): string => JSON.stringify(
    snapshot
      .map((status) => ({ name: status.name, tools: status.tools }))
      .sort((left, right) => left.name.localeCompare(right.name)),
  );
  let previousTools = toolsKey(getServersStatus());
  return subscribeStatusChanges((snapshot) => {
    try { appEvents.publish("mcp.changed"); } catch {}
    const nextTools = toolsKey(snapshot);
    if (nextTools !== previousTools) {
      previousTools = nextTools;
      try { appEvents.publish("dashboard.changed"); } catch {}
    }
  });
}

// 不再移动活跃 session 文件——只在 header 标记 workspace
const __dirname = dirname(fileURLToPath(import.meta.url));
const APP_ROOT = resolve(__dirname, "..", "..");
const STARTUP = resolveStartupPaths({ appRoot: APP_ROOT, argv: process.argv.slice(2), env: process.env });
const STARTUP_SNAPSHOT = startupPathsSnapshot(STARTUP);
const DATA_DIR = STARTUP.dataRoot;
const PI_CONFIG_DIR = STARTUP.layout.userRoot;
const SESSIONS_DIR = STARTUP.layout.sessionsDir;
const SETTINGS_FILE = STARTUP.layout.settingsFile;
const SUBAGENTS_FILE = STARTUP.layout.subagentsFile;
const DATA_ROOT_POINTER_FILE = process.env.PI_DESKTOP_DATA_ROOT_POINTER || "";
const FRONTEND_DIR = resolve(APP_ROOT, "dist", "frontend");
const FRONTEND_ENTRY_FILE = "dashboard.html";
const HAS_BUILT_FRONTEND = existsSync(resolve(FRONTEND_DIR, FRONTEND_ENTRY_FILE));
const FRONTEND_SRC_DIR = resolve(APP_ROOT, "src", "frontend");
const TRANSIENT_EMPTY_WORKSPACE = STARTUP.workspace === canonicalWorkspacePath(
  resolve(STARTUP.layout.instanceRoot, "empty-workspace"),
);
let activeWorkspaceLock: WorkspaceLockCoordinator | null = null;
let activeWorkspaceLockRelease: Promise<void> | null = null;

async function releaseActiveWorkspaceLock(): Promise<void> {
  if (activeWorkspaceLockRelease) return activeWorkspaceLockRelease;
  const lock = activeWorkspaceLock;
  if (!lock) return;
  activeWorkspaceLockRelease = lock.release()
    .then(() => {
      if (activeWorkspaceLock === lock) activeWorkspaceLock = null;
    })
    .finally(() => {
      activeWorkspaceLockRelease = null;
    });
  await activeWorkspaceLockRelease;
}

// ─── 启动 Pi ──────────────────────────────────────────────────────
async function main() {
  mark("server_start");
  console.log("Starting Pi server...");

  await cleanupStaleInstanceDirectories(STARTUP.dataRoot, STARTUP.instanceId);
  for (const directory of [
    STARTUP.layout.dataRoot,
    STARTUP.layout.userRoot,
    STARTUP.layout.workspaceRoot,
    STARTUP.layout.sessionsDir,
    STARTUP.layout.instanceRoot,
    STARTUP.layout.cacheDir,
  ]) {
    mkdirSync(directory, { recursive: true });
  }
  try {
    writeFileSync(STARTUP.layout.authFile, JSON.stringify({}, null, 2), { encoding: "utf8", flag: "wx" });
  } catch (error: any) {
    if (error?.code !== "EEXIST") throw error;
  }
  const instanceMetadata: InstanceMetadata = {
    version: 1,
    instanceId: STARTUP.instanceId,
    pid: process.pid,
    port: 0,
    workspace: STARTUP.workspace,
    startedAt: Date.now(),
  };
  await writeInstanceMetadata(STARTUP.layout.portFile, instanceMetadata);

  const workspaceLock = new WorkspaceLockCoordinator({
    dataRoot: STARTUP.dataRoot,
    instanceId: STARTUP.instanceId,
  });
  activeWorkspaceLock = workspaceLock;
  await workspaceLock.acquireInitial(STARTUP.workspace);
  try {
    await recordOpenedWorkspace(SETTINGS_FILE, STARTUP.workspace, {
      transientWorkspace: resolve(STARTUP.layout.instanceRoot, "empty-workspace"),
    });
  } catch (error) {
    console.warn("Failed to record opened workspace:", error);
  }
  writeWorkspaceMetadata(DATA_DIR, STARTUP.workspace);

  // ─── 共享可变状态 ────────────────────────────────────────────
  const chatStream: ChatStreamState = { textBuffer: "", thinkingBuffer: "", currentTextSnapshot: "", currentThinkingSnapshot: "", response: null, turnId: "", traceSeq: 0, emittedTraces: new Set(), blocks: [], blockSeq: 0, eventSeq: 0, eventHistory: [] };
  const appEvents = new AppEventHub();
  appEvents.subscribeClientRemoved(cancelPermissionConfirmationsForResponse);
  const unsubscribeMcpEvents = attachMcpEvents(appEvents);
  const sessionPermissionState = createSessionPermissionState();
  let runtime: AgentRuntime;
  let subagentHost: SubagentDelegationHost;
  const subagentBridge = createSubagentDelegationBridge();
  const security = createDesktopSecurityConfig(undefined, STARTUP.instanceId);
  clearDesktopSessionTokenEnv();
  const rootRegistry = new RootRegistry();
  const permissionService = new ServerPermissionService({
    sessionPermissionState,
    workspaceRootProvider: () => runtime?.currentWorkspace || STARTUP.workspace,
    rootRegistry,
    confirmPermission: createPermissionConfirmCallback(appEvents),
    auditStore: new FilePermissionAuditStore(STARTUP.layout.permissionAuditFile, { maxEntries: 2000 }),
    permissionRuleStore: new FileWorkspacePermissionRuleStore(STARTUP.layout.permissionRulesFile),
  });
  const permissionMode = createPermissionModeController("standard", (mode) => {
    permissionService.recordPermissionModeChange(mode, "permissions.mode");
  });

  const customProviderStore = new CustomProviderStore({
    configFile: STARTUP.layout.customProvidersFile,
    secretsFile: STARTUP.layout.customProviderSecretsFile,
  });
  const customProviderAdapter = new PiCustomProviderAdapter();
  const customProviderCoordinator = new CustomProviderRuntimeCoordinator({
    store: customProviderStore,
    adapter: customProviderAdapter,
  });
  const providerReferenceChecker = new ProviderReferenceChecker({
    currentModel: () => {
      const model = runtime.session.model;
      return model ? { provider: model.provider, id: model.id } : undefined;
    },
    defaultModel: () => {
      const settings = readUserSettings(SETTINGS_FILE);
      const preferences = readUserPreferences(SETTINGS_FILE);
      const provider = settings.defaultProvider ?? preferences.defaultProvider;
      const id = settings.defaultModel ?? preferences.defaultModel;
      return provider && id ? { provider, id } : undefined;
    },
    customAgents: () => readSubagentDefinitions(SUBAGENTS_FILE),
  });
  const customProviderService = new CustomProviderService({
    store: customProviderStore,
    coordinator: customProviderCoordinator,
    referenceChecker: providerReferenceChecker,
  });

  runtime = await initAgent({
    agentDir: PI_CONFIG_DIR,
    cwd: STARTUP.workspace,
    sessionsDir: SESSIONS_DIR,
    sessionsDirForWorkspace: (workspace) => workspaceDataPaths(DATA_DIR, workspace).sessionsDir,
    authFile: STARTUP.layout.authFile,
    modelsFile: STARTUP.layout.modelsFile,
    syncModelProviders: modelRuntime => customProviderService.syncRuntime(modelRuntime),
    getPermissionMode: () => permissionMode.get(),
    shellDialect: shellDialectFromEnv(),
    confirmCommand: createCommandConfirmCallback(chatStream),
    desktopApiToken: security.token,
    sessionPermissionState,
    authorizePath: (root, target, operation, source) => permissionService.authorizePath(root, target, operation, source),
    authorizeTool: (request) => permissionService.authorizeTool(request),
    applyPermissionSuggestions: async (suggestions, scope) => {
      await permissionService.applyPermissionSuggestions(suggestions, scope);
    },
    validateSubagentModel: subagentBridge.runtimeConfig.validateSubagentModel,
    getSubagentDefinitions: () => readSubagentDefinitions(SUBAGENTS_FILE),
    getSubagentLimits: () => {
      const preferences = readUserPreferences(SETTINGS_FILE);
      const readLimit = (key: string, fallback: number): number => {
        const value = Number(preferences[key]);
        return Number.isInteger(value) ? Math.min(30, Math.max(1, value)) : fallback;
      };
      return {
        maxTasks: readLimit("subagent-max-tasks", 4),
        maxConcurrent: readLimit("subagent-max-concurrent", 2),
      };
    },
    delegateTasks: subagentBridge.runtimeConfig.delegateTasks,
  });

  subagentHost = createRuntimeSubagentHost({
    runtime,
    createEventSink: () => createSubagentEventSink({ runtime, chatStream }),
  });
  subagentBridge.bind(subagentHost);

  for (const [root, source] of [
    [APP_ROOT, "app-data"],
    [DATA_DIR, "app-data"],
    [PI_CONFIG_DIR, "app-data"],
    [SESSIONS_DIR, "session"],
    [STARTUP.layout.workspaceRoot, "app-data"],
    [STARTUP.layout.instanceRoot, "app-data"],
  ] as const) {
    try {
      rootRegistry.register(root, {
        source,
        operations: ["read", "write", "create", "remove"],
      });
    } catch {
      // Optional data roots may not exist until the agent initializes them.
    }
  }
  try {
    rootRegistry.setWorkspaceRoot(runtime.currentWorkspace || STARTUP.workspace);
  } catch {
    // Permission checks remain fail-closed if the initial workspace is unavailable.
  }

  console.log("Pi session ready");
  mark("agent_ready");

  const baseCtx: ServerContext = {
    runtime,
    chatStream,
    appEvents,
    security,
    permissionService,
    permissionMode,
    workspaceLock,
    customProviderService,
    rootRegistry,
    recordUserNote: (note) => recordUserNoteBlock(runtime, chatStream, note, {
      authorizeSessionWrite: (sessionFile, source) => {
        const sessionsDir = workspaceDataPaths(DATA_DIR, runtime.currentWorkspace || STARTUP.workspace).sessionsDir;
        permissionService.authorizePathSync(sessionsDir, sessionFile, "write", source);
      },
    }),
    paths: {
      APP_ROOT,
      DATA_DIR,
      PI_CONFIG_DIR,
      SESSIONS_DIR,
      SETTINGS_FILE,
      SUBAGENTS_FILE,
      DATA_ROOT_POINTER_FILE,
      STARTUP: STARTUP_SNAPSHOT,
      FRONTEND_DIR,
      FRONTEND_SRC_DIR,
      HAS_BUILT_FRONTEND,
    },
  };

  // ─── 启动恢复：只恢复本实例显式指定的 workspace ─────────────
  try {
    const state = await readWorkspaceUiState(baseCtx, STARTUP.workspace);
    if (state.activeView?.type === "session" && state.activeView.id) {
      console.log(`[startup] 恢复 workspace: "${STARTUP.workspace}", session: ${state.activeView.id}`);
      const { findAuthorizedSessionFileById } = await import("./routes/sessions.js");
      const sessionFile = await findAuthorizedSessionFileById(baseCtx, state.activeView.id, "sessions.startup.restore");
      if (sessionFile) await runtime.openSession(sessionFile, STARTUP.workspace);
    }
  } catch (e) {
    console.log(`[startup] 恢复失败: ${e}`);
  }

  const workspaceWatcher = new WorkspaceFileWatcher({
    appRoot: APP_ROOT,
    onChange: (file) => appEvents.publish("explorer.changed", { file }),
    onWatching: (workspace) => console.log("[watcher] watching " + workspace),
    onError: (error) => console.log("[watcher] not available: " + error.message),
  });
  let openedWorkspaceRecordTail = Promise.resolve();
  const enqueueOpenedWorkspaceRecord = (workspace: string): void => {
    openedWorkspaceRecordTail = openedWorkspaceRecordTail
      .then(() => recordOpenedWorkspace(SETTINGS_FILE, workspace, {
        transientWorkspace: resolve(STARTUP.layout.instanceRoot, "empty-workspace"),
      }))
      .then(
        () => undefined,
        (error) => { console.warn("Failed to record opened workspace:", error); },
      );
  };
  const unsubscribeWorkspaceWatcher = runtime.onWorkspaceChange((workspace) => {
    instanceMetadata.workspace = workspace;
    void writeInstanceMetadata(STARTUP.layout.portFile, instanceMetadata).catch((error) => {
      console.error("Failed to update instance workspace metadata:", error);
    });
    const workspacePaths = workspaceDataPaths(DATA_DIR, workspace);
    mkdirSync(workspacePaths.sessionsDir, { recursive: true });
    writeWorkspaceMetadata(DATA_DIR, workspace);
    try {
      rootRegistry.register(workspacePaths.workspaceRoot, {
        source: "app-data",
        operations: ["read", "write", "create", "remove"],
      });
      rootRegistry.register(workspacePaths.sessionsDir, {
        source: "session",
        operations: ["read", "write", "create", "remove"],
      });
      rootRegistry.setWorkspaceRoot(workspace);
    } catch {}
    workspaceWatcher.watchWorkspace(workspace);
    enqueueOpenedWorkspaceRecord(workspace);
  });
  workspaceWatcher.watchWorkspace(runtime.currentWorkspace || STARTUP.workspace);

  attachSessionEvents(runtime, chatStream, baseCtx);

  // ─── tsserver（TypeScript 语言服务，延迟启动）────────────────────
  const tsServer = new TsserverManager();

  // ─── 上下文对象 ──────────────────────────────────────────────────
  const ctx: ServerContext = {
    ...baseCtx,
    tsServer,
  };

  // ─── HTTP 服务器 ─────────────────────────────────────────────
  const server = createServer(async (req, res) => {
    const url = req.url ?? "/";
    const cors = { "Access-Control-Allow-Origin": "*" };
    installSecurityHeaders(req, res, ctx.security);

    const securityDecision = authorizeLocalApiRequest(req, ctx.security);
    if (!securityDecision.ok) {
      writeSecurityError(res, securityDecision);
      return;
    }
    if (isApiPreflight(req)) {
      res.writeHead(204);
      res.end();
      return;
    }

    // favicon — 返回空内容避免控制台 404 报错
    if (url === "/favicon.ico") {
      res.writeHead(200, { "Content-Type": "image/x-icon" });
      res.end();
      return;
    }

    // 图标文件 — 始终从 src/frontend/icons/ 提供
    const reqPath = url.includes("?") ? url.slice(0, url.indexOf("?")) : url;
    if (reqPath.startsWith("/icons/") && reqPath.endsWith(".svg")) {
      try {
        const iconRoot = HAS_BUILT_FRONTEND ? FRONTEND_DIR : FRONTEND_SRC_DIR;
        const iconFile = resolveStaticAssetPath(iconRoot, reqPath);
        const content = readFileSync(iconFile);
        res.writeHead(200, { "Content-Type": "image/svg+xml", "Cache-Control": "max-age=3600" });
        res.end(content);
      } catch {
        res.writeHead(404);
        res.end("Not found");
      }
      return;
    }

    // 静态文件 — 构建产物优先，无则从 src/ 回退
    if (HAS_BUILT_FRONTEND) {
      const filePath = reqPath === "/" ? `/${FRONTEND_ENTRY_FILE}` : reqPath;
      const fullPath = resolveStaticAssetPath(FRONTEND_DIR, filePath);
      if (existsSync(fullPath) && statSync(fullPath).isFile()) {
        const content = readFileSync(fullPath);
        res.writeHead(200, { "Content-Type": contentTypeForStaticAsset(fullPath) });
        res.end(content);
        return;
      }
    } else {
      // 开发模式：从 src/ 直接服务静态文件
      const pathname = url.includes("?") ? url.slice(0, url.indexOf("?")) : url;
      if ((pathname.startsWith("/dashboard") || pathname.startsWith("/ui/") || pathname.startsWith("/pane/") || pathname.startsWith("/service/") || pathname.startsWith("/devicon") || pathname.startsWith("/fonts/") || pathname.startsWith("/devicon-colors") || pathname.startsWith("/icons/") || pathname.startsWith("/core/") || pathname.startsWith("/shell/") || pathname.startsWith("/services/")) && (pathname.endsWith(".css") || pathname.endsWith(".js") || pathname.endsWith(".svg") || pathname.endsWith(".woff") || pathname.endsWith(".woff2"))) {
        const ext = pathname.endsWith(".css") ? "css" : pathname.endsWith(".svg") ? "svg+xml" : pathname.endsWith(".woff") ? "font/woff" : pathname.endsWith(".woff2") ? "font/woff2" : "javascript";
                const isText = ext === "css" || ext === "javascript" || ext === "svg+xml";
                try {
                  const filePath = resolveStaticAssetPath(FRONTEND_SRC_DIR, pathname);
          if (isText) {
            const content = readFileSync(filePath, "utf-8");
            res.writeHead(200, { "Content-Type": `text/${ext}; charset=utf-8` });
            res.end(content);
          } else {
            const content = readFileSync(filePath);
            res.writeHead(200, { "Content-Type": ext });
            res.end(content);
          }
        } catch {
          res.writeHead(404);
          res.end("Not found");
        }
        return;
      }
    }

    // 主页
    if (url === "/" || url === "/index.html") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(getDashboardHTML(ctx));
      return;
    }

    // SSE: 文件变更事件
    if (url === "/api/events" && req.method === "GET") {
      openAppEventStream(req, res, appEvents, cors);
      return;
    }

    // 领域路由分发
    const handled = await dispatchRoute(req, res, ctx);
    if (handled) return;

    // 404
    res.writeHead(404);
    res.end("Not found");
  });

  const devPort = parseInt(process.env.PI_DEV_PORT || "0", 10);
  server.listen(devPort || 0, "127.0.0.1", () => {
    const addr = server.address();
    if (addr && typeof addr === "object") {
      const port = addr.port;
      process.env.SERVER_PORT = String(port);
      void workspaceLock.updatePort(port).then(async () => {
        instanceMetadata.port = port;
        await writeInstanceMetadata(STARTUP.layout.portFile, instanceMetadata);
        console.log(`SERVER_PORT:${port}`);
        mark("http_listening");
        logTiming();
        console.log(`Pi Desktop server: http://127.0.0.1:${port}`);
      }).catch((error) => {
        console.error("Failed to update workspace lock:", error);
        server.close();
        void releaseActiveWorkspaceLock()
          .catch((releaseError) => console.error("Failed to release workspace lock:", releaseError))
          .finally(() => process.exit(1));
      });
    }
    // ─── 文件系统监听 ──────────────────────────────────────────
  });

  let releaseInstancePromise: Promise<void> | null = null;
  const closeInstanceStreams = () => {
    appEvents.closeAll();
    const response = chatStream.response;
    if (!response) return;
    cancelCommandConfirmationsForResponse(response);
    try { response.end(); } catch {}
    if (chatStream.response === response) chatStream.response = null;
  };
  const releaseInstanceResources = (removeRuntimeData: boolean): Promise<void> => {
    if (releaseInstancePromise) return releaseInstancePromise;
    releaseInstancePromise = (async () => {
      closeInstanceStreams();
      unsubscribeMcpEvents();
      unsubscribeWorkspaceWatcher();
      workspaceWatcher.close();
      tsServer.stop();
      try {
        await permissionService.flushAuditWrites();
      } catch (error) {
        console.error("Failed to flush permission audit:", error);
      }
      try {
        await openedWorkspaceRecordTail;
      } catch (error) {
        console.warn("Failed to finish opened workspace recording:", error);
      }
      try {
        await subagentHost.dispose();
      } catch (error) {
        console.error("Failed to dispose subagent host:", error);
      }
      runtime.dispose();
      try {
        await releaseActiveWorkspaceLock();
      } catch (error) {
        console.error("Failed to release workspace lock:", error);
      }
      if (removeRuntimeData) {
        try {
          await removeInstanceRuntimeDirectory(STARTUP.layout.instanceRoot);
        } catch (error) {
          console.error("Failed to remove instance runtime data:", error);
        }
        if (TRANSIENT_EMPTY_WORKSPACE) {
          try {
            await removeInstanceRuntimeDirectory(STARTUP.layout.workspaceRoot);
          } catch (error) {
            console.error("Failed to remove transient workspace data:", error);
          }
        }
      }
    })();
    return releaseInstancePromise;
  };

  server.on("close", () => {
    void releaseInstanceResources(false);
  });
  server.on("error", (error) => {
    console.error("Server error:", error);
    void releaseInstanceResources(false)
      .finally(() => process.exit(1));
  });

  let shuttingDown = false;
  const shutdown = (signal: NodeJS.Signals | "stdin") => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[server] ${signal}, shutting down`);
    closeInstanceStreams();
    server.close();
    void releaseInstanceResources(true).finally(() => process.exit(0));
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    if (String(chunk).split(/\r?\n/).includes("PI_SERVER_SHUTDOWN")) shutdown("stdin");
  });
  if (process.env.PI_ELECTRON_PARENTED === "1") {
    process.stdin.once("end", () => shutdown("stdin"));
    process.stdin.once("close", () => shutdown("stdin"));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(async (err) => {
    console.error("Fatal error:", err);
    try {
      await releaseActiveWorkspaceLock();
    } catch (releaseError) {
      console.error("Failed to release workspace lock:", releaseError);
    }
    process.exitCode = 1;
  });
}

// ═══════════════════════════════════════════════════════════════════
//  HTML TEMPLATE — 从独立文件读取
// ═══════════════════════════════════════════════════════════════════

function getDashboardHTML(ctx: ServerContext): string {
  if (ctx.paths.HAS_BUILT_FRONTEND) {
    return readFileSync(resolve(ctx.paths.FRONTEND_DIR, FRONTEND_ENTRY_FILE), "utf-8");
  }
  return readFileSync(
    resolve(dirname(fileURLToPath(import.meta.url)), "..", "frontend", "dashboard.html"),
    "utf-8"
  );
}
