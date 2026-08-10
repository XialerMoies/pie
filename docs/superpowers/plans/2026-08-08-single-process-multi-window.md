# Single-Process Multi-Window Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace one-Electron-process-per-window launching with one Electron main process that creates multiple immediate shells, while each bound project window retains an independent server child process and `AgentRuntime`.

**Architecture:** A process-wide bootstrap owns the shared Chromium profile and data root. `WindowManager` owns a `WindowContext` per `BrowserWindow`; each context has a `none`, `external`, or `owned` server binding. Desktop IPC resolves the caller through `event.sender.id`, and workspace ownership is coordinated before an owned server is started.

**Tech Stack:** Electron 39, Node.js/TypeScript, child processes, loopback HTTP, IPC/preload, existing data-layout and workspace-lock services, Node test runner, packaged Electron E2E.

---

## Scope and Existing Worktree

- Preserve the uncommitted startup-performance changes currently present in `src/electron/electron-main.ts` and `test/desktop-auth-bootstrap.test.mjs`; read and integrate them instead of reverting them.
- Preserve one server process and one `AgentRuntime` per project window.
- Keep the primary development window on Vite plus the external server from `scripts/dev.mjs`.
- Secondary development windows load from their owned servers without Vite HMR.
- Do not add a server prewarm pool or a multi-runtime server.

## File Structure

### New production units

- `src/electron/desktop-bootstrap.ts`: process-wide data-root, shared Chromium paths, and second-launch parsing.
- `src/electron/server-binding.ts`: owned/external/none server lifecycle and process supervision.
- `src/electron/window-manager.ts`: window contexts, workspace index, shell navigation, binding/switching, and disposal.
- `src/electron/window-shell.html`: local shell markup and CSP.
- `src/electron/window-shell.css`: shell/titlebar/menu/loading/error layout.
- `src/electron/window-shell.ts`: shell interaction and status-event rendering.

### Modified production units

- `src/electron/electron-main.ts`: composition root, single-instance ownership, context creation, E2E probe wiring.
- `src/electron/desktop-ipc.ts`: sender-context routing and separate workspace-open/folder-picker channels.
- `src/electron/preload.ts`: context-scoped token, workspace open, pure folder selection, and shell-status APIs.
- `src/frontend/dashboard/dashboard-menus.ts`: delegate workspace opening to Electron instead of `/api/workspace/switch`.
- `src/frontend/dashboard/dashboard-settings.ts`: use the pure folder selector for storage location.
- `src/frontend/dashboard.d.ts`: new preload result and event types.
- `src/server/server.ts`: parent-pipe shutdown for Electron-owned servers.
- `scripts/compile-preload.mjs`: build/copy local shell assets.
- `scripts/dev.mjs`: pass the external server port and watch new Electron modules/assets.
- `package.json`: register focused unit tests.

### Tests

- Create `test/desktop-bootstrap.test.mjs`.
- Create `test/server-binding.test.mjs`.
- Create `test/window-manager.test.mjs`.
- Create `test/window-shell.test.mjs`.
- Modify `test/desktop-ipc.test.mjs`.
- Modify `test/workspace-ui.test.mjs`.
- Modify `test/multi-instance-launch.test.mjs`.
- Modify `test/desktop-auth-bootstrap.test.mjs`.
- Modify `test/packaged-electron.e2e.mjs`.

---

### Task 1: Establish process-wide desktop bootstrap and single-instance ownership

**Files:**
- Create: `src/electron/desktop-bootstrap.ts`
- Create: `test/desktop-bootstrap.test.mjs`
- Modify: `src/electron/electron-main.ts`
- Modify: `test/server-startup-paths.test.mjs`
- Modify: `package.json`

- [ ] **Step 1: Write failing bootstrap path tests.**

Cover a stable shared Chromium path, a stable shared cache path, preservation of the OS bootstrap pointer, and rejection of a second-launch data root that differs from the active process root.

