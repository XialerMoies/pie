// 全局快捷键 + 快速打开 + 帮助
// 从 dashboard-layout.ts 拆出

function saveCurrentFile(): Promise<void> {
  const id = (window as any).__state._activeFileTab;
  if (!id) return Promise.resolve();
  const m = (window as any).__monaco;
  const content = m?.getValue() ?? '';
  if (!content && !m) return Promise.resolve();
  const status = $('fc-status');
  if (status) status.textContent = '保存中...';
  const ws = ExplorerService.getWorkspacePath();
  return fetch('/api/file/write', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ root: ws, path: id, content }),
  }).then(r => r.json()).then(d => {
    if (!d.error) {
      if (status) { status.textContent = '已保存'; setTimeout(() => { if (status) status.textContent = ''; }, 2000); }
      const tab = (window as any).__state._fileTabs.find((t: any) => t.id === id);
      if (tab) tab.content = content;
      toast('✅ 已保存: ' + (id.split('/').pop() || id), 'success');
    } else {
      if (status) status.textContent = '保存失败: ' + d.error;
      toast('❌ 保存失败: ' + d.error, 'error');
    }
  }).catch(() => {
    if (status) status.textContent = '保存失败';
    toast('❌ 保存失败: 网络错误', 'error');
  });
}

function quickOpenFile(): void {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.style.zIndex = '10000';
  overlay.innerHTML = `<div class="modal-box" style="width:500px;height:auto;min-height:unset;padding:12px;position:absolute;top:80px;left:50%;transform:translateX(-50%)">
    <input id="qo-input" type="text" placeholder="输入文件名搜索..." autofocus
      style="width:100%;padding:8px 10px;border-radius:6px;border:1px solid var(--bd);background:var(--bc);color:var(--tx);font-size:.82rem;font-family:var(--fb);outline:none;box-sizing:border-box">
    <div id="qo-results" style="margin-top:6px;max-height:300px;overflow-y:auto;font-size:.75rem"></div>
  </div>`;
  document.body.appendChild(overlay);

  const input = document.getElementById('qo-input') as HTMLInputElement | null;
  const results = document.getElementById('qo-results') as HTMLElement | null;
  if (!input || !results) { overlay.remove(); return; }

  let timer: ReturnType<typeof setTimeout> | null = null;
  input.addEventListener('input', () => {
    clearTimeout(timer);
    const q = input.value.trim();
    if (!q) { results.innerHTML = '<div style="padding:12px;text-align:center;color:var(--tm)">输入文件名搜索</div>'; return; }
    timer = setTimeout(async () => {
      try {
        const ws = ExplorerService.getWorkspacePath();
        if (!ws) { results.innerHTML = '<div style="padding:12px;text-align:center;color:var(--tm)">未选择工作区</div>'; return; }
        const r = await fetch(`/api/search?root=${encodeURIComponent(ws)}&q=${encodeURIComponent(q)}&mode=filename`);
        const d = await r.json();
        if (!d.results || d.results.length === 0) { results.innerHTML = '<div style="padding:12px;text-align:center;color:var(--tm)">未找到文件</div>'; return; }
        results.innerHTML = d.results.map((f: { path: string; name: string }) =>
          `<div class="qo-item" data-path="${E(f.path)}">${ExplorerService.iconFor(f.name, false)} ${E(f.name)} <span style="color:var(--tm);font-size:.6rem;margin-left:auto">${E(f.path)}</span></div>`
        ).join('');
        results.querySelectorAll('.qo-item').forEach(el => {
          el.addEventListener('click', async () => {
            const path = (el as HTMLElement).dataset.path || '';
            overlay.remove();
            try {
              const r2 = await fetch(`/api/file/read?root=${encodeURIComponent(ws)}&path=${encodeURIComponent(path)}`);
              const d2 = await r2.json();
              if (!r2.ok) return;
              const content = d2.encoding === 'base64' ? '[二进制文件，无法预览]' : d2.content;
              openFileTab(path, content, (path.split('.').pop() || ''));
            } catch {}
          });
        });
      } catch { results.innerHTML = '<div style="padding:12px;text-align:center;color:var(--rs)">搜索失败</div>'; }
    }, 200);
  });

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') overlay.remove();
    if (e.key === 'Enter') { const first = results?.querySelector('.qo-item') as HTMLElement | null; first?.click(); }
  });

  setTimeout(() => input.focus(), 50);
  overlay.addEventListener('click', (ev) => { if (ev.target === overlay) overlay.remove(); });
}

