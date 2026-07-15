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
window.pollTokenUsage = pollTokenUsage;
