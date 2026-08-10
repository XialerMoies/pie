# Single-Process Multi-Window Design

**Date:** 2026-08-08
**Status:** Approved

## Problem

The desktop currently implements concurrent projects by launching one Electron process per window. Each process owns one `BrowserWindow`, one server child process, and one `AgentRuntime`. This preserves project isolation, but a new window pays the full Electron startup cost before it becomes visible.

The target is one Electron main process with multiple windows. A new window shell should appear immediately, while every project window keeps an independent server child process and independent `AgentRuntime`.

## Goals

1. Show a new empty window shell within 300 ms of the command.
2. Load project content in approximately 1-2 seconds in packaged mode, with a 3-second cold-start ceiling.
3. Keep one server process and one `AgentRuntime` per bound project window.
4. Preserve workspace locks, per-instance runtime data, permission state, MCP state, and desktop authentication isolation.
5. Keep the development primary window on the existing Vite and external dev-server path for the first release.
6. Make window closure, server failure, and duplicate-workspace selection local to the affected window.

## Non-Goals

- Multiple `AgentRuntime` objects inside one server process.
- Multiple concurrent chat sessions in one window.
- A prewarmed server pool.
- Restoring an entire group of previously open windows after restart.
- Live migration of the application data root while windows are running.
- Replacing the existing server-hosted workbench with a local-protocol workbench.

## Core Architecture

The Electron main process owns a `WindowManager`. Every window has one `WindowContext`; the server and runtime remain isolated in a child process.

```text
Electron main process
  WindowManager
    WindowContext A -> BrowserWindow A -> server child A -> AgentRuntime A
    WindowContext B -> BrowserWindow B -> server child B -> AgentRuntime B
    WindowContext C -> empty shell, no server
```

The Electron layer stops using process-global `mainWindow`, `serverProcess`, `serverPort`, server token, health-check timer, restart counter, startup workspace, and trusted-root registry.

```ts
interface WindowContext {
  id: string;
  instanceId: string;
  window: BrowserWindow;
  workspace: string | null;
  layout: DataLayout | null;
  token: string | null;
  trustedRoots: TrustedDesktopRoots;
  server: ServerBinding;
  lifecycle: "active" | "closing" | "closed";
  disposePromise: Promise<void> | null;
}

type ServerBinding =
  | { kind: "none" }
  | {
      kind: "external";
      port: number;
      token: string;
      origin: string;
    }
  | {
      kind: "owned";
      state: "starting" | "ready" | "stopping" | "failed";
      process: ChildProcess;
      port: number;
      ready: Promise<number>;
      restartCount: number;
      healthCheckTimer: NodeJS.Timeout | null;
    };
```

The manager owns these indexes:

```ts
Map<number, WindowContext> // webContents.id -> context
Map<string, WindowContext> // canonical workspace -> context
```

The workspace index is authoritative for desktop UX. The existing workspace lock remains authoritative for write safety if a process outside this manager attempts to open the same project.

## Process-Wide Storage Contract

`app.setPath("userData", ...)` is process-wide and cannot be set per window. The application must never attempt to derive Chromium `userData` from a `WindowContext`.

All windows share:

- one Electron `userData` directory;
- one Electron cache directory;
- one OS bootstrap `data-root.json` pointer;
- one active `dataRoot` for the lifetime of the Electron main process;
- user-level configuration below `<dataRoot>/user/`.

The OS-default Electron user-data directory stores only the small bootstrap pointer. After reading that pointer, the main process sets stable shared paths before `app.whenReady()`:

```text
<os-user-data>/data-root.json               process-wide bootstrap pointer
<dataRoot>/electron-user-data/              shared Chromium profile
<dataRoot>/cache/electron/                   shared Electron cache
<dataRoot>/user/                             shared user configuration
<dataRoot>/workspaces/<workspace-hash>/      persistent workspace state
<dataRoot>/instances/<instance-id>/          disposable per-window runtime state
```

Window isolation begins at the workspace and instance directories, not at Electron `userData`. `localStorage` is non-authoritative: durable preferences live in user settings, and tabs/panels/session UI state live in workspace `ui-state.json`.

