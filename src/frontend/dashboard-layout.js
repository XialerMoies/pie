function layout() {
  $("app").innerHTML = buildTopBar() + buildSideBar() + buildSidePanel() + buildMainArea();
  initResizeHandle();
  renderTabs();
  document.body.style.background = "var(--bg)";
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
    <button class="b" data-side="chat" onclick="togglePanel('chat')" title="\u5BF9\u8BDD\u5386\u53F2">${S("imsg", 20)}</button>
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
      <div class="msgs" id="ms">${msgs()}</div>
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
  let scroll = "";
  scroll += `<div class="tb-item${active === null ? " active" : ""}" data-tab="chat" onclick="switchTab(null)"><span class="tb-icon">${S("ic", 13)}</span><span class="tb-label">\u5BF9\u8BDD</span></div>`;
  for (let i = 0; i < window.__state._fileTabs.length; i++) {
    const ft = window.__state._fileTabs[i];
    const icon = ExplorerService.iconFor(ft.label, false);
    scroll += `<div class="tb-item${ft.id === active ? " active" : ""}" draggable="true" data-tab-index="${i}" data-tab="${E(ft.id)}" onclick="switchTab('${E(ft.id)}')" oncontextmenu="tabContextMenu(event,'${E(ft.id)}')">
      <span class="tb-icon">${icon}</span>
      <span class="tb-label">${E(ft.label)}</span>
      <span class="tb-close" onclick="event.stopPropagation();closeFileTab('${E(ft.id)}')">\u2715</span>
    </div>`;
  }
  el.innerHTML = `<div class="tb-scroll">${scroll}</div>${hasTabs ? '<div class="tb-more" onclick="tabMoreMenu(event)" title="\u66F4\u591A\u64CD\u4F5C">\xB7\xB7\xB7</div>' : ""}`;
  if (hasTabs) setupTabDrag(el);
}
const FILE_TABS_KEY = "file-tabs";
const LAST_ACTIVE_KEY = "last-active-tab";
const LAST_SESSION_KEY = "last-session-id";
function switchTab(fileId) {
  window.__state._activeFileTab = fileId;
  const ms = $("ms");
  const fc = $("file-content");
  const fi = $("fi");
  const mc = document.querySelector(".mc");
  if (fileId === null) {
    if (ms) ms.style.display = "";
    if (fc) fc.style.display = "none";
    if (fi) fi.style.display = "";
    mc?.classList.remove("editing");
  } else {
    if (ms) ms.style.display = "none";
    if (fc) fc.style.display = "";
    if (fi) fi.style.display = "none";
    mc?.classList.add("editing");
    const tab = window.__state._fileTabs.find((t) => t.id === fileId);
    const editorEl = $("fc-editor");
    if (editorEl && tab) {
      const m = window.__monaco;
      if (m) {
        if (!editorEl.dataset.monacoReady) {
          editorEl.innerHTML = "";
          m.create(editorEl);
          editorEl.dataset.monacoReady = "1";
        }
        m.setValue(tab.content);
        m.setLang(tab.id);
      }
    }
  }
  renderTabs();
  try {
    localStorage.setItem(LAST_ACTIVE_KEY, fileId ?? "__chat__");
  } catch {
  }
}
function _saveFileTabs() {
  try {
    localStorage.setItem(FILE_TABS_KEY, JSON.stringify(
      window.__state._fileTabs.map((t) => ({ id: t.id, label: t.label, lang: t.lang }))
    ));
  } catch {
  }
}
function openFileTab(id, content, lang) {
  const label = id.split("/").pop() || id;
  const existing = window.__state._fileTabs.findIndex((t) => t.id === id);
  if (existing !== -1) {
    window.__state._fileTabs[existing].content = content;
    window.__state._fileTabs[existing].lang = lang || "";
  } else {
    window.__state._fileTabs.push({ id, label, content, lang: lang || "" });
  }
  _saveFileTabs();
  switchTab(id);
}
function closeFileTab(id) {
  const idx = window.__state._fileTabs.findIndex((t) => t.id === id);
  if (idx === -1) return;
  const monaco = window.__monaco;
  if (monaco?.tsCloseFile) monaco.tsCloseFile(id);
  window.__state._fileTabs.splice(idx, 1);
  _saveFileTabs();
  if (window.__state._activeFileTab === id) {
    switchTab(window.__state._fileTabs.length > 0 ? window.__state._fileTabs[Math.min(idx, window.__state._fileTabs.length - 1)].id : null);
  } else {
    renderTabs();
  }
}
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
    } else {
      if (status) status.textContent = "\u4FDD\u5B58\u5931\u8D25: " + d.error;
    }
  }).catch(() => {
    if (status) status.textContent = "\u4FDD\u5B58\u5931\u8D25";
  });
}
document.addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === "s") {
    const fc = $("file-content");
    if (fc && fc.style.display !== "none") {
      e.preventDefault();
      saveCurrentFile();
    }
  }
});
window.saveCurrentFile = saveCurrentFile;
function restoreFileTabs() {
  try {
    const intendedTarget = localStorage.getItem(LAST_ACTIVE_KEY) ?? "__chat__";
    const raw = localStorage.getItem(FILE_TABS_KEY);
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
    if (target === "__chat__" || !target) {
      switchTab(null);
      setTimeout(() => {
        window.restoreLastSession?.();
      }, 100);
    } else {
      const exists = window.__state._fileTabs.some((t) => t.id === target);
      if (exists) switchTab(target);
      else {
        switchTab(null);
        setTimeout(() => {
          window.restoreLastSession?.();
        }, 100);
      }
    }
  } catch {
    switchTab(null);
  }
}
document.addEventListener("DOMContentLoaded", () => setTimeout(restoreFileTabs, 500));
function togglePanel(name) {
  const si = $("si"), pc = $("pc");
  if (!si || !pc) return;
  if (window.__state._activePanel === name && !si.classList.contains("closed")) {
    si.classList.add("closed");
    document.querySelectorAll(".sbar .b[data-side]").forEach((b) => b.classList.remove("on"));
    return;
  }
  window.__state._activePanel = name;
  si.classList.remove("closed");
  si.style.width = "260px";
  document.querySelectorAll(".sbar .b[data-side]").forEach((b) => b.classList.toggle("on", b.dataset.side === name));
  renderPanel(name, pc);
}
function initResizeHandle() {
  const handle = $("si-handle"), si = $("si");
  if (!handle || !si) return;
  handle.onmousedown = function(e) {
    e.preventDefault();
    si.classList.add("dragging");
    const startX = e.clientX, startW = si.offsetWidth;
    const appRect = document.querySelector(".app").getBoundingClientRect();
    const maxW = appRect.width * 0.8 - 60;
    function onMove(ev) {
      let newW = startW + (ev.clientX - startX);
      newW = Math.max(0, Math.min(newW, maxW));
      si.style.width = newW + "px";
      si.classList.remove("closed");
    }
    function onUp() {
      si.classList.remove("dragging");
      if (si.offsetWidth < 20) {
        si.classList.add("closed");
        si.style.width = "";
      }
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    }
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  };
}
function renderPanel(name, pc) {
  if (!pc) pc = $("pc");
  if (!pc) return;
  const paneFn = getPane(name);
  if (paneFn) {
    paneFn(pc);
    return;
  }
  pc.innerHTML = `<div class="sg-item dim">\u9762\u677F "${E(name)}" \u672A\u6CE8\u518C</div>`;
}
function sinfoHTML() {
  const stD = window.__state.D;
  if (!stD) return '<div class="sg" style="padding:12px;font-size:.7rem;color:var(--tm)">\u52A0\u8F7D\u4E2D...</div>';
  const ts = (stD.tools || ["read", "write", "edit", "bash"]).slice(0, 18);
  const act = (stD.activeTools || stD.tools || []).length;
  return `<div class="sg"><div class="sg-t">\u6A21\u578B</div>
    <div class="sg-r" data-model="provider"><span class="l">\u63D0\u4F9B\u5546</span><span class="v">${E(stD.modelProvider || "N/A")}</span></div>
    <div class="sg-r" data-model="id"><span class="l">\u6A21\u578B</span><span class="v" title="${E(stD.modelId || "")}">${E((stD.modelId || "").split("/").pop() || "N/A")}</span></div>
    <div class="sg-r"><span class="l">\u4E0A\u4E0B\u6587</span><span class="v">${E(stD.modelContextWindow || "N/A")}</span></div>
    <div class="sg-r"><span class="l">\u8F93\u51FA\u4E0A\u9650</span><span class="v">${E(stD.modelMaxTokens || "N/A")}</span></div>
    <div class="sg-r"><span class="l">\u601D\u8003</span><span class="v p">${E(stD.thinkingLevel || "off")}</span></div></div>
    <div class="sg"><div class="sg-t">\u4F1A\u8BDD</div>
    <div class="sg-r"><span class="l">\u8FD0\u884C</span><span class="v">${F(stD.runtime || 0)}</span></div>
    <div class="sg-r"><span class="l">\u6D88\u606F</span><span class="v">${stD.messagesCount || 0}</span></div>
    <div class="sg-r"><span class="l">\u72B6\u6001</span><span class="v p">${stD.isIdle === false ? "\u54CD\u5E94\u4E2D" : "\u7A7A\u95F2"}</span></div></div>
    <div class="sg"><div class="sg-t">\u5DE5\u5177 (${act})</div>
    ${ts.map((t) => '<span class="sg-tag">' + E(t) + "</span>").join("")}${ts.length < act ? '<span class="sg-tag" style="opacity:.5">+' + (act - ts.length) + "</span>" : ""}</div>
    <div class="sg"><div class="sg-t">\u5B58\u50A8</div><div class="sg-p">${E(stD.dataDir || "data/")}</div></div>`;
}
function refreshSinfo() {
  const si = $("si");
  if (si) si.innerHTML = sinfoHTML();
  const modelEls = si?.querySelectorAll(".sg-r[data-model]");
  if (modelEls) modelEls.forEach((el) => {
    el.style.cursor = "pointer";
    el.onclick = showModelPicker;
  });
}
function setupTabDrag(el) {
  const scroll = el.querySelector(".tb-scroll");
  if (!scroll) return;
  let dragIdx = -1;
  function clearIndicators() {
    scroll.querySelectorAll(".tb-drop").forEach((e) => e.classList.remove("tb-drop"));
  }
  scroll.addEventListener("dragstart", (e) => {
    const item = e.target.closest(".tb-item");
    if (!item) return;
    dragIdx = parseInt(item.dataset.tabIndex || "-1");
    e.dataTransfer?.setData("text/tab-index", String(dragIdx));
    e.dataTransfer.effectAllowed = "move";
    item.style.opacity = "0.3";
  });
  scroll.addEventListener("dragend", () => {
    clearIndicators();
    scroll.querySelectorAll(".tb-item").forEach((el2) => el2.style.opacity = "");
    dragIdx = -1;
  });
  scroll.addEventListener("dragover", (e) => {
    e.preventDefault();
    clearIndicators();
    const items = scroll.querySelectorAll(".tb-item");
    for (let i = 0; i < items.length; i++) {
      const r = items[i].getBoundingClientRect();
      const midX = r.left + r.width / 2;
      if (e.clientX < midX) {
        items[i].classList.add("tb-drop");
        return;
      }
    }
    items[items.length - 1]?.classList.add("tb-drop");
  });
  scroll.addEventListener("drop", (e) => {
    e.preventDefault();
    clearIndicators();
    const srcIdx = parseInt(e.dataTransfer?.getData("text/tab-index") || "-1");
    if (srcIdx < 0) return;
    const items = scroll.querySelectorAll(".tb-item");
    let dstIdx = items.length - 1;
    for (let i = 0; i < items.length; i++) {
      const r = items[i].getBoundingClientRect();
      if (e.clientX < r.left + r.width / 2) {
        dstIdx = i;
        break;
      }
    }
    const tabs = window.__state._fileTabs;
    if (srcIdx === dstIdx) return;
    const [moved] = tabs.splice(srcIdx, 1);
    tabs.splice(dstIdx > srcIdx ? dstIdx - 1 : dstIdx, 0, moved);
    renderTabs();
  });
}
document.addEventListener("wheel", (e) => {
  const target = e.target.closest(".tb-scroll");
  if (!target) return;
  target.scrollLeft += e.deltaY;
}, { passive: true });
function tabContextMenu(e, id) {
  e.preventDefault();
  document.querySelectorAll(".ctx-menu").forEach((el) => el.remove());
  const tabs = window.__state._fileTabs;
  const idx = tabs.findIndex((t) => t.id === id);
  const menu = document.createElement("div");
  menu.className = "ctx-menu";
  menu.style.left = e.clientX + "px";
  menu.style.top = e.clientY + "px";
  const items = [
    { label: "\u5173\u95ED", action: () => closeFileTab(id) },
    { label: "\u5173\u95ED\u5176\u4ED6", action: () => {
      for (let i = tabs.length - 1; i >= 0; i--) if (tabs[i].id !== id) closeFileTab(tabs[i].id);
    } },
    { label: "\u5173\u95ED\u53F3\u4FA7", action: () => {
      for (let i = tabs.length - 1; i > idx; i--) closeFileTab(tabs[i].id);
    } },
    { label: "\u5173\u95ED\u6240\u6709", action: () => {
      for (let i = tabs.length - 1; i >= 0; i--) closeFileTab(tabs[i].id);
    } },
    { label: "-", action: () => {
    } },
    { label: "\u590D\u5236\u8DEF\u5F84", action: () => {
      navigator.clipboard.writeText(id).then(() => toast("\u5DF2\u590D\u5236\u8DEF\u5F84")).catch(() => toast("\u590D\u5236\u5931\u8D25", "error"));
    } }
  ];
  for (const a of items) {
    if (a.label === "-") {
      const s = document.createElement("div");
      s.className = "ctx-sep";
      menu.appendChild(s);
      continue;
    }
    const item = document.createElement("div");
    item.className = "ctx-item";
    item.textContent = a.label;
    item.onclick = () => {
      menu.remove();
      a.action();
    };
    menu.appendChild(item);
  }
  document.body.appendChild(menu);
  setTimeout(() => document.addEventListener("click", () => menu.remove(), { once: true }), 0);
}
function tabMoreMenu(e) {
  document.querySelectorAll(".ctx-menu").forEach((el) => el.remove());
  const tabs = window.__state._fileTabs;
  const maxH = Math.min(tabs.length * 28 + 70, 450);
  const menu = document.createElement("div");
  menu.className = "ctx-menu";
  let x = e.clientX, y = e.clientY + 4;
  const mw = 200;
  if (x + mw > window.innerWidth) x = window.innerWidth - mw - 8;
  if (y + maxH > window.innerHeight) y = window.innerHeight - maxH - 4;
  menu.style.left = x + "px";
  menu.style.top = y + "px";
  menu.style.maxHeight = maxH + "px";
  menu.style.overflowY = "auto";
  const actions = [
    { label: "\u5173\u95ED\u5168\u90E8\u6807\u7B7E\u9875", fn: () => {
      for (let i = tabs.length - 1; i >= 0; i--) closeFileTab(tabs[i].id);
    } },
    { label: "\u5173\u95ED\u5DF2\u4FDD\u5B58\u6807\u7B7E\u9875", fn: () => {
      for (let i = tabs.length - 1; i >= 0; i--) closeFileTab(tabs[i].id);
    } }
  ];
  for (const a of actions) {
    const item = document.createElement("div");
    item.className = "ctx-item";
    item.textContent = a.label;
    item.onclick = () => {
      menu.remove();
      a.fn();
    };
    menu.appendChild(item);
  }
  if (tabs.length > 0) {
    const sep = document.createElement("div");
    sep.className = "ctx-sep";
    menu.appendChild(sep);
    for (const ft of tabs) {
      const item = document.createElement("div");
      item.className = "ctx-tab-item";
      const active = ft.id === window.__state._activeFileTab;
      if (active) item.style.color = "var(--am)";
      item.innerHTML = `<span class="ctx-tab-icon">${ExplorerService.iconFor(ft.label, false)}</span><span class="ctx-tab-label">${E(ft.label)}</span><span class="ctx-tab-close">\u2715</span>`;
      item.querySelector(".ctx-tab-close").addEventListener("click", (ce) => {
        ce.stopPropagation();
        menu.remove();
        closeFileTab(ft.id);
      });
      item.addEventListener("click", () => {
        menu.remove();
        switchTab(ft.id);
      });
      menu.appendChild(item);
    }
  }
  document.body.appendChild(menu);
  setTimeout(() => document.addEventListener("click", () => menu.remove(), { once: true }), 0);
}
window.tabContextMenu = tabContextMenu;
window.tabMoreMenu = tabMoreMenu;
window.layout = layout;
window.togglePanel = togglePanel;
window.renderPanel = renderPanel;
window.sinfoHTML = sinfoHTML;
window.refreshSinfo = refreshSinfo;
window.renderTabs = renderTabs;
window.switchTab = switchTab;
window.openFileTab = openFileTab;
window.closeFileTab = closeFileTab;
const AppLayout = window.App?.UI;
if (AppLayout) {
  AppLayout.layout = layout;
  AppLayout.togglePanel = togglePanel;
  AppLayout.renderPanel = renderPanel;
  AppLayout.sinfoHTML = sinfoHTML;
  AppLayout.refreshSinfo = refreshSinfo;
  AppLayout.renderTabs = renderTabs;
  AppLayout.switchTab = switchTab;
  AppLayout.openFileTab = openFileTab;
  AppLayout.closeFileTab = closeFileTab;
  AppLayout.saveCurrentFile = saveCurrentFile;
}