```ts
const paths = resolveDesktopProcessPaths({
  osUserData: "C:/Users/test/AppData/Roaming/MyCodeAgent",
  runtimeRoot: "E:/my-code-agent",
  configuredDataRoot: "E:/agent-data",
});
assert.equal(paths.dataRootPointerFile, resolve("C:/Users/test/AppData/Roaming/MyCodeAgent/data-root.json"));
assert.equal(paths.electronUserData, resolve("E:/agent-data/electron-user-data"));
assert.equal(paths.electronCache, resolve("E:/agent-data/cache/electron"));
assert.throws(
  () => validateSecondLaunchDataRoot("E:/agent-data", "D:/other-data"),
  /already running with data root/i,
);
```

- [ ] **Step 2: Run the test and verify the expected failure.**

```powershell
node scripts/tsx-test.mjs --test --test-concurrency=1 test/desktop-bootstrap.test.mjs
```

Expected: fail because `desktop-bootstrap.ts` does not exist.

- [ ] **Step 3: Implement the pure bootstrap contract.**

Export these APIs with canonical path comparison on Windows:

```ts
export interface DesktopProcessPaths {
  dataRoot: string;
  dataRootPointerFile: string;
  electronUserData: string;
  electronCache: string;
  userRoot: string;
}

export function resolveDesktopProcessPaths(options: {
  osUserData: string;
  runtimeRoot: string;
  configuredDataRoot?: string;
}): DesktopProcessPaths;

export function validateSecondLaunchDataRoot(activeDataRoot: string, requested?: string): void;
```

The OS path contains only `data-root.json`; `electronUserData` and `electronCache` are stable children of the selected data root.

- [ ] **Step 4: Verify RED turns GREEN.**

```powershell
node scripts/tsx-test.mjs --test --test-concurrency=1 test/desktop-bootstrap.test.mjs
```

- [ ] **Step 5: Write failing source-wiring assertions.**

In `test/server-startup-paths.test.mjs`, assert that Electron calls:

```ts
app.setPath("userData", DESKTOP_PATHS.electronUserData);
app.setPath("cache", DESKTOP_PATHS.electronCache);
```

Assert that it no longer uses `STARTUP.layout.instanceRoot` for `userData`, and that production requests `app.requestSingleInstanceLock()` and handles `second-instance`.

- [ ] **Step 6: Wire process bootstrap and the single-instance lock.**

Keep `resolveStartupPaths()` for the initial window, but treat only `dataRoot` as process-wide. Before `app.whenReady()`:

1. capture the original `app.getPath("userData")` for `data-root.json`;
2. resolve `DESKTOP_PATHS`;
3. set shared Electron user-data/cache paths;
4. acquire the single-instance lock;
5. quit immediately if the lock is unavailable.

The `second-instance` callback validates `--data-root` and delegates workspace/no-workspace requests to `WindowManager` after Task 3. Task 1 implements a concrete `pendingSecondLaunches: DesktopLaunchRequest[]` queue: requests arriving before `app.whenReady()` are parsed and appended, then Task 3 drains the queue through `WindowManager` immediately after the initial context is registered. No request may launch a second process or be silently discarded.

- [ ] **Step 7: Run focused tests and typecheck.**

```powershell
node scripts/tsx-test.mjs --test --test-concurrency=1 test/desktop-bootstrap.test.mjs test/server-startup-paths.test.mjs
npm.cmd run typecheck
```

- [ ] **Step 8: Commit.**

```powershell
git add src/electron/desktop-bootstrap.ts src/electron/electron-main.ts test/desktop-bootstrap.test.mjs test/server-startup-paths.test.mjs package.json
git commit -m "refactor: establish process-wide desktop bootstrap"
```

### Task 2: Extract per-window server bindings

**Files:**
- Create: `src/electron/server-binding.ts`
- Create: `test/server-binding.test.mjs`
- Modify: `src/electron/electron-main.ts`
- Modify: `package.json`

