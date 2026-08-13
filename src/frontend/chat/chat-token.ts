// ═══════════════════════════════════════════════════════════════════
//  Token Display — Token Rail + Usage 面板
//  应用事件触发 /api/usage/current 刷新，更新 Rail 和面板数据
// ═══════════════════════════════════════════════════════════════════

function fmt(n: number | null | undefined): string {
  if (n == null) return '--';
  if (n < 1000) return String(n);
  if (n < 1000000) return (n / 1000).toFixed(n < 10000 ? 1 : 0) + 'k';
  return (n / 1000000).toFixed(1) + 'M';
}

function formatPercent(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '--%';
  const clamped = Math.max(0, Math.min(100, value));
  if (clamped > 0 && clamped < 0.1) return '<0.1%';
  const digits = clamped < 10 && !Number.isInteger(clamped) ? 1 : 0;
  return clamped.toFixed(digits).replace(/\.0$/, '') + '%';
}

// ─── Currency helpers ────────────────────────────────────
const CNY_PER_USD = 7.2;

const CURRENCY_MAP: Record<string, { sym: string; rate: number }> = {
  deepseek: { sym: '¥', rate: CNY_PER_USD },
  moonshot: { sym: '¥', rate: CNY_PER_USD },
  'zhipu-ai': { sym: '¥', rate: CNY_PER_USD },
  baidu: { sym: '¥', rate: CNY_PER_USD },
  alibaba: { sym: '¥', rate: CNY_PER_USD },
  bytedance: { sym: '¥', rate: CNY_PER_USD },
  '01-ai': { sym: '¥', rate: CNY_PER_USD },
};

function formatCost(costUsd: number | null | undefined, provider?: string): string {
  if (costUsd == null) return '--';
  const info = CURRENCY_MAP[provider?.toLowerCase() ?? ''] || { sym: '$', rate: 1 };
  const converted = costUsd * info.rate;
  if (converted < 0.01) return info.sym + converted.toFixed(6);
  if (converted < 1) return info.sym + converted.toFixed(4);
  return info.sym + converted.toFixed(2);
}

// ─── 当前缓存的 usage 数据（供面板使用） ────────────────
let _lastUsageData: UsageCurrentResponse | null = null;

interface UsageCurrentResponse {
  sessionId: string;
  provider: string;
  hasActiveSession: boolean;
  contextUsage: { tokens: number | null; contextWindow: number; percent: number | null } | null;
  tokens: { input: number; output: number; cacheRead: number; cacheWrite: number };
  cacheHitRate: number;
  cost: number;
  compactCount: number;
  lastCompactionAt: string | null;
  lastCompactionSummary: string | null;
  isStreaming: boolean;
  isCompacting: boolean;
}

// ─── Token Rail 更新 ────────────────────────────────────

function isChatTabActive(): boolean {
  const tabs = App.Tabs;
  const active = tabs?.getActiveTab?.();
  return active != null && (active.kind === 'chat' || active.kind === 'session');
}

function updateRail(data: UsageCurrentResponse): void {
  const pctEl = $('tr-pct');
  const crEl = $('tr-cr');
  const btnEl = $('tr-btn') as HTMLButtonElement | null;

  if (!pctEl) return; // Rail 还没渲染

  // 当前活跃 tab 不是 chat/session 时显示无会话
  if (!data.hasActiveSession || !isChatTabActive()) {
    pctEl.textContent = '--%';
    crEl.textContent = '--%';
    if (btnEl) { btnEl.disabled = true; btnEl.textContent = '详情'; btnEl.title = '打开会话后可查看详情'; }
    return;
  }

  // 上下文百分比
  const pct = data.contextUsage?.percent;
  pctEl.textContent = formatPercent(pct);
  // 警戒色（使用 CSS 类而非 inline style，确保 --uw/--ud 变量生效）
  pctEl.classList.toggle('danger', pct != null && pct >= 85);
  pctEl.classList.toggle('warn', pct != null && pct >= 70 && pct < 85);

  // 缓存命中率
  crEl.textContent = formatPercent(data.cacheHitRate);

  // 压缩按钮
  if (btnEl) {
    if (data.isCompacting) {
      btnEl.disabled = true;
      btnEl.textContent = '...';
      btnEl.title = '正在压缩';
    } else if (data.isStreaming) {
      btnEl.disabled = true;
      btnEl.textContent = '压缩';
      btnEl.title = '请等待回复完成';
    } else {
      btnEl.disabled = false;
      btnEl.textContent = '压缩';
      btnEl.title = '压缩上下文';
    }
  }
}

