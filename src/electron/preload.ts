/**
 * My Code Agent — IPC preload
 * 暴露窗口控制和应用 API 给渲染进程
 *
 * 保持最小暴露原则：只暴露 Electron 能力，不做业务逻辑。
 */
import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("electronAPI", {
  // 窗口控制
  minimize: () => ipcRenderer.send("window-minimize"),
  maximize: () => ipcRenderer.send("window-maximize"),
  close: () => ipcRenderer.send("window-close"),
  newWindow: () => ipcRenderer.send("window-new"),

  // 文件对话框
  openFile: () => ipcRenderer.invoke("dialog-open-file"),
  openFolder: () => ipcRenderer.invoke("open-folder-dialog"),

  // 文件操作
  showItemInFolder: (path: string) => ipcRenderer.invoke("show-item-in-folder", path),
  trashItem: (path: string) => ipcRenderer.invoke("trash-item", path),

  // 终端
  spawnTerminal: () => ipcRenderer.invoke("spawn-terminal"),
});
