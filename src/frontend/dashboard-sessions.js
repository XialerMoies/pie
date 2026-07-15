let _loadRetries = 0;
const MAX_LOAD_RETRIES = 8;
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
  const ws = localStorage.getItem("workspace_path") || "";
  console.log(`\u{1F4CB} loadSessions ws="${ws}"`);
  fetch("/api/sessions?workspace=" + encodeURIComponent(ws) + "&other=1").then((r) => r.json()).then((data) => {
    console.log(`\u{1F4CB} loadSessions done in ${Date.now() - t0}ms, sessions=${data.sessions?.length}, other=${data.other?.length}`);
    if (!el) return;
    if (data.error) {
      el.innerHTML = `<div class="sg-item dim">${E(data.error)}</div>`;
      return;
    }
    if ((!data.sessions || data.sessions.length === 0) && (!data.other || data.other.length === 0)) {
      el.innerHTML = '<div class="sg-item dim">\u6682\u65E0\u4F1A\u8BDD</div>';
      return;
    }
    let html = "";
    const sessions = data.sessions || [];
    html += `<div style="font-size:.6rem;color:var(--am);margin-bottom:4px">${sessions.length > 0 ? sessions.length + " \u4E2A\u4F1A\u8BDD" : "\u65E0\u4F1A\u8BDD"}</div>`;
    html += sessions.map((s) => {
      const name = s.name || "\u672A\u547D\u540D\u4F1A\u8BDD";
      const msgs2 = s.messageCount + " \u6761\u6D88\u606F";
      const cls = s.active ? " active" : "";
      return `<div class="sess-item${cls}" onclick="switchSession('${s.id}')">
        <div class="sess-info"><div class="sess-name">${E(name)}</div><div class="sess-meta">${msgs2}</div></div>
        <div class="sess-ops">
          <button class="sess-rename" onclick="event.stopPropagation();renameSession(this,'${s.id}')">\u270E</button>
          <button class="sess-del" onclick="event.stopPropagation();deleteSession('${s.id}')">\u2715</button>
        </div>
      </div>`;
    }).join("");
    const others = data.other || [];
    if (others.length > 0) {
      html += `<div class="sess-other-header" onclick="toggleOtherSessions(this)">\u25B8 \u5176\u4ED6\u9879\u76EE (${others.length})</div>`;
      html += `<div class="sess-other-list" style="display:none">`;
      for (const proj of others) {
        const projLabel = proj.project === "\u672A\u5206\u7C7B" ? "\u672A\u5206\u7C7B\uFF08\u65E7\u4F1A\u8BDD\uFF09" : E(proj.project);
        const projPath = proj.path ? ` <span style="font-size:.55rem;color:var(--tm);font-family:var(--fm)">${E(proj.path)}</span>` : "";
        html += `<div style="font-size:.6rem;color:var(--tm);padding:6px 4px 2px;font-family:var(--fd)">${projLabel}${projPath}</div>`;
        html += proj.sessions.map((s) => {
          const name = s.name || "\u672A\u547D\u540D\u4F1A\u8BDD";
          const msgs2 = s.messageCount + " \u6761\u6D88\u606F";
          return `<div class="sess-item" onclick="switchSession('${s.id}')">
            <div class="sess-info"><div class="sess-name">${E(name)}</div><div class="sess-meta">${msgs2}</div></div>
            <div class="sess-ops">
              <button class="sess-rename" onclick="event.stopPropagation();renameSession(this,'${s.id}')">\u270E</button>
              <button class="sess-del" onclick="event.stopPropagation();deleteSession('${s.id}')">\u2715</button>
            </div>
          </div>`;
        }).join("");
      }
      html += `</div>`;
    }
    el.innerHTML = html;
  }).catch(() => {
    const el2 = $("sl");
    if (el2) el2.innerHTML = '<div class="sg-item dim">\u7F51\u7EDC\u9519\u8BEF</div>';
    toast("\u52A0\u8F7D\u4F1A\u8BDD\u5217\u8868\u5931\u8D25", "error");
  });
}
function toggleOtherSessions(header) {
  const list = header.nextElementSibling;
  if (!list) return;
  const isOpen = list.style.display !== "none";
  list.style.display = isOpen ? "none" : "block";
  header.textContent = (isOpen ? "\u25B8" : "\u25BE") + " \u5176\u4ED6\u9879\u76EE";
}
function newSession() {
  if (window.__state.M.length > 0) {
    fetch("/api/sessions/save", { method: "POST" }).catch(() => {
      toast("\u4FDD\u5B58\u5F53\u524D\u4F1A\u8BDD\u5931\u8D25", "error");
    });
  }
  const ws = localStorage.getItem("workspace_path") || "";
  window.__state.M = [];
  const msgsEl = $("ms");
  if (msgsEl) msgsEl.innerHTML = '<div class="wl"><h2>\u{1F4AC} \u65B0\u4F1A\u8BDD</h2><p>\u8F93\u5165\u6D88\u606F\u5F00\u59CB\u65B0\u7684\u5BF9\u8BDD</p></div>';
  toast("\u5DF2\u5F00\u542F\u65B0\u4F1A\u8BDD", "success");
  loadSessions();
  fetch("/api/sessions/new", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ workspace: ws }) }).catch(() => {
  });
}
function renameSession(el, id) {
  let item = el;
  while (item && !item.classList.contains("sess-item")) item = item.parentNode;
  if (!item) {
    toast("\u8BF7\u7A0D\u540E\u91CD\u8BD5");
    return;
  }
  const nameEl = item.querySelector(".sess-name");
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
          msgsEl.innerHTML = msgs();
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
function switchSession(id) {
  fetch("/api/sessions/" + encodeURIComponent(id) + "/messages").then((r) => r.json()).then((data) => {
    if (data.error) {
      toast("\u52A0\u8F7D\u5931\u8D25: " + data.error);
      return;
    }
    if (!data.messages || data.messages.length === 0) {
      toast("\u4F1A\u8BDD\u4E3A\u7A7A");
      return;
    }
    window.__state.M = data.messages.map((m) => ({ role: m.role === "user" ? "user" : "assistant", content: m.content }));
    const msgsEl = $("ms");
    if (msgsEl) {
      msgsEl.innerHTML = msgs();
      setTimeout(() => {
        msgsEl.scrollTop = msgsEl.scrollHeight;
      }, 50);
    }
    toast("\u5DF2\u5207\u6362\u5230\u4F1A\u8BDD (" + window.__state.M.length + " \u6761\u6D88\u606F)");
    try {
      localStorage.setItem("last-session-id", id);
    } catch {
    }
    loadSessions();
  }).catch(() => toast("\u52A0\u8F7D\u5931\u8D25"));
}
function restoreLastSession() {
  try {
    if (localStorage.getItem("no-restore-session") === "1") return;
    const id = localStorage.getItem("last-session-id");
    if (id) switchSession(id);
  } catch {
  }
}
window.loadSessions = loadSessions;
window.newSession = newSession;
window.renameSession = renameSession;
window.deleteSession = deleteSession;
window.switchSession = switchSession;
window.restoreLastSession = restoreLastSession;
const AppSess = window.App?.Session;
if (AppSess) {
  AppSess.loadSessions = loadSessions;
  AppSess.newSession = newSession;
  AppSess.renameSession = renameSession;
  AppSess.deleteSession = deleteSession;
  AppSess.switchSession = switchSession;
}
