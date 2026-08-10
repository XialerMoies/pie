import * as fs from "fs";
import * as path from "path";

export const DESKTOP_IPC_SEND_CHANNELS = [
  "window-minimize",
  "window-maximize",
  "window-close",
] as const;

export const DESKTOP_IPC_INVOKE_CHANNELS = [
  "desktop-session-token",
  "window-new",
  "workspace-open-folder",
  "workspace-retry",
  "dialog-select-folder",
  "dialog-open-file",
  "show-item-in-folder",
  "trash-item",
  "spawn-terminal",
] as const;

export type DesktopIpcSendChannel = typeof DESKTOP_IPC_SEND_CHANNELS[number];
export type DesktopIpcInvokeChannel = typeof DESKTOP_IPC_INVOKE_CHANNELS[number];
export type DesktopPathOperation = "reveal" | "trash";
export type WorkspaceOpenAction =
  | "unchanged"
  | "focused-existing"
  | "binding"
  | "switching";

export interface WorkspaceOpenResult {
  ok: boolean;
  action: WorkspaceOpenAction;
  workspace?: string;
}

export interface DesktopWindowLike {
  readonly webContents: unknown;
  minimize(): void;
  isMaximized(): boolean;
  maximize(): void;
  unmaximize(): void;
  close(): void;
}

export type DesktopIpcInvokeHandler = (event: unknown, ...args: unknown[]) => unknown;
export type DesktopIpcSendHandler = (event: unknown, ...args: unknown[]) => void;

export interface DesktopIpcMainLike {
  handle(channel: DesktopIpcInvokeChannel, handler: DesktopIpcInvokeHandler): void;
  on(channel: DesktopIpcSendChannel, handler: DesktopIpcSendHandler): void;
}

export interface DesktopIpcContext {
  id: string;
  window: DesktopWindowLike;
  workspace: string | null;
  token: string | null;
  trustedRoots: TrustedDesktopRoots;
  server: {
    readonly kind: "none" | "external" | "owned";
    readonly port: number;
    readonly origin: string;
  };
}

export interface DesktopIpcContextResolverDeps {
  contextForSender(senderId: number): DesktopIpcContext;
  dashboardUrl: string;
  viteOrigin?: string;
}

export interface DesktopIpcHandlerDeps {
  ipcMain: DesktopIpcMainLike;
  resolveContext(event: unknown): DesktopIpcContext;
  createEmptyWindow(): unknown | Promise<unknown>;
  openWorkspaceFolder(context: DesktopIpcContext): Promise<WorkspaceOpenResult | null>;
  retryWorkspace(context: DesktopIpcContext): Promise<void>;
  selectFolder(context: DesktopIpcContext): Promise<string | null>;
  selectFile(context: DesktopIpcContext): Promise<string | null>;
  showItemInFolder(context: DesktopIpcContext, filePath: string): void;
  trashItem(context: DesktopIpcContext, filePath: string): Promise<void>;
  spawnTerminal(context: DesktopIpcContext): Promise<boolean> | boolean;
}

export class DesktopIpcValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DesktopIpcValidationError";
  }
}

export class TrustedDesktopRoots {
  private readonly trustedFileRoots = new Set<string>();
  private readonly trustedExactFiles = new Set<string>();

  addRoot(root: string): void {
    if (!root || typeof root !== "string") return;
    this.trustedFileRoots.add(realpathOrResolve(root));
  }

  addFile(filePath: string): void {
    if (!filePath || typeof filePath !== "string") return;
    this.trustedExactFiles.add(realpathOrResolve(filePath));
  }

  addPersistedWorkspaceRoots(uiStateFile: string): number {
    try {
      if (!fs.existsSync(uiStateFile)) return 0;
      const data = JSON.parse(fs.readFileSync(uiStateFile, "utf-8"));
      const workspaces = data && typeof data === "object" ? data.workspaces : null;
      if (!workspaces || typeof workspaces !== "object") return 0;

      let added = 0;
      for (const workspace of Object.keys(workspaces)) {
        if (workspace === "_default" || !path.isAbsolute(workspace) || !fs.existsSync(workspace)) continue;
        this.addRoot(workspace);
        added++;
      }
      return added;
    } catch {
      return 0;
    }
  }

