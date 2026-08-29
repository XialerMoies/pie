/**
 * My Code Agent — Pi 服务器
 * 作为子进程运行，通过 HTTP 提供仪表盘和对话 API
 *
 * 环境变量：
 *   PI_WORKSPACE       - initial workspace
 *   PI_DATA_ROOT       - persistent data root
 *   PI_INSTANCE_ID     - per-launch instance id
 */
import { initAgentHost, type AgentRuntime } from "../agent/index.js";
import type { AgentEngine } from "../agent-engine/index.js";
import { resolve, dirname, join } from "path";
import { fileURLToPath, pathToFileURL } from "url";
import { writeFileSync, existsSync, mkdirSync } from "fs";
import { cancelCommandConfirmationsForResponse, createCommandConfirmCallback, createPlanExitConfirmCallback } from "./routes/chat.js";
import type { ChatStreamState } from "./routes/types.js";
import { TsserverManager } from "./ts-server.js";
import { mark, logTiming } from "./timing.js";
import { preferredShellDialect } from "../agent/tools/command/shell-parser.js";
import { createSessionPermissionState } from "../agent/permissions.js";
import {
  cleanupStaleInstanceDirectories,
  clearDesktopSessionTokenEnv,
  createDesktopSecurityConfig,
  removeInstanceRuntimeDirectory,
  writeInstanceMetadata,
  type InstanceMetadata,
} from "./security.js";
import { ServerPermissionService } from "./permission-service.js";
import { cancelPermissionConfirmationsForResponse, createPermissionConfirmCallback } from "./permission-confirmation.js";
import { FilePermissionAuditStore } from "./permission-audit-store.js";
import { FileWorkspacePermissionRuleStore } from "./permission-rule-store.js";
import { RootRegistry } from "./root-registry.js";
import { createPermissionModeController } from "./permission-mode.js";
import { AppEventHub } from "./app-events.js";
import { WorkspaceFileWatcher } from "./workspace-file-watcher.js";
import { mcpHostIntegrationProvider } from "../agent/mcp/MCPClientService.js";
import { resolveStartupPaths, startupPathsSnapshot } from "./startup-paths.js";
import { canonicalWorkspacePath } from "../data/data-layout.js";
import {
  readUserPreferences,
  readUserPreferencesStrict,
  readUserSettingsStrict,
  recordOpenedWorkspace,
} from "../data/user-settings.js";
import { readSubagentDefinitions, readSubagentDefinitionsStrict } from "../data/subagent-config.js";
import { WorkspaceLockCoordinator } from "./workspace-lock.js";
import { workspaceDataPaths, writeWorkspaceMetadata } from "./routes/session-dir.js";
import { readWorkspaceUiState } from "./routes/ui-state.js";
import {
  createSubagentDelegationBridge,
  createRuntimeSubagentHost,
  type SubagentDelegationHost,
} from "./subagent-delegation.js";
import { createSubagentEventSink } from "./subagent-events.js";
import { authorizeExecutionContractAttempt } from "./task-lifecycle.js";
import { CustomProviderStore } from "../model-provider/custom-provider-store.js";
import { PiCustomProviderAdapter } from "../model-provider/pi-custom-provider-adapter.js";
import { CustomProviderRuntimeCoordinator } from "../model-provider/runtime-coordinator.js";
import { ProviderReferenceChecker } from "../model-provider/provider-reference-checker.js";
import { CustomProviderService } from "../model-provider/custom-provider-service.js";
import { FileProviderReferenceMutationLock } from "../model-provider/provider-reference-lock.js";
import { StructuredLogger, ToolOutcomeMetrics, createToolOutcomeObserver } from "./observability.js";
import { EvidenceLedger } from "./evidence-ledger.js";
import { CorrelationLedger } from "./correlation.js";
import { createServerContext } from "./server-bootstrap.js";
import { createHttpApp, openAppEventStream } from "./http-app.js";
export { openAppEventStream } from "./http-app.js";
import { createServerLifecycle } from "./server-lifecycle.js";
import { SkillService } from "../agent/skills/skill-service.js";
import { toolRegistry } from "../agent/tools/index.js";
import { assertProfileCatalogsReady } from "../agent/profile-catalog.js";
import { setLocalApiToken } from "../agent/tools/local-api.js";
import { capabilityComponentManager } from "../agent/capability-components.js";
import { createPermissionEvaluatorProvider } from "../agent/capability-contracts.js";

import { attachEngineEvents, recordUserNoteBlock } from "./agent-event-router.js";
export { attachEngineEvents, emitBlock, emitTrace, flushPendingBlockPersist, flushPendingTracePersist, nextBlockSeq, persistBlockEvent, persistTaskLifecycle, persistTraceEvent, recordUserNoteBlock, tagSessionHeader } from "./agent-event-router.js";
export { writePresentationEvent } from "./presentation-events.js";