Changing the storage location is a process-wide operation. The setting writes the shared bootstrap pointer and requires all windows to close and the application to restart. A window cannot select a private data root. A second launch that supplies a different `--data-root` while the main process is active is rejected with a clear message; the active process root is never changed in place.

Shared mutable user files continue to use the existing cross-process locks because server child processes remain independent writers.

## Single Main-Process Ownership

Production uses `app.requestSingleInstanceLock()` after the shared `userData` path is selected. A second application launch forwards its command line to the existing main process through Electron's `second-instance` event.

- A launch with a new workspace creates and binds a new window in the existing process.
- A launch for an already-open workspace focuses its existing window.
- A launch without a workspace creates an empty shell window.
- A launch with a conflicting data root is rejected.

Development keeps one Electron main process per `npm run dev` process. Test-only overrides may allow isolated packaged fixtures, but production behavior remains single-main-process.

## Window Shell

`window-shell.html` is a local, minimal loading surface. It contains the existing visual language for the title bar, File menu, window controls, loading state, retry action, and folder picker. It does not initialize the dashboard, Monaco, SSE, MCP, or an empty server.

The shell never polls a server and never receives a server token or origin. The main process sends only display states such as `idle`, `starting`, and `failed`. When an owned server's `ready` promise resolves, the main process calls `window.loadURL(serverOrigin)`. The shell remains visible until navigation commits and is then replaced by the complete workbench.

An empty shell has `ServerBinding.kind === "none"`. Creating additional empty windows must not increase the server child-process count.

## Open-Folder Semantics

All desktop folder changes are coordinated by `WindowManager`; the renderer no longer performs an independent `/api/workspace/switch` after the Electron folder picker returns.

The selected directory is canonicalized before this decision table is applied:

1. Target equals the current window workspace: keep and focus the current window.
2. Target belongs to another active window: focus that existing window and leave the initiating window unchanged.
3. Target is unowned and the initiating window is empty: bind that window to the target.
4. Target is unowned and the initiating window is bound: switch that window from its old workspace to the target.

When an empty window selects an already-open project, it remains open and stays empty. The user decides whether to close it.

Switching a bound window follows this sequence:

```text
load local shell
  -> stop old owned server
  -> wait for process exit and workspace-lock release
  -> remove old workspace index entry
  -> allocate new instance layout and token
  -> reserve new workspace index entry
  -> start new server
  -> navigate only that window to the new server origin
```

If startup of the new workspace fails, the window remains on the shell with retry and folder-selection actions. It does not silently return to the old project.

## Development Compatibility

The first development window keeps the current Vite renderer and the external server managed by `scripts/dev.mjs`. Its server binding is explicitly `external`; the manager does not stop or restart it.

Additional development windows use owned server child processes and load frontend assets from those servers. This intentionally gives secondary windows no Vite HMR in the first release. It avoids adding a multi-origin API abstraction to 89 existing frontend request sites.

The primary development context still participates in sender routing, workspace indexing, duplicate-workspace focusing, per-window trusted roots, and token lookup.

## Closing and Disposal

Disposal is idempotent and represented by `context.disposePromise`.

1. Remove the context from sender routing as soon as its renderer is closed.
2. Mark the context `closing` and reject new IPC from that sender.
3. Stop only its owned server using the existing stdin shutdown command, with a bounded force-kill fallback.
4. Keep the workspace reservation until the child exits and the server releases its workspace lock.
5. Remove the workspace index entry and disposable instance runtime after shutdown completes.
6. Mark the context `closed`.

If another window requests a workspace whose old owner is closing, it waits for that owner's `disposePromise` and retries the ownership decision. It does not focus a destroyed window and does not race the workspace lock.

Closing an external development context does not stop the external server. Closing the final window waits for all owned contexts to dispose before allowing Electron to quit.

## Failure Recovery

