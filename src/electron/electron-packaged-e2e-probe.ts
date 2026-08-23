import * as fs from "fs";
import * as path from "path";
import type { BrowserWindow } from "electron";
import {
  createElectronE2EFailureDiagnostic,
  sanitizeE2EReopenError,
  type ElectronE2EReopenErrorDiagnostic,
} from "./e2e-diagnostics.js";
import type { createElectronE2ERuntime } from "./electron-e2e-runtime.js";
import {
  capturePackagedFailureEvidence,
  collectRendererE2EResult,
  runPackagedCancellationProbe,
  runPackagedConcurrencyProbe,
  runPackagedReplayProviderProbe,
  runPackagedChatEventFlowProbe,
  runRendererCookieIsolationProbe,
  waitForRendererReady,
} from "./electron-e2e-renderer-probe.js";
import { requestJson, requestStatus, waitForServerOrigin } from "./electron-http-client.js";
import type { SecondInstanceRecord } from "./electron-launch-coordinator.js";
import type { ServerBinding } from "./server-binding.js";
import type { WindowContext, WorkspaceOpenAction } from "./window-manager.js";

type ElectronE2ERuntime = ReturnType<typeof createElectronE2ERuntime>;

function collectSanitizedSessionEvidence(root: string): Record<string, unknown>[] {
  const records: Record<string, unknown>[] = [];
  const visit = (directory: string): void => {
    let entries: fs.Dirent[] = [];
    try { entries = fs.readdirSync(directory, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(target);
      else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        let lines: string[] = [];
        try { lines = fs.readFileSync(target, "utf8").split(/\r?\n/u).filter(Boolean); } catch { continue; }
        for (const [line, raw] of lines.entries()) {
          try {
            const value = JSON.parse(raw) as Record<string, any>;
            const block = value.block && typeof value.block === "object" ? value.block : null;
            records.push({
              file: path.relative(root, target).replaceAll("\\", "/"),
              line: line + 1,
              type: typeof value.type === "string" ? value.type : null,
              role: typeof value.role === "string" ? value.role : null,
              turnId: typeof value.turnId === "string" ? value.turnId : null,
              block: block ? {
                type: typeof block.type === "string" ? block.type : null,
                status: typeof block.status === "string" ? block.status : null,
                blockId: typeof block.blockId === "string" ? block.blockId : null,
                seq: Number.isFinite(block.seq) ? block.seq : null,
                toolCallId: typeof block.toolCallId === "string" ? block.toolCallId : null,
              } : null,
            });
          } catch {
            records.push({ file: path.relative(root, target).replaceAll("\\", "/"), line: line + 1, type: "invalid_json" });
          }
        }
      }
    }
  };
  visit(root);
  return records.slice(-4_096);
}

interface PackagedE2EWindowManager {
  openWorkspace(context: WindowContext, workspace: string): Promise<WorkspaceOpenAction>;
}

interface ElectronPackagedE2EProbeOptions {
  enabled: boolean;
  packaged: boolean;
  electronPid: number;
  startup: object;
  dataRoot: string;
  e2eDataRoot: string | null;
  initialContext(): WindowContext | null;
  initialServerBinding(): ServerBinding;
  createEmptyManagedWindow(): WindowContext;
  windowManager: PackagedE2EWindowManager;
  e2eRuntime: ElectronE2ERuntime;
  secondLaunchRecords(): readonly SecondInstanceRecord[];
  ensureDir(directory: string): void;
  getFocusedWindow(): BrowserWindow | null;
  getAllWindows(): readonly BrowserWindow[];
  quit(): void;
}

async function waitForE2ECondition(
  description: string,
  predicate: () => boolean,
  timeoutMs = 30_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 25));
  }
  throw new Error(`Timed out waiting for E2E condition: ${description}`);
}

