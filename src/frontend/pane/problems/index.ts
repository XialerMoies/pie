/**
 * Problems Pane — 问题面板
 *
 * 功能：
 *   - 按 severity 分组展示问题（错误 / 警告 / 信息）
 *   - 显示每个问题所在文件和行列号
 *   - 点击跳转到文件对应位置
 *   - 过滤当前文件 / 工作区 / 仅错误
 *   - store 有更新时自动刷新
 *
 * 数据来源：window.__problemsStore（ProblemsStore 数据层）
 */

/// <reference path="../../dashboard.d.ts" />

/** 将相对路径转为 tsserver 绝对路径（用于 code actions API） */
function _tsserverAbsPath(filePath: string): string {
  const key = (window as any).App?.Constants?.WS_KEY;
  const root = key ? (window as any).localStorage?.getItem?.(key) || "" : "";
  return root ? root + "/" + filePath : filePath;
}

// ─── 过滤状态 ──────────────────────────────────────

let _problemsFilter: 'workspace' | 'current-file' | 'errors-only' = 'workspace';

// ─── 面板渲染 ──────────────────────────────────────

function problemsPaneRender(container: HTMLElement): void {
  const store = (window as any).__problemsStore as ProblemsStoreAPI | undefined;
  if (!store) {
    container.innerHTML = '<div class="sg-t">问题</div><div class="sg-item dim" style="padding:12px;color:var(--tm)">问题面板不可用</div>';
    return;
  }

  let allProblems = store.getProblems();
  const currentFile = _getCurrentFile();

  // 应用过滤
  if (_problemsFilter === 'current-file' && currentFile) {
    allProblems = allProblems.filter(p => p.filePath === currentFile);
  } else if (_problemsFilter === 'errors-only') {
    allProblems = allProblems.filter(p => p.severity === 'error');
  }

  // 按严重度分组（保持顺序：错误 → 警告 → 信息）
  const errors = allProblems.filter(p => p.severity === 'error');
  const warnings = allProblems.filter(p => p.severity === 'warning');
  const infos = allProblems.filter(p => p.severity === 'info');

  const totalAll = store.getProblems().length;
  const totalErrors = store.getErrorCount();
  const totalWarnings = store.getWarningCount();
  const totalInfos = store.getInfoCount();

  // 构建 HTML
  let html = '';

  // 过滤栏
  html += `<div class="pf-bar">
    <button class="pf-btn${_problemsFilter === 'workspace' ? ' on' : ''}" data-filter="workspace">工作区 <span class="pf-cnt">${totalAll}</span></button>
    <button class="pf-btn${_problemsFilter === 'current-file' ? ' on' : ''}" data-filter="current-file">当前文件</button>
    <button class="pf-btn${_problemsFilter === 'errors-only' ? ' on' : ''}" data-filter="errors-only">仅错误 <span class="pf-cnt">${totalErrors}</span></button>
  </div>`;

  if (totalAll === 0) {
    html += '<div class="pf-empty">当前没有检测到问题 ✦</div>';
    container.innerHTML = html;
    _bindFilterButtons(container);
    return;
  }

  // 汇总统计
  html += `<div class="pf-summary">
    ${_sevTag('error', totalErrors)}
    ${_sevTag('warning', totalWarnings)}
    ${_sevTag('info', totalInfos)}
    <span class="pf-files">${store.getFileCount()} 个文件</span>
  </div>`;

  // 分组渲染
  if (errors.length > 0) html += _renderGroup('错误', errors, 'var(--ud)');
  if (warnings.length > 0) html += _renderGroup('警告', warnings, 'var(--uw)');
  if (infos.length > 0) html += _renderGroup('信息', infos, 'var(--in)');

  container.innerHTML = html;
  _bindFilterButtons(container);
  _bindProblemClicks(container);
  _bindProblemFixButtons(container);
}

// ─── 辅助渲染函数 ──────────────────────────────────