  guardPath(filePath: unknown, operation: DesktopPathOperation): string {
    if (typeof filePath !== "string" || !filePath.trim() || filePath.includes("\0")) {
      throw new DesktopIpcValidationError(`Invalid ${operation} path`);
    }
    if (!path.isAbsolute(filePath)) {
      throw new DesktopIpcValidationError(`${operation} path must be absolute`);
    }
    if (!fs.existsSync(filePath)) {
      throw new DesktopIpcValidationError(`${operation} path does not exist`);
    }

    const target = fs.realpathSync.native(filePath);
    for (const file of this.trustedExactFiles) {
      if (isSamePath(file, target)) return target;
    }
    for (const root of this.trustedFileRoots) {
      if (isPathInsideRoot(root, target)) return target;
    }
    throw new DesktopIpcValidationError(`${operation} path is outside trusted desktop roots`);
  }

  listRoots(): string[] {
    return [...this.trustedFileRoots];
  }
}

export function resolveDesktopIpcContext(
  event: unknown,
  deps: DesktopIpcContextResolverDeps,
): DesktopIpcContext {
  const ipcEvent = event as {
    sender?: { id?: unknown };
    senderFrame?: { url?: unknown } | null;
  };
  const sender = ipcEvent?.sender;
  if (!sender || typeof sender.id !== "number") {
    throw new DesktopIpcValidationError("Desktop IPC request is not from a managed app window");
  }

  let context: DesktopIpcContext;
  try {
    context = deps.contextForSender(sender.id);
  } catch {
    throw new DesktopIpcValidationError("Desktop IPC request is not from a managed app window");
  }

  if (sender !== context.window.webContents) {
    throw new DesktopIpcValidationError("Desktop IPC request is not from the trusted app window");
  }

  const senderUrl = ipcEvent.senderFrame?.url;
  if (typeof senderUrl !== "string" || !senderUrl.trim()) {
    throw new DesktopIpcValidationError("Desktop IPC request is not from a trusted app origin");
  }
  if (!isAllowedDesktopIpcUrl(senderUrl, context, deps)) {
    throw new DesktopIpcValidationError("Desktop IPC request is not from a trusted app origin");
  }
  return context;
}

export function isAllowedDesktopIpcUrl(
  rawUrl: string,
  context: DesktopIpcContext,
  options: Pick<DesktopIpcContextResolverDeps, "dashboardUrl" | "viteOrigin">,
): boolean {
  if (rawUrl === options.dashboardUrl || rawUrl.startsWith(`${options.dashboardUrl}?`)) return true;

  const senderOrigin = loopbackHttpOrigin(rawUrl);
  if (!senderOrigin) return false;
  if (context.server.kind === "owned") {
    return senderOrigin === loopbackHttpOrigin(context.server.origin);
  }
  if (context.server.kind === "external" && options.viteOrigin) {
    return senderOrigin === loopbackHttpOrigin(options.viteOrigin);
  }
  return false;
}