// ─── Usage 面板 ─────────────────────────────────────────

let _usageModalEl: HTMLElement | null = null;
let _usageTab: 'current' | 'summary' = 'current';
let _usageSummaryFetchInFlight: Promise<void> | null = null;

class UsageModalView {
  static render(): string {
    return `
    <div class="usage-panel">
      <button class="usage-close" id="usage-close">&times;</button>
      <div class="usage-head">
        <button class="usage-tab active" data-tab="current">当前会话</button>
        <button class="usage-tab" data-tab="summary">全部会话</button>
      </div>
      <div class="usage-body" id="usage-body">
        <div class="usage-view" id="usage-view-current"></div>
        <div class="usage-view" id="usage-view-summary" hidden></div>
      </div>
    </div>`;
  }
}

function openUsagePanel(): void {
  closeUsagePanel(); // 关闭已有

  // 重置为默认 Tab
  _usageTab = 'current';
  _lastSummary = null;
  _usageSummaryFetchInFlight = null;

  const overlay = document.createElement('div');
  overlay.className = 'usage-modal';
  overlay.id = 'usage-modal';
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) closeUsagePanel();
  });

  overlay.innerHTML = UsageModalView.render();

  document.body.appendChild(overlay);
  _usageModalEl = overlay;

  // 事件绑定
  overlay.querySelector('#usage-close')?.addEventListener('click', closeUsagePanel);
  overlay.querySelectorAll('.usage-tab').forEach((btn) => {
    btn.addEventListener('click', () => {
      overlay.querySelectorAll('.usage-tab').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      _usageTab = (btn as HTMLElement).dataset.tab as 'current' | 'summary';
      renderUsagePanel();
    });
  });

  renderUsagePanel();
}

function closeUsagePanel(): void {
  if (_usageModalEl) {
    _usageModalEl.remove();
    _usageModalEl = null;
  }
}

function renderUsagePanel(refreshActive = false): void {
  const currentView = document.getElementById('usage-view-current');
  const summaryView = document.getElementById('usage-view-summary');
  if (!currentView || !summaryView) return;

  currentView.hidden = _usageTab !== 'current';
  summaryView.hidden = _usageTab !== 'summary';

  if (_usageTab === 'current') {
    if (refreshActive || !currentView.dataset.rendered) {
      renderCurrentSessionUsage(currentView);
      currentView.dataset.rendered = 'true';
    }
  } else if (!summaryView.dataset.rendered) {
    renderSummaryUsage(summaryView);
    summaryView.dataset.rendered = 'true';
  }
}