- [ ] **Step 1: Write failing lifecycle tests with a fake child process.**

Use an `EventEmitter` fake with `stdin`, `pid`, `exitCode`, and `kill`. Cover:

- `none` starts with no process and stop is a no-op;
- `external` returns its fixed origin and stop is a no-op;
- `owned.start()` resolves once stdout contains `SERVER_PORT:<port>`;
- two concurrent starts share one readiness promise;
- two stops share one disposal promise;
- stop writes `PI_SERVER_SHUTDOWN\n`, waits for exit, then uses the bounded force fallback;
- pre-ready exit rejects with captured stdout/stderr;
- unexpected post-ready exit invokes only that binding's callback.

```ts
const binding = createOwnedServerBinding(spec, { spawn: () => fakeChild });
const ready = binding.start();
fakeChild.stdout.emit("data", Buffer.from("SERVER_PORT:43127\n"));
assert.equal(await ready, 43127);
assert.equal(binding.snapshot().state, "ready");
```

- [ ] **Step 2: Run the test and verify failure.**

```powershell
node scripts/tsx-test.mjs --test --test-concurrency=1 test/server-binding.test.mjs
```

- [ ] **Step 3: Implement the binding module.**

Export:

```ts
export type ServerBinding = NoneServerBinding | ExternalServerBinding | OwnedServerBinding;
export function createNoneServerBinding(): NoneServerBinding;
export function createExternalServerBinding(input: { port: number; token: string; origin?: string }): ExternalServerBinding;
export function createOwnedServerBinding(spec: OwnedServerSpec, deps?: OwnedServerDeps): OwnedServerBinding;
```

`OwnedServerSpec` contains workspace, `DataLayout`, instance ID, token, app/runtime roots, packaged mode, and environment. Preserve the direct Electron Node-mode spawn added by the current startup optimization:

```ts
spawn(process.execPath, ["--import", "tsx", serverScript], {
  env: { ...env, ELECTRON_RUN_AS_NODE: "1", PI_ELECTRON_PARENTED: "1" },
  stdio: ["pipe", "pipe", "pipe"],
  shell: false,
});
```

- [ ] **Step 4: Run binding tests and verify GREEN.**

```powershell
node scripts/tsx-test.mjs --test --test-concurrency=1 test/server-binding.test.mjs
```

- [ ] **Step 5: Replace the old global start/stop implementation with a temporary initial binding.**

The existing single-window behavior must remain green while `serverProcess`, `serverPort`, `serverStopping`, `serverShutdownPromise`, `restartCount`, and `healthCheckTimer` move behind one initial `ServerBinding`. Do not introduce `WindowManager` yet.

- [ ] **Step 6: Run desktop startup regression tests and typecheck.**

```powershell
node scripts/tsx-test.mjs --test --test-concurrency=1 test/server-binding.test.mjs test/desktop-auth-bootstrap.test.mjs test/desktop-ipc.test.mjs
npm.cmd run typecheck
```

- [ ] **Step 7: Commit.**

```powershell
git add src/electron/server-binding.ts src/electron/electron-main.ts test/server-binding.test.mjs package.json
git commit -m "refactor: isolate desktop server bindings"
```

### Task 3: Add `WindowManager` and workspace ownership

**Files:**
- Create: `src/electron/window-manager.ts`
- Create: `test/window-manager.test.mjs`
- Modify: `src/electron/electron-main.ts`
- Modify: `test/multi-instance-launch.test.mjs`
- Modify: `package.json`

- [ ] **Step 1: Write failing context/index tests with fake windows and bindings.**

Define the wished-for API in the test:

```ts
const manager = new WindowManager(deps);
const empty = manager.createEmptyWindow();
assert.equal(empty.workspace, null);
assert.equal(empty.server.kind, "none");
assert.equal(manager.contextForWebContents(empty.window.webContents.id), empty);
```

Cover the four workspace decisions:

