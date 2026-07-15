let lastMessagesRenderKey = "";
let submitMessageHandler = null;
let activeSendContext = null;
function chatGetActiveSessionTabId() {
  const fn = window.getActiveSessionTabId;
  if (typeof fn === "function") return fn();
  try {
    const id = localStorage.getItem("active-session-tab");
    return id || null;
  } catch {
    return null;
  }
}
function chatIsDraftSessionId(id) {
  return typeof id === "string" && id.startsWith("draft:");
}
function chatReadLocalSessionTabIds() {
  try {
    const raw = localStorage.getItem("session-tabs");
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((id) => typeof id === "string" && id.length > 0) : [];
  } catch {
    return [];
  }
}
function chatWriteLocalSessionTabIds(ids) {
  const unique = Array.from(new Set(ids.filter((id) => typeof id === "string" && id.length > 0)));
  try {
    localStorage.setItem("session-tabs", JSON.stringify(unique));
  } catch {
  }
  if (window.__state) window.__state._sessionTabs = unique;
}
function chatSetActiveSessionTabId(id) {
  const fn = window.setActiveSessionTabId;
  if (typeof fn === "function") {
    fn(id);
    return;
  }
  try {
    if (id) localStorage.setItem("active-session-tab", id);
    else localStorage.removeItem("active-session-tab");
  } catch {
  }
}
function chatCommitSessionTab(oldId, newId) {
  const fn = window.commitSessionTab;
  if (typeof fn === "function") {
    fn(oldId, newId);
    return;
  }
  const nextIds = chatReadLocalSessionTabIds().map((id) => id === oldId ? newId : id);
  if (!nextIds.includes(newId)) nextIds.push(newId);
  chatWriteLocalSessionTabIds(nextIds);
  chatSetActiveSessionTabId(newId);
  try {
    localStorage.setItem("last-session-id", newId);
  } catch {
  }
}
async function ensureSessionForSend() {
  const activeTabId = chatGetActiveSessionTabId();
  if (activeTabId && !chatIsDraftSessionId(activeTabId)) {
    return { sessionId: activeTabId, persistent: true };
  }
  const ws = localStorage.getItem(App.Constants.WS_KEY) || "";
  try {
    const response = await fetch("/api/sessions/new", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workspace: ws })
    });
    const data = await response.json().catch(() => ({}));
    const sessionId = typeof data.id === "string" ? data.id : "";
    if (activeTabId && chatIsDraftSessionId(activeTabId) && sessionId) {
      chatCommitSessionTab(activeTabId, sessionId);
      chatSetActiveSessionTabId(sessionId);
      try {
        localStorage.setItem("last-session-id", sessionId);
      } catch {
      }
      return { sessionId, persistent: true, draftId: activeTabId };
    }
    return { sessionId, persistent: false, draftId: activeTabId && chatIsDraftSessionId(activeTabId) ? activeTabId : void 0 };
  } catch {
    const draftId = activeTabId && chatIsDraftSessionId(activeTabId) ? activeTabId : void 0;
    return {
      sessionId: draftId || "",
      persistent: Boolean(draftId),
      draftId
    };
  }
}
async function deleteEphemeralSession(sessionId) {
  if (!sessionId) return;
  try {
    await fetch("/api/sessions/delete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: sessionId })
    });
  } catch {
  }
}
function buildMessagesRenderKey() {
  return JSON.stringify(window.__state.M.map((message) => ({
    role: message.role,
    content: message.content,
    thinking: message.thinking || "",
    streaming: Boolean(message.streaming),
    error: message.error ? {
      title: message.error.title,
      message: message.error.message,
      reason: message.error.reason || "",
      nextSteps: message.error.nextSteps || [],
      raw: message.error.raw || ""
    } : null,
    traceCount: message.trace?.length || 0,
    turnId: message.turnId || ""
  })));
}
function extractLastUserMessage() {
  for (let i = window.__state.M.length - 1; i >= 0; i--) {
    const msg = window.__state.M[i];
    if (msg.role === "user" && msg.content.trim()) return msg.content.trim();
  }
  return "";
}
function retryLastTurn() {
  if (window.__state.IL) return;
  const text = extractLastUserMessage();
  if (!text) {
    toast("\u6CA1\u6709\u53EF\u91CD\u53D1\u7684\u6D88\u606F", "error");
    return;
  }
  const input = $("ci");
  if (submitMessageHandler) submitMessageHandler(text);
  else if (input) {
    input.value = text;
    updateUI();
  }
}
async function copyLastError() {
  const last = [...window.__state.M].reverse().find((m) => m.error?.message || m.error?.reason || m.error?.raw);
  const error = last?.error;
  if (!error) {
    toast("\u6CA1\u6709\u53EF\u590D\u5236\u7684\u9519\u8BEF", "error");
    return;
  }
  const text = [
    error.title,
    error.message,
    error.reason ? `\u53EF\u80FD\u539F\u56E0\uFF1A${error.reason}` : "",
    error.nextSteps?.length ? `\u4E0B\u4E00\u6B65\u64CD\u4F5C\uFF1A${error.nextSteps.join("\uFF1B")}` : "",
    error.raw ? `\u8BE6\u60C5\uFF1A${error.raw}` : ""
  ].filter(Boolean).join("\n");
  try {
    await navigator.clipboard.writeText(text);
    toast("\u5DF2\u590D\u5236\u9519\u8BEF", "success");
  } catch {
    toast("\u590D\u5236\u5931\u8D25", "error");
  }
}
function refreshWorkspaceState() {
  loadSessions();
  getD();
  const pc = $("pc");
  if (pc) renderPanel(window.__state._activePanel, pc);
  if (App.Git?.refreshGit) setTimeout(() => App.Git.refreshGit(), 200);
}
function bind() {
  const ci = $("ci"), cs = $("cs");
  if (!ci || !cs) return;
  ci.addEventListener("input", () => {
    ci.style.height = "auto";
    ci.style.height = Math.min(ci.scrollHeight, 120) + "px";
    const fn = App.Chat?.handleSlash;
    if (fn) fn(ci);
  });
  let _streamGen = 0;
  let renderFrame = null;
  function makeErrorState(title, message, reason, nextSteps, raw) {
    return { title, message, reason, nextSteps, raw };
  }
  function setAssistantError(title, message, reason, nextSteps, raw) {
    const last = window.__state.M[window.__state.M.length - 1];
    if (!last) return;
    last.error = makeErrorState(title, message, reason, nextSteps, raw);
    last.streaming = false;
    last.thinking = "";
    updateUI();
  }
  function submitMessage(rawText) {
    const ci2 = ci;
    const st = window.__state;
    const ciVal = rawText.trim();
    if (!ciVal) return;
    ci2.value = "";
    ci2.style.height = "auto";
    if (ciVal === "/clear") {
      st.IL = false;
      fetch("/api/clear", { method: "POST" }).then((r) => r.json()).then((d) => toast(d.ok ? "\u7F13\u5B58\u5DF2\u6E05\u9664" : "\u6E05\u9664\u5931\u8D25", d.ok ? "success" : "error")).catch(() => toast("\u6E05\u9664\u5931\u8D25", "error"));
      updateUI();
      return;
    }
    st.M.push({ role: "user", content: ciVal });
    st.IL = true;
    st.M.push({ role: "assistant", content: "", thinking: "", streaming: true });
    updateUI();
    sb("ms");
    const _ws = localStorage.getItem(App.Constants.WS_KEY) || "";
    const gen = ++_streamGen;
    const activeTabId = chatGetActiveSessionTabId();
    activeSendContext = activeTabId && !chatIsDraftSessionId(activeTabId) ? { sessionId: activeTabId, persistent: true } : activeTabId && chatIsDraftSessionId(activeTabId) ? { sessionId: "", persistent: true, draftId: activeTabId } : { sessionId: "", persistent: false };
    if (st.CS) {
      st.CS.onmessage = null;
      st.CS.onerror = null;
      st.CS.close();
      st.CS = null;
    }
    st.CS = new EventSource("/api/chat/stream");
    const finalizeSendContext = (context) => {
      if (context && !context.persistent && context.sessionId) {
        void deleteEphemeralSession(context.sessionId).then(() => loadSessions());
      } else {
        loadSessions();
      }
    };
    void (async () => {
      const prepared = await ensureSessionForSend();
      if (_streamGen !== gen || !st.IL) return;
      activeSendContext = prepared;
      const atts = App.Chat?.getPendingAttachments?.();
      const pending = atts && atts.length > 0 ? atts : void 0;
      const finalMsg = App.Chat?.buildInstruction?.(ciVal) || ciVal;
      const body = pending ? { message: finalMsg, workspace: _ws, attachments: pending } : { message: finalMsg, workspace: _ws };
      fetch("/api/chat", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }).then(() => {
        if (pending) App.Chat?.clearAttachments?.();
      }).catch((err) => {
        if (_streamGen !== gen) return;
        setAssistantError(
          "\u53D1\u9001\u5931\u8D25",
          "\u6D88\u606F\u6CA1\u6709\u6210\u529F\u9001\u8FBE\u540E\u7AEF\uFF0C\u8BF7\u68C0\u67E5\u5F53\u524D\u8FDE\u63A5\u3002",
          err instanceof Error ? err.message : "\u8BF7\u6C42 `/api/chat` \u5931\u8D25",
          ["\u786E\u8BA4\u540E\u7AEF\u670D\u52A1\u662F\u5426\u4ECD\u5728\u8FD0\u884C", "\u68C0\u67E5\u5F53\u524D\u5DE5\u4F5C\u533A\u662F\u5426\u6709\u6548", "\u91CD\u65B0\u53D1\u9001\u5F53\u524D\u6D88\u606F"],
          err instanceof Error ? err.stack || err.message : String(err)
        );
        window.__state.IL = false;
        updateUI();
        const failedContext = activeSendContext;
        activeSendContext = null;
        finalizeSendContext(failedContext);
      });
    })();
    st.CS.onmessage = (e) => {
      if (_streamGen !== gen) return;
      try {
        const d = JSON.parse(e.data);
        const last = st.M[st.M.length - 1];
        if (d.type === "block") {
          if (last?.streaming && d.block) {
            if (!last.blocks) last.blocks = [];
            const idx = last.blocks.findIndex((b) => b.blockId === d.block.blockId);
            if (idx >= 0) last.blocks[idx] = d.block;
            else last.blocks.push(d.block);
            const updated = App.Chat?.updateLastBlock?.(d.block) || false;
            if (!updated) scheduleMessagesRender();
            else sb("ms");
          }
          return;
        } else if (d.type === "trace") {
          if (last?.streaming) {
            if (d.trace?.turnId && !last.turnId) last.turnId = d.trace.turnId;
            if (!last.trace) last.trace = [];
            const idx = last.trace.findIndex((t) => t.id === d.trace.id);
            if (idx >= 0) last.trace[idx] = d.trace;
            else last.trace.push(d.trace);
            renderLastTrace();
          }
          return;
        } else if (d.type === "delta") {
          if (d.thinking) {
            sb("ms");
            return;
          }
          if (last?.streaming) {
            if (!last.blocks?.length) App.Chat?.appendDelta?.(d.text || "");
          } else {
            st.M.push({ role: "assistant", content: d.text || "", thinking: "", streaming: true });
            updateUI();
          }
          sb("ms");
        } else if (d.type === "thinking") {
          if (last) {
            last.thinking = (last.thinking || "") + (d.text || "");
          }
          sb("ms");
        } else if (d.type === "done") {
          if (!last) return;
          if (d.turnId && !last.turnId) last.turnId = d.turnId;
          last.content = d.text || "";
          last.streaming = false;
          last.error = void 0;
          if (Array.isArray(d.blocks)) last.blocks = d.blocks;
          st.IL = false;
          st.CS?.close();
          st.CS = null;
          renderMessages();
          const _cs = $("cs");
          const _ci = $("ci");
          if (_cs) {
            _cs.disabled = false;
            _cs.title = "\u53D1\u9001\u6D88\u606F";
            _cs.innerHTML = S("iup", 16);
          }
          if (_ci) _ci.disabled = false;
          const sessionId = d.sessionId || activeSendContext?.sessionId || "";
          const sendContext = activeSendContext;
          activeSendContext = null;
          if (sendContext && !sendContext.persistent && sessionId) {
            void deleteEphemeralSession(sessionId).then(() => loadSessions());
          } else {
            if (sessionId) {
              try {
                localStorage.setItem("last-session-id", sessionId);
              } catch {
              }
            }
            loadSessions();
          }
          sb("ms");
        } else if (d.type === "error") {
          const reason = d.text || d.message || "\u672A\u77E5\u9519\u8BEF";
          setAssistantError(
            "\u53D1\u751F\u4E86\u9519\u8BEF",
            "\u5F53\u524D\u56DE\u590D\u672A\u80FD\u5B8C\u6210\u3002\u8BF7\u5148\u67E5\u770B\u9519\u8BEF\u8BE6\u60C5\uFF0C\u518D\u51B3\u5B9A\u662F\u5426\u91CD\u8BD5\u3002",
            reason,
            ["\u68C0\u67E5\u7F51\u7EDC\u548C\u6A21\u578B\u914D\u7F6E", "\u786E\u8BA4\u5DE5\u4F5C\u533A\u8DEF\u5F84\u4ECD\u7136\u6709\u6548", "\u91CD\u8BD5\u53D1\u9001\u5F53\u524D\u6D88\u606F"],
            reason
          );
          st.IL = false;
          st.CS?.close();
          st.CS = null;
          renderMessages();
          const _cs2 = $("cs");
          const _ci2 = $("ci");
          if (_cs2) {
            _cs2.disabled = false;
            _cs2.title = "\u53D1\u9001\u6D88\u606F";
            _cs2.innerHTML = S("iup", 16);
          }
          if (_ci2) _ci2.disabled = false;
          const failedContext = activeSendContext;
          activeSendContext = null;
          finalizeSendContext(failedContext);
          sb("ms");
          console.error("[chat] SSE error:", d.text || d.message);
        }
      } catch {
      }
    };
    st.CS.onerror = () => {
      if (_streamGen !== gen) return;
      const last = st.M[st.M.length - 1];
      if (last?.streaming) {
        setAssistantError(
          "\u8FDE\u63A5\u4E2D\u65AD",
          "\u4E0E\u540E\u7AEF\u7684\u6D41\u5F0F\u8FDE\u63A5\u5DF2\u65AD\u5F00\u3002\u56DE\u590D\u53EF\u80FD\u6CA1\u6709\u5B8C\u6574\u4FDD\u5B58\u3002",
          "EventSource \u8FDE\u63A5\u88AB\u5173\u95ED\u6216\u670D\u52A1\u5668\u6682\u65F6\u4E0D\u53EF\u7528",
          ["\u68C0\u67E5\u540E\u7AEF\u662F\u5426\u4ECD\u5728\u8FD0\u884C", "\u7A0D\u540E\u91CD\u8BD5\u5F53\u524D\u6D88\u606F", "\u5982\u679C\u53CD\u590D\u51FA\u73B0\uFF0C\u5237\u65B0\u5DE5\u4F5C\u533A"],
          "EventSource closed"
        );
        st.IL = false;
      }
      if (st.CS) {
        toast("\u8FDE\u63A5\u4E2D\u65AD\uFF0C\u8BF7\u91CD\u8BD5", "error");
        st.CS?.close();
        st.CS = null;
        updateUI();
      }
      const failedContext = activeSendContext;
      activeSendContext = null;
      finalizeSendContext(failedContext);
    };
  }
  submitMessageHandler = submitMessage;
  function renderMessages(scroll = true) {
    if (renderFrame !== null) {
      cancelAnimationFrame(renderFrame);
      renderFrame = null;
    }
    const msgsEl = $("ms");
    if (msgsEl && window.msgs) {
      lastMessagesRenderKey = buildMessagesRenderKey();
      msgsEl.innerHTML = window.msgs();
      if (scroll) sb("ms");
    }
  }
  function scheduleMessagesRender(scroll = true) {
    if (renderFrame !== null) return;
    renderFrame = requestAnimationFrame(() => {
      renderFrame = null;
      renderMessages(scroll);
    });
  }
  App.Chat.scheduleMessagesRender = scheduleMessagesRender;
  function renderLastTrace(scroll = true) {
    const msgsEl = $("ms");
    const renderTrace = App.Chat?.renderTrace;
    if (!msgsEl || !renderTrace) {
      scheduleMessagesRender(scroll);
      return;
    }
    const msgDivs = msgsEl.querySelectorAll(".m");
    const lastMsg = msgDivs[msgDivs.length - 1];
    const last = window.__state.M[window.__state.M.length - 1];
    if (!lastMsg || !last) {
      scheduleMessagesRender(scroll);
      return;
    }
    const traceHtml = renderTrace(last.trace);
    let traceEl = lastMsg.querySelector(".trace");
    if (!traceHtml) {
      traceEl?.remove();
    } else if (traceEl) {
      const wrapper = document.createElement("div");
      wrapper.innerHTML = traceHtml;
      traceEl.replaceWith(wrapper.firstElementChild);
    } else {
      const label = lastMsg.querySelector(".ml");
      if (label) label.insertAdjacentHTML("afterend", traceHtml);
      else lastMsg.insertAdjacentHTML("afterbegin", traceHtml);
    }
    if (scroll) sb("ms");
  }
  function sendOrStop() {
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
    submitMessage(ci.value);
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
  App.Chat?.loadModeState?.();
  const modeBtn = $("fi-mode-btn");
  if (modeBtn) {
    modeBtn.onclick = () => App.Chat?.showModePopup?.(modeBtn);
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
          App.Chat?.addAttachment?.({ kind: "file", path: relPath, name });
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
      App.Chat?.showDropZone?.(true);
    });
    fiArea.addEventListener("dragleave", (e) => {
      if (!fiArea.contains(e.relatedTarget)) {
        App.Chat?.showDropZone?.(false);
      }
    });
    fiArea.addEventListener("drop", (e) => {
      e.preventDefault();
      App.Chat?.showDropZone?.(false);
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
          App.Chat?.addAttachment?.({ kind: "folder", path: treeNodeId, name: name + "/" });
        } else {
          App.Chat?.addAttachment?.({ kind: "file", path: treeNodeId, name });
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
  window.pollTokenUsage?.();
  setInterval(() => window.pollTokenUsage?.(), 6e3);
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
    cs.innerHTML = stIL ? S("ipause", 16) : S("iup", 16);
  }
  const msgsEl = $("ms");
  const nextKey = buildMessagesRenderKey();
  if (msgsEl && nextKey !== lastMessagesRenderKey) {
    lastMessagesRenderKey = nextKey;
    msgsEl.innerHTML = window.msgs ? window.msgs() : "";
  }
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
window.bind = bind;
window.updateUI = updateUI;
window.showModelPicker = showModelPicker;
{
  const AppChat = window.App?.Chat;
  if (AppChat) {
    AppChat.bind = bind;
    AppChat.updateUI = updateUI;
    AppChat.showModelPicker = showModelPicker;
    AppChat.updateModelName = updateModelName;
    App.Chat.retryLastTurn = retryLastTurn;
    App.Chat.copyLastError = copyLastError;
    App.Chat.refreshWorkspaceState = refreshWorkspaceState;
  }
}