- Owned server fails before ready: keep the shell, report a concise failure, and expose retry/open-folder actions.
- Owned server crashes after ready: return only its window to the shell and apply the existing bounded restart policy.
- Restart succeeds: navigate only the affected window back to its server origin.
- Restart limit is reached: keep the failed shell and preserve diagnostics.
- Renderer crashes: keep its owned server alive and allow that window to reload/reconnect.
- Electron main exits normally: dispose all owned servers before exit.
- Electron main terminates unexpectedly: a parented server treats closure of its stdin pipe as shutdown, closes streams, and releases the workspace lock. This behavior is enabled only for Electron-parented servers so CLI stdin semantics do not change.

One server failure or renderer failure must not reload, stop, or mutate any other window context.

## IPC and Security

Every desktop IPC operation resolves its context from `event.sender.id`. `getMainWindow()` and the process-global trusted-root registry are removed from IPC dependencies.

Each context owns:

- one desktop session token;
- one `TrustedDesktopRoots` instance;
- its workspace, workspace data directory, and instance directory roots;
- its allowed renderer origins.

Allowed origins are context-specific:

- the local shell file;
- the Vite origin for the external primary development context;
- the exact loopback port for an owned server context.

The preload returns only the caller context's token. Tokens are never put in URLs or query strings. A renderer cannot use IPC to obtain another context's token, control another window, or authorize another workspace path.

Folder and file dialogs are parented to the sender's window. Reveal, trash, terminal, minimize, maximize, close, and open-folder actions operate on the sender context. A selected folder is added only to that context's trusted roots after validation.

## Observability

Every context emits timing records with its context ID and instance ID:

```text
window-created
shell-visible
workspace-selected
server-spawned
server-ready
workbench-loaded
server-stopped
context-disposed
```

Logs must make it possible to attribute a server PID, port, restart, and shutdown to exactly one window without exposing the desktop token.

## Testing

### Unit Tests

- Context creation creates an empty `none` binding.
- Workspace canonicalization and the four open-folder branches.
- Duplicate selection focuses the owner and leaves the initiating context unchanged.
- Closing and switching are idempotent.
- A request waits for a closing owner and retries after disposal.
- `none`, `external`, and `owned` bindings follow distinct lifecycle rules.
- Owned server stop and restart affect only one context.
- Shared `userData` and data root are process invariants; per-window layouts remain distinct.

### IPC and Security Tests

- Sender routing controls the sender's window, not a global main window.
- Token lookup returns only the sender context token.
- Cross-window origin, token, and path attempts are rejected.
- Shell, Vite, and owned-server origins are accepted only for their matching contexts.
- Dialog results extend only the sender context's trusted roots.

### Packaged E2E

1. Launch one packaged Electron main process and create two project windows.
2. Assert both windows share the Electron main PID.
3. Assert their server PID, port, token, instance ID, workspace directory, and instance directory differ.
4. Close window B and assert B's server exits while A remains interactive.
5. Crash B's server and assert A is not reloaded or disconnected.
6. Open an empty window B and select A's workspace. Assert A is focused, B remains present, `B.server.kind === "none"`, and the server child-process count does not increase.
7. Close a workspace window and immediately reopen its project. Assert the second request waits for disposal rather than receiving a workspace-lock conflict.
8. Launch the executable a second time and assert the existing main process handles the request.

### Development Acceptance

- The first window remains on Vite and uses the external server.
- A second window appears immediately and starts no server until a folder is selected.
- Selecting a new project starts one owned server and loads its workbench.
- Closing the secondary window leaves the Vite window and external server untouched.

### Performance Acceptance

- `shell-visible - window-created < 300 ms` on the target Windows machine.
- Packaged `workbench-loaded - workspace-selected` is normally 1-2 seconds and does not exceed 3 seconds in the cold-start acceptance run.
- Creating an empty window does not increase server count or wait for server startup.

## Delivery Order

1. Extract process-wide bootstrap storage and establish the single-main-process invariant.
2. Add testable `ServerBinding` and per-window server lifecycle units.
3. Add `WindowManager`, context indexes, and sender-based IPC routing.
4. Add the local shell and empty-window path.
5. Move desktop open-folder behavior into `WindowManager`.
6. Add context-specific crash recovery, shutdown, and parent-pipe cleanup.
7. Extend packaged/dev E2E and enforce timing and resource-count acceptance.