```ts
assert.equal(await manager.openWorkspace(empty, projectA), "bound");
assert.equal(await manager.openWorkspace(empty, projectA), "unchanged");
assert.equal(await manager.openWorkspace(otherEmpty, projectA), "focused-existing");
assert.equal(otherEmpty.server.kind, "none");
assert.equal(fakeSpawn.count, 1);
assert.equal(await manager.openWorkspace(empty, projectB), "switched");
```

Also cover canonical Windows path equivalence, reservation before spawn, failed startup retaining the shell, idempotent disposal, and waiting for a closing owner before rebinding.

- [ ] **Step 2: Run the manager test and verify failure.**

```powershell
node scripts/tsx-test.mjs --test --test-concurrency=1 test/window-manager.test.mjs
```

- [ ] **Step 3: Implement `WindowManager` with explicit dependencies.**

Export:

```ts
export interface WindowContext {
  id: string;
  instanceId: string;
  window: ManagedWindow;
  workspace: string | null;
  layout: DataLayout | null;
  token: string | null;
  trustedRoots: TrustedDesktopRoots;
  server: ServerBinding;
  lifecycle: "active" | "closing" | "closed";
  disposePromise: Promise<void> | null;
}

export class WindowManager {
  createEmptyWindow(): WindowContext;
  createInitialWindow(input: InitialWindowInput): WindowContext;
  contextForSender(senderId: number): WindowContext;
  openWorkspace(context: WindowContext, workspace: string): Promise<WorkspaceOpenAction>;
  dispose(context: WindowContext): Promise<void>;
  disposeAll(): Promise<void>;
}
```

Keep Electron construction, dialogs, and real child spawning in injected adapters. The manager itself must be importable in Node tests without creating an Electron app.

- [ ] **Step 4: Verify the focused manager suite passes.**

```powershell
node scripts/tsx-test.mjs --test --test-concurrency=1 test/window-manager.test.mjs
```

- [ ] **Step 5: Replace `mainWindow` and detached-process launching in the composition root.**

`window-new` must call `manager.createEmptyWindow()` in the same main process. Remove `launchWindowForWorkspace()`, `launchEmptyWindow()` detached `spawn(process.execPath, ...)`, and the old test assertions requiring `detached: true`.

Initial packaged startup creates one context, starts its owned binding before/alongside Electron readiness, displays its window immediately, and navigates only that context when ready. Initial development startup creates an `external` context using `VITE_DEV_PORT`, `PI_DEV_PORT`, and the dev token.

- [ ] **Step 6: Wire second-launch requests to the manager.**

- no workspace: `createEmptyWindow()`;
- unopened workspace: create empty context, then bind it;
- already-open workspace: focus its context;
- conflicting data root: show an error without mutating the active process root.

- [ ] **Step 7: Run focused launch tests and typecheck.**

```powershell
node scripts/tsx-test.mjs --test --test-concurrency=1 test/window-manager.test.mjs test/multi-instance-launch.test.mjs test/desktop-auth-bootstrap.test.mjs
npm.cmd run typecheck
```

- [ ] **Step 8: Commit.**

```powershell
git add src/electron/window-manager.ts src/electron/electron-main.ts test/window-manager.test.mjs test/multi-instance-launch.test.mjs package.json
git commit -m "feat: manage project windows in one Electron process"
```

### Task 4: Route desktop IPC by sender context

**Files:**
- Modify: `src/electron/desktop-ipc.ts`
- Modify: `src/electron/preload.ts`
- Modify: `src/frontend/dashboard.d.ts`
- Modify: `test/desktop-ipc.test.mjs`

- [ ] **Step 1: Write failing sender-isolation tests.**

Create two fake sender events and two contexts. Assert minimize/maximize/close target the sender window, token lookup returns the sender token, and reveal/trash use only the sender's `TrustedDesktopRoots`.

