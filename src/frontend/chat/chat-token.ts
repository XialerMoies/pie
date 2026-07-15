// ═══════════════════════════════════════════════════════════════════
//  Token Display
// ═══════════════════════════════════════════════════════════════════

function fmt(n: number | null | undefined): string {
  if (n == null) return '—';
  if (n < 1000) return String(n);
  if (n < 1000000) return (n / 1000).toFixed(n < 10000 ? 1 : 0) + 'k';
  return (n / 1000000).toFixed(1) + 'M';
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

function formatCost(costUsd: number | null | undefined, provider: string): string {
  if (costUsd == null) return '—';
  const info = CURRENCY_MAP[provider.toLowerCase()] || { sym: '$', rate: 1 };
  const converted = costUsd * info.rate;
  if (converted < 0.01) return info.sym + converted.toFixed(6);
  if (converted < 1) return info.sym + converted.toFixed(4);
  return info.sym + converted.toFixed(2);
}

function updateTokenDisplay(cu: TokenUsage | null, ss: SessionStats | null, provider?: string): void {
  const ctxEl = $('fi-tk-ctx');
  const fillEl = $('fi-tk-fill');
  if (ctxEl && cu) {
    const used = cu.tokens, limit = cu.contextWindow;
    ctxEl.textContent = (used != null ? fmt(used) : '—') + ' / ' + (limit ? fmt(limit) : '—');
    if (fillEl) fillEl.style.width = (cu.percent ?? 0) + '%';
  }

  const t = ss?.tokens;
  if (!t) return;
  setText('fi-tk-in', fmt(t.input));
  setText('fi-tk-out', fmt(t.output));
  setText('fi-tk-ch', fmt(t.cacheRead));
  setText('fi-tk-cm', fmt(t.cacheWrite));
  const total = (t.cacheRead || 0) + (t.cacheWrite || 0);
  setText('fi-tk-rate', total > 0 ? Math.round((t.cacheRead || 0) / total * 100) + '%' : '—');
  if (ss.cost != null) setText('fi-tk-cost', formatCost(ss.cost, provider || ''));
}

function setText(id: string, text: string): void {
  const el = $(id);
  if (el) el.textContent = text;
}

// ─── Token polling ───────────────────────────────────────

async function pollTokenUsage(): Promise<void> {
  try {
    const r = await fetch('/api/token-usage');
    const data = await r.json();
    if (data) updateTokenDisplay(data.contextUsage, data.sessionStats, data.provider);
  } catch { /* ignore */ }
}

// 公开 API — pollTokenUsage 被 bind() 调用
(window as any).pollTokenUsage = pollTokenUsage;