function _sevTag(sev: string, count: number): string {
  const color = sev === 'error' ? 'var(--ud)' : sev === 'warning' ? 'var(--uw)' : 'var(--in)';
  return `<span class="pf-sev-tag" style="color:${color}">${sev} ${count}</span>`;
}

function _renderGroup(label: string, items: ProblemItem[], color: string): string {
  let html = `<div class="pf-group">
    <div class="pf-group-hd" style="border-left-color:${color}">
      <span class="pf-group-label">${label}</span>
      <span class="pf-group-cnt">${items.length}</span>
    </div>`;

  // 按文件分组
  const byFile = new Map<string, ProblemItem[]>();
  for (const p of items) {
    const list = byFile.get(p.filePath) || [];
    list.push(p);
    byFile.set(p.filePath, list);
  }

  for (const [filePath, fileProblems] of byFile) {
    const fileName = filePath.split('/').pop() || filePath;
    for (const p of fileProblems) {
      const codeText = p.code != null ? String(p.code) : '';
      const canFix = p.severity !== 'info' && codeText.length > 0;
      html += `<div class="pf-item" data-file="${E(filePath)}" data-line="${p.line}" data-col="${p.column}" data-code="${E(codeText)}" title="${E(p.message)}">
        <span class="pf-sev-dot" style="background:${color}"></span>
        <span class="pf-msg">${E(p.message)}</span>
        ${canFix ? `<button class="pf-act" data-fix="1" title="应用首个可用修复">修复</button>` : ''}
        <span class="pf-loc">${E(fileName)}:${p.line}:${p.column}</span>
        ${p.code ? `<span class="pf-code">${E(String(p.code))}</span>` : ''}
      </div>`;
    }
  }

  html += '</div>';
  return html;
}

function _getCurrentFile(): string | null {
  const m = (window as any).__monaco as MonacoAPI | undefined;
  return m?.getCurrentFile?.() || null;
}

// ─── 事件绑定 ──────────────────────────────────────

function _bindFilterButtons(container: HTMLElement): void {
  container.querySelectorAll('.pf-btn[data-filter]').forEach(el => {
    (el as HTMLElement).onclick = () => {
      _problemsFilter = (el as HTMLElement).dataset.filter as typeof _problemsFilter;
      problemsPaneRender(container);
    };
  });
}

function _bindProblemClicks(container: HTMLElement): void {
  container.querySelectorAll('.pf-item').forEach(el => {
    (el as HTMLElement).onclick = () => {
      const file = (el as HTMLElement).dataset.file;
      const line = parseInt((el as HTMLElement).dataset.line || '1', 10);
      const col = parseInt((el as HTMLElement).dataset.col || '1', 10);
      if (!file) return;

      // 打开文件并定位
      _navigateToProblem(file, line, col);
    };
  });
}

function _bindProblemFixButtons(container: HTMLElement): void {
  container.querySelectorAll('.pf-act[data-fix="1"]').forEach(el => {
    (el as HTMLElement).onclick = async (event) => {
      event.stopPropagation();
      const item = (el as HTMLElement).closest('.pf-item') as HTMLElement | null;
      if (!item) return;

      const file = item.dataset.file || '';
      const line = parseInt(item.dataset.line || '1', 10);
      const col = parseInt(item.dataset.col || '1', 10);
      const code = item.dataset.code || '';
      if (!file || !code) return;

      await _applyFirstFix(file, line, col, code);
    };
  });
}

/** 获取工作区根目录路径 */
function _getWorkspaceRoot(): string {
  const key = (window as any).App?.Constants?.WS_KEY;
  return key ? (window as any).localStorage?.getItem?.(key) || "" : "";
}