function showShortcutsHelp(): void {
  const existing = document.getElementById('shortcuts-modal');
  if (existing) { existing.remove(); return; }
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.id = 'shortcuts-modal';
  const shortcuts = [
    ['Ctrl+S', '保存文件'],
    ['Ctrl+W', '关闭标签'],
    ['Ctrl+Tab', '下一个标签'],
    ['Ctrl+Shift+Tab', '上一个标签'],
    ['Ctrl+P', '快速打开文件'],
    ['Ctrl+N', '新建会话'],
    ['Ctrl+B', '切换侧栏'],
    ['Ctrl+`', '打开终端'],
    ['F1', '快捷键帮助'],
  ];
  overlay.innerHTML = `<div class="modal-box" style="width:400px;height:auto;min-height:unset;padding:16px">
    <div class="modal-header" style="padding:0 0 12px;border:none">
      <span class="modal-title">快捷键</span>
      <button class="modal-close" onclick="this.closest('.modal-overlay').remove()">✕</button>
    </div>
    <div style="display:grid;grid-template-columns:auto 1fr;gap:6px 20px;font-size:.78rem">
      ${shortcuts.map(([k, d]) => `<span style="font-family:var(--fm);color:var(--am);white-space:nowrap">${k}</span><span style="color:var(--ts)">${d}</span>`).join('')}
    </div>
    <div style="margin-top:12px;padding-top:10px;border-top:1px solid var(--bd);font-size:.68rem;color:var(--tm);text-align:center">macOS 下 Ctrl 替换为 Cmd</div>
  </div>`;
  document.body.appendChild(overlay);
  overlay.addEventListener('click', (ev) => { if (ev.target === overlay) overlay.remove(); });
}

// ─── 全局快捷键 ─────────────────────────────────────────────
document.addEventListener('keydown', (e) => {
  const ctrl = e.ctrlKey || e.metaKey;
  const key = e.key.toLowerCase();

  if (ctrl && key === 's') {
    const fc = $('file-content');
    if (fc && fc.style.display !== 'none') { e.preventDefault(); saveCurrentFile(); return; }
  }
  if (ctrl && key === 'w') {
    e.preventDefault();
    const active = (window as any).__state._activeFileTab;
    if (active) { closeFileTab(active); return; }
  }
  if (ctrl && key === 'tab' && !e.shiftKey) {
    e.preventDefault();
    const tabs = (window as any).__state._fileTabs;
    if (tabs.length === 0) return;
    const active = (window as any).__state._activeFileTab;
    const idx = active ? tabs.findIndex((t: any) => t.id === active) : -1;
    const next = (idx + 1) % tabs.length;
    const target = tabs[next >= 0 ? next : 0]?.id;
    if (target) switchTab(target);
  }
  if (ctrl && key === 'tab' && e.shiftKey) {
    e.preventDefault();
    const tabs = (window as any).__state._fileTabs;
    if (tabs.length === 0) return;
    const active = (window as any).__state._activeFileTab;
    const idx = active ? tabs.findIndex((t: any) => t.id === active) : 0;
    const prev = (idx - 1 + tabs.length) % tabs.length;
    const target = tabs[prev >= 0 ? prev : tabs.length - 1]?.id;
    if (target) switchTab(target);
  }
  if (ctrl && key === 'n') {
    e.preventDefault();
    const sess = (window as any).App?.Session;
    if (sess?.newSession) sess.newSession();
    else (window as any).newSession?.();
  }
  if (ctrl && key === 'b') {
    e.preventDefault();
    togglePanel((window as any).__state._activePanel);
  }
  if (ctrl && key === 'p') {
    e.preventDefault();
    quickOpenFile();
  }
  if (key === 'f1') {
    e.preventDefault();
    showShortcutsHelp();
  }
  if (ctrl && (key === '`' || key === '~')) {
    e.preventDefault();
    launchCli();
  }
});

// ─── window 别名 ──────────────────────────────────
(window as any).saveCurrentFile = saveCurrentFile;
(window as any).quickOpenFile = quickOpenFile;

// ─── App 绑定 ──────────────────────────────────────
{ const U = (window as any).App?.UI; if (U) {
  U.saveCurrentFile = saveCurrentFile;
} }