```ts
assert.equal(await ipc.invokeWithEvent("desktop-session-token", eventA), "token-a");
assert.equal(await ipc.invokeWithEvent("desktop-session-token", eventB), "token-b");
ipc.sendWithEvent("window-close", eventB);
assert.equal(windowA.closeCalls, 0);
assert.equal(windowB.closeCalls, 1);
```

Assert that an unknown sender, a mismatched shell/server origin, and a path trusted only by A are rejected from B.

- [ ] **Step 2: Run the test and verify failure against global-window dependencies.**

```powershell
node scripts/tsx-test.mjs --test --test-concurrency=1 test/desktop-ipc.test.mjs
```

- [ ] **Step 3: Replace IPC dependencies with context resolution.**

```ts
interface DesktopIpcHandlerDeps {
  resolveContext(event: unknown): DesktopIpcContext;
  createEmptyWindow(): unknown | Promise<unknown>;
  openWorkspaceFolder(context: DesktopIpcContext): Promise<WorkspaceOpenResult | null>;
  selectFolder(context: DesktopIpcContext): Promise<string | null>;
  selectFile(context: DesktopIpcContext): Promise<string | null>;
  // OS operations remain injected.
}
```

Remove `getMainWindow()`, global `getDesktopSessionToken()`, global `validateSender()`, and global `trustedRoots` from the handler contract.

- [ ] **Step 4: Split workspace opening from pure folder selection.**

Add channels:

```ts
"workspace-open-folder" // select + WindowManager.openWorkspace
"dialog-select-folder"  // pure folder path for storage settings
```

Expose in preload:

```ts
openWorkspaceFolder: () => ipcRenderer.invoke("workspace-open-folder"),
selectFolder: () => ipcRenderer.invoke("dialog-select-folder"),
```

Keep compatibility aliases only where a current call site still requires them; remove them once Task 6 migrates all call sites.

- [ ] **Step 5: Make URL validation context-specific.**

Allow exactly the context's local shell file, exact owned-server loopback port, or Vite origin for an external binding. Do not accept another context's port merely because it is loopback.

- [ ] **Step 6: Run IPC/security tests and typecheck.**

```powershell
node scripts/tsx-test.mjs --test --test-concurrency=1 test/desktop-ipc.test.mjs test/multi-instance-security.test.mjs
npm.cmd run typecheck
```

- [ ] **Step 7: Commit.**

```powershell
git add src/electron/desktop-ipc.ts src/electron/preload.ts src/frontend/dashboard.d.ts test/desktop-ipc.test.mjs
git commit -m "refactor: route desktop IPC by window context"
```

### Task 5: Build and display the local empty-window shell

**Files:**
- Create: `src/electron/window-shell.html`
- Create: `src/electron/window-shell.css`
- Create: `src/electron/window-shell.ts`
- Create: `test/window-shell.test.mjs`
- Modify: `scripts/compile-preload.mjs`
- Modify: `scripts/dev.mjs`
- Modify: `src/electron/preload.ts`
- Modify: `src/electron/window-manager.ts`
- Modify: `test/desktop-auth-bootstrap.test.mjs`

- [ ] **Step 1: Write failing shell structure/build tests.**

Assert:

- strict local CSP without `unsafe-inline` or `unsafe-eval`;
- no inline event attributes;
- titlebar controls have labels/tooltips;
- File menu contains New Window, Open File, Open Folder, and Close Window;
- idle, starting, and failed regions exist;
- retry and folder actions are real buttons;
- shell assets are emitted under `dist-electron/electron/shell/` by the build helper.

- [ ] **Step 2: Run the shell test and verify failure.**

```powershell
node scripts/tsx-test.mjs --test --test-concurrency=1 test/window-shell.test.mjs
```

- [ ] **Step 3: Implement the shell renderer.**

Use the existing dark workbench visual language and stable titlebar dimensions. The shell must not import dashboard, Monaco, SSE, or MCP code. Its renderer listens through a preload subscription:

```ts
onWindowShellStatus(listener: (status: WindowShellStatus) => void): () => void;
retryWorkspace(): Promise<void>;
openWorkspaceFolder(): Promise<WorkspaceOpenResult | null>;
```

The unsubscribe function must remove only that listener.

- [ ] **Step 4: Extend the Electron asset build.**

Keep preload as CJS. Bundle `window-shell.ts` separately for the browser and copy HTML/CSS into `dist-electron/electron/shell`. Update the Electron watcher to rebuild when any `src/electron/*.ts`, `window-shell.html`, or `window-shell.css` file changes.

- [ ] **Step 5: Load shell immediately for every new/transitioning context.**

`createEmptyWindow()` loads the shell and shows the `BrowserWindow` without starting a server. Binding sends `starting`; failure sends `failed`; server readiness invokes `loadURL(origin)` without giving the origin to shell JavaScript.

- [ ] **Step 6: Verify focused shell/startup tests.**

```powershell
node scripts/tsx-test.mjs --test --test-concurrency=1 test/window-shell.test.mjs test/desktop-auth-bootstrap.test.mjs test/window-manager.test.mjs
npm.cmd run build:electron
```

- [ ] **Step 7: Commit.**

```powershell
git add src/electron/window-shell.html src/electron/window-shell.css src/electron/window-shell.ts src/electron/preload.ts src/electron/window-manager.ts scripts/compile-preload.mjs scripts/dev.mjs test/window-shell.test.mjs test/desktop-auth-bootstrap.test.mjs
git commit -m "feat: add immediate local window shell"
```

### Task 6: Move desktop workspace switching into `WindowManager`

**Files:**
- Modify: `src/frontend/dashboard/dashboard-menus.ts`
- Modify: `src/frontend/dashboard/dashboard-settings.ts`
- Modify: `src/frontend/dashboard.d.ts`
- Modify: `src/frontend/service/explorer-service.ts`
- Modify: `test/workspace-ui.test.mjs`
- Modify: `test/dashboard-actions.test.mjs`
- Modify: `test/settings-ui.test.mjs`

- [ ] **Step 1: Rewrite frontend tests first.**

Replace the old expectation that `openFolder` posts `/api/workspace/switch` with these behaviors:

- File > Open Folder calls `electronAPI.openWorkspaceFolder()` exactly once.
- The frontend does not call `/api/workspace/switch` or locally reset tabs/messages for desktop folder changes.
- A `focused-existing` result leaves the initiating page state unchanged.
- Storage settings call `electronAPI.selectFolder()` and never call `openWorkspaceFolder()`.
- Explorer's open-root command delegates to `openWorkspaceFolder()`.

- [ ] **Step 2: Run tests and verify they fail against the old mixed API.**

```powershell
node scripts/tsx-test.mjs --test --test-concurrency=1 test/workspace-ui.test.mjs test/dashboard-actions.test.mjs test/settings-ui.test.mjs
```

- [ ] **Step 3: Implement the frontend API split.**

Use:

```ts
interface WorkspaceOpenResult {
  ok: boolean;
  action: "unchanged" | "focused-existing" | "binding" | "switching";
  workspace?: string;
}

interface ElectronAPI {
  openWorkspaceFolder(): Promise<WorkspaceOpenResult | null>;
  selectFolder(): Promise<string | null>;
}
```

Remove `workspacePathKey()`, `workspaceSwitchError()`, and the local reset path if no other caller remains. Navigation owns state replacement for bind/switch.

- [ ] **Step 4: Run frontend tests and typecheck.**

```powershell
node scripts/tsx-test.mjs --test --test-concurrency=1 test/workspace-ui.test.mjs test/dashboard-actions.test.mjs test/settings-ui.test.mjs
npm.cmd run typecheck:frontend
```

- [ ] **Step 5: Commit.**