class UsageCurrentView {
  static render(container: HTMLElement): void {
    const d = _lastUsageData;
    if (!d || !d.hasActiveSession || !isChatTabActive()) {
      container.innerHTML = '<div class="usage-none">未选择会话</div>';
      return;
    }

    const pct = d.contextUsage?.percent;
    const pctDisplay = formatPercent(pct);
    const pctClass = pct != null && pct >= 85 ? 'usage-danger' : pct != null && pct >= 70 ? 'usage-warn' : '';

    container.innerHTML = `
    <div class="usage-grid">
      <div class="usage-card">
        <div class="usage-card-val ${pctClass}">${pctDisplay}</div>
        <div class="usage-card-lb">上下文窗口</div>
        <div style="font-size:.65rem;color:var(--tm);margin-top:2px">${d.contextUsage?.tokens != null ? fmt(d.contextUsage.tokens) : '--'} / ${d.contextUsage?.contextWindow ? fmt(d.contextUsage.contextWindow) : '--'}</div>
      </div>
      <div class="usage-card">
        <div class="usage-card-val">${formatPercent(d.cacheHitRate)}</div>
        <div class="usage-card-lb">缓存命中率</div>
      </div>
      <div class="usage-card">
        <div class="usage-card-val">${formatCost(d.cost, d.provider)}</div>
        <div class="usage-card-lb">费用</div>
      </div>
    </div>

    <div class="usage-section">
      <div class="usage-section-hd">Token 用量</div>
      <div class="usage-detail">
        <span class="usage-dl">输入</span><span class="usage-dv">${fmt(d.tokens.input)}</span>
        <span class="usage-dl">输出</span><span class="usage-dv">${fmt(d.tokens.output)}</span>
        <span class="usage-dl">缓存命中</span><span class="usage-dv">${fmt(d.tokens.cacheRead)}</span>
        <span class="usage-dl">缓存写入</span><span class="usage-dv">${fmt(d.tokens.cacheWrite)}</span>
      </div>
    </div>

    <div class="usage-section">
      <div class="usage-section-hd">Compaction</div>
      <div style="font-size:.75rem;display:grid;grid-template-columns:auto 1fr;gap:4px 12px">
        <span class="usage-dl">压缩次数</span><span class="usage-dv" style="text-align:left">${fmt(d.compactCount)}</span>
        ${d.lastCompactionAt ? `<span class="usage-dl">最近压缩</span><span class="usage-dv" style="text-align:left">${new Date(d.lastCompactionAt).toLocaleString('zh-CN')}</span>` : ''}
      </div>
      ${d.lastCompactionSummary ? `<div class="usage-summary-text">${escapeHtml(d.lastCompactionSummary)}</div>` : ''}
    </div>

    ${d.isCompacting
      ? '<div style="margin-top:12px;font-size:.72rem;color:var(--uw);text-align:center">正在压缩...</div>'
      : `<button class="usage-compact-btn" id="panel-compact-btn" ${d.isStreaming ? 'disabled' : ''}>${d.isStreaming ? '请等待回复完成' : '压缩上下文'}</button>`}
    `;

    requestAnimationFrame(() => {
      const panelBtn = container.querySelector('#panel-compact-btn') as HTMLButtonElement | null;
      if (panelBtn && !panelBtn.disabled) {
        panelBtn.addEventListener('click', () => { closeUsagePanel(); (window as any).openCompactModal?.(); });
      }
    });
  }
}

function renderCurrentSessionUsage(container: HTMLElement): void {
  return UsageCurrentView.render(container);
  const d = _lastUsageData;

  if (!d || !d.hasActiveSession || !isChatTabActive()) {
    container.innerHTML = '<div class="usage-none">未选择会话</div>';
    return;
  }

  // 三指标卡片
  const pct = d.contextUsage?.percent;
  const pctDisplay = formatPercent(pct);
  const pctClass = pct != null && pct >= 85 ? 'usage-danger' : pct != null && pct >= 70 ? 'usage-warn' : '';

  container.innerHTML = `
    <div class="usage-grid">
      <div class="usage-card">
        <div class="usage-card-val ${pctClass}">${pctDisplay}</div>
        <div class="usage-card-lb">上下文窗口</div>
        <div style="font-size:.65rem;color:var(--tm);margin-top:2px">${d.contextUsage?.tokens != null ? fmt(d.contextUsage.tokens) : '--'} / ${d.contextUsage?.contextWindow ? fmt(d.contextUsage.contextWindow) : '--'}</div>
      </div>
      <div class="usage-card">
        <div class="usage-card-val">${formatPercent(d.cacheHitRate)}</div>
        <div class="usage-card-lb">缓存命中率</div>
      </div>
      <div class="usage-card">
        <div class="usage-card-val">${formatCost(d.cost, d.provider)}</div>
        <div class="usage-card-lb">费用</div>
      </div>
    </div>

    <div class="usage-section">
      <div class="usage-section-hd">Token 用量</div>
      <div class="usage-detail">
        <span class="usage-dl">输入</span><span class="usage-dv">${fmt(d.tokens.input)}</span>
        <span class="usage-dl">输出</span><span class="usage-dv">${fmt(d.tokens.output)}</span>
        <span class="usage-dl">缓存命中</span><span class="usage-dv">${fmt(d.tokens.cacheRead)}</span>
        <span class="usage-dl">缓存写入</span><span class="usage-dv">${fmt(d.tokens.cacheWrite)}</span>
      </div>
    </div>

    <div class="usage-section">
      <div class="usage-section-hd">Compaction</div>
      <div style="font-size:.75rem;display:grid;grid-template-columns:auto 1fr;gap:4px 12px">
        <span class="usage-dl">压缩次数</span><span class="usage-dv" style="text-align:left">${fmt(d.compactCount)}</span>
        ${d.lastCompactionAt ? `<span class="usage-dl">最近压缩</span><span class="usage-dv" style="text-align:left">${new Date(d.lastCompactionAt).toLocaleString('zh-CN')}</span>` : ''}
      </div>
      ${d.lastCompactionSummary ? `<div class="usage-summary-text">${escapeHtml(d.lastCompactionSummary)}</div>` : ''}
    </div>

    ${d.isCompacting
      ? '<div style="margin-top:12px;font-size:.72rem;color:var(--uw);text-align:center">正在压缩...</div>'
      : `<button class="usage-compact-btn" id="panel-compact-btn" ${d.isStreaming ? 'disabled' : ''}>${d.isStreaming ? '请等待回复完成' : '压缩上下文'}</button>`}
    `;

    // 面板内压缩按钮
    requestAnimationFrame(() => {
      const panelBtn = container.querySelector('#panel-compact-btn') as HTMLButtonElement | null;
      if (panelBtn && !panelBtn.disabled) {
        panelBtn.addEventListener('click', () => { closeUsagePanel(); (window as any).openCompactModal?.(); });
      }
    });
}

