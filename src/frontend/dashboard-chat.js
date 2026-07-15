function mdRender(text) {
  const md = window.marked;
  if (!md || !text) return E(text || "");
  try {
    const html = md.parse(text, { breaks: true, gfm: true });
    return html.replace(/<link[^>]*>/gi, "");
  } catch {
    return E(text);
  }
}
function msgs() {
  const M = window.__state.M;
  if (M.length === 0) return '<div class="wl"><h2>Pi \u2014 \u4F60\u7684\u4EE3\u7801\u52A9\u624B</h2><p>\u5728\u4E0B\u65B9\u8F93\u5165\uFF0C\u5F00\u59CB\u7F16\u7801</p></div>';
  return M.map((m) => {
    const c = m.role + (m.streaming ? " go" : ""), lb = m.role === "user" ? "\u4F60" : "Pi";
    const ty = m.streaming ? `<div class="ty"><span class="ty-d"></span><span class="ty-d"></span><span class="ty-d"></span></div>` : "";
    const content = m.content ? mdRender(m.content) : "";
    return `<div class="m ${c}"><div class="ml">${lb}</div><div class="mt">${content}</div>${ty}</div>`;
  }).join("\n");
}
function appendDelta(text) {
  const M = window.__state.M;
  const msgsEl = $("ms");
  if (!msgsEl) return;
  const last = M[M.length - 1];
  if (!last) return;
  last.content += text;
  const msgDivs = msgsEl.querySelectorAll(".m");
  const lastMsg = msgDivs[msgDivs.length - 1];
  if (lastMsg) {
    const cd = lastMsg.querySelector(".mt");
    if (cd) {
      cd.innerHTML = mdRender(last.content);
      return;
    }
  }
  msgsEl.innerHTML = msgs();
}
function handleSlash(ci) {
  const slashEl = $("fi-slash");
  if (!slashEl) return;
  const val = ci.value;
  if (val.startsWith("/") && !val.includes(" ")) {
    slashEl.style.display = "flex";
    slashEl.querySelectorAll(".fi-slash-item").forEach((item) => {
      const cmd = item.dataset.cmd || "";
      const match = cmd.startsWith(val);
      item.style.background = match ? "var(--bc)" : "";
      item.style.color = match ? "var(--tx)" : "";
    });
  } else {
    slashEl.style.display = "none";
  }
}
function fmt(n) {
  if (n == null) return "\u2014";
  if (n < 1e3) return String(n);
  if (n < 1e6) return (n / 1e3).toFixed(n < 1e4 ? 1 : 0) + "k";
  return (n / 1e6).toFixed(1) + "M";
}
const CNY_PER_USD = 7.2;
const CURRENCY_MAP = {
  deepseek: { sym: "\xA5", rate: CNY_PER_USD },
  moonshot: { sym: "\xA5", rate: CNY_PER_USD },
  "zhipu-ai": { sym: "\xA5", rate: CNY_PER_USD },
  baidu: { sym: "\xA5", rate: CNY_PER_USD },
  alibaba: { sym: "\xA5", rate: CNY_PER_USD },
  bytedance: { sym: "\xA5", rate: CNY_PER_USD },
  "01-ai": { sym: "\xA5", rate: CNY_PER_USD }
};
function formatCost(costUsd, provider) {
  if (costUsd == null) return "\u2014";
  const info = CURRENCY_MAP[provider.toLowerCase()] || { sym: "$", rate: 1 };
  const converted = costUsd * info.rate;
  if (converted < 0.01) return info.sym + converted.toFixed(6);
  if (converted < 1) return info.sym + converted.toFixed(4);
  return info.sym + converted.toFixed(2);
}
function updateTokenDisplay(cu, ss, provider) {
  const ctxEl = $("fi-tk-ctx");
  const fillEl = $("fi-tk-fill");
  if (ctxEl && cu) {
    const used = cu.tokens, limit = cu.contextWindow;
    ctxEl.textContent = (used != null ? fmt(used) : "\u2014") + " / " + (limit ? fmt(limit) : "\u2014");
    if (fillEl) fillEl.style.width = (cu.percent ?? 0) + "%";
  }
  const t = ss?.tokens;
  if (!t) return;
  setText("fi-tk-in", fmt(t.input));
  setText("fi-tk-out", fmt(t.output));
  setText("fi-tk-ch", fmt(t.cacheRead));
  setText("fi-tk-cm", fmt(t.cacheWrite));
  const total = (t.cacheRead || 0) + (t.cacheWrite || 0);
  setText("fi-tk-rate", total > 0 ? Math.round((t.cacheRead || 0) / total * 100) + "%" : "\u2014");
  if (ss.cost != null) setText("fi-tk-cost", formatCost(ss.cost, provider || ""));
}
function setText(id, text) {
  const el = $(id);
  if (el) el.textContent = text;
}
async function pollTokenUsage() {
  try {
    const r = await fetch("/api/token-usage");
    const data = await r.json();
    if (data) updateTokenDisplay(data.contextUsage, data.sessionStats, data.provider);
  } catch {
  }
}
const MODE_LABELS = { auto: "\u81EA\u52A8", explain: "\u89E3\u91CA", plan: "\u8BA1\u5212" };
const EFFORT_LABELS = { low: "\u4F4E", medium: "\u4E2D", high: "\u9AD8", xhigh: "\u6781\u9AD8", max: "\u6700\u9AD8" };
const MODE_INSTRUCTIONS = {
  auto: "",
  explain: "\u4EC5\u89E3\u91CA\uFF0C\u4E0D\u8981\u4FEE\u6539\u4EFB\u4F55\u6587\u4EF6\u6216\u6267\u884C\u547D\u4EE4\u3002",
  plan: "\u4E0D\u8981\u6267\u884C\u4EFB\u4F55\u64CD\u4F5C\u3002\u8F93\u51FA\u7ED3\u6784\u5316\u65B9\u6848\uFF1A\u76EE\u6807 \u2192 \u6B65\u9AA4 \u2192 \u6D89\u53CA\u6587\u4EF6 \u2192 \u98CE\u9669\u3002"
};
const EFFORT_INSTRUCTIONS = {
  low: "\u7B80\u8981\u56DE\u7B54\u5373\u53EF\u3002",
  medium: "",
  high: "\u8BF7\u6DF1\u5165\u5206\u6790\uFF0C\u8003\u8651\u8FB9\u754C\u60C5\u51B5\u3002",
  xhigh: "\u8BF7\u8FDB\u884C\u6DF1\u5EA6\u5206\u6790\uFF0C\u8003\u8651\u591A\u79CD\u53EF\u80FD\u6027\u548C\u8FB9\u754C\u60C5\u51B5\u3002",
  max: "\u8BF7\u7A77\u5C3D\u6240\u6709\u53EF\u80FD\u6027\uFF0C\u8FDB\u884C\u5F7B\u5E95\u5206\u6790\u548C\u9A8C\u8BC1\u3002"
};
let _currentMode = "auto";
let _currentEffort = "medium";
function loadModeState() {
  try {
    _currentMode = localStorage.getItem("chat-mode") || "auto";
    _currentEffort = localStorage.getItem("chat-effort") || "medium";
    if (!MODE_LABELS[_currentMode]) _currentMode = "auto";
    if (!EFFORT_LABELS[_currentEffort]) _currentEffort = "medium";
  } catch {
    _currentMode = "auto";
    _currentEffort = "medium";
  }
  updateModeButton();
}
function setMode(mode) {
  _currentMode = mode;
  try {
    localStorage.setItem("chat-mode", mode);
  } catch {
  }
  updateModeButton();
}
function setEffort(effort) {
  _currentEffort = effort;
  try {
    localStorage.setItem("chat-effort", effort);
  } catch {
  }
}
function updateModeButton() {
  const el = $("fi-mode-name");
  if (el) el.textContent = MODE_LABELS[_currentMode] || "\u81EA\u52A8";
}
function showModePopup(btn) {
  const existing = document.getElementById("mode-popup");
  if (existing) {
    existing.remove();
    return;
  }
  const rect = btn.getBoundingClientRect();
  const popup = document.createElement("div");
  popup.id = "mode-popup";
  popup.style.cssText = `position:fixed;bottom:${window.innerHeight - rect.top + 4}px;left:${rect.left}px;z-index:999;background:var(--be);border:1px solid var(--bd);border-radius:8px;padding:6px;min-width:160px;box-shadow:0 8px 32px var(--sd)`;
  let html = '<div style="font-size:.6rem;font-weight:600;text-transform:uppercase;letter-spacing:.05em;color:var(--tm);padding:4px 8px;font-family:var(--fd)">\u6A21\u5F0F</div>';
  for (const [key, label] of Object.entries(MODE_LABELS)) {
    const active = key === _currentMode;
    html += `<div class="mode-popup-item" data-mode="${key}" style="${active ? "background:rgba(245,158,11,.1);color:var(--am);font-weight:600" : ""}">${label} ${active ? "\u2713" : ""}</div>`;
  }
  html += '<div style="font-size:.6rem;font-weight:600;text-transform:uppercase;letter-spacing:.05em;color:var(--tm);padding:8px 8px 3px;font-family:var(--fd);margin-top:4px;border-top:1px solid var(--bd)">\u601D\u8003\u6DF1\u5EA6</div>';
  html += '<div style="padding:4px 8px">';
  html += '<div style="display:flex;gap:2px">';
  for (const [key, label] of Object.entries(EFFORT_LABELS)) {
    const active = key === _currentEffort;
    html += `<div class="mode-effort-item" data-effort="${key}" style="flex:1;text-align:center;padding:3px 0;border-radius:4px;font-size:.65rem;cursor:pointer;${active ? "background:var(--am);color:#0A0A0F;font-weight:600" : "color:var(--ts)"}">${label}</div>`;
  }
  html += "</div></div>";
  popup.innerHTML = html;
  document.body.appendChild(popup);
  popup.querySelectorAll(".mode-popup-item").forEach((el) => {
    el.addEventListener("click", () => {
      const mode = el.dataset.mode || "auto";
      setMode(mode);
      popup.remove();
    });
  });
  popup.querySelectorAll(".mode-effort-item").forEach((el) => {
    el.addEventListener("click", () => {
      const effort = el.dataset.effort || "medium";
      setEffort(effort);
      popup.remove();
    });
  });
  setTimeout(() => {
    document.addEventListener("click", function close(ev) {
      if (!popup.contains(ev.target) && ev.target !== btn) {
        popup.remove();
        document.removeEventListener("click", close, true);
      }
    }, true);
  }, 0);
}
function buildInstruction(message) {
  const modeIns = MODE_INSTRUCTIONS[_currentMode] || "";
  const effortIns = EFFORT_INSTRUCTIONS[_currentEffort] || "";
  if (!modeIns && !effortIns) return message;
  const parts = [];
  if (modeIns) parts.push(modeIns);
  if (effortIns) parts.push(effortIns);
  return parts.join("\n") + "\n\n" + message;
}
let _pendingAttachments = [];
let _attachIdCounter = 0;
function addAttachment(att) {
  const id = "att-" + Date.now().toString(36) + "-" + ++_attachIdCounter;
  _pendingAttachments.push({ ...att, id });
  renderAttachments();
}
function removeAttachment(id) {
  _pendingAttachments = _pendingAttachments.filter((a) => a.id !== id);
  renderAttachments();
}
function clearAttachments() {
  _pendingAttachments = [];
  renderAttachments();
}
function renderAttachments() {
  const bar = $("fi-attach-bar");
  if (!bar) return;
  if (_pendingAttachments.length === 0) {
    bar.style.display = "none";
    bar.innerHTML = "";
    return;
  }
  bar.style.display = "flex";
  bar.innerHTML = _pendingAttachments.map((a) => {
    let info = "";
    if (a.kind === "folder") {
      info = a.fileCount ? ` \xB7 ${a.fileCount} \u6587\u4EF6` : "";
    } else if (a.kind === "clip") {
      info = ` \xB7 ${a.startLine}-${a.endLine}`;
    }
    const iconHtml = ExplorerService.iconFor(a.name, a.kind === "folder");
    return `<div class="fi-attach-pill" data-attach-id="${a.id}" data-kind="${a.kind}" title="${E(a.path)}">
      ${iconHtml}
      <span class="fi-attach-pill-name">${E(a.name)}</span>
      <span class="fi-attach-pill-info">${info}</span>
      <button class="fi-attach-del" onclick="event.stopPropagation();App.Chat.removeAttachment('${a.id}')">\u2715</button>
    </div>`;
  }).join("");
  bar.querySelectorAll(".fi-attach-pill").forEach((pill) => {
    pill.addEventListener("click", (e) => {
      if (e.target.closest(".fi-attach-del")) return;
      const id = pill.dataset.attachId || "";
      const att = _pendingAttachments.find((a) => a.id === id);
      if (!att) return;
      if (att.kind === "clip" && att.startLine != null) {
        const ws = ExplorerService.getWorkspacePath();
        if (!ws) return;
        fetch(`/api/file/read?root=${encodeURIComponent(ws)}&path=${encodeURIComponent(att.path)}`).then((r) => r.ok ? r.json() : null).then((d) => {
          if (!d) return;
          const content = d.encoding === "base64" ? "[\u4E8C\u8FDB\u5236\u6587\u4EF6\uFF0C\u65E0\u6CD5\u9884\u89C8]" : d.content;
          openFileTab(att.path, content, att.path.split(".").pop() || "");
          setTimeout(() => {
            const monaco = window.__monaco;
            if (monaco?.editor) {
              monaco.editor.revealLineInCenter(att.startLine);
              monaco.editor.setPosition({ lineNumber: att.startLine, column: 1 });
            }
          }, 200);
        });
      } else {
        const ws = ExplorerService.getWorkspacePath();
        if (!ws) return;
        fetch(`/api/file/read?root=${encodeURIComponent(ws)}&path=${encodeURIComponent(att.path)}`).then((r) => r.ok ? r.json() : null).then((d) => {
          if (!d) return;
          const content = d.encoding === "base64" ? "[\u4E8C\u8FDB\u5236\u6587\u4EF6\uFF0C\u65E0\u6CD5\u9884\u89C8]" : d.content;
          openFileTab(att.path, content, att.path.split(".").pop() || "");
        });
      }
    });
  });
}
function showDropZone(show) {
  const dz = $("fi-drop-zone");
  if (dz) dz.classList.toggle("show", show);
  const fa = $("fi");
  if (fa) fa.classList.toggle("drag-over", show);
}
function bind() {
  const ci = $("ci"), cs = $("cs");
  if (!ci || !cs) return;
  ci.addEventListener("input", () => {
    ci.style.height = "auto";
    ci.style.height = Math.min(ci.scrollHeight, 120) + "px";
    handleSlash(ci);
  });
  let _streamGen = 0;
  function sendOrStop() {
    const ci2 = ci;
    const st = window.__state;
    if (st.IL) {
      if (st.CS) {
        st.CS.onmessage = null;
        st.CS.onerror = null;
        st.CS.close();
        st.CS = null;
      }
      const last = st.M[st.M.length - 1];
      if (last?.streaming) last.streaming = false;
      st.IL = false;
      updateUI();
      sb("ms");
      return;
    }
    const ciVal = ci2.value.trim();
    if (!ciVal) return;
    ci2.value = "";
    ci2.style.height = "auto";
    st.M.push({ role: "user", content: ciVal });
    st.IL = true;
    st.M.push({ role: "assistant", content: "", streaming: true });
    updateUI();
    sb("ms");
    const _ws = localStorage.getItem("workspace_path") || "";
    const gen = ++_streamGen;
    if (st.CS) {
      st.CS.onmessage = null;
      st.CS.onerror = null;
      st.CS.close();
      st.CS = null;
    }
    st.CS = new EventSource("/api/chat/stream");
    st.CS.onmessage = (e) => {
      if (_streamGen !== gen) return;
      try {
        const d = JSON.parse(e.data);
        const last = st.M[st.M.length - 1];
        if (d.type === "delta") {
          if (d.thinking) {
            sb("ms");
            return;
          }
          if (last?.streaming) appendDelta(d.text || "");
          else {
            st.M.push({ role: "assistant", content: d.text || "", streaming: true });
            updateUI();
          }
          sb("ms");
        } else if (d.type === "done") {
          if (last) {
            last.content = d.text || "";
            last.streaming = false;
          }
          st.IL = false;
          st.CS?.close();
          st.CS = null;
          const _cs = $("cs");
          const _ci = $("ci");
          if (_cs) {
            _cs.disabled = false;
            _cs.title = "\u53D1\u9001\u6D88\u606F";
            _cs.innerHTML = window.S("iup", 16);
          }
          if (_ci) _ci.disabled = false;
          const msgsEl = $("ms");
          if (msgsEl) {
            const md = msgsEl.querySelectorAll(".m"), lm = md[md.length - 1];
            if (lm) {
              lm.classList.remove("go");
              const ty = lm.querySelector(".ty");
              if (ty) ty.remove();
            }
          }
          sb("ms");
        }
      } catch {
      }
    };
    st.CS.onerror = () => {
      if (_streamGen !== gen) return;
      const last = st.M[st.M.length - 1];
      if (last?.streaming) {
        last.streaming = false;
        st.IL = false;
      }
      if (st.CS) {
        toast("\u8FDE\u63A5\u4E2D\u65AD\uFF0C\u8BF7\u91CD\u8BD5", "error");
        st.CS?.close();
        st.CS = null;
        updateUI();
      }
    };
    const atts = _pendingAttachments.length > 0 ? _pendingAttachments : void 0;
    const finalMsg = buildInstruction(ciVal);
    const body = atts ? { message: finalMsg, workspace: _ws, attachments: atts } : { message: finalMsg, workspace: _ws };
    fetch("/api/chat", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }).then(() => {
      if (atts) clearAttachments();
    }).catch(() => {
      if (_streamGen === gen) {
        window.__state.IL = false;
        updateUI();
        toast("\u53D1\u9001\u5931\u8D25\uFF0C\u8BF7\u68C0\u67E5\u7F51\u7EDC\u8FDE\u63A5", "error");
      }
    });
  }
  ci.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendOrStop();
    }
    if (e.key === "Escape") {
      const se = $("fi-slash");
      if (se) se.style.display = "none";
    }
    if (e.key === "Tab" && ci.value.startsWith("/")) {
      e.preventDefault();
      const slashEl2 = $("fi-slash");
      if (slashEl2 && slashEl2.style.display !== "none") {
        const first = slashEl2.querySelector(".fi-slash-item");
        if (first) first.click();
      }
    }
  });
  cs.addEventListener("click", sendOrStop);
  const modelBtn = $("fi-model-btn");
  if (modelBtn) {
    modelBtn.onclick = (e) => {
      const st = window.__state.D;
      if (!st || st.modelId === "N/A" || st.modelId === "unknown") {
        window.openSettingsModal?.();
      } else {
        showModelPicker(e);
      }
    };
    updateModelName();
  }
  loadModeState();
  const modeBtn = $("fi-mode-btn");
  if (modeBtn) {
    modeBtn.onclick = () => showModePopup(modeBtn);
  }
  const fileBtn = $("fi-file-btn");
  if (fileBtn) {
    fileBtn.onclick = async () => {
      const api = window.electronAPI;
      if (api?.openFile) {
        const p = await api.openFile();
        if (p) {
          const ws = ExplorerService.getWorkspacePath();
          const relPath = ws ? p.replace(ws.replace(/\\/g, "/"), "").replace(/^\/+/, "") : p;
          const name = p.split(/[/\\]/).pop() || p;
          addAttachment({ kind: "file", path: relPath, name });
        }
      } else {
        toast("\u8BF7\u4F7F\u7528 Electron \u684C\u9762\u7248", "info");
      }
    };
  }
  const fiArea = $("fi");
  if (fiArea) {
    fiArea.addEventListener("dragover", (e) => {
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
      showDropZone(true);
    });
    fiArea.addEventListener("dragleave", (e) => {
      if (!fiArea.contains(e.relatedTarget)) {
        showDropZone(false);
      }
    });
    fiArea.addEventListener("drop", (e) => {
      e.preventDefault();
      showDropZone(false);
      let treeNodeId = e.dataTransfer?.getData("text/tree-node");
      if (!treeNodeId) {
        const plain = e.dataTransfer?.getData("text/plain") || "";
        if (plain.startsWith("tree-node:")) treeNodeId = plain.slice(10);
      }
      if (treeNodeId) {
        const ws = ExplorerService.getWorkspacePath();
        if (!ws) {
          toast("\u8BF7\u5148\u9009\u62E9\u5DE5\u4F5C\u533A", "error");
          return;
        }
        const name = treeNodeId.split("/").pop() || treeNodeId;
        const tree = ExplorerService._getTree?.();
        const node = tree?._findNodeById?.(treeNodeId);
        if (node?.isDir) {
          addAttachment({ kind: "folder", path: treeNodeId, name: name + "/" });
        } else {
          addAttachment({ kind: "file", path: treeNodeId, name });
        }
        toast(`\u5DF2\u6DFB\u52A0: ${name}`, "success");
      } else if (e.dataTransfer?.files && e.dataTransfer.files.length > 0) {
        toast("\u8BF7\u4F7F\u7528\u6587\u4EF6\u83DC\u5355\u6216\u76EE\u5F55\u6811\u6DFB\u52A0\u6587\u4EF6", "info");
      }
    });
  }
  const slashEl = $("fi-slash");
  if (slashEl) {
    slashEl.querySelectorAll(".fi-slash-item").forEach((item) => {
      item.addEventListener("click", () => {
        const cmd = item.dataset.cmd || "";
        ci.value = cmd + " ";
        ci.focus();
        slashEl.style.display = "none";
        ci.style.height = "auto";
      });
    });
  }
  pollTokenUsage();
  setInterval(pollTokenUsage, 6e3);
}
function updateModelName() {
  const mn = $("fi-model-name");
  if (!mn) return;
  const st = window.__state.D;
  if (!st || st.modelId === "N/A" || !st.modelId) {
    mn.textContent = "\u672A\u914D\u7F6E";
    mn.style.color = "var(--tm)";
  } else {
    mn.textContent = st.modelId;
    mn.style.color = "";
  }
}
function updateUI() {
  const ci = $("ci"), cs = $("cs");
  const stIL = window.__state.IL;
  if (ci) ci.disabled = stIL;
  if (cs) {
    cs.disabled = stIL ? false : !ci?.value.trim();
    cs.title = stIL ? "\u4E2D\u6B62" : "\u53D1\u9001\u6D88\u606F";
    cs.innerHTML = stIL ? window.S("ipause", 16) : window.S("iup", 16);
  }
  $("ms").innerHTML = msgs();
}
function showModelPicker(e) {
  const existing = $("model-picker");
  if (existing) {
    existing.remove();
    return;
  }
  const target = e.currentTarget || $("fi-model-btn");
  fetch("/api/models").then((r) => r.json()).then((data) => {
    if (!data.models || !data.models.length) {
      toast("\u6CA1\u6709\u53EF\u7528\u6A21\u578B");
      return;
    }
    const rect = target.getBoundingClientRect();
    const picker = document.createElement("div");
    picker.id = "model-picker";
    picker.style.cssText = `position:fixed;bottom:${window.innerHeight - rect.top + 4}px;left:${rect.left}px;z-index:999;background:var(--be);border:1px solid var(--bd);border-radius:8px;padding:4px;max-height:200px;overflow-y:auto;min-width:200px;box-shadow:0 8px 32px rgba(0,0,0,.5)`;
    const grouped = {};
    for (const m of data.models) {
      if (!grouped[m.provider]) grouped[m.provider] = [];
      grouped[m.provider].push(m);
    }
    for (const [provider, models] of Object.entries(grouped)) {
      const header = document.createElement("div");
      header.style.cssText = "font-size:.6rem;font-weight:600;text-transform:uppercase;color:var(--tm);padding:6px 10px 3px;letter-spacing:.05em;font-family:var(--fd)";
      header.textContent = provider;
      picker.appendChild(header);
      for (const m of models) {
        const item = document.createElement("div");
        const stD = window.__state.D;
        const active = m.provider === stD?.modelProvider && m.id === stD?.modelId;
        item.style.cssText = `padding:6px 10px;border-radius:4px;cursor:pointer;font-size:.78rem;font-family:var(--fm);color:${active ? "var(--am)" : "var(--ts)"};background:${active ? "rgba(245,158,11,.1)" : "transparent"}`;
        item.textContent = m.id;
        item.onmouseenter = () => {
          item.style.background = "var(--bc)";
        };
        item.onmouseleave = () => {
          item.style.background = active ? "rgba(245,158,11,.1)" : "transparent";
        };
        item.onclick = () => {
          fetch("/api/model/switch", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ provider, modelId: m.id }) }).then((r) => r.json()).then((r) => {
            if (r.ok) {
              toast("\u5DF2\u5207\u6362: " + m.id, "success");
              getD();
              picker.remove();
            } else toast("\u5207\u6362\u5931\u8D25: " + (r.error || ""), "error");
          }).catch(() => toast("\u5207\u6362\u5931\u8D25", "error"));
        };
        picker.appendChild(item);
      }
    }
    document.body.appendChild(picker);
    const close = function(ev) {
      if (!picker.contains(ev.target) && ev.target !== target) {
        picker.remove();
        document.removeEventListener("click", close, true);
      }
    };
    setTimeout(() => document.addEventListener("click", close, true), 0);
  }).catch((err) => {
    console.error("[model picker]", err);
    toast("\u52A0\u8F7D\u6A21\u578B\u5217\u8868\u5931\u8D25");
  });
}
window.msgs = msgs;
window.bind = bind;
window.updateUI = updateUI;
window.showModelPicker = showModelPicker;
const AppChat = window.App?.Chat;
if (AppChat) {
  AppChat.msgs = msgs;
  AppChat.bind = bind;
  AppChat.updateUI = updateUI;
  AppChat.showModelPicker = showModelPicker;
  AppChat.appendDelta = appendDelta;
  AppChat.updateModelName = updateModelName;
  AppChat.addAttachment = addAttachment;
  AppChat.removeAttachment = removeAttachment;
  AppChat.clearAttachments = clearAttachments;
  AppChat.getPendingAttachments = () => _pendingAttachments;
  AppChat.setMode = setMode;
  AppChat.setEffort = setEffort;
  AppChat.getMode = () => _currentMode;
  AppChat.getEffort = () => _currentEffort;
}
