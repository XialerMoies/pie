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
{
  const AppChat = window.App?.Chat;
  if (AppChat) {
    AppChat.addAttachment = addAttachment;
    AppChat.removeAttachment = removeAttachment;
    AppChat.clearAttachments = clearAttachments;
    AppChat.getPendingAttachments = () => _pendingAttachments;
    AppChat.showDropZone = showDropZone;
  }
}
