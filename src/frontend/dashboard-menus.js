function toggleFileMenu(ev) {
  const existing = $("file-menu");
  if (existing) {
    existing.remove();
    return;
  }
  const rect = ev.currentTarget.getBoundingClientRect();
  const menu = document.createElement("div");
  menu.id = "file-menu";
  menu.style.cssText = `position:fixed;top:${rect.bottom + 2}px;left:${rect.left}px;z-index:900;background:var(--bs);border:1px solid var(--bd);border-radius:8px;padding:4px;min-width:160px;box-shadow:0 8px 32px rgba(0,0,0,.4)`;
  menu.innerHTML = `
    <div class="fm-item" onclick="fileAction('newWindow');closeFM()">\u65B0\u5EFA\u7A97\u53E3</div>
    <div class="fm-item" onclick="fileAction('openFile');closeFM()">\u6253\u5F00\u6587\u4EF6</div>
    <div class="fm-item" onclick="fileAction('openFolder');closeFM()">\u6253\u5F00\u6587\u4EF6\u5939</div>
    <div class="fm-sep"></div>
    <div class="fm-item" onclick="fileAction('save');closeFM()">\u4FDD\u5B58 <span style="color:var(--tm);font-size:10px;float:right">Ctrl+S</span></div>
    <div class="fm-item" onclick="fileAction('saveAll');closeFM()">\u5168\u90E8\u4FDD\u5B58</div>
    <div class="fm-item" onclick="fileAction('toggleAutoSave');closeFM()">${localStorage.getItem("auto-save") === "1" ? "\u2713 " : ""}\u81EA\u52A8\u4FDD\u5B58</div>
    <div class="fm-sep"></div>
    <div class="fm-item" onclick="fileAction('closeWindow');closeFM()">\u5173\u95ED\u7A97\u53E3</div>
  `;
  document.body.appendChild(menu);
  setTimeout(() => document.addEventListener("click", closeFMOutside, true), 0);
}
function closeFM() {
  const el = $("file-menu");
  if (el) el.remove();
  document.removeEventListener("click", closeFMOutside, true);
}
function closeFMOutside(ev) {
  if (!ev.target.closest("#file-menu") && !ev.target.closest(".top-tab")) closeFM();
}
function fileAction(action) {
  const api = window.electronAPI;
  if (action === "newWindow" && api) api.newWindow();
  else if (action === "openFile" && api) api.openFile().then((p) => {
    if (p) toast("\u5DF2\u9009\u62E9: " + p);
  });
  else if (action === "openFolder" && api) api.openFolder().then((p) => {
    if (p) {
      const oldPath = localStorage.getItem("workspace_path");
      if (p === oldPath) return;
      localStorage.setItem("workspace_path", p);
      fetch("/api/workspace/switch", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ workspace: p }) }).catch(() => {
      });
      toast("\u5DE5\u4F5C\u533A: " + p);
      window.__state._fileTabs = [];
      window.__state._activeFileTab = null;
      window.__state.M = [];
      try {
        localStorage.removeItem("file-tabs");
      } catch {
      }
      const m = window.__monaco;
      if (m?.dispose) m.dispose();
      switchTab(null);
      const pc = $("pc");
      if (pc) renderPanel("explorer", pc);
      loadSessions();
      const App = window.App;
      if (App?.Git?.refreshGit) setTimeout(() => App.Git.refreshGit(), 300);
    }
  });
  else if (action === "save" && api) {
  } else if (action === "saveAll" && api) {
  } else if (action === "toggleAutoSave") {
    const v = localStorage.getItem("auto-save");
    if (v === "1") localStorage.removeItem("auto-save");
    else localStorage.setItem("auto-save", "1");
    toast("\u81EA\u52A8\u4FDD\u5B58: " + (v === "1" ? "\u5173" : "\u5F00"));
  } else if (action === "closeWindow" && api) api.close();
}
function launchCli() {
  const api = window.electronAPI;
  if (api && api.spawnTerminal) {
    api.spawnTerminal();
    toast("\u5DF2\u6253\u5F00 CLI \u7EC8\u7AEF\u7A97\u53E3");
  } else toast("\u8BF7\u5148\u542F\u52A8 Electron \u684C\u9762\u5E94\u7528");
}
window.toggleFileMenu = toggleFileMenu;
window.closeFM = closeFM;
window.fileAction = fileAction;
window.launchCli = launchCli;
const AppFile = window.App?.File;
if (AppFile) {
  AppFile.toggleFileMenu = toggleFileMenu;
  AppFile.closeFM = closeFM;
  AppFile.fileAction = fileAction;
  AppFile.launchCli = launchCli;
}
