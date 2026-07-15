const CHAT_TAB_OPEN_KEY = "chat-tab-open";
function isChatTabOpen() {
  try {
    return localStorage.getItem(CHAT_TAB_OPEN_KEY) !== "0";
  } catch {
    return true;
  }
}
function hasOpenSessionTabs() {
  try {
    const raw = localStorage.getItem("session-tabs");
    const ids = raw ? JSON.parse(raw) : [];
    return Array.isArray(ids) && ids.length > 0;
  } catch {
    return false;
  }
}
function closeChatTab() {
  try {
    localStorage.setItem(CHAT_TAB_OPEN_KEY, "0");
  } catch {
  }
  if (window.__state._activeFileTab === null && window.__state._fileTabs.length > 0) {
    switchTab(window.__state._fileTabs[0].id);
    return;
  }
  renderTabs();
}
function layout() {
  $("app").innerHTML = buildTopBar() + buildSideBar() + buildSidePanel() + buildMainArea();
  initResizeHandle();
  renderTabs();
  document.querySelectorAll(".sbar .b[data-side]").forEach((b) => b.classList.toggle("on", b.dataset.side === window.__state._activePanel));
  const pc = $("pc");
  if (pc) renderPanel(window.__state._activePanel, pc);
  bind();
}
function buildTopBar() {
  return `<div class="topbar">
    <div class="nm"><span>PI</span></div>
    <div class="top-tabs">
      <button class="top-tab" onclick="toggleFileMenu(event)">\u6587\u4EF6</button>
    </div>
    <div class="win-controls">
      <button class="win-btn" onclick="winCtrl('minimize')">\u2500</button>
      <button class="win-btn" onclick="winCtrl('maximize')">\u25A1</button>
      <button class="win-btn close" onclick="winCtrl('close')">\u2715</button>
    </div>
  </div>`;
}
function buildSideBar() {
  return `<div class="sbar">
    <button class="b" data-side="explorer" onclick="togglePanel('explorer')" title="\u8D44\u6E90\u7BA1\u7406\u5668">${S("ifolder", 20)}</button>
    <button class="b" data-side="chat" onclick="togglePanel('chat')" title="\u4EFB\u52A1\u7EBF\u7A0B">${S("imsg", 20)}</button>
    <button class="b" data-side="search" onclick="togglePanel('search')" title="\u641C\u7D22">${S("isearch", 20)}</button>
    <button class="b" data-side="git" onclick="togglePanel('git')" title="Git">${S("igit", 20)}</button>
    <div class="spcr"></div>
    <div class="bb">
      <button class="b" title="CLI" onclick="launchCli()">${S("iterm", 20)}</button>
      <button class="b" title="\u8BBE\u7F6E" onclick="openSettingsModal()">${S("is", 20)}</button>
    </div>
  </div>`;
}
function buildSidePanel() {
  return `<div class="sinfo" id="si"><div class="panel-content" id="pc"></div><div class="sinfo-handle" id="si-handle"></div></div>`;
}
function buildMainArea() {
  return `<div class="main">
    <div class="main-tabs" id="main-tabs"></div>
    <div class="mc">
      <div class="msgs" id="ms">${window.msgs ? window.msgs() : ""}</div>
      <div class="file-content" id="file-content" style="display:none">
        <div class="fc-toolbar"><span class="fc-status" id="fc-status"></span></div>
        <div class="fc-editor" id="fc-editor"></div>
      </div>
      <div class="fi-area" id="fi">
        <div class="fi-token-box" id="fi-token">
          <div class="fi-tk-top"><span class="fi-tk-hd">Tokens</span><span class="fi-tk-ctx" id="fi-tk-ctx">\u2014 / \u2014</span></div>
          <div class="fi-tk-bar"><div class="fi-tk-fill" id="fi-tk-fill" style="width:0%"></div></div>
          <div class="fi-tk-grid" id="fi-tk-grid">
            <span class="fi-tk-l">\u8F93\u5165</span><span class="fi-tk-v" id="fi-tk-in">\u2014</span>
            <span class="fi-tk-l">\u8F93\u51FA</span><span class="fi-tk-v" id="fi-tk-out">\u2014</span>
            <span class="fi-tk-l">\u547D\u4E2D</span><span class="fi-tk-v" id="fi-tk-ch">\u2014</span>
            <span class="fi-tk-l">\u672A\u547D</span><span class="fi-tk-v" id="fi-tk-cm">\u2014</span>
            <span class="fi-tk-l">\u547D\u4E2D\u7387</span><span class="fi-tk-v" id="fi-tk-rate">\u2014</span>
            <span class="fi-tk-sep"></span>
            <span class="fi-tk-l">\u8D39\u7528</span><span class="fi-tk-v" id="fi-tk-cost">\u2014</span>
          </div>
        </div>
        <div class="fi-box" id="fi-box">
          <div class="fi-drop-zone" id="fi-drop-zone">\u677E\u5F00\u6DFB\u52A0\u6587\u4EF6\u5F15\u7528</div>
          <div class="fi-slash" id="fi-slash" style="display:none">
            <div class="fi-slash-item" data-cmd="/explain"><span class="cmd">/explain</span> <span class="desc">\u89E3\u91CA\u4EE3\u7801</span></div>
            <div class="fi-slash-item" data-cmd="/refactor"><span class="cmd">/refactor</span> <span class="desc">\u91CD\u6784\u5EFA\u8BAE</span></div>
            <div class="fi-slash-item" data-cmd="/test"><span class="cmd">/test</span> <span class="desc">\u751F\u6210\u6D4B\u8BD5</span></div>
            <div class="fi-slash-item" data-cmd="/optimize"><span class="cmd">/optimize</span> <span class="desc">\u4F18\u5316\u6027\u80FD</span></div>
            <div class="fi-slash-item" data-cmd="/audit"><span class="cmd">/audit</span> <span class="desc">\u5B89\u5168\u5BA1\u8BA1</span></div>
            <div class="fi-slash-item" data-cmd="/fix"><span class="cmd">/fix</span> <span class="desc">\u4FEE\u590D\u95EE\u9898</span></div>
            <div class="fi-slash-divider"></div>
            <div class="fi-slash-item" data-cmd="/clear"><span class="cmd">/clear</span> <span class="desc">\u6E05\u9664\u7F13\u5B58</span></div>
          </div>
          <div class="fi-attach-bar" id="fi-attach-bar" style="display:none"></div>
          <textarea id="ci" rows="1" placeholder="\u8F93\u5165\u6D88\u606F...\uFF08\u8F93\u5165 / \u4F7F\u7528\u5FEB\u6377\u547D\u4EE4\uFF09" ${window.__state.IL ? "disabled" : ""}></textarea>
          <div class="fi-divider"></div>
          <div class="fi-actions-bar">
            <button class="fi-abtn fi-model" id="fi-model-btn" title="\u5207\u6362\u6A21\u578B"><span id="fi-model-name">claude-sonnet</span> <span class="fi-arrow">\u25BE</span></button>
            <button class="fi-abtn fi-mode" id="fi-mode-btn" title="\u5207\u6362\u6A21\u5F0F"><span id="fi-mode-name">\u81EA\u52A8</span> <span class="fi-arrow">\u25BE</span></button>
            <button class="fi-abtn fi-file" id="fi-file-btn" title="\u6DFB\u52A0\u672C\u673A\u6587\u4EF6">${window.S("iplus", 14)}</button>
            <span class="fi-spacer"></span>
            <button id="cs" class="fi-send-btn" title="${window.__state.IL ? "\u4E2D\u6B62" : "\u53D1\u9001\u6D88\u606F"}">${window.S("iup", 16)}</button>
          </div>
        </div>
      </div>
    </div>
  </div>`;
}
function renderTabs() {
  const el = $("main-tabs");
  if (!el) return;
  const active = window.__state._activeFileTab;
  const hasTabs = window.__state._fileTabs.length > 0;
  const chatOpen = isChatTabOpen();
  const sessionOpen = hasOpenSessionTabs();
  let scroll = "";
  if (chatOpen) {
    scroll += `<div class="tb-item${active === null && !sessionOpen ? " active" : ""}" data-tab="chat" onclick="switchTab(null)">
      <span class="tb-icon">${S("ic", 13)}</span>
      <span class="tb-label">\u5BF9\u8BDD</span>
      <span class="tb-close" onclick="event.stopPropagation();closeChatTab()">\u2715</span>
    </div>`;
  }
  for (let i = 0; i < window.__state._fileTabs.length; i++) {
    const ft = window.__state._fileTabs[i];
    const icon = ExplorerService.iconFor(ft.label, false);
    scroll += `<div class="tb-item${ft.id === active ? " active" : ""}" draggable="true" data-tab-index="${i}" data-tab="${E(ft.id)}" onclick="switchTab('${E(ft.id)}')" oncontextmenu="tabContextMenu(event,'${E(ft.id)}')">
      <span class="tb-icon">${icon}</span>
      <span class="tb-label">${E(ft.label)}</span>
      <span class="tb-close" onclick="event.stopPropagation();closeFileTab('${E(ft.id)}')">\u2715</span>
    </div>`;
  }
  const sessionTabs = `<div class="session-tabs empty" id="session-tabs"></div>`;
  el.innerHTML = `${sessionTabs}<div class="tb-scroll">${scroll}</div>${hasTabs ? '<div class="tb-more" onclick="tabMoreMenu(event)" title="\u66F4\u591A\u64CD\u4F5C">\xB7\xB7\xB7</div>' : ""}`;
  if (hasTabs) setupTabDrag(el);
  window.App?.Session?.renderSessionTabs?.(localStorage.getItem("active-session-tab") || void 0);
}
document.addEventListener("wheel", (e) => {
  const target = e.target.closest(".tb-scroll");
  if (!target) return;
  target.scrollLeft += e.deltaY;
}, { passive: true });
function restoreFileTabs() {
  try {
    const intendedTarget = localStorage.getItem("last-active-tab") ?? "__chat__";
    const raw = localStorage.getItem("file-tabs");
    if (!raw) {
      restoreActiveTabWith(intendedTarget);
      return;
    }
    const saved = JSON.parse(raw);
    if (!Array.isArray(saved)) {
      restoreActiveTabWith(intendedTarget);
      return;
    }
    window.__state._fileTabs = [];
    let loaded = 0;
    const total = saved.length;
    for (const st of saved) {
      const ws = ExplorerService.getWorkspacePath();
      if (ws) {
        fetch(`/api/file/read?root=${encodeURIComponent(ws)}&path=${encodeURIComponent(st.id)}`).then((r) => r.ok ? r.json() : null).then((d) => {
          if (!d) return;
          const content = d.encoding === "base64" ? "[\u4E8C\u8FDB\u5236\u6587\u4EF6\uFF0C\u65E0\u6CD5\u9884\u89C8]" : d.content;
          openFileTab(st.id, content, st.lang || "");
        }).catch(() => {
        }).finally(() => {
          loaded++;
          if (loaded >= total) restoreActiveTabWith(intendedTarget);
        });
      } else {
        loaded++;
        if (loaded >= total) restoreActiveTabWith(intendedTarget);
      }
    }
    if (total === 0) restoreActiveTabWith(intendedTarget);
  } catch {
  }
}
function restoreActiveTabWith(target) {
  try {
    if (target === "__chat__" || !target) switchTab(null);
    else {
      const exists = window.__state._fileTabs.some((t) => t.id === target);
      if (exists) switchTab(target);
      else switchTab(null);
    }
  } catch {
    switchTab(null);
  }
}
document.addEventListener("DOMContentLoaded", () => {
  setTimeout(restoreFileTabs, 500);
  const si = $("si");
  if (si) {
    try {
      const savedWidth = parseInt(localStorage.getItem("panel-width") || "", 10);
      if (savedWidth > 50) si.style.width = savedWidth + "px";
    } catch {
    }
  }
});
window.layout = layout;
window.renderTabs = renderTabs;
window.closeChatTab = closeChatTab;
{
  const U = window.App?.UI;
  if (U) {
    U.layout = layout;
    U.renderTabs = renderTabs;
  }
}
