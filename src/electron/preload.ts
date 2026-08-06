/**
 * My Code Agent IPC preload.
 *
 * Exposes a minimal Electron capability surface to the renderer. Business
 * logic stays in the renderer/server; privileged OS actions stay in IPC.
 */
import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("electronAPI", {
  getDesktopSessionToken: () => ipcRenderer.invoke("desktop-session-token"),

  // Window controls
  minimize: () => ipcRenderer.send("window-minimize"),
  maximize: () => ipcRenderer.send("window-maximize"),
  close: () => ipcRenderer.send("window-close"),
  newWindow: () => ipcRenderer.invoke("window-new"),

  // File dialogs
  openFile: () => ipcRenderer.invoke("dialog-open-file"),
  openFolder: () => ipcRenderer.invoke("open-folder-dialog"),

  // File actions
  showItemInFolder: (path: string) => ipcRenderer.invoke("show-item-in-folder", path),
  trashItem: (path: string) => ipcRenderer.invoke("trash-item", path),

  // Terminal
  spawnTerminal: () => ipcRenderer.invoke("spawn-terminal"),
});