interface SummaryResponse {
  sessions: number;
  tokens: { input: number; output: number; cacheRead: number; cacheWrite: number };
  cost: number;
  compactCount: number;
  lastUpdatedAt: string;
  topSessions: Array<{ id: string; name: string; workspace: string; totalTokens: number; updatedAt: string }>;
}

let _lastSummary: SummaryResponse | null = null;

async function fetchSummary(): Promise<void> {
  if (_usageSummaryFetchInFlight) return _usageSummaryFetchInFlight;
  _usageSummaryFetchInFlight = (async () => {
    try {
      const r = await fetch('/api/usage/summary');
      _lastSummary = await r.json();
    } catch { _lastSummary = null; }
  })().finally(() => {
    _usageSummaryFetchInFlight = null;
  });
  return _usageSummaryFetchInFlight;
}

class UsageSummaryView {
  static render(container: HTMLElement): void {
    if (!_lastSummary) {
      container.innerHTML = '<div class="usage-none">加载中...</div>';
      fetchSummary().then(() => {
        if (_lastSummary && container.isConnected && _usageTab === 'summary') UsageSummaryView.render(container);
      });
      return;
    }

    const s = _lastSummary;
    const t = s.tokens;
    const topHtml = s.topSessions.map((session, i) =>
      `<div style="display:flex;gap:8px;padding:4px 0;font-size:.75rem;border-bottom:1px solid var(--bd)">
      <span style="color:var(--tm);min-width:16px">${i + 1}</span>
      <span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--tx)">${escapeHtml(session.name)}</span>
      <span style="color:var(--tm);font-family:var(--fm)">${fmt(session.totalTokens)}</span>
    </div>`
    ).join('');

    container.innerHTML = `
    <div class="usage-grid">
      <div class="usage-card">
        <div class="usage-card-val">${fmt(s.sessions)}</div>
        <div class="usage-card-lb">总会话数</div>
      </div>
      <div class="usage-card">
        <div class="usage-card-val">${fmt(t.input + t.output + t.cacheRead + t.cacheWrite)}</div>
        <div class="usage-card-lb">总 Tokens</div>
      </div>
      <div class="usage-card">
        <div class="usage-card-val">${formatCost(s.cost)}</div>
        <div class="usage-card-lb">总费用</div>
      </div>
    </div>
    <div class="usage-section">
      <div class="usage-section-hd">Token 用量</div>
      <div class="usage-detail">
        <span class="usage-dl">输入</span><span class="usage-dv">${fmt(t.input)}</span>
        <span class="usage-dl">输出</span><span class="usage-dv">${fmt(t.output)}</span>
        <span class="usage-dl">命中</span><span class="usage-dv">${fmt(t.cacheRead)}</span>
        <span class="usage-dl">未命中</span><span class="usage-dv">${fmt(t.cacheWrite)}</span>
      </div>
    </div>
    <div class="usage-section">
      <div class="usage-section-hd">压缩</div>
      <div style="font-size:.75rem">总压缩次数: ${s.compactCount}</div>
    </div>
    ${s.topSessions.length > 0 ? `
    <div class="usage-section">
      <div class="usage-section-hd">Token 最高会话 Top 5</div>
      ${topHtml}
    </div>` : ''}
    <div style="font-size:.65rem;color:var(--tm);text-align:center;margin-top:8px">${s.lastUpdatedAt ? '数据更新: ' + new Date(s.lastUpdatedAt).toLocaleString('zh-CN') : ''}</div>`;
  }
}