export function createElectronPackagedE2EProbe(options: ElectronPackagedE2EProbeOptions) {
  let started = false;

  async function run(win: BrowserWindow): Promise<void> {
    if (!options.enabled || started) return;
    started = true;
    const initialServerBinding = options.initialServerBinding();
    let renderer: Record<string, unknown> | null = null;
    let chatEventFlow: Record<string, unknown> | null = null;
    let cancellation: Record<string, unknown> | null = null;
    let concurrency: Record<string, unknown> | null = null;
    let replayProvider: Record<string, unknown> | null = null;
    let rendererFailureEvidence: Record<string, unknown> | null = null;
    try {
      await waitForRendererReady(win);
      const origin = await waitForServerOrigin(initialServerBinding);
      if (!origin) {
        throw new Error("E2E probe failed to wait for server origin (initialServerBinding.origin is empty)");
      }
      const e2eRoot = options.e2eDataRoot || options.dataRoot;
      const projectA = path.join(e2eRoot, "project-a");
      const projectB = path.join(e2eRoot, "project-b");
      const siblingWorkspace = path.join(e2eRoot, "project-a-sibling");
      const externalRoot = path.join(path.dirname(e2eRoot), "external");
      options.ensureDir(projectA);
      options.ensureDir(projectB);
      options.ensureDir(siblingWorkspace);
      options.ensureDir(externalRoot);
      fs.writeFileSync(path.join(e2eRoot, "read.txt"), "packaged-read", "utf-8");
      fs.writeFileSync(path.join(projectA, "read.txt"), "workspace-read", "utf-8");
      fs.writeFileSync(path.join(projectA, "index.ts"), "const answer: number = 1;\n", "utf-8");
      fs.writeFileSync(path.join(projectB, "read.txt"), "workspace-b-read", "utf-8");
      fs.writeFileSync(path.join(externalRoot, "read.txt"), "external-read", "utf-8");
      fs.writeFileSync(path.join(externalRoot, ".env"), "SECRET=e2e", "utf-8");
      fs.writeFileSync(path.join(externalRoot, "ipc.txt"), "ipc-outside", "utf-8");
      fs.writeFileSync(path.join(siblingWorkspace, "read.txt"), "sibling-read", "utf-8");

      renderer = await collectRendererE2EResult(win, path.join(externalRoot, "ipc.txt"));
      chatEventFlow = await runPackagedChatEventFlowProbe(win);
      cancellation = await runPackagedCancellationProbe(win);
      concurrency = await runPackagedConcurrencyProbe(win);
      replayProvider = await runPackagedReplayProviderProbe(win);
      // Capture while the replay turn and its correlation ledger still belong
      // to the active server. Later workspace switches intentionally replace
      // that server and would erase the failure-local protocol evidence.
      rendererFailureEvidence = await capturePackagedFailureEvidence(win);
      if (process.env.MY_CODE_AGENT_E2E_EXPECT_FAILURE_ARTIFACT === "1") {
        throw Object.assign(new Error("Injected packaged artifact failure"), { code: "E2E_ARTIFACT_PROBE" });
      }
      const textIconStatus = await requestStatus(`${origin}/icons/file_type_text.svg`);
      const unauthorizedApiStatus = await requestStatus(`${origin}/api/dashboard`);
      const wrongTokenApi = await requestJson(initialServerBinding, "/api/dashboard", "GET", undefined, {
        headers: { "X-My-Code-Agent-Token": "forged-token" },
      });
      const hostileOriginApi = await requestJson(initialServerBinding, "/api/dashboard", "GET", undefined, {
        headers: { Origin: "https://evil.example" },
      });
      const crossSiteApi = await requestJson(initialServerBinding, "/api/dashboard", "GET", undefined, {
        headers: { "Sec-Fetch-Site": "cross-site" },
      });
      const unauthorizedMutationPath = path.join(e2eRoot, "unauthorized-write.txt");
      const unauthorizedMutation = await requestJson(initialServerBinding, "/api/file/write", "POST", {
        root: e2eRoot,
        path: "unauthorized-write.txt",
        content: "must-not-exist",
      }, { includeToken: false });

      const fileRead = await requestJson(
        initialServerBinding,
        `/api/file/read?root=${encodeURIComponent(e2eRoot)}&path=read.txt`,
      );
      const fileWrite = await requestJson(initialServerBinding, "/api/file/write", "POST", {
        root: e2eRoot,
        path: "write.txt",
        content: "packaged-write",
      });
      const externalRead = await requestJson(
        initialServerBinding,
        `/api/file/read?root=${encodeURIComponent(externalRoot)}&path=read.txt`,
      );
      let sensitiveExternalReadBlocked = false;
      try {
        const sensitiveExternalRead = await requestJson(
          initialServerBinding,
          `/api/file/read?root=${encodeURIComponent(externalRoot)}&path=${encodeURIComponent(".env")}`,
          "GET",
          undefined,
          { timeoutMs: 1_000 },
        );
        sensitiveExternalReadBlocked = sensitiveExternalRead.status !== 200;
      } catch (error) {
        sensitiveExternalReadBlocked = error instanceof Error && error.message.includes("timed out");
      }
      const persistedPreferences = await requestJson(initialServerBinding, "/api/preferences");

      const contextA = options.initialContext();
      if (!contextA) throw new Error("Initial Electron context is unavailable");
      const projectASelectedAt = Date.now();
      await options.windowManager.openWorkspace(contextA, projectA);
      const workspaceRead = await requestJson(
        contextA.server,
        `/api/file/read?root=${encodeURIComponent(projectA)}&path=read.txt`,
        "GET",
        undefined,
      );
      const pathTraversal = await requestJson(
        contextA.server,
        `/api/file/read?root=${encodeURIComponent(projectA)}&path=${encodeURIComponent("../read.txt")}`,
        "GET",
        undefined,
      );
      const siblingTraversal = await requestJson(
        contextA.server,
        `/api/file/read?root=${encodeURIComponent(projectA)}&path=${encodeURIComponent("../project-a-sibling/read.txt")}`,
        "GET",
        undefined,
      );

      const contextB = options.createEmptyManagedWindow();
      await waitForE2ECondition("empty B shell to become visible", () => (
        options.e2eRuntime.latestTiming(contextB, "shell-visible") !== null
      ));
      const shellCreatedAt = options.e2eRuntime.latestTiming(contextB, "window-created");
      const shellVisibleAt = options.e2eRuntime.latestTiming(contextB, "shell-visible");
      if (shellCreatedAt === null || shellVisibleAt === null) {
        throw new Error("Empty B shell timing was not recorded");
      }

      const serverChildCountBefore = options.e2eRuntime.countOwnedServerChildren();
      const projectAWindow = contextA.window as BrowserWindow;
      if (options.enabled && !projectAWindow.isVisible()) projectAWindow.show();
      let focusObserved = false;
      const observeFocus = () => { focusObserved = true; };
      projectAWindow.on("focus", observeFocus);
      let duplicateAction: WorkspaceOpenAction;
      try {
        duplicateAction = await options.windowManager.openWorkspace(contextB, projectA);
        await waitForE2ECondition("existing project A window focus", () => (
          focusObserved
            || projectAWindow.isFocused()
            || options.getFocusedWindow() === projectAWindow
        ));
      } finally {
        projectAWindow.off("focus", observeFocus);
      }
      const focusedWindow = options.getFocusedWindow();
      const focusedContextId = focusedWindow === projectAWindow && projectAWindow.isFocused()
        ? contextA.id
        : null;
      const duplicateWorkspace = {
        focusedContextId,
        action: duplicateAction,
        attemptedContextId: contextB.id,
        emptyContextId: contextB.id,
        serverKindAfter: contextB.server.kind,
        workspaceAfter: contextB.workspace,
        windowCount: options.getAllWindows().length,
        serverChildCountBefore,
        serverChildCountAfter: options.e2eRuntime.countOwnedServerChildren(),
      };

      const workspaceSelectedAt = Date.now();
      const projectBAction = await options.windowManager.openWorkspace(contextB, projectB);
      const projectBLoadedAt = options.e2eRuntime.latestTiming(contextB, "workbench-loaded");
      if (projectBLoadedAt === null) throw new Error("Project B workbench timing was not recorded");
      const rendererCookieIsolation = await runRendererCookieIsolationProbe(
        contextA.window as BrowserWindow,
        contextB.window as BrowserWindow,
      );

      const projectALoadedAtBefore = options.e2eRuntime.latestTiming(contextA, "workbench-loaded");
      const projectBLoadedAtBeforeCrash = projectBLoadedAt;
      const crashedChild = contextB.server.process;
      const serverPidBefore = crashedChild?.pid || null;
      if (!crashedChild?.pid || !crashedChild.kill()) {
        throw new Error("Could not crash project B server child");
      }
      await waitForE2ECondition("project B server recovery", () => (
        !!contextB.server.process?.pid
          && contextB.server.process.pid !== serverPidBefore
          && contextB.server.port > 0
          && (options.e2eRuntime.latestTiming(contextB, "workbench-loaded") || 0) > projectBLoadedAtBeforeCrash
      ));
      const serverPidAfter = contextB.server.process?.pid || null;
      const projectALoadedAtAfter = options.e2eRuntime.latestTiming(contextA, "workbench-loaded");
      const projectADashboardAfterCrash = await requestJson(
        contextA.server,
        "/api/dashboard",
        "GET",
        undefined,
      );

      const closingChild = contextB.server.process;
      (contextB.window as BrowserWindow).close();
      const reopenedB = options.createEmptyManagedWindow();
      let reopenAction: WorkspaceOpenAction | null = null;
      let reopenError: ElectronE2EReopenErrorDiagnostic | null = null;
      try {
        reopenAction = await options.windowManager.openWorkspace(reopenedB, projectB);
      } catch (error) {
        reopenError = sanitizeE2EReopenError(error);
      }
      await waitForE2ECondition("closed B context disposal", () => (
        contextB.lifecycle === "closed"
          && contextB.server.process === null
      ));
      const closedServerExited = contextB.lifecycle === "closed" && contextB.server.process === null;
      const projectADashboardAfterClose = await requestJson(
        contextA.server,
        "/api/dashboard",
        "GET",
        undefined,
      );

      options.e2eRuntime.writeResult({
        state: "awaiting-second-launch",
        electronPid: options.electronPid,
        launch: {
          workspace: projectA,
          dataRoot: options.dataRoot,
          instanceId: "e2e-second-executable-launch",
        },
      });
      await waitForE2ECondition("second executable single-instance handoff", () => (
        options.secondLaunchRecords().some((launch) => launch.request.instanceId === "e2e-second-executable-launch")
      ));
      const secondLaunch = options.secondLaunchRecords().find((launch) => (
        launch.request.instanceId === "e2e-second-executable-launch"
      ));
      if (!secondLaunch) throw new Error("Second executable handoff diagnostic is missing");

      const diagnostics = options.e2eRuntime.snapshot([contextA, reopenedB]);
      const artifactProbe = {
        failure: { code: "injected_settled_failure", message: "Injected settled-state artifact probe" },
        ...rendererFailureEvidence,
        session: collectSanitizedSessionEvidence(e2eRoot),
        consoleNetwork: {
          diagnostics: options.e2eRuntime.diagnostics,
          requests: (concurrency as { requestRecords?: unknown })?.requestRecords || [],
        },
      };
      options.e2eRuntime.writeResult({
        ok: true,
        packaged: options.packaged,
        STARTUP: options.startup,
        ...diagnostics,
        renderer,
        chatEventFlow,
        concurrency,
        replayProvider,
        cancellation,
        artifactProbe,
        textIconStatus,
        unauthorizedApiStatus,
        wrongTokenApiStatus: wrongTokenApi.status,
        hostileOriginApiStatus: hostileOriginApi.status,
        crossSiteApiStatus: crossSiteApi.status,
        unauthorizedMutationStatus: unauthorizedMutation.status,
        unauthorizedMutationCreated: fs.existsSync(unauthorizedMutationPath),
        fileReadStatus: fileRead.status,
        fileWriteStatus: fileWrite.status,
        externalReadStatus: externalRead.status,
        sensitiveExternalReadBlocked,
        persistedPreferences,
        workspaceReadStatus: workspaceRead.status,
        pathTraversalStatus: pathTraversal.status,
        siblingTraversalStatus: siblingTraversal.status,
        acceptance: {
          workspaceA: projectA,
          workspaceB: projectB,
          projectASelectedAt,
          projectBAction,
          duplicateWorkspace,
          crashIsolation: {
            serverPidBefore,
            serverPidAfter,
            projectALoadedAtBefore,
            projectALoadedAtAfter,
            projectADashboardStatus: projectADashboardAfterCrash.status,
          },
          closeReopen: {
            closedServerPid: closingChild?.pid || null,
            closedServerExited,
            projectADashboardStatus: projectADashboardAfterClose.status,
            reopenAction,
            reopenError,
            windowCount: options.getAllWindows().length,
          },
          rendererCookieIsolation,
          secondLaunch: {
            electronPid: secondLaunch.electronPid,
            handledAt: secondLaunch.handledAt,
            windowCount: options.getAllWindows().length,
          },
          timing: {
            shellContextId: contextB.id,
            workspaceContextId: contextB.id,
            workspaceSelectedAt,
            shellVisibleMs: shellVisibleAt - shellCreatedAt,
            workbenchLoadedMs: projectBLoadedAt - workspaceSelectedAt,
          },
        },
      });
    } catch (error) {
      const snapshot = options.e2eRuntime.failureSnapshot();
      const redactions = options.e2eRuntime.failureRedactions();
      let rendererEvidence: Record<string, unknown> = rendererFailureEvidence || {};
      if (!rendererFailureEvidence) {
        try { rendererEvidence = await capturePackagedFailureEvidence(win); } catch { /* renderer may already be gone */ }
      }
      const failureDiagnostic = createElectronE2EFailureDiagnostic({
        error,
        diagnostics: options.e2eRuntime.diagnostics,
        snapshot,
        ...redactions,
      });
      options.e2eRuntime.writeResult({
        ok: false,
        ...failureDiagnostic,
        failureEvidence: {
          ...rendererEvidence,
          session: collectSanitizedSessionEvidence(options.e2eDataRoot || options.dataRoot),
          consoleNetwork: {
            diagnostics: failureDiagnostic.diagnostics,
            requests: (concurrency as { requestRecords?: unknown } | null)?.requestRecords || [],
          },
          settled: { renderer, chatEventFlow, cancellation, concurrency, replayProvider },
        },
        secondLaunches: options.secondLaunchRecords().map((launch) => ({
          electronPid: launch.electronPid,
          handledAt: launch.handledAt,
          instanceId: launch.request.instanceId || null,
          hasWorkspace: !!launch.request.workspace,
        })),
        windowCount: options.getAllWindows().length,
      });
    } finally {
      options.quit();
    }
  }

  return { run };
}
