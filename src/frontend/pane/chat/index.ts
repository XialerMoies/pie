/**
 * Chat (Session History) pane — 会话列表面板 + 对话搜索
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
    list.innerHTML = '<div class="search-status dim">未找到匹配的对话</div>';
    return;
  }
  let html = `<div class="search-count" style="padding:6px">${data.results.length} 个会话，${data.total} 处匹配</div>`;
  for (const r of data.results) {
    html += `<div class="search-file" style="margin:4px 0">`;
    html += `<div class="search-file-name" onclick="App.Session?.activate?.('${E(r.sessionId)}')">`;
    html += `💬 ${E(r.sessionName)} <span class="search-file-path">${E(r.workspace)}</span>`;
    html += `</div>`;
    for (const m of r.matches) {
      const icon = m.role === "user" ? "👤" : m.role === "assistant" ? "🤖" : "📝";
      html += `<div class="search-match" style="padding:2px 6px 2px 22px">`;
      html += `<span class="search-match-text">${icon} ${E(m.text)}</span>`;
      html += `</div>`;
    }
    html += `</div>`;
  }
  if (data.truncated) {
    html += `<div class="search-more">… 结果过多已截断</div>`;
  }
  list.innerHTML = html;
}

function chatPaneRender(container: HTMLElement): void {
  container.style.cssText = "display:flex;flex-direction:column;height:100%;min-height:0";
  container.innerHTML = [
    '<div class="sg-t">任务线程</div>',
    '<input class="s-search" id="chat-search-input" placeholder="搜索对话…" style="margin:4px 6px;width:calc(100% - 12px)">',
    '<div class="session-kicker" style="padding:0 6px">按当前任务、历史任务和项目归档整理</div>',
    '<div class="session-list" id="sl" style="flex:1;min-height:0;overflow-y:auto">加载中...</div>',
  ].join('');
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