function renderSummaryUsage(container: HTMLElement): void {
  return UsageSummaryView.render(container);
  if (!_lastSummary) {
    container.innerHTML = '<div class="usage-none">加载中...</div>';
    fetchSummary().then(() => {
      if (_lastSummary && container.isConnected && _usageTab === 'summary') renderSummaryUsage(container);
    });
    return;
  }

  const s = _lastSummary;
  const t = s.tokens;
  const topHtml = s.topSessions.map((t, i) =>
    `<div style="display:flex;gap:8px;padding:4px 0;font-size:.75rem;border-bottom:1px solid var(--bd)">
      <span style="color:var(--tm);min-width:16px">${i + 1}</span>
      <span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--tx)">${escapeHtml(t.name)}</span>
      <span style="color:var(--tm);font-family:var(--fm)">${fmt(t.totalTokens)}</span>
    </div>`
  ).join('');

  container.innerHTML = `
    <div class="usage-grid">
      <div class="usage-card">
        <div class="usage-card-val">${fmt(s.sessions)}</div>
        <div class="usage-card-lb">总会话数</div>
      </div>
      <div class="usage-card">
        <div class="usage-card-val">${fmt(t.input + t.output + t.cacheRead + t.cacheWrite)}</div>
        <div class="usage-card-lb">总 Tokens</div>
      </div>
      <div class="usage-card">
        <div class="usage-card-val">${formatCost(s.cost)}</div>
        <div class="usage-card-lb">总费用</div>
      </div>
    </div>
    <div class="usage-section">
      <div class="usage-section-hd">Token 用量</div>
      <div class="usage-detail">
        <span class="usage-dl">输入</span><span class="usage-dv">${fmt(t.input)}</span>
        <span class="usage-dl">输出</span><span class="usage-dv">${fmt(t.output)}</span>
        <span class="usage-dl">命中</span><span class="usage-dv">${fmt(t.cacheRead)}</span>
        <span class="usage-dl">未命中</span><span class="usage-dv">${fmt(t.cacheWrite)}</span>
      </div>
    </div>
    <div class="usage-section">
      <div class="usage-section-hd">压缩</div>
      <div style="font-size:.75rem">总压缩次数: ${s.compactCount}</div>
    </div>
    ${s.topSessions.length > 0 ? `
    <div class="usage-section">
      <div class="usage-section-hd">Token 最高会话 Top 5</div>
      ${topHtml}
    </div>` : ''}
    <div style="font-size:.65rem;color:var(--tm);text-align:center;margin-top:8px">${s.lastUpdatedAt ? '数据更新: ' + new Date(s.lastUpdatedAt).toLocaleString('zh-CN') : ''}</div>`;
}

function escapeHtml(s: string): string {
  const d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML;
}

// ─── Token usage updates ─────────────────────────────────

let _tokenRefreshInFlight: Promise<void> | null = null;
let _tokenRefreshQueued = false;
let _tokenUpdateUnsubscribers: Array<() => void> = [];
let _railResizeObserver: ResizeObserver | null = null;
let _railResizeTarget: Element | null = null;

function offsetTopWithin(target: HTMLElement, container: HTMLElement): number {
  let top = 0;
  let element: HTMLElement | null = target;
  while (element && element !== container) {
    top += element.offsetTop;
    element = element.offsetParent as HTMLElement | null;
  }
  if (element === container) return top;
  return target.getBoundingClientRect().top - container.getBoundingClientRect().top;
}

async function refreshTokenUsage(): Promise<void> {
  if (_tokenRefreshInFlight) {
    _tokenRefreshQueued = true;
    return _tokenRefreshInFlight;
  }

  _tokenRefreshInFlight = (async () => {
    do {
      _tokenRefreshQueued = false;
      try {
        const r = await fetch('/api/usage/current');
        const data: UsageCurrentResponse = await r.json();
        _lastUsageData = data;
        updateRail(data);
        if (_usageModalEl) renderUsagePanel(true);
      } catch { /* ignore */ }
    } while (_tokenRefreshQueued);
  })().finally(() => {
    _tokenRefreshInFlight = null;
  });

  return _tokenRefreshInFlight;
}

