// ═══════════════════════════════════════════════════════════════════
//  Attachments — 引用文件/文件夹/代码片段
// ═══════════════════════════════════════════════════════════════════

let _pendingAttachments: ChatAttachment[] = [];
let _attachIdCounter = 0;

function addAttachment(att: Omit<ChatAttachment, 'id'>): void {
  const id = 'att-' + Date.now().toString(36) + '-' + (++_attachIdCounter);
  _pendingAttachments.push({ ...att, id });
  renderAttachments();
}

function removeAttachment(id: string): void {
  _pendingAttachments = _pendingAttachments.filter(a => a.id !== id);
  renderAttachments();
}

function clearAttachments(): void {
  _pendingAttachments = [];
  renderAttachments();
}

function renderAttachments(): void {
  const bar = $('fi-attach-bar') as HTMLElement | null;
  if (!bar) return;
  if (_pendingAttachments.length === 0) {
    bar.style.display = 'none';
    bar.innerHTML = '';
    return;
  }
  bar.style.display = 'flex';
  bar.innerHTML = _pendingAttachments.map(a => {
    let info = '';
    if (a.kind === 'folder') {
      info = a.fileCount ? ` · ${a.fileCount} 文件` : '';
    } else if (a.kind === 'clip') {
      info = ` · ${a.startLine}-${a.endLine}`;
    }
    const iconHtml = ExplorerService.iconFor(a.name, a.kind === 'folder');
    return `<div class="fi-attach-pill" data-attach-id="${E(a.id)}" data-kind="${E(a.kind)}" title="${E(a.path)}">
      ${iconHtml}
      <span class="fi-attach-pill-name">${E(a.name)}</span>
      <span class="fi-attach-pill-info">${info}</span>
      <button type="button" class="fi-attach-del" aria-label="删除附件">✕</button>
    </div>`;
  }).join('');
  bar.querySelectorAll('.fi-attach-pill').forEach(pill => {
    pill.addEventListener('click', (e) => {
      const id = (pill as HTMLElement).dataset.attachId || '';
      if ((e.target as HTMLElement).closest('.fi-attach-del')) {
        e.stopPropagation();
        if (id) removeAttachment(id);
        return;
      }
      const att = _pendingAttachments.find(a => a.id === id);
      if (!att) return;
      if (att.kind === 'clip' && att.startLine != null) {
        const ws = ExplorerService.getWorkspacePath();
        if (!ws) return;
        fetch(`/api/file/read?root=${encodeURIComponent(ws)}&path=${encodeURIComponent(att.path)}`)
          .then(r => r.ok ? r.json() : null)
          .then(d => {
            if (!d) return;
            const content = d.encoding === 'base64' ? '[二进制文件，无法预览]' : d.content;
            openFileTab(att.path, content, att.path.split('.').pop() || '');
            setTimeout(() => {
              const monaco = (window as any).__monaco;
              if (monaco?.editor) {
                monaco.editor.revealLineInCenter(att.startLine!);
                monaco.editor.setPosition({ lineNumber: att.startLine!, column: 1 });
              }
            }, 200);
          });
      } else {
        const ws = ExplorerService.getWorkspacePath();
        if (!ws) return;
        fetch(`/api/file/read?root=${encodeURIComponent(ws)}&path=${encodeURIComponent(att.path)}`)
          .then(r => r.ok ? r.json() : null)
          .then(d => {
            if (!d) return;
            const content = d.encoding === 'base64' ? '[二进制文件，无法预览]' : d.content;
            openFileTab(att.path, content, att.path.split('.').pop() || '');
          });
      }
    });
  });
}

function showDropZone(show: boolean): void {
  const dz = $('fi-drop-zone');
  if (dz) dz.classList.toggle('show', show);
  const fa = $('fi');
  if (fa) fa.classList.toggle('drag-over', show);
}

// ─── App 命名空间绑定 ──────────────────────────────────────
{ const AppChat = (window as any).App?.Chat; if (AppChat) {
  AppChat.addAttachment = addAttachment;
  AppChat.removeAttachment = removeAttachment;
  AppChat.clearAttachments = clearAttachments;
  AppChat.getPendingAttachments = () => _pendingAttachments;
  AppChat.showDropZone = showDropZone;
} }