export function attachMcpEvents(appEvents: Pick<AppEventHub, "publish">): () => void {
  const toolsKey = (snapshot: ReturnType<typeof mcpHostIntegrationProvider.getServersStatus>): string => JSON.stringify(
    snapshot
      .map((status) => ({ name: status.name, tools: status.tools }))
      .sort((left, right) => left.name.localeCompare(right.name)),
  );
  let previousTools = toolsKey(mcpHostIntegrationProvider.getServersStatus());
  return mcpHostIntegrationProvider.subscribeStatusChanges((snapshot) => {
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
  const startedAt = Date.now();
  assertProfileCatalogsReady();
  const logger = new StructuredLogger({
    filePath: join(STARTUP.layout.instanceRoot, "server.log.jsonl"),
  });
  const toolOutcomeMetrics = new ToolOutcomeMetrics();
  toolOutcomeMetrics.setExpectedTools(toolRegistry.getAll().map((tool) => tool.name));
  const evidenceLedger = new EvidenceLedger({
    filePath: join(STARTUP.layout.instanceRoot, "evidence-ledger.jsonl"),
  });
  const correlationLedger = new CorrelationLedger({ maxEntries: 1024 });
  const observability = {
    logger,
    appVersion: process.env.npm_package_version || "0.1.0",
    startedAt,
    toolOutcomeMetrics,
    evidenceLedger,
    correlationLedger,
  };
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
  await capabilityComponentManager.restore(join(PI_CONFIG_DIR, "component-state.json"));
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
  const chatStream: ChatStreamState = { textBuffer: "", thinkingBuffer: "", currentTextSnapshot: "", currentThinkingSnapshot: "", response: null, turnId: "", traceId: "", traceSeq: 0, emittedTraces: new Set(), blocks: [], blockSeq: 0, eventSeq: 0, eventHistory: [], correlationLedger };
  const appEvents = new AppEventHub();
  appEvents.subscribeClientRemoved(cancelPermissionConfirmationsForResponse);
  const unsubscribeMcpEvents = attachMcpEvents(appEvents);
  const sessionPermissionState = createSessionPermissionState();
  let runtime: AgentRuntime;
  let engine: AgentEngine;
  let subagentHost: SubagentDelegationHost;
  const subagentBridge = createSubagentDelegationBridge();
  // createDesktopSecurityConfig keeps the Vite cookie name stable across hot
  // reloads while retaining instance isolation for packaged windows.
  const security = createDesktopSecurityConfig(undefined, STARTUP.instanceId);
  setLocalApiToken(security.token);
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
  // Permission remains a host-owned service, outside the three replacement slots.
  const permissionEvaluator = createPermissionEvaluatorProvider(permissionService);
  const permissionMode = createPermissionModeController("standard", (mode) => {
    permissionService.recordPermissionModeChange(mode, "permissions.mode");
  });
  const planExitConfirm = createPlanExitConfirmCallback(chatStream);

  const customProviderStore = new CustomProviderStore({
    configFile: STARTUP.layout.customProvidersFile,
    secretsFile: STARTUP.layout.customProviderSecretsFile,
  });
  const customProviderAdapter = new PiCustomProviderAdapter();
  const customProviderCoordinator = new CustomProviderRuntimeCoordinator({
    store: customProviderStore,
    adapter: customProviderAdapter,
  });
  const providerReferenceLock = new FileProviderReferenceMutationLock(
    STARTUP.layout.providerReferenceLockFile,
    { instanceId: STARTUP.instanceId },
  );
  const providerReferenceChecker = new ProviderReferenceChecker({
    currentModel: () => {
      const model = engine?.session.model;
      return model ? { provider: model.provider, id: model.id } : undefined;
    },
    defaultModel: () => {
      const settings = readUserSettingsStrict(SETTINGS_FILE);
      const preferences = readUserPreferencesStrict(SETTINGS_FILE);
      const provider = settings.defaultProvider ?? preferences.defaultProvider;
      const id = settings.defaultModel ?? preferences.defaultModel;
      return provider && id ? { provider, id } : undefined;
    },
    customAgents: () => readSubagentDefinitionsStrict(SUBAGENTS_FILE),
  });
  const customProviderService = new CustomProviderService({
    store: customProviderStore,
    coordinator: customProviderCoordinator,
    referenceChecker: providerReferenceChecker,
    referenceLock: providerReferenceLock,
  });
  const skillService = new SkillService({
    userRoot: join(PI_CONFIG_DIR, "skills"),
    workspaceRoot: () => join(runtime?.currentWorkspace || STARTUP.workspace, "agent", "skills"),
    statePath: join(PI_CONFIG_DIR, "skill-state.json"),
    knownTools: new Set(toolRegistry.getAll().map((tool) => tool.name)),
  });

  ({ runtime, engine } = await initAgentHost({
    agentDir: PI_CONFIG_DIR,
    cwd: STARTUP.workspace,
    userMemoryRoot: join(PI_CONFIG_DIR, "memory"),
    sessionsDir: SESSIONS_DIR,
    sessionsDirForWorkspace: (workspace) => workspaceDataPaths(DATA_DIR, workspace).sessionsDir,
    authFile: STARTUP.layout.authFile,
    modelsFile: STARTUP.layout.modelsFile,
    syncModelProviders: modelRuntime => customProviderService.syncRuntime(modelRuntime),
    getPermissionMode: () => permissionMode.get(),
    getPlanState: () => runtime?.planState,
    enterPlanMode: (reason) => runtime.enterPlanMode(reason),
    requestPlanExit: (summary) => runtime.requestPlanExit(summary, ({ requestId, summary: planSummary }) => planExitConfirm({ requestId, summary: planSummary })),
    shellDialect: preferredShellDialect(),
    confirmCommand: createCommandConfirmCallback(chatStream),
    desktopApiToken: security.token,
    sessionPermissionState,
    authorizePath: (root, target, operation, source) => permissionEvaluator.authorizePath(root, target, operation, source),
    authorizeTool: (request) => permissionEvaluator.authorizeTool(request),
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
    toolOutcomeObserver: createToolOutcomeObserver(toolOutcomeMetrics, logger, evidenceLedger, correlationLedger),
    getCorrelationContext: () => chatStream.correlation ? { ...chatStream.correlation } : undefined,
    toolOutcomeSource: "live",
    evidenceLookup: (toolName, scope) => evidenceLedger.lookup(toolName, scope),
    getExecutionContract: () => chatStream.taskRequirements?.contract,
    authorizeExecutionContract: (toolName, _input, scope) => {
      const contract = chatStream.taskRequirements?.contract;
      const attempts = chatStream.executionContractAttempts || (chatStream.executionContractAttempts = new Set());
      const metrics = chatStream.executionPolicyMetrics || (chatStream.executionPolicyMetrics = { unrelatedAttempts: 0, blockedAttempts: 0 });
      const progress = chatStream.executionContractProgress || (chatStream.executionContractProgress = new Map());
      return authorizeExecutionContractAttempt(contract, chatStream.taskLifecycle, attempts, toolName, scope, metrics, progress);
    },
    skillService,
  }));

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

  // TypeScript language service starts lazily, but its owner is fixed at bootstrap.
  const tsServer = new TsserverManager();

  const baseCtx = createServerContext({
    engine,
    runtime,
    chatStream,
    appEvents,
    security,
    permissionService,
    permissionMode,
    workspaceLock,
    customProviderService,
    providerReferenceLock,
    observability,
    skillService,
    tsServer,
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
  });

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

  attachEngineEvents(engine, runtime, chatStream, baseCtx);

  // ─── HTTP 服务器 ─────────────────────────────────────────────
  const server = createHttpApp({
    ctx: baseCtx,
    logger,
    frontendDir: FRONTEND_DIR,
    frontendSourceDir: FRONTEND_SRC_DIR,
    hasBuiltFrontend: HAS_BUILT_FRONTEND,
    appEvents,
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

  createServerLifecycle({
    server,
    appEvents,
    chatStream,
    cancelResponseConfirmations: cancelCommandConfirmationsForResponse,
    unsubscribeMcpEvents,
    unsubscribeWorkspaceWatcher,
    workspaceWatcher,
    tsServer,
    flushPermissionAudit: () => permissionService.flushAuditWrites(),
    logger,
    awaitOpenedWorkspaceRecords: () => openedWorkspaceRecordTail,
    disposeSubagentHost: () => Promise.resolve(subagentHost.dispose()),
    disposeEngine: () => Promise.resolve(engine.dispose()),
    releaseWorkspaceLock: releaseActiveWorkspaceLock,
    removeRuntimeData: async () => {
      try { await removeInstanceRuntimeDirectory(STARTUP.layout.instanceRoot); }
      catch (error) { console.error("Failed to remove instance runtime data:", error); }
      if (TRANSIENT_EMPTY_WORKSPACE) {
        try { await removeInstanceRuntimeDirectory(STARTUP.layout.workspaceRoot); }
        catch (error) { console.error("Failed to remove transient workspace data:", error); }
      }
    },
    electronParented: process.env.PI_ELECTRON_PARENTED === "1",
  });
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