/** 将 Rail 垂直位置同步到输入框底部 */
function syncRailPosition(): void {
  const rail = document.getElementById('tr-rail');
  const fi = document.getElementById('fi') as HTMLElement | null;
  const fiBox = document.getElementById('fi-box');
  const mc = document.querySelector('.mc');
  if (!rail || !fi || !fiBox || !mc) return;
  if (getComputedStyle(fi).display === 'none') {
    rail.style.display = 'none';
    return;
  }
  rail.style.display = 'flex';
  rail.style.height = '';
  const top = offsetTopWithin(fiBox, mc as HTMLElement);
  const railTop = top + fiBox.offsetHeight - rail.offsetHeight;
  if (railTop >= 0) rail.style.top = railTop + 'px';
}

function watchRailPosition(): void {
  const fiBox = document.getElementById('fi-box');
  if (!fiBox || _railResizeTarget === fiBox) return;
  _railResizeObserver?.disconnect();
  _railResizeTarget = fiBox;
  if (typeof ResizeObserver === 'undefined') return;
  _railResizeObserver = new ResizeObserver(() => syncRailPosition());
  _railResizeObserver.observe(fiBox);
}

function startTokenUpdates(): void {
  stopTokenUpdates();
  watchRailPosition();
  requestAnimationFrame(syncRailPosition);
  void refreshTokenUsage();
  _tokenUpdateUnsubscribers = [
    App.Events.subscribe('usage.changed', () => { void refreshTokenUsage(); }),
    App.Events.subscribe('resync', () => { void refreshTokenUsage(); }),
  ];
}

window.addEventListener('resize', () => requestAnimationFrame(syncRailPosition));

function stopTokenUpdates(): void {
  for (const unsubscribe of _tokenUpdateUnsubscribers) unsubscribe();
  _tokenUpdateUnsubscribers = [];
}

// ─── Compact 弹窗 ───────────────────────────────────────

let _compactModalEl: HTMLElement | null = null;
let _compactInFlight = false;

function openCompactModal(): void {
  closeCompactModal();

  const overlay = document.createElement('div');
  overlay.className = 'usage-modal';
  overlay.id = 'compact-modal';
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) closeCompactModal();
  });

  const d = _lastUsageData;
  const canCompact = d?.hasActiveSession && !d?.isStreaming && !d?.isCompacting && isChatTabActive();
  let disabledReason = '';
  if (!d?.hasActiveSession || !isChatTabActive()) disabledReason = '未选择会话';
  else if (d?.isStreaming) disabledReason = '请等待当前回复完成';
  else if (d?.isCompacting) disabledReason = '正在压缩中';

  overlay.innerHTML = `
    <div class="usage-panel" style="max-width:480px">
      <button class="usage-close" id="compact-close">&times;</button>
      <div style="padding:20px">
        <div style="font-size:.95rem;font-weight:600;color:var(--tx);margin-bottom:8px;font-family:var(--fd)">压缩上下文</div>
        <div style="font-size:.78rem;color:var(--ts);line-height:1.6;margin-bottom:16px">会把较早对话摘要为上下文摘要，最近消息会保留。</div>
        ${!canCompact ? `<div style="font-size:.78rem;color:var(--tm);padding:8px 12px;background:var(--bc);border-radius:6px;margin-bottom:16px">${disabledReason}</div>`
        : `<label style="display:block;font-size:.72rem;color:var(--tm);margin-bottom:4px;font-family:var(--fd)">摘要重点（可选）</label>
        <textarea id="compact-focus" rows="3" style="width:100%;box-sizing:border-box;padding:8px 10px;border-radius:6px;border:1px solid var(--bd);background:var(--bc);color:var(--tx);font-size:.78rem;font-family:var(--fm);outline:none;resize:vertical;min-height:50px" placeholder="例如：当前 bug、已修改文件、后续计划、关键决策"></textarea>
        <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:16px">
          <button id="compact-cancel" style="padding:6px 16px;border-radius:6px;border:1px solid var(--bd);background:0 0;color:var(--ts);font-size:.78rem;font-family:var(--fb);cursor:pointer">取消</button>
          <button id="compact-start" style="padding:6px 16px;border-radius:6px;border:none;background:var(--am);color:#0A0A0F;font-size:.78rem;font-family:var(--fb);font-weight:600;cursor:pointer">开始压缩</button>
        </div>`}
      </div>
    </div>`;

  document.body.appendChild(overlay);
  _compactModalEl = overlay;

  overlay.querySelector('#compact-close')?.addEventListener('click', closeCompactModal);
  overlay.querySelector('#compact-cancel')?.addEventListener('click', closeCompactModal);
  const startBtn = overlay.querySelector('#compact-start') as HTMLButtonElement | null;
  if (startBtn) {
    startBtn.addEventListener('click', () => doCompact());
    // Enter 键触发放缩
    const focusInput = overlay.querySelector('#compact-focus') as HTMLTextAreaElement | null;
    if (focusInput) {
      focusInput.focus();
      focusInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); doCompact(); }
      });
    }
  }
}

