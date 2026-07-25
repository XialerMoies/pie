/**
 * Chat (Session History) pane — 会话列表面板 + 对话搜索
 *
 * 样式参考 Claude Code 侧边栏设计。
 */
/// <reference path="../../dashboard.d.ts" />

let _convQuery = "";
let _convTimer: ReturnType<typeof setTimeout> | null = null;

async function doConvSearch(): Promise<void> {
  const list = document.getElementById("sl");
  if (!list) return;
  const q = _convQuery.trim();
  if (!q) { loadSessions(); return; }

  const seq = bumpSessionListSeq();
  list.classList.remove("is-loading");
  list.innerHTML = '<div class="search-status">搜索中…</div>';
  try {
    const r = await fetch("/api/search/conversations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: q }),
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error);
    if (!isCurrentSessionListSeq(seq)) return;
    renderConvResults(list, data);
  } catch (e: unknown) {
    if (!isCurrentSessionListSeq(seq)) return;
    const msg = e instanceof Error ? e.message : String(e);
    list.classList.remove("is-loading");
    list.innerHTML = `<div class="search-status error">搜索失败: ${E(msg)}</div>`;
  }
}

function renderConvResults(list: HTMLElement, data: any): void {
  list.classList.remove("is-loading");
  if (!data.results?.length) {
    list.innerHTML = '<div class="cs-empty">未找到匹配的对话</div>';
    return;
  }
  let html = `<div class="cs-count">${data.results.length} 个会话，${data.total} 处匹配</div>`;
  for (const r of data.results) {
    html += `<div class="cs-session" onclick="App.Session?.activate?.('${E(r.sessionId)}')">`;
    html += `<div class="cs-session-title">${E(r.sessionName)}</div>`;
    for (const m of r.matches.slice(0, 3)) {
      const icon = m.role === "user" ? "→" : "←";
      html += `<div class="cs-match"><span class="cs-match-role">${icon}</span><span class="cs-match-text">${E(m.text)}</span></div>`;
    }
    if (r.matches.length > 3) {
      html += `<div class="cs-more">… 还有 ${r.matches.length - 3} 处匹配</div>`;
    }
    html += `</div>`;
  }
  if (data.truncated) html += `<div class="cs-more">… 结果过多已截断</div>`;
  list.innerHTML = html;
}

function chatPaneRender(container: HTMLElement): void {
  container.style.cssText = "display:flex;flex-direction:column;height:100%;min-height:0";
  container.innerHTML = [
    // 1. 标题
    `<div class="ch-header">任务线程</div>`,
    // 2. 新会话
    `<div class="ch-new" onclick="App.Session?.newSession?.() || newSession?.()">
      <span class="ch-new-icon">+</span> 开启新对话
    </div>`,
    // 3. 搜索
    `<div class="ch-search">
      <span class="ch-search-icon">🔍</span>
      <input class="ch-search-input" id="chat-search-input" placeholder="搜索会话…">
    </div>`,
    // 4. 列表
    `<div class="session-list" id="sl">加载中...</div>`,
  ].join("");
  loadSessions();

  const input = document.getElementById("chat-search-input") as HTMLInputElement | null;
  if (input) {
    input.addEventListener("input", () => {
      _convQuery = input.value;
      if (_convTimer) clearTimeout(_convTimer);
      _convTimer = setTimeout(doConvSearch, 300);
    });
    input.addEventListener("keydown", (e: KeyboardEvent) => {
      if (e.key === "Enter") {
        if (_convTimer) clearTimeout(_convTimer);
        doConvSearch();
      }
    });
  }
}

registerPane('chat', chatPaneRender);
