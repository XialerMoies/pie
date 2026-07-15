let _loadRetries = 0;
const MAX_LOAD_RETRIES = 8;
let _lastSessionRenderKey = "";
const SESSION_TABS_KEY = "session-tabs";
const SESSION_TAB_LABELS_KEY = "session-tab-labels";
const ACTIVE_SESSION_TAB_KEY = "active-session-tab";
const DRAFT_SESSION_PREFIX = "draft:";
let _sessionTabLookup = /* @__PURE__ */ new Map();
function isDraftSessionId(id) {
  return typeof id === "string" && id.startsWith(DRAFT_SESSION_PREFIX);
}
function createDraftSessionId() {
  return DRAFT_SESSION_PREFIX + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8);
}
function normalizeSessionTabIds(ids) {
  const seen = /* @__PURE__ */ new Set();
  const result = [];
  for (const id of ids) {
    if (typeof id !== "string" || !id || seen.has(id)) continue;
    seen.add(id);
    result.push(id);
  }
  return result;
}
function readSessionTabIds() {
  const stateIds = window.__state._sessionTabs;
  if (Array.isArray(stateIds) && stateIds.length > 0) return stateIds;
  try {
    const raw = localStorage.getItem(SESSION_TABS_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    if (Array.isArray(parsed)) {
      const ids = normalizeSessionTabIds(parsed);
      window.__state._sessionTabs = ids;
      return ids;
    }
  } catch {
  }
  window.__state._sessionTabs = [];
  return [];
}
function writeSessionTabIds(ids) {
  const next = normalizeSessionTabIds(ids);
  window.__state._sessionTabs = next;
  try {
    localStorage.setItem(SESSION_TABS_KEY, JSON.stringify(next));
  } catch {
  }
}
function getActiveSessionTabId() {
  try {
    const id = localStorage.getItem(ACTIVE_SESSION_TAB_KEY);
    if (!id) return null;
    if (readSessionTabIds().includes(id)) return id;
    localStorage.removeItem(ACTIVE_SESSION_TAB_KEY);
  } catch {
  }
  return null;
}
function setActiveSessionTabId(id) {
  try {
    if (id) localStorage.setItem(ACTIVE_SESSION_TAB_KEY, id);
    else localStorage.removeItem(ACTIVE_SESSION_TAB_KEY);
  } catch {
  }
}
function readOpenRealSessionIds() {
  return new Set(readSessionTabIds().filter((id) => !isDraftSessionId(id)));
}
function readSessionTabLabels() {
  try {
    const raw = localStorage.getItem(SESSION_TAB_LABELS_KEY);
    const parsed = raw ? JSON.parse(raw) : {};
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}
function writeSessionTabLabel(id, label) {
  if (!id || !label.trim()) return;
  const labels = readSessionTabLabels();
  labels[id] = label.trim();
  try {
    localStorage.setItem(SESSION_TAB_LABELS_KEY, JSON.stringify(labels));
  } catch {
  }
}
function removeSessionTabLabel(id) {
  const labels = readSessionTabLabels();
  if (!(id in labels)) return;
  delete labels[id];
  try {
    localStorage.setItem(SESSION_TAB_LABELS_KEY, JSON.stringify(labels));
  } catch {
  }
}
function commitSessionTab(draftId, sessionId, label) {
  if (!sessionId) return;
  const ids = readSessionTabIds();
  const index = ids.indexOf(draftId);
  const next = index >= 0 ? ids.map((id) => id === draftId ? sessionId : id) : [...ids, sessionId];
  writeSessionTabIds(next);
  const labels = readSessionTabLabels();
  const nextLabel = (label || labels[draftId] || "\u65B0\u4F1A\u8BDD").trim();
  delete labels[draftId];
  if (nextLabel) labels[sessionId] = nextLabel;
  try {
    localStorage.setItem(SESSION_TAB_LABELS_KEY, JSON.stringify(labels));
  } catch {
  }
  setActiveSessionTabId(sessionId);
  try {
    localStorage.setItem("last-session-id", sessionId);
  } catch {
  }
  renderSessionTabs(sessionId);
}
function rememberSessionTab(id) {
  if (!id) return;
  const ids = readSessionTabIds();
  if (!ids.includes(id)) writeSessionTabIds([...ids, id]);
}
function forgetSessionTab(id) {
  const ids = readSessionTabIds();
  const index = ids.indexOf(id);
  if (index < 0) return ids[0] || null;
  const next = ids.filter((tabId) => tabId !== id);
  writeSessionTabIds(next);
  removeSessionTabLabel(id);
  return next[Math.min(index, next.length - 1)] || next[index - 1] || null;
}
function indexSessionTabs(sessions, others) {
  const next = /* @__PURE__ */ new Map();
  for (const session of sessions) next.set(session.id, session);
  for (const project of others) for (const session of project.sessions) next.set(session.id, session);
  _sessionTabLookup = next;
}
function sessionTabLabel(id) {
  if (isDraftSessionId(id)) return readSessionTabLabels()[id] || "\u65B0\u4F1A\u8BDD";
  const cached = readSessionTabLabels()[id];
  if (cached) return cached;
  const session = _sessionTabLookup.get(id);
  if (session?.name && session.name.trim() !== "\u65B0\u4F1A\u8BDD") return session.name.trim();
  return "\u65B0\u4F1A\u8BDD";
}
function focusChatView() {
  if (window.__state._activeFileTab === null) return;
  if (window.switchTab) {
    window.switchTab(null);
    return;
  }
  window.__state._activeFileTab = null;
  const ms = $("ms");
  const fc = $("file-content");
  const fi = $("fi");
  const mc = document.querySelector(".mc");
  if (ms) ms.style.display = "";
  if (fc) fc.style.display = "none";
  if (fi) fi.style.display = "";
  mc?.classList.remove("editing");
}
function renderSessionTabs(activeId) {
  const el = $("session-tabs");
  if (!el) return;
  const currentId = activeId !== void 0 ? activeId : getActiveSessionTabId() || "";
  const ids = readSessionTabIds();
  writeSessionTabIds(ids);
  if (ids.length === 0) {
    el.classList.add("empty");
    el.innerHTML = "";
    return;
  }
  el.classList.remove("empty");
  const tabs = ids.map((id) => {
    const session = _sessionTabLookup.get(id);
    const active = id === currentId;
    const running = Boolean(session?.isRunning);
    const error = Boolean(session?.hasError);
    const className = `tb-item session-tab${active ? " active" : ""}${running ? " running" : ""}${error ? " error" : ""}`;
    return `<div class="${className}" title="${E(sessionTabLabel(id))}" onclick="switchSession('${id}')">
      <span class="tb-icon">${S("ic", 13)}</span>
      <span class="tb-label">${E(sessionTabLabel(id))}</span>
      <span class="tb-close" title="\u5173\u95ED\u6807\u7B7E" aria-label="\u5173\u95ED\u6807\u7B7E" onclick="event.stopPropagation();closeSessionTab('${id}')">\u2715</span>
    </div>`;
  }).join("");
  el.innerHTML = `<div class="session-tab-scroll">${tabs}</div>`;
}
function activateDraftSession(id) {
  rememberSessionTab(id);
  setActiveSessionTabId(id);
  window.__state.M = [];
  window.__state.IL = false;
  App.Chat?.clearAttachments?.();
  const oldCS = window.__state.CS;
  if (oldCS) {
    oldCS.onmessage = null;
    oldCS.onerror = null;
    oldCS.close();
    window.__state.CS = null;
  }
  focusChatView();
  const ci = $("ci");
  if (ci) {
    ci.value = "";
    ci.style.height = "auto";
  }
  const msgsEl = $("ms");
  if (msgsEl) msgsEl.innerHTML = '<div class="wl"><h2>\u{1F4AC} \u65B0\u4F1A\u8BDD</h2><p>\u8F93\u5165\u6D88\u606F\u5F00\u59CB\u65B0\u7684\u5BF9\u8BDD</p></div>';
  renderSessionTabs(id);
  loadSessions();
}
function closeSessionTab(id) {
  const activeId = getActiveSessionTabId() || "";
  const nextId = forgetSessionTab(id);
  if (id === activeId) {
    if (nextId) switchSession(nextId);
    else {
      setActiveSessionTabId(null);
      window.__state.M = [];
      window.__state.IL = false;
      renderSessionTabs("");
      const msgsEl = $("ms");
      if (msgsEl) msgsEl.innerHTML = window.msgs ? window.msgs() : "";
      loadSessions();
    }
    return;
  }
  renderSessionTabs(activeId);
}
function parseSessionTime(value) {
  if (!value) return 0;
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : 0;
}
function formatSessionTime(value) {
  const time = parseSessionTime(value);
  if (!time) return "\u65F6\u95F4\u672A\u77E5";
  const diff = Date.now() - time;
  const minute = 60 * 1e3;
  const hour = 60 * minute;
  const day = 24 * hour;
  if (diff < minute) return "\u521A\u521A";
  if (diff < hour) return `${Math.max(1, Math.floor(diff / minute))} \u5206\u949F\u524D`;
  if (diff < day) return `${Math.max(1, Math.floor(diff / hour))} \u5C0F\u65F6\u524D`;
  if (diff < 7 * day) return `${Math.max(1, Math.floor(diff / day))} \u5929\u524D`;
  return new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit" }).format(new Date(time));
}
function getSessionTimeValue(session) {
  return parseSessionTime(session.updatedAt || session.createdAt);
}
function isActiveSession(session, openSessionIds) {
  return openSessionIds.has(session.id);
}
function deriveThreadStatus(session, activeId) {
  if (session.archived) return "archived";
  if (session.hasError) return "error";
  if (session.isRunning) return "running";
  if (session.pinned) return "pinned";
  if (session.messageCount <= 0) return "empty";
  return "success";
}
function threadStatusLabel(status) {
  if (status === "running") return "\u8FD0\u884C\u4E2D";
  if (status === "error") return "\u9700\u5904\u7406";
  if (status === "archived") return "\u5DF2\u5F52\u6863";
  if (status === "pinned") return "\u56FA\u5B9A";
  if (status === "empty") return "\u7A7A\u7EBF\u7A0B";
  return "\u5DF2\u5B8C\u6210";
}
function threadStatusHint(status) {
  if (status === "running") return "\u8FD9\u6761\u7EBF\u7A0B\u6B63\u5728\u5F53\u524D\u5DE5\u4F5C\u533A\u63A8\u8FDB";
  if (status === "error") return "\u4E0A\u6B21\u6267\u884C\u51FA\u73B0\u9519\u8BEF\uFF0C\u5EFA\u8BAE\u5148\u67E5\u770B\u5931\u8D25\u8282\u70B9";
  if (status === "archived") return "\u8FD9\u6761\u7EBF\u7A0B\u5DF2\u5F52\u6863\uFF0C\u4FDD\u7559\u7528\u4E8E\u56DE\u770B";
  if (status === "pinned") return "\u56FA\u5B9A\u7EBF\u7A0B\u4F1A\u4FDD\u7559\u5728\u9876\u90E8\uFF0C\u65B9\u4FBF\u7EE7\u7EED";
  if (status === "empty") return "\u8FD9\u6761\u7EBF\u7A0B\u8FD8\u6CA1\u6709\u5F62\u6210\u6709\u6548\u5BF9\u8BDD";
  return "\u8FD9\u6761\u4EFB\u52A1\u7EBF\u7A0B\u53EF\u7EE7\u7EED\u6253\u5F00\u6216\u4F5C\u4E3A\u5206\u652F\u8D77\u70B9";
}
function renderSessionEmptyState(title, message, actions) {
  return `<div class="session-empty">
    <div class="session-empty-icon">${S("imsg", 20)}</div>
    <div class="session-empty-title">${E(title)}</div>
    <div class="session-empty-text">${E(message)}</div>
    <div class="session-empty-actions">${actions.join("")}</div>
  </div>`;
}
function renderSessionActions() {
  return `<div class="session-actions"><button class="sa-btn primary" onclick="newSession()">+ \u65B0\u4F1A\u8BDD</button></div>`;
}
function renderSessionCard(session, openSessionIds, scopeLabel) {
  const name = session.name || "\u672A\u547D\u540D\u4F1A\u8BDD";
  const messageText = session.messageCount > 0 ? `${session.messageCount} \u6761\u6D88\u606F` : "\u6682\u65E0\u6D88\u606F";
  const active = isActiveSession(session, openSessionIds);
  const status = deriveThreadStatus(session, active ? session.id : "");
  const timeText = formatSessionTime(session.updatedAt || session.createdAt);
  const className = `sess-item thread-item thread-${status}${active ? " active" : ""}`;
  const pinTitle = session.pinned ? "\u53D6\u6D88\u56FA\u5B9A" : "\u56FA\u5B9A\u7EBF\u7A0B";
  const pinIcon = session.pinned ? S("ipin-off", 14) : S("ipin", 14);
  const branchText = session.branchFrom?.name ? `\u4ECE ${session.branchFrom.name} \u5206\u652F` : session.branchFrom?.id ? "\u5206\u652F\u7EBF\u7A0B" : "";
  const hint = [threadStatusHint(status), messageText, scopeLabel, branchText].filter(Boolean).join(" \xB7 ");
  return `<div class="${className}" title="${E(hint)}" onclick="switchSession('${session.id}')">
    <div class="thread-row">
      <div class="sess-info thread-info">
        <div class="sess-name thread-name">
          <span class="thread-title">${E(name)}</span>
        </div>
      </div>
      <div class="thread-time">${E(timeText)}</div>
      <div class="sess-ops thread-ops">
        <button class="sess-pin" title="${pinTitle}" aria-label="${pinTitle}" onclick="event.stopPropagation();pinSession('${session.id}',${session.pinned ? false : true})">${pinIcon}</button>
        <button class="sess-branch" title="\u521B\u5EFA\u5206\u652F" aria-label="\u521B\u5EFA\u5206\u652F" onclick="event.stopPropagation();branchSession('${session.id}')">${S("ibranch", 14)}</button>
        <button class="sess-rename" title="\u91CD\u547D\u540D" aria-label="\u91CD\u547D\u540D" onclick="event.stopPropagation();renameSession(this,'${session.id}')">${S("iedit", 14)}</button>
        <button class="sess-del" title="\u5220\u9664" aria-label="\u5220\u9664" onclick="event.stopPropagation();deleteSession('${session.id}')">${S("itrash", 14)}</button>
      </div>
    </div>
  </div>`;
}
function renderSessionGroup(title, hint, sessions, openSessionIds, scopeLabel) {
  const count = sessions.length;
  const items = sessions.length > 0 ? sessions.map((session) => renderSessionCard(session, openSessionIds, scopeLabel)).join("") : `<div class="session-group-empty">${E(hint)}</div>`;
  return `<div class="session-group">
    <div class="session-group-head"><span>${E(title)}</span><span class="session-group-count">${count}</span></div>
    ${items}
  </div>`;
}
function buildSessionRenderKey(sessions, others, openSessionIds) {
  return JSON.stringify({
    openSessionIds: [...openSessionIds].sort(),
    sessions: sessions.map((session) => ({
      id: session.id,
      name: session.name,
      active: session.active,
      messageCount: session.messageCount,
      updatedAt: session.updatedAt || session.createdAt,
      workspace: session.workspace || "",
      pinned: Boolean(session.pinned),
      archived: Boolean(session.archived),
      hasError: Boolean(session.hasError),
      isRunning: Boolean(session.isRunning),
      status: deriveThreadStatus(session, ""),
      branchFrom: session.branchFrom?.id || ""
    })),
    others: others.map((project) => ({
      project: project.project,
      path: project.path,
      sessions: project.sessions.map((session) => ({
        id: session.id,
        name: session.name,
        active: session.active,
        messageCount: session.messageCount,
        updatedAt: session.updatedAt || session.createdAt,
        pinned: Boolean(session.pinned),
        archived: Boolean(session.archived),
        hasError: Boolean(session.hasError),
        isRunning: Boolean(session.isRunning),
        status: deriveThreadStatus(session, ""),
        branchFrom: session.branchFrom?.id || ""
      }))
    }))
  });
}
function setSessionPanelStatus(text, kind = "ready") {
  void text;
  void kind;
}
function loadSessions() {
  const t0 = Date.now();
  const el = $("sl");
  if (!el) {
    _loadRetries++;
    if (_loadRetries > MAX_LOAD_RETRIES) return;
    console.log(`\u23F3 loadSessions retry #${_loadRetries}: no #sl`);
    setTimeout(loadSessions, 500);
    return;
  }
  _loadRetries = 0;
  const ws = localStorage.getItem(App.Constants.WS_KEY) || "";
  setSessionPanelStatus("\u6B63\u5728\u5237\u65B0\u4EFB\u52A1\u7EBF\u7A0B\u2026", "loading");
  el.classList.add("is-loading");
  console.log(`\u{1F4CB} loadSessions ws="${ws}"`);
  fetch("/api/sessions?workspace=" + encodeURIComponent(ws) + "&other=1").then((r) => r.json()).then((data) => {
    console.log(`\u{1F4CB} loadSessions done in ${Date.now() - t0}ms, sessions=${data.sessions?.length}, other=${data.other?.length}`);
    if (!el) return;
    if (data.error) {
      _lastSessionRenderKey = "";
      el.classList.remove("is-loading");
      setSessionPanelStatus("\u52A0\u8F7D\u5931\u8D25", "error");
      el.innerHTML = renderSessionEmptyState(
        "\u4EFB\u52A1\u7EBF\u7A0B\u52A0\u8F7D\u5931\u8D25",
        data.error,
        [`<button class="sa-btn primary" onclick="loadSessions()">\u91CD\u65B0\u52A0\u8F7D</button>`, `<button class="sa-btn" onclick="newSession()">+ \u65B0\u4F1A\u8BDD</button>`]
      );
      return;
    }
    const activeId = getActiveSessionTabId() || "";
    const openSessionIds = readOpenRealSessionIds();
    const sessions = (data.sessions || []).slice().sort((a, b) => getSessionTimeValue(b) - getSessionTimeValue(a));
    const others = data.other || [];
    indexSessionTabs(sessions, others);
    renderSessionTabs(activeId);
    const renderKey = buildSessionRenderKey(sessions, others, openSessionIds);
    const needsInitialRender = !el.querySelector(".session-toolbar") && !el.querySelector(".session-empty") && !el.querySelector(".session-group");
    const hasChanged = needsInitialRender || renderKey !== _lastSessionRenderKey;
    const totalSessions = sessions.length + others.reduce((sum, project) => sum + project.sessions.length, 0);
    const pinnedSessions = sessions.filter((session) => session.pinned);
    const activeSessions = sessions.filter((session) => isActiveSession(session, openSessionIds));
    if (sessions.length === 0 && others.length === 0) {
      _lastSessionRenderKey = renderKey;
      el.classList.remove("is-loading");
      setSessionPanelStatus("\u6682\u65E0\u4EFB\u52A1\u7EBF\u7A0B", "ready");
      el.innerHTML = renderSessionEmptyState(
        "\u6682\u65E0\u4EFB\u52A1\u7EBF\u7A0B",
        "\u65B0\u4F1A\u8BDD\u4F1A\u51FA\u73B0\u5728\u8FD9\u91CC\uFF0C\u6309\u65F6\u95F4\u548C\u6D3B\u8DC3\u72B6\u6001\u6574\u7406\u6210\u53EF\u7EE7\u7EED\u7684\u4EFB\u52A1\u7EBF\u7A0B\u3002",
        [
          `<button class="sa-btn primary" onclick="newSession()">+ \u65B0\u4F1A\u8BDD</button>`
        ].filter(Boolean)
      );
      return;
    }
    const currentHint = activeSessions.length > 0 ? "\u5F53\u524D\u5DE5\u4F5C\u533A\u91CC\u5DF2\u6253\u5F00\u7684\u7EBF\u7A0B\u4F1A\u9AD8\u4EAE\u663E\u793A\u3002" : "\u5F53\u524D\u5DE5\u4F5C\u533A\u8FD8\u6CA1\u6709\u6253\u5F00\u7684\u7EBF\u7A0B\u3002";
    const statusBits = [
      pinnedSessions.length > 0 ? `${pinnedSessions.length} \u4E2A\u56FA\u5B9A` : "",
      activeSessions.length > 0 ? `${activeSessions.length} \u4E2A\u5DF2\u6253\u5F00` : "",
      others.length > 0 ? `${others.length} \u4E2A\u5176\u4ED6\u9879\u76EE` : ""
    ].filter(Boolean);
    setSessionPanelStatus(statusBits.length > 0 ? `\u4EFB\u52A1\u7EBF\u7A0B\u5DF2\u5237\u65B0 \xB7 ${statusBits.join(" \xB7 ")}` : "\u4EFB\u52A1\u7EBF\u7A0B\u5DF2\u5237\u65B0", "ready");
    el.classList.remove("is-loading");
    if (hasChanged) {
      let html = `<div class="session-toolbar">${renderSessionActions()}</div>`;
      if (pinnedSessions.length > 0) html += renderSessionGroup("\u56FA\u5B9A\u7EBF\u7A0B", "\u56FA\u5B9A\u7684\u91CD\u8981\u4EFB\u52A1\u4F1A\u7559\u5728\u8FD9\u91CC\u3002", pinnedSessions, openSessionIds, "\u5F53\u524D\u9879\u76EE");
      html += renderSessionGroup("\u5F53\u524D\u5DE5\u4F5C\u533A", currentHint, sessions.filter((session) => !session.pinned), openSessionIds, "\u5F53\u524D\u9879\u76EE");
      if (others.length > 0) {
        html += `<div class="sess-other-header" data-label="\u5176\u4ED6\u9879\u76EE (${others.length})" onclick="toggleOtherSessions(this)">\u25B8 \u5176\u4ED6\u9879\u76EE (${others.length})</div>`;
        html += `<div class="sess-other-list" style="display:none">`;
        for (const proj of others) {
          const projLabel = proj.project === "\u672A\u5206\u7C7B" ? "\u672A\u5206\u7C7B\uFF08\u65E7\u4F1A\u8BDD\uFF09" : E(proj.project);
          const projPath = proj.path ? ` <span class="sess-other-path">${E(proj.path)}</span>` : "";
          const otherSessions = proj.sessions.slice().sort((a, b) => getSessionTimeValue(b) - getSessionTimeValue(a));
          html += `<div class="sess-other-project"><div class="sess-other-title">${projLabel}${projPath}</div>`;
          html += otherSessions.map((s) => renderSessionCard(s, openSessionIds, projLabel)).join("");
          html += `</div>`;
        }
        html += `</div>`;
      }
      el.innerHTML = html;
      _lastSessionRenderKey = renderKey;
    }
    if (!hasChanged) {
      console.log(`\u{1F4CB} loadSessions skipped redraw (${totalSessions} sessions unchanged)`);
    }
  }).catch(() => {
    const el2 = $("sl");
    if (el2) {
      _lastSessionRenderKey = "";
      el2.classList.remove("is-loading");
      setSessionPanelStatus("\u52A0\u8F7D\u5931\u8D25", "error");
      el2.innerHTML = renderSessionEmptyState(
        "\u7F51\u7EDC\u9519\u8BEF",
        "\u4F1A\u8BDD\u5217\u8868\u6682\u65F6\u65E0\u6CD5\u52A0\u8F7D\uFF0C\u53EF\u80FD\u662F\u540E\u7AEF\u672A\u542F\u52A8\u6216\u7F51\u7EDC\u88AB\u4E2D\u65AD\u3002",
        [`<button class="sa-btn primary" onclick="loadSessions()">\u91CD\u65B0\u52A0\u8F7D</button>`, `<button class="sa-btn" onclick="newSession()">+ \u65B0\u4F1A\u8BDD</button>`]
      );
    }
    toast("\u52A0\u8F7D\u4F1A\u8BDD\u5217\u8868\u5931\u8D25", "error");
  });
}
function toggleOtherSessions(header) {
  const list = header.nextElementSibling;
  if (!list) return;
  const isOpen = list.style.display !== "none";
  list.style.display = isOpen ? "none" : "block";
  const label = header.dataset.label || "\u5176\u4ED6\u9879\u76EE";
  header.textContent = (isOpen ? "\u25B8" : "\u25BE") + " " + label;
}
function newSession() {
  const draftId = createDraftSessionId();
  window.__state.M = [];
  window.__state.IL = false;
  App.Chat?.clearAttachments?.();
  const oldCS = window.__state.CS;
  if (oldCS) {
    oldCS.onmessage = null;
    oldCS.onerror = null;
    oldCS.close();
    window.__state.CS = null;
  }
  rememberSessionTab(draftId);
  writeSessionTabLabel(draftId, "\u65B0\u4F1A\u8BDD");
  setActiveSessionTabId(draftId);
  focusChatView();
  const msgsEl = $("ms");
  if (msgsEl) msgsEl.innerHTML = '<div class="wl"><h2>\u{1F4AC} \u65B0\u4F1A\u8BDD</h2><p>\u8F93\u5165\u6D88\u606F\u5F00\u59CB\u65B0\u7684\u5BF9\u8BDD</p></div>';
  renderSessionTabs(draftId);
  toast("\u5DF2\u5F00\u542F\u65B0\u4F1A\u8BDD", "success");
}
function renameSession(el, id) {
  let item = el;
  while (item && !item.classList.contains("sess-item")) item = item.parentNode;
  if (!item) {
    toast("\u8BF7\u7A0D\u540E\u91CD\u8BD5");
    return;
  }
  const nameEl = item.querySelector(".thread-title");
  if (!nameEl) {
    toast("\u8BF7\u7A0D\u540E\u91CD\u8BD5");
    return;
  }
  const oldName = nameEl.textContent || "";
  const input = document.createElement("input");
  input.type = "text";
  input.value = oldName;
  input.className = "sess-rename-input";
  input.style.cssText = "width:100%;padding:2px 4px;border-radius:4px;border:1px solid var(--am);background:var(--bc);color:var(--tx);font-size:.72rem;font-family:var(--fb);outline:none;box-sizing:border-box";
  nameEl.innerHTML = "";
  nameEl.appendChild(input);
  input.focus();
  input.select();
  const nm = nameEl;
  function save() {
    const val = input.value.trim();
    if (val && val !== oldName) {
      fetch("/api/sessions/rename", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id, name: val }) }).then((r) => r.json()).then((r) => {
        if (r.ok) {
          _lastSessionRenderKey = "";
          writeSessionTabLabel(id, val);
          renderSessionTabs(id);
          toast("\u5DF2\u91CD\u547D\u540D");
          loadSessions();
        } else {
          nm.textContent = oldName;
          toast("\u91CD\u547D\u540D\u5931\u8D25");
        }
      }).catch(() => {
        nm.textContent = oldName;
        toast("\u91CD\u547D\u540D\u5931\u8D25");
      });
    } else {
      nm.textContent = oldName;
    }
  }
  input.onkeydown = function(e) {
    if (e.key === "Enter") {
      e.preventDefault();
      input.blur();
    }
  };
  input.onblur = save;
}
async function deleteSession(id) {
  const ok = await confirmAsync("\u786E\u5B9A\u5220\u9664\u6B64\u4F1A\u8BDD\uFF1F");
  if (!ok) return;
  const t0 = Date.now();
  console.log(`\u{1F5D1}\uFE0F Deleting session: ${id}`);
  fetch("/api/sessions/delete", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id }) }).then((r) => r.json()).then((r) => {
    if (r.ok) {
      console.log(`\u{1F5D1}\uFE0F Session deleted in ${Date.now() - t0}ms`);
      toast("\u5DF2\u5220\u9664");
      try {
        if (localStorage.getItem("last-session-id") === id) localStorage.removeItem("last-session-id");
      } catch {
      }
      forgetSessionTab(id);
      renderSessionTabs();
      const oldCS = window.__state.CS;
      if (oldCS) {
        oldCS.onmessage = null;
        oldCS.onerror = null;
        oldCS.close();
        window.__state.CS = null;
      }
      window.__state.M = [];
      window.__state.IL = false;
      setTimeout(() => {
        try {
          const m = window.__monaco;
          m?.pauseDiags?.();
          m?.blur?.();
        } catch {
        }
        const activeTab = window.__state._activeFileTab;
        if (activeTab !== null) switchTab(null);
        const msgsEl = $("ms");
        if (msgsEl) {
          msgsEl.innerHTML = window.msgs ? window.msgs() : "";
          msgsEl.scrollTop = 0;
        }
        const ci = $("ci");
        if (ci) {
          ci.disabled = false;
          ci.value = "";
          ci.style.height = "auto";
        }
        const cs = $("cs");
        if (cs) {
          cs.disabled = false;
          cs.title = "\u53D1\u9001\u6D88\u606F";
          cs.innerHTML = window.S("iz", 16);
        }
        console.log(`  UI reset done at ${Date.now()}`);
      }, 50);
      loadSessions();
    } else toast("\u5220\u9664\u5931\u8D25");
  }).catch((err) => {
    console.error("\u{1F5D1}\uFE0F Delete failed:", err);
    toast("\u5220\u9664\u5931\u8D25");
  });
}
function pinSession(id, pinned) {
  fetch("/api/sessions/pin", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id, pinned })
  }).then((r) => r.json()).then((r) => {
    if (!r.ok) {
      toast("\u56FA\u5B9A\u5931\u8D25: " + (r.error || ""), "error");
      return;
    }
    toast(pinned ? "\u5DF2\u56FA\u5B9A\u7EBF\u7A0B" : "\u5DF2\u53D6\u6D88\u56FA\u5B9A", "success");
    _lastSessionRenderKey = "";
    loadSessions();
  }).catch(() => toast("\u56FA\u5B9A\u5931\u8D25", "error"));
}
function branchSession(id) {
  const ws = localStorage.getItem(App.Constants.WS_KEY) || "";
  fetch("/api/sessions/branch", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id, workspace: ws })
  }).then((r) => r.json()).then((data) => {
    if (!data.ok || data.error) {
      toast("\u521B\u5EFA\u5206\u652F\u5931\u8D25: " + (data.error || ""), "error");
      return;
    }
    const oldCS = window.__state.CS;
    if (oldCS) {
      oldCS.onmessage = null;
      oldCS.onerror = null;
      oldCS.close();
      window.__state.CS = null;
    }
    window.__state.IL = false;
    window.__state.M = (data.messages || []).map((m) => ({ role: m.role, content: m.content, thinking: m.thinking || "", trace: m.trace || [], streaming: false }));
    focusChatView();
    const activeId = data.activeSessionId || data.id || "";
    if (activeId) {
      try {
        localStorage.setItem("last-session-id", activeId);
      } catch {
      }
      rememberSessionTab(activeId);
      setActiveSessionTabId(activeId);
      renderSessionTabs(activeId);
    }
    const msgsEl = $("ms");
    if (msgsEl) {
      msgsEl.innerHTML = window.msgs ? window.msgs() : "";
      setTimeout(() => {
        msgsEl.scrollTop = msgsEl.scrollHeight;
      }, 50);
    }
    toast("\u5DF2\u521B\u5EFA\u5206\u652F\u7EBF\u7A0B", "success");
    loadSessions();
  }).catch(() => toast("\u521B\u5EFA\u5206\u652F\u5931\u8D25", "error"));
}
function switchSession(id) {
  if (isDraftSessionId(id)) {
    activateDraftSession(id);
    return;
  }
  const ws = localStorage.getItem(App.Constants.WS_KEY) || "";
  fetch("/api/sessions/activate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id, workspace: ws })
  }).then((r) => {
    if (!r.ok) throw new Error("HTTP " + r.status);
    return r.json();
  }).then((data) => {
    if (!data.ok || data.error) {
      toast("\u52A0\u8F7D\u5931\u8D25: " + (data.error || ""));
      return;
    }
    const oldCS = window.__state.CS;
    if (oldCS) {
      oldCS.onmessage = null;
      oldCS.onerror = null;
      oldCS.close();
      window.__state.CS = null;
    }
    window.__state.IL = false;
    window.__state.M = (data.messages || []).map((m) => ({ role: m.role, content: m.content, thinking: m.thinking || "", trace: m.trace || [], streaming: false }));
    focusChatView();
    const msgsEl = $("ms");
    if (msgsEl) {
      msgsEl.innerHTML = window.__state.M.length > 0 ? window.msgs ? window.msgs() : "" : '<div class="wl"><h2>\u{1F4AC} \u65B0\u4F1A\u8BDD</h2><p>\u8F93\u5165\u6D88\u606F\u5F00\u59CB\u65B0\u7684\u5BF9\u8BDD</p></div>';
      setTimeout(() => {
        msgsEl.scrollTop = msgsEl.scrollHeight;
      }, 50);
    }
    toast("\u5DF2\u5207\u6362\u5230\u4F1A\u8BDD (" + window.__state.M.length + " \u6761\u6D88\u606F)");
    const activeId = data.activeSessionId || id;
    if (activeId) {
      try {
        localStorage.setItem("last-session-id", activeId);
      } catch {
      }
      rememberSessionTab(activeId);
      setActiveSessionTabId(activeId);
      renderSessionTabs(activeId);
    }
    loadSessions();
  }).catch(() => {
    try {
      localStorage.removeItem("last-session-id");
    } catch {
    }
    setActiveSessionTabId(null);
    window.__state.M = [];
    window.__state.IL = false;
    const oldCS = window.__state.CS;
    if (oldCS) {
      oldCS.onmessage = null;
      oldCS.onerror = null;
      oldCS.close();
      window.__state.CS = null;
    }
    const ci = $("ci");
    const cs = $("cs");
    if (ci) {
      ci.disabled = false;
      ci.style.height = "auto";
    }
    if (cs) {
      cs.disabled = false;
      cs.title = "\u53D1\u9001\u6D88\u606F";
      cs.innerHTML = window.S("iup", 16);
    }
    toast("\u4F1A\u8BDD\u5DF2\u5931\u6548");
    loadSessions();
  });
}
window.loadSessions = loadSessions;
window.newSession = newSession;
window.renameSession = renameSession;
window.deleteSession = deleteSession;
window.pinSession = pinSession;
window.branchSession = branchSession;
window.switchSession = switchSession;
window.commitSessionTab = commitSessionTab;
window.getActiveSessionTabId = getActiveSessionTabId;
window.setActiveSessionTabId = setActiveSessionTabId;
window.renderSessionTabs = renderSessionTabs;
window.closeSessionTab = closeSessionTab;
const AppSess = window.App?.Session;
if (AppSess) {
  AppSess.loadSessions = loadSessions;
  AppSess.newSession = newSession;
  AppSess.renameSession = renameSession;
  AppSess.deleteSession = deleteSession;
  AppSess.pinSession = pinSession;
  AppSess.branchSession = branchSession;
  AppSess.switchSession = switchSession;
  AppSess.commitSessionTab = commitSessionTab;
  AppSess.getActiveSessionTabId = getActiveSessionTabId;
  AppSess.setActiveSessionTabId = setActiveSessionTabId;
  AppSess.renderSessionTabs = renderSessionTabs;
  AppSess.closeSessionTab = closeSessionTab;
}