function closeCompactModal(): void {
  if (_compactModalEl) {
    _compactModalEl.remove();
    _compactModalEl = null;
  }
}

async function doCompact(): Promise<void> {
  if (_compactInFlight) return;
  _compactInFlight = true;
  const startBtn = document.getElementById('compact-start') as HTMLButtonElement | null;
  const focusInput = document.getElementById('compact-focus') as HTMLTextAreaElement | null;
  if (startBtn) { startBtn.disabled = true; startBtn.textContent = '压缩中...'; }

  try {
    const focus = focusInput?.value?.trim() || undefined;
    const r = await fetch('/api/compact', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ focus }),
    });
    const data = await r.json();

    if (!data.ok) {
      toast(data.error || '压缩失败', 'error');
      _compactInFlight = false;
      if (startBtn) { startBtn.disabled = false; startBtn.textContent = '开始压缩'; }
      return;
    }

    closeCompactModal();
    if (data.compacted) {
      toast(data.message || '压缩完成', 'success');
    } else {
      toast(data.message || '当前会话还不需要压缩', 'info');
    }

    // 刷新 Usage + 清除 summary 缓存（下次切 Tab 时重新拉取）
    _lastSummary = null;
    void refreshTokenUsage();
    // 触发消息刷新（保留完整字段：turnId/blocks/error 等）
    const activeId = App.Tabs.getActiveSessionTabId();
    if (activeId && !activeId.startsWith('draft:')) {
      const ws = App.State.getWorkspacePath();
      try {
        const r2 = await fetch('/api/sessions/activate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: activeId, workspace: ws }),
        });
        const data2 = await r2.json();
        if (data2.ok && Array.isArray(data2.messages)) {
          App.Chat?.resetMsgKeys?.();
          App.ChatState.replaceMessages(data2.messages.map((m: any) => ({
            role: m.role,
            content: m.content,
            thinking: m.thinking || '',
            streaming: false,
            _compacted: m._compacted || false,
            turnId: m.turnId || undefined,
            blocks: m.blocks || undefined,
            error: m.error || undefined,
          })));
          const msgsEl = document.getElementById('ms') as HTMLElement | null;
          if (msgsEl) {
            msgsEl.innerHTML = window.msgs ? window.msgs() : '';
            msgsEl.scrollTop = msgsEl.scrollHeight;
          }
        }
      } catch {}
    }
  } catch (err: any) {
    toast('压缩请求失败: ' + (err?.message || ''), 'error');
    _compactInFlight = false;
    if (startBtn) { startBtn.disabled = false; startBtn.textContent = '开始压缩'; }
  }
  _compactInFlight = false;
}

// ─── 公开 API ───────────────────────────────────────────

(window as any).refreshTokenUsage = refreshTokenUsage;
(window as any).startTokenUpdates = startTokenUpdates;
(window as any).stopTokenUpdates = stopTokenUpdates;
(window as any).syncTokenRailPosition = syncRailPosition;
(window as any).openUsagePanel = openUsagePanel;
(window as any).closeUsagePanel = closeUsagePanel;
(window as any).openCompactModal = openCompactModal;
(window as any).closeCompactModal = closeCompactModal;
