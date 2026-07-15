function togglePanel(name) {
  const si = $("si"), pc = $("pc");
  if (!si || !pc) return;
  if (window.__state._activePanel === name && !si.classList.contains("closed")) {
    si.classList.add("closed");
    si.style.width = "";
    document.querySelectorAll(".sbar .b[data-side]").forEach((b) => b.classList.remove("on"));
    return;
  }
  window.__state._activePanel = name;
  si.classList.remove("closed");
  const savedWidth = (() => {
    try {
      return parseInt(localStorage.getItem("panel-width") || "", 10);
    } catch {
      return 0;
    }
  })();
  si.style.width = (savedWidth > 50 ? savedWidth : 260) + "px";
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
      } else {
        try {
          localStorage.setItem("panel-width", String(si.offsetWidth));
        } catch {
        }
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
    el.onclick = window.showModelPicker;
  });
}
window.togglePanel = togglePanel;
window.renderPanel = renderPanel;
window.sinfoHTML = sinfoHTML;
window.refreshSinfo = refreshSinfo;
{
  const U = window.App?.UI;
  if (U) {
    U.togglePanel = togglePanel;
    U.renderPanel = renderPanel;
    U.sinfoHTML = sinfoHTML;
    U.refreshSinfo = refreshSinfo;
  }
}