```powershell
git add src/frontend/dashboard/dashboard-menus.ts src/frontend/dashboard/dashboard-settings.ts src/frontend/dashboard.d.ts src/frontend/service/explorer-service.ts test/workspace-ui.test.mjs test/dashboard-actions.test.mjs test/settings-ui.test.mjs
git commit -m "refactor: let Electron coordinate workspace changes"
```

### Task 7: Harden shutdown, crash recovery, and development ownership

**Files:**
- Modify: `src/server/server.ts`
- Modify: `src/electron/server-binding.ts`
- Modify: `src/electron/window-manager.ts`
- Modify: `src/electron/electron-main.ts`
- Modify: `scripts/dev.mjs`
- Modify: `test/server-binding.test.mjs`
- Modify: `test/window-manager.test.mjs`
- Modify: `test/desktop-auth-bootstrap.test.mjs`
- Modify: `test/workspace-lock.test.mjs`

- [ ] **Step 1: Add failing parent-pipe and isolation tests.**

Start an Electron-parented test server with `PI_ELECTRON_PARENTED=1`, close its stdin without sending the explicit command, and assert it exits and releases the workspace lock. Start a normal server without the flag and assert stdin closure does not change CLI behavior.

Add manager tests asserting:

- closing B stops only B's owned binding;
- external primary stop is a no-op;
- B crash sends B to shell and does not navigate A;
- B restart navigates only B;
- final application quit awaits all owned `disposePromise`s.

- [ ] **Step 2: Run the focused tests and verify failure.**

```powershell
node scripts/tsx-test.mjs --test --test-concurrency=1 test/server-binding.test.mjs test/window-manager.test.mjs test/workspace-lock.test.mjs
```

- [ ] **Step 3: Implement parent-pipe shutdown.**

In desktop-parented mode only:

```ts
process.stdin.once("end", () => shutdown("stdin"));
process.stdin.once("close", () => shutdown("stdin"));
```

Keep `shutdown()` idempotent so explicit `PI_SERVER_SHUTDOWN`, pipe close, SIGINT, and SIGTERM cannot release resources twice.

- [ ] **Step 4: Make restart/health state context-local.**

Remove any remaining global health timer or restart counter. Unexpected exits call back into the owning context; the manager loads shell, applies the maximum restart count, and navigates only that window after recovery.

- [ ] **Step 5: Finish dev external binding wiring.**

Pass both values when Electron starts:

```js
VITE_DEV_PORT: String(VITE_PORT),
PI_DEV_PORT: String(DEV_PORT),
```

The external context never spawns, stops, or restarts that process. `scripts/dev.mjs` remains its owner and cleans it after Electron exits.

- [ ] **Step 6: Run lifecycle/security tests and typecheck.**

```powershell
node scripts/tsx-test.mjs --test --test-concurrency=1 test/server-binding.test.mjs test/window-manager.test.mjs test/workspace-lock.test.mjs test/desktop-auth-bootstrap.test.mjs
npm.cmd run typecheck
```

- [ ] **Step 7: Commit.**

```powershell
git add src/server/server.ts src/electron/server-binding.ts src/electron/window-manager.ts src/electron/electron-main.ts scripts/dev.mjs test/server-binding.test.mjs test/window-manager.test.mjs test/desktop-auth-bootstrap.test.mjs test/workspace-lock.test.mjs
git commit -m "fix: isolate multi-window server lifecycle"
```

### Task 8: Replace process-based Electron E2E with multi-window acceptance

**Files:**
- Modify: `test/packaged-electron.e2e.mjs`
- Modify: `test/multi-instance-e2e.mjs`
- Modify: `src/electron/electron-main.ts`
- Modify: `test/smoke.mjs`
- Modify: `docs/backlog.md`

- [ ] **Step 1: Add a failing packaged E2E phase for two windows in one main process.**

Expose test-only diagnostics through the existing E2E result file, never through production HTTP:

```ts
{
  electronPid,
  windows: [
    { contextId, webContentsId, workspace, instanceId, serverKind, serverPid, port, loadedAt },
  ],
  timings: [
    { contextId, event: "window-created" | "shell-visible" | "server-ready" | "workbench-loaded", at },
  ],
}
```