async function _navigateToProblem(filePath: string, line: number, col: number): Promise<void> {
  const tabs = (window as any).__tabs;
  const tab = tabs?.getTab?.(filePath);

  if (tab) {
    // Tab 已存在 → 直接激活
    const AT = (window as any).App?.Tabs;
    if (AT) AT.activate(filePath);
  } else {
    // Tab 不存在 → 先从磁盘读取内容再打开（_fileActivate 不会自动读磁盘）
    const fn = (window as any).openFileTab as Function | undefined;
    if (fn) {
      const root = _getWorkspaceRoot();
      let content = '';
      try {
        const resp = await fetch(`/api/file/read?root=${encodeURIComponent(root)}&path=${encodeURIComponent(filePath)}`);
        const data = await resp.json();
        content = data?.content || '';
      } catch { /* 读取失败时用空内容兜底 */ }
      fn(filePath, content, '.' + (filePath.split('.').pop() || '').toLowerCase());
    }
  }

  // 等待 Monaco 就绪后定位（_fileActivate 是 async，需要轮询等待）
  const m = (window as any).__monaco as MonacoAPI | undefined;
  if (!m) return;

  for (let attempt = 0; attempt < 40; attempt++) {
    if (m.isReady?.() && m.getCurrentFile?.() === filePath) {
      m.revealPosition(line, col);
      return;
    }
    await new Promise(r => requestAnimationFrame(r));
  }

  // 超时兜底
  try { m.revealPosition(line, col); } catch {}
}

async function _applyFirstFix(filePath: string, line: number, col: number, code: string): Promise<void> {
  const parsedCode = Number(code);
  if (!Number.isFinite(parsedCode)) {
    _toast('该问题没有可用代码', 'info');
    return;
  }

  const root = _getWorkspaceRoot();
  if (!root) {
    _toast('未找到工作区根目录', 'error');
    return;
  }

  try {
    const resp = await fetch('/api/ts/code-actions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        file: _tsserverAbsPath(filePath),
        line,
        offset: col,
        endLine: line,
        endOffset: col,
        errorCodes: [parsedCode],
      }),
    });
    const data = await resp.json();
    const action = data?.actions?.find((a: any) => a?.changes?.length > 0);
    if (!action) {
      _toast('没有可用修复', 'info');
      return;
    }

    const applyResp = await fetch('/api/ts/apply-code-action', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ changes: action.changes }),
    });
    const applyData = await applyResp.json();
    if (!applyData?.ok && !applyData?.partial) {
      _toast(applyData?.errors?.[0] || '代码修复应用失败', 'error');
      return;
    }

    const refresh = (window as any).__monaco?.refreshDiagnosticsForFile as ((filePath: string) => Promise<void>) | undefined;
    const changedFiles = Array.isArray(applyData?.files) && applyData.files.length > 0 ? applyData.files : [filePath];
    await Promise.all(changedFiles.map((changedFile: string) => refresh ? refresh(changedFile) : Promise.resolve()));
    if (applyData?.partial) _toast('部分文件代码修复失败，请检查', 'error');
    else _toast('已应用修复', 'success');
  } catch (err) {
    _toast(`代码修复失败: ${(err as Error).message}`, 'error');
  }
}

function _toast(message: string, type?: 'info' | 'error' | 'success'): void {
  const fn = (window as any).toast || (window as any).App?.UI?.toast;
  if (typeof fn === 'function') fn(message, type);
}

// ─── HTML 转义 ─────────────────────────────────────

function E(s: unknown): string {
  const d = document.createElement('div');
  d.textContent = String(s ?? '');
  return d.innerHTML;
}

// ─── 面板注册 ──────────────────────────────────────

if (typeof registerPane === 'function') {
  registerPane('problems', problemsPaneRender);
}

// ─── Store 变更自动刷新 ────────────────────────────

(function() {
  const store = (window as any).__problemsStore as ProblemsStoreAPI | undefined;
  if (!store) return;

  let _timer: ReturnType<typeof setTimeout> | null = null;

  store.subscribe(() => {
    // 节流：150ms 内多次变更只刷新一次
    if (_timer) clearTimeout(_timer);
    _timer = setTimeout(() => {
      _timer = null;
      // 只在 problems 面板激活时刷新
      if ((window as any).__state?._activePanel === 'problems') {
        const pc = document.getElementById('pc');
        if (pc) problemsPaneRender(pc);
      }
    }, 150);
  });
})();