export function registerDesktopIpcHandlers(deps: DesktopIpcHandlerDeps): void {
  deps.ipcMain.handle("desktop-session-token", (event, ...args) => {
    const context = deps.resolveContext(event);
    assertNoArgs("desktop-session-token", args);
    if (!context.token) {
      throw new DesktopIpcValidationError("Desktop session token is unavailable for this window");
    }
    return context.token;
  });

  deps.ipcMain.on("window-minimize", (event, ...args) => {
    const context = deps.resolveContext(event);
    assertNoArgs("window-minimize", args);
    context.window.minimize();
  });

  deps.ipcMain.on("window-maximize", (event, ...args) => {
    const context = deps.resolveContext(event);
    assertNoArgs("window-maximize", args);
    const win = context.window;
    if (win.isMaximized()) win.unmaximize();
    else win.maximize();
  });

  deps.ipcMain.on("window-close", (event, ...args) => {
    const context = deps.resolveContext(event);
    assertNoArgs("window-close", args);
    context.window.close();
  });

  deps.ipcMain.handle("window-new", async (event, ...args) => {
    deps.resolveContext(event);
    assertNoArgs("window-new", args);
    return deps.createEmptyWindow();
  });

  deps.ipcMain.handle("dialog-open-file", async (event, ...args) => {
    const context = deps.resolveContext(event);
    assertNoArgs("dialog-open-file", args);
    const trustedRoots = context.trustedRoots;
    const selected = await deps.selectFile(context);
    if (context.trustedRoots !== trustedRoots) return null;
    if (selected) trustedRoots.addFile(selected);
    return selected;
  });

  deps.ipcMain.handle("dialog-select-folder", async (event, ...args) => {
    const context = deps.resolveContext(event);
    assertNoArgs("dialog-select-folder", args);
    const trustedRoots = context.trustedRoots;
    const selected = await deps.selectFolder(context);
    if (context.trustedRoots !== trustedRoots) return null;
    if (selected) trustedRoots.addRoot(selected);
    return selected;
  });

  deps.ipcMain.handle("workspace-open-folder", (event, ...args) => {
    const context = deps.resolveContext(event);
    assertNoArgs("workspace-open-folder", args);
    return deps.openWorkspaceFolder(context);
  });

  deps.ipcMain.handle("workspace-retry", async (event, ...args) => {
    const context = deps.resolveContext(event);
    assertNoArgs("workspace-retry", args);
    await deps.retryWorkspace(context);
  });

  deps.ipcMain.handle("show-item-in-folder", (event, ...args) => {
    const context = deps.resolveContext(event);
    const filePath = expectPathArg("show-item-in-folder", args);
    deps.showItemInFolder(context, context.trustedRoots.guardPath(filePath, "reveal"));
  });

  deps.ipcMain.handle("trash-item", async (event, ...args) => {
    const context = deps.resolveContext(event);
    const filePath = expectPathArg("trash-item", args);
    await deps.trashItem(context, context.trustedRoots.guardPath(filePath, "trash"));
    return true;
  });

  deps.ipcMain.handle("spawn-terminal", async (event, ...args) => {
    const context = deps.resolveContext(event);
    assertNoArgs("spawn-terminal", args);
    return deps.spawnTerminal(context);
  });
}

function loopbackHttpOrigin(rawUrl: string): string | null {
  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol !== "http:" || parsed.username || parsed.password) return null;
    const hostname = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "");
    const loopback = hostname === "localhost"
      || hostname === "::1"
      || hostname === "127.0.0.1"
      || hostname.startsWith("127.");
    return loopback ? parsed.origin : null;
  } catch {
    return null;
  }
}

function assertNoArgs(channel: string, args: readonly unknown[]): void {
  if (args.length > 0) {
    throw new DesktopIpcValidationError(`${channel} does not accept renderer arguments`);
  }
}

function expectPathArg(channel: string, args: readonly unknown[]): string {
  if (args.length !== 1 || typeof args[0] !== "string" || !path.isAbsolute(args[0])) {
    throw new DesktopIpcValidationError(`${channel} expects exactly one absolute path argument`);
  }
  return args[0];
}

function realpathOrResolve(target: string): string {
  try {
    return fs.realpathSync.native(target);
  } catch {
    return path.resolve(target);
  }
}

function normalizeForCompare(value: string): string {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function isPathInsideRoot(root: string, target: string): boolean {
  const parent = normalizeForCompare(root);
  const child = normalizeForCompare(target);
  const relative = path.relative(parent, child);
  return relative === "" || (!!relative && !relative.startsWith("..") && !path.isAbsolute(relative));
}

function isSamePath(left: string, right: string): boolean {
  return normalizeForCompare(left) === normalizeForCompare(right);
}
