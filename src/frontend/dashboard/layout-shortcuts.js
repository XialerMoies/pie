function saveCurrentFile() {
  const id = window.__state._activeFileTab;
  if (!id) return Promise.resolve();
  const m = window.__monaco;
  const content = m?.getValue() ?? "";
  if (!content && !m) return Promise.resolve();
  const status = $("fc-status");
  if (status) status.textContent = "\u4FDD\u5B58\u4E2D...";
  const ws = ExplorerService.getWorkspacePath();
  return fetch("/api/file/write", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ root: ws, path: id, content })
  }).then((r) => r.json()).then((d) => {
    if (!d.error) {
      if (status) {
        status.textContent = "\u5DF2\u4FDD\u5B58";
        setTimeout(() => {
          if (status) status.textContent = "";
        }, 2e3);
      }
      const tab = window.__state._fileTabs.find((t) => t.id === id);
      if (tab) tab.content = content;
      toast("\u2705 \u5DF2\u4FDD\u5B58: " + (id.split("/").pop() || id), "success");
    } else {
      if (status) status.textContent = "\u4FDD\u5B58\u5931\u8D25: " + d.error;
      toast("\u274C \u4FDD\u5B58\u5931\u8D25: " + d.error, "error");
    }
  }).catch(() => {
    if (status) status.textContent = "\u4FDD\u5B58\u5931\u8D25";
    toast("\u274C \u4FDD\u5B58\u5931\u8D25: \u7F51\u7EDC\u9519\u8BEF", "error");
  });
}
function quickOpenFile() {
  const overlay = document.createElement("div");
  overlay.className = "modal-overlay";
  overlay.style.zIndex = "10000";
  overlay.innerHTML = `<div class="modal-box" style="width:500px;height:auto;min-height:unset;padding:12px;position:absolute;top:80px;left:50%;transform:translateX(-50%)">
    <input id="qo-input" type="text" placeholder="\u8F93\u5165\u6587\u4EF6\u540D\u641C\u7D22..." autofocus
      style="width:100%;padding:8px 10px;border-radius:6px;border:1px solid var(--bd);background:var(--bc);color:var(--tx);font-size:.82rem;font-family:var(--fb);outline:none;box-sizing:border-box">
    <div id="qo-results" style="margin-top:6px;max-height:300px;overflow-y:auto;font-size:.75rem"></div>
  </div>`;
  document.body.appendChild(overlay);
  const input = document.getElementById("qo-input");
  const results = document.getElementById("qo-results");
  if (!input || !results) {
    overlay.remove();
    return;
  }
  let timer = null;
  input.addEventListener("input", () => {
    clearTimeout(timer);
    const q = input.value.trim();
    if (!q) {
      results.innerHTML = '<div style="padding:12px;text-align:center;color:var(--tm)">\u8F93\u5165\u6587\u4EF6\u540D\u641C\u7D22</div>';
      return;
    }
    timer = setTimeout(async () => {
      try {
        const ws = ExplorerService.getWorkspacePath();
        if (!ws) {
          results.innerHTML = '<div style="padding:12px;text-align:center;color:var(--tm)">\u672A\u9009\u62E9\u5DE5\u4F5C\u533A</div>';
          return;
        }
        const r = await fetch(`/api/search?root=${encodeURIComponent(ws)}&q=${encodeURIComponent(q)}&mode=filename`);
        const d = await r.json();
        if (!d.results || d.results.length === 0) {
          results.innerHTML = '<div style="padding:12px;text-align:center;color:var(--tm)">\u672A\u627E\u5230\u6587\u4EF6</div>';
          return;
        }
        results.innerHTML = d.results.map(
          (f) => `<div class="qo-item" data-path="${E(f.path)}">${ExplorerService.iconFor(f.name, false)} ${E(f.name)} <span style="color:var(--tm);font-size:.6rem;margin-left:auto">${E(f.path)}</span></div>`
        ).join("");
        results.querySelectorAll(".qo-item").forEach((el) => {
          el.addEventListener("click", async () => {
            const path = el.dataset.path || "";
            overlay.remove();
            try {
              const r2 = await fetch(`/api/file/read?root=${encodeURIComponent(ws)}&path=${encodeURIComponent(path)}`);
              const d2 = await r2.json();
              if (!r2.ok) return;
              const content = d2.encoding === "base64" ? "[\u4E8C\u8FDB\u5236\u6587\u4EF6\uFF0C\u65E0\u6CD5\u9884\u89C8]" : d2.content;
              openFileTab(path, content, path.split(".").pop() || "");
            } catch {
            }
          });
        });
      } catch {
        results.innerHTML = '<div style="padding:12px;text-align:center;color:var(--rs)">\u641C\u7D22\u5931\u8D25</div>';
      }
    }, 200);
  });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Escape") overlay.remove();
    if (e.key === "Enter") {
      const first = results?.querySelector(".qo-item");
      first?.click();
    }
  });
  setTimeout(() => input.focus(), 50);
  overlay.addEventListener("click", (ev) => {
    if (ev.target === overlay) overlay.remove();
  });
}
function showShortcutsHelp() {
  const existing = document.getElementById("shortcuts-modal");
  if (existing) {
    existing.remove();
    return;
  }
  const overlay = document.createElement("div");
  overlay.className = "modal-overlay";
  overlay.id = "shortcuts-modal";
  const shortcuts = [
    ["Ctrl+S", "\u4FDD\u5B58\u6587\u4EF6"],
    ["Ctrl+W", "\u5173\u95ED\u6807\u7B7E"],
    ["Ctrl+Tab", "\u4E0B\u4E00\u4E2A\u6807\u7B7E"],
    ["Ctrl+Shift+Tab", "\u4E0A\u4E00\u4E2A\u6807\u7B7E"],
    ["Ctrl+P", "\u5FEB\u901F\u6253\u5F00\u6587\u4EF6"],
    ["Ctrl+N", "\u65B0\u5EFA\u4F1A\u8BDD"],
    ["Ctrl+B", "\u5207\u6362\u4FA7\u680F"],
    ["Ctrl+`", "\u6253\u5F00\u7EC8\u7AEF"],
    ["F1", "\u5FEB\u6377\u952E\u5E2E\u52A9"]
  ];
  overlay.innerHTML = `<div class="modal-box" style="width:400px;height:auto;min-height:unset;padding:16px">
    <div class="modal-header" style="padding:0 0 12px;border:none">
      <span class="modal-title">\u5FEB\u6377\u952E</span>
      <button class="modal-close" onclick="this.closest('.modal-overlay').remove()">\u2715</button>
    </div>
    <div style="display:grid;grid-template-columns:auto 1fr;gap:6px 20px;font-size:.78rem">
      ${shortcuts.map(([k, d]) => `<span style="font-family:var(--fm);color:var(--am);white-space:nowrap">${k}</span><span style="color:var(--ts)">${d}</span>`).join("")}
    </div>
    <div style="margin-top:12px;padding-top:10px;border-top:1px solid var(--bd);font-size:.68rem;color:var(--tm);text-align:center">macOS \u4E0B Ctrl \u66FF\u6362\u4E3A Cmd</div>
  </div>`;
  document.body.appendChild(overlay);
  overlay.addEventListener("click", (ev) => {
    if (ev.target === overlay) overlay.remove();
  });
}
document.addEventListener("keydown", (e) => {
  const ctrl = e.ctrlKey || e.metaKey;
  const key = e.key.toLowerCase();
  if (ctrl && key === "s") {
    const fc = $("file-content");
    if (fc && fc.style.display !== "none") {
      e.preventDefault();
      saveCurrentFile();
      return;
    }
  }
  if (ctrl && key === "w") {
    e.preventDefault();
    const active = window.__state._activeFileTab;
    if (active) {
      closeFileTab(active);
      return;
    }
  }
  if (ctrl && key === "tab" && !e.shiftKey) {
    e.preventDefault();
    const tabs = window.__state._fileTabs;
    if (tabs.length === 0) return;
    const active = window.__state._activeFileTab;
    const idx = active ? tabs.findIndex((t) => t.id === active) : -1;
    const next = (idx + 1) % tabs.length;
    const target = tabs[next >= 0 ? next : 0]?.id;
    if (target) switchTab(target);
  }
  if (ctrl && key === "tab" && e.shiftKey) {
    e.preventDefault();
    const tabs = window.__state._fileTabs;
    if (tabs.length === 0) return;
    const active = window.__state._activeFileTab;
    const idx = active ? tabs.findIndex((t) => t.id === active) : 0;
    const prev = (idx - 1 + tabs.length) % tabs.length;
    const target = tabs[prev >= 0 ? prev : tabs.length - 1]?.id;
    if (target) switchTab(target);
  }
  if (ctrl && key === "n") {
    e.preventDefault();
    const sess = window.App?.Session;
    if (sess?.newSession) sess.newSession();
    else window.newSession?.();
  }
  if (ctrl && key === "b") {
    e.preventDefault();
    togglePanel(window.__state._activePanel);
  }
  if (ctrl && key === "p") {
    e.preventDefault();
    quickOpenFile();
  }
  if (key === "f1") {
    e.preventDefault();
    showShortcutsHelp();
  }
  if (ctrl && (key === "`" || key === "~")) {
    e.preventDefault();
    launchCli();
  }
});
window.saveCurrentFile = saveCurrentFile;
window.quickOpenFile = quickOpenFile;
{
  const U = window.App?.UI;
  if (U) {
    U.saveCurrentFile = saveCurrentFile;
  }
}
