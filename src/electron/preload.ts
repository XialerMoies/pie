/**
 * My Code Agent IPC preload.
 *
 * Exposes a minimal Electron capability surface to the renderer. Business
 * logic stays in the renderer/server; privileged OS actions stay in IPC.
 */
import { contextBridge, ipcRenderer } from "electron";

type WorkspaceStatus =
  | { state: "idle" }
  | { state: "starting"; workspace: string }
  | { state: "failed"; workspace: string; message: string };

contextBridge.exposeInMainWorld("electronAPI", {
  getDesktopSessionToken: () => ipcRenderer.invoke("desktop-session-token"),

  // Window controls
  minimize: () => ipcRenderer.send("window-minimize"),
  maximize: () => ipcRenderer.send("window-maximize"),
  close: () => ipcRenderer.send("window-close"),
  newWindow: () => ipcRenderer.invoke("window-new"),

  // File dialogs
  openWorkspaceFolder: () => ipcRenderer.invoke("workspace-open-folder"),
  retryWorkspace: () => ipcRenderer.invoke("workspace-retry"),
  onWorkspaceStatus: (listener: (status: WorkspaceStatus) => void) => {
    const wrappedListener = (_event: unknown, status: WorkspaceStatus) => listener(status);
    ipcRenderer.on("workspace-status", wrappedListener);
    return () => ipcRenderer.removeListener("workspace-status", wrappedListener);
  },
  selectFile: () => ipcRenderer.invoke("dialog-open-file"),
  selectFolder: () => ipcRenderer.invoke("dialog-select-folder"),

  // File actions
  showItemInFolder: (path: string) => ipcRenderer.invoke("show-item-in-folder", path),
  trashItem: (path: string) => ipcRenderer.invoke("trash-item", path),

  // Terminal
  spawnTerminal: () => ipcRenderer.invoke("spawn-terminal"),
});
