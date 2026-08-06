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
  "dialog-open-file",
  "dialog-open-folder",
  "open-folder-dialog",
  "show-item-in-folder",
  "trash-item",
  "spawn-terminal",
] as const;

export type DesktopIpcSendChannel = typeof DESKTOP_IPC_SEND_CHANNELS[number];
export type DesktopIpcInvokeChannel = typeof DESKTOP_IPC_INVOKE_CHANNELS[number];
export type DesktopPathOperation = "reveal" | "trash";

export interface DesktopWindowLike {
  minimize(): void;
  isMaximized(): boolean;
  maximize(): void;
  unmaximize(): void;
  close(): void;
}

export interface DesktopOpenDialogOptions {
  properties: Array<"openFile" | "openDirectory">;
}

export interface DesktopOpenDialogResult {
  canceled?: boolean;
  filePaths: string[];
}

export type DesktopIpcInvokeHandler = (event: unknown, ...args: unknown[]) => unknown;
export type DesktopIpcSendHandler = (event: unknown, ...args: unknown[]) => void;

export interface DesktopIpcMainLike {
  handle(channel: DesktopIpcInvokeChannel, handler: DesktopIpcInvokeHandler): void;
  on(channel: DesktopIpcSendChannel, handler: DesktopIpcSendHandler): void;
}

export interface DesktopIpcHandlerDeps {
  ipcMain: DesktopIpcMainLike;
  getMainWindow(): DesktopWindowLike | null | undefined;
  showOpenDialog(options: DesktopOpenDialogOptions): Promise<DesktopOpenDialogResult>;
  launchEmptyWindow(): unknown | Promise<unknown>;
  showItemInFolder(filePath: string): void;
  trashItem(filePath: string): Promise<void>;
  spawnTerminal(): Promise<boolean> | boolean;
  getDesktopSessionToken(): string;
  validateSender(event: unknown): void;
  trustedRoots: TrustedDesktopRoots;
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

export function registerDesktopIpcHandlers(deps: DesktopIpcHandlerDeps): void {
  deps.ipcMain.handle("desktop-session-token", (event, ...args) => {
    deps.validateSender(event);
    assertNoArgs("desktop-session-token", args);
    return deps.getDesktopSessionToken();
  });

  deps.ipcMain.on("window-minimize", (event, ...args) => {
    deps.validateSender(event);
    assertNoArgs("window-minimize", args);
    deps.getMainWindow()?.minimize();
  });

  deps.ipcMain.on("window-maximize", (event, ...args) => {
    deps.validateSender(event);
    assertNoArgs("window-maximize", args);
    const win = deps.getMainWindow();
    if (!win) return;
    if (win.isMaximized()) win.unmaximize();
    else win.maximize();
  });

  deps.ipcMain.on("window-close", (event, ...args) => {
    deps.validateSender(event);
    assertNoArgs("window-close", args);
    deps.getMainWindow()?.close();
  });

  deps.ipcMain.handle("window-new", async (event, ...args) => {
    deps.validateSender(event);
    assertNoArgs("window-new", args);
    return deps.launchEmptyWindow();
  });

  deps.ipcMain.handle("dialog-open-file", async (event, ...args) => {
    deps.validateSender(event);
    assertNoArgs("dialog-open-file", args);
    const result = await deps.showOpenDialog({ properties: ["openFile"] });
    const selected = result.canceled ? null : result.filePaths[0] || null;
    if (selected) deps.trustedRoots.addFile(selected);
    return selected;
  });

  const openFolder = async (channel: DesktopIpcInvokeChannel, args: unknown[]) => {
    assertNoArgs(channel, args);
    const result = await deps.showOpenDialog({ properties: ["openDirectory"] });
    const selected = result.canceled ? null : result.filePaths[0] || null;
    if (selected) deps.trustedRoots.addRoot(selected);
    return selected;
  };

  deps.ipcMain.handle("dialog-open-folder", (event, ...args) => {
    deps.validateSender(event);
    return openFolder("dialog-open-folder", args);
  });
  deps.ipcMain.handle("open-folder-dialog", (event, ...args) => {
    deps.validateSender(event);
    return openFolder("open-folder-dialog", args);
  });

  deps.ipcMain.handle("show-item-in-folder", (event, ...args) => {
    deps.validateSender(event);
    const filePath = expectPathArg("show-item-in-folder", args);
    deps.showItemInFolder(deps.trustedRoots.guardPath(filePath, "reveal"));
  });

  deps.ipcMain.handle("trash-item", async (event, ...args) => {
    deps.validateSender(event);
    const filePath = expectPathArg("trash-item", args);
    await deps.trashItem(deps.trustedRoots.guardPath(filePath, "trash"));
    return true;
  });

  deps.ipcMain.handle("spawn-terminal", async (event, ...args) => {
    deps.validateSender(event);
    assertNoArgs("spawn-terminal", args);
    return deps.spawnTerminal();
  });
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