Assert two project windows share `electronPid` but differ in server PID, port, token fingerprint, workspace root, and instance root.

- [ ] **Step 2: Add resource-level duplicate-workspace assertions.**

Create B as an empty shell, record the owned-server child count, select A's workspace from B, and assert:

```ts
assert.equal(result.focusedContextId, contextA.id);
assert.equal(contextB.serverKind, "none");
assert.equal(result.windowCount, 2);
assert.equal(result.serverChildCountAfter, result.serverChildCountBefore);
```

- [ ] **Step 3: Add close/crash/reopen acceptance.**

- closing B exits only B's server and A's `/api/dashboard` remains 200;
- crashing B's server never reloads A;
- reopening B's just-closed workspace waits for disposal and does not return `workspace_locked`;
- a second executable launch is handled by the same Electron PID.

- [ ] **Step 4: Add timing assertions.**

On the target Windows acceptance run:

```ts
assert.ok(shellVisibleAt - windowCreatedAt < 300);
assert.ok(workbenchLoadedAt - workspaceSelectedAt < 3000);
```

Report the measured values even when they pass. Keep the 1-2 second value as the normal target and 3 seconds as the deterministic gate.

- [ ] **Step 5: Preserve server-level isolation coverage.**

`test/multi-instance-e2e.mjs` continues to verify two independent server processes and workspace/data isolation. Rename descriptions that still claim there are two Electron processes; do not delete the server security coverage.

- [ ] **Step 6: Run focused suites, then all gates.**

```powershell
node scripts/tsx-test.mjs --test --test-concurrency=1 test/desktop-bootstrap.test.mjs test/server-binding.test.mjs test/window-manager.test.mjs test/window-shell.test.mjs test/desktop-ipc.test.mjs test/multi-instance-launch.test.mjs test/desktop-auth-bootstrap.test.mjs test/workspace-lock.test.mjs
npm.cmd run typecheck
npm.cmd run test:frontend
npm.cmd run test:routes
npm.cmd run test:unit
npm.cmd run test:electron:e2e
```

Expected: all suites pass; packaged E2E reports one Electron PID, isolated child servers, duplicate-project zero-spawn behavior, and timing values within the gate.

- [ ] **Step 7: Perform manual development acceptance.**

1. Run `npm run dev` with project A restored.
2. Choose File > New Window and verify the shell appears immediately.
3. Confirm no new server process exists before choosing a folder.
4. Open project B and verify its workbench loads while A remains responsive.
5. Open A from a third empty window and verify A focuses, the third window remains empty, and server count does not increase.
6. Close B and verify A and the external dev server continue running.
7. Press Ctrl+C and verify all owned secondary servers exit without stale workspace locks.

- [ ] **Step 8: Update architecture documentation and commit.**

Update `docs/backlog.md` so ④-A describes the delivered one-main-process/multi-window form and references the design. Record measured startup timings rather than estimates.

```powershell
git add test/packaged-electron.e2e.mjs test/multi-instance-e2e.mjs test/smoke.mjs src/electron/electron-main.ts docs/backlog.md
git commit -m "test: verify single-process multi-window isolation"
```

---

## Final Verification Checklist

- [ ] No production path launches a detached Electron process for New Window.
- [ ] `app.setPath("userData")` is called once from the process bootstrap and never from a window context.
- [ ] All windows share one active `dataRoot`; workspace and instance directories remain distinct.
- [ ] Empty windows have no server process.
- [ ] Duplicate project selection focuses the owner and does not spawn.
- [ ] Every IPC action resolves the sender context.
- [ ] Token and trusted roots remain context-local.
- [ ] Closing/crashing one server does not affect another window.
- [ ] Development primary remains external; secondary servers are owned.
- [ ] Full tests, packaged E2E, and manual timing acceptance pass.
