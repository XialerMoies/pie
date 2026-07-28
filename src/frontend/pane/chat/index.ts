/**
 * Chat (Session History) pane — 会话列表面板 + 对话搜索
 *
 * 样式参考 Claude Code 侧边栏设计。
 */
/// <reference path="../../dashboard.d.ts" />

let _convQuery = "";
let _convTimer: ReturnType<typeof setTimeout> | null = null;
let _convCache: any = null;
let _convCacheQuery = "";
let _convPendingQuery = "";
let _convSearching = false;
let _lastInlineHighlight: HTMLElement | null = null;
let _convClickSeq = 0;

async function doConvSearch(): Promise<void> {
  const list = document.getElementById("sl");
  if (!list) return;
  const q = _convQuery.trim();
  if (!q) {
    _convCache = null;
    _convCacheQuery = "";
    _convPendingQuery = "";
    _convSearching = false;
    loadSessions();
    return;
  }

  const seq = bumpSessionListSeq();
  _convSearching = true;
  _convPendingQuery = q;
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
    _convCache = data;
    _convCacheQuery = q;
    _convSearching = false;
    _convPendingQuery = "";
    renderConvResults(list, data);
  } catch (e: unknown) {
    if (!isCurrentSessionListSeq(seq)) return;
    _convSearching = false;
    _convPendingQuery = "";
    const msg = e instanceof Error ? e.message : String(e);
    list.classList.remove("is-loading");
    list.innerHTML = `<div class="search-status error">搜索失败: ${E(msg)}</div>`;
  }
}

/** 用 matchPos 高亮关键词并 HTML 转义 */
function highlightTextWithPositions(text: string, matchPos?: { start: number; end: number }[]): string {
  if (!matchPos || matchPos.length === 0) return E(text);
  let result = "";
  let lastEnd = 0;
  for (const pos of matchPos) {
    result += E(text.slice(lastEnd, pos.start));
    result += `<span class="search-hl">${E(text.slice(pos.start, pos.end))}</span>`;
    lastEnd = pos.end;
  }
  result += E(text.slice(lastEnd));
  return result;
}

/** 格式化为简短相对时间 */
function shortRelTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const min = Math.floor(diff / 60000);
  if (min < 1) return "刚刚";
  if (min < 60) return `${min} 分钟前`;
  const hrs = Math.floor(min / 60);
  if (hrs < 24) return `${hrs} 小时前`;
  const days = Math.floor(hrs / 24);
  if (days < 30) return `${days} 天前`;
  return new Date(iso).toLocaleDateString("zh-CN");
}

function isActiveSession(sessionId: string): boolean {
  const activeTab = (window as any).__tabs?.getActiveTab?.();
  if (activeTab?.id === sessionId) return true;
  if (typeof getActiveSessionTabId === "function" && getActiveSessionTabId() === sessionId) return true;
  return (window as any).__state?._activeSessionTabId === sessionId;
}

function clearInlineHighlight(): void {
  const mark = _lastInlineHighlight;
  if (!mark || !mark.parentNode) { _lastInlineHighlight = null; return; }
  const parent = mark.parentNode;
  parent.replaceChild(document.createTextNode(mark.textContent || ""), mark);
  parent.normalize();
  _lastInlineHighlight = null;
}

function highlightOccurrence(root: Element, query: string, ordinal: number): HTMLElement | null {
  clearInlineHighlight();
  const needle = query.trim();
  if (!needle) return null;
  const needleLower = needle.toLowerCase();
  let seen = 0;
  const textNodeFilter = (window as any).NodeFilter?.SHOW_TEXT ?? 4;
  const walker = document.createTreeWalker(root, textNodeFilter);
  let node = walker.nextNode() as Text | null;
  while (node) {
    const text = node.nodeValue || "";
    const haystack = text.toLowerCase();
    let offset = 0;
    let index = haystack.indexOf(needleLower, offset);
    while (index !== -1) {
      if (seen === ordinal) {
        const range = document.createRange();
        range.setStart(node, index);
        range.setEnd(node, index + needle.length);
        const mark = document.createElement("span");
        mark.className = "msg-match-highlight";
        range.surroundContents(mark);
        _lastInlineHighlight = mark;
        setTimeout(clearInlineHighlight, 2200);
        return mark;
      }
      seen++;
      offset = index + Math.max(needle.length, 1);
      index = haystack.indexOf(needleLower, offset);
    }
    node = walker.nextNode() as Text | null;
  }
  return null;
}

/** 打开会话并滚动到指定消息 */
function openConvMatch(sessionId: string, msgIndex?: number, matchOrdinal?: number): void {
  if (msgIndex === undefined || msgIndex < 0) { App.Tabs.activate(sessionId, { scroll: 'none', refreshSessions: false }); return; }

  const seq = ++_convClickSeq;
  let settled = false;
  let cancel: (() => void) | null = null;
  let delayTimer: ReturnType<typeof setTimeout> | null = null;
  let cleanupTimer: ReturnType<typeof setTimeout> | null = null;

  const cleanup = (): void => {
    if (cancel) { cancel(); cancel = null; }
    if (delayTimer) { clearTimeout(delayTimer); delayTimer = null; }
    if (cleanupTimer) { clearTimeout(cleanupTimer); cleanupTimer = null; }
  };

  const scrollOnce = (behavior: ScrollBehavior): boolean => {
    if (settled || seq !== _convClickSeq || !isActiveSession(sessionId)) return false;
    const msgsEl = document.getElementById("ms");
    if (!msgsEl) return false;
    const msgs = msgsEl.querySelectorAll(".m");
    if (msgs.length <= msgIndex) return false;

    settled = true;
    cleanup();
    const target = msgs[msgIndex];
    const inlineTarget = highlightOccurrence(target, _convQuery, matchOrdinal ?? 0);
    (inlineTarget || target).scrollIntoView({ behavior, block: "center" });
    target.classList.add("msg-highlight");
    setTimeout(() => target.classList.remove("msg-highlight"), 2200);
    return true;
  };

  // 先订阅再 activate（session 限定，只消费匹配的）
  if (typeof window.onceSessionActivated === "function") {
    cancel = window.onceSessionActivated(sessionId, () => {
      if (settled || seq !== _convClickSeq) { cleanup(); return; }
      delayTimer = setTimeout(() => {
        delayTimer = null;
        if (!scrollOnce("smooth")) cleanup();
      }, 60);
    });
    cleanupTimer = setTimeout(cleanup, 5000);
  }

  // 传 options 通知 _applySessionMessages
  App.Tabs.activate(sessionId, { scroll: 'none', refreshSessions: false });

  // 立即尝试：目标会话已激活且消息已渲染
  scrollOnce("auto");
}

/** 打开搜索命中的会话（不退出搜索状态） */
function openConvResult(sessionId: string, msgIndex?: number, matchOrdinal?: number): void {
  openConvMatch(sessionId, msgIndex, matchOrdinal);
}

/** 清除搜索输入，退回会话列表 */
function clearConvSearch(): void {
  const input = document.getElementById("chat-search-input") as HTMLInputElement | null;
  if (input) { input.value = ""; }
  _convQuery = "";
  _convCache = null;
  _convCacheQuery = "";
  _convPendingQuery = "";
  _convSearching = false;
  if (_convTimer) clearTimeout(_convTimer);
  _convTimer = null;
  loadSessions();
}

function isConversationSearchActive(): boolean {
  return _convQuery.trim().length > 0 || _convSearching;
}

function firstMessageMatchIndex(matches: Array<{ msgIndex?: number }>): number | undefined {
  return matches.find((m) => m.msgIndex !== undefined)?.msgIndex;
}

function renderConvResults(list: HTMLElement, data: any): void {
  list.classList.remove("is-loading");
  if (!data.results?.length) {
    list.innerHTML = '<div class="cs-empty">未找到匹配的对话</div>';
    return;
  }
  let html = `<div class="cs-count">${data.results.length} 个会话，${data.total} 处匹配</div>`;
  for (const r of data.results) {
    const matchCount = r.matches.length;
    const timeStr = r.updatedAt ? shortRelTime(r.updatedAt) : "";
    const firstMsgIdx = firstMessageMatchIndex(r.matches || []);
    html += `<div class="sess-item thread-item thread-success" data-session-id="${E(r.sessionId)}" data-msg-index="${firstMsgIdx !== undefined ? firstMsgIdx : ''}">`;
    html += `<div class="thread-row cs-result-row">`;
    html += `<div class="sess-info thread-info">`;
    html += `<div class="sess-name thread-name"><span class="thread-title">${E(r.sessionName)}</span></div>`;
    html += `</div>`;
    html += `<div class="thread-time">${timeStr ? timeStr + " · " : ""}${matchCount} 处匹配</div>`;
    html += `</div>`;
    for (const m of r.matches) {
      let icon: string;
      if (m.role === "session_info") {
        icon = "📋";
      } else {
        icon = m.role === "user" ? "→" : "←";
      }
      const highlighted = highlightTextWithPositions(m.text, m.matchPos);
      html += `<div class="cs-match" data-session-id="${E(r.sessionId)}" data-msg-index="${m.msgIndex !== undefined ? m.msgIndex : ''}" data-match-ordinal="${m.matchOrdinal !== undefined ? m.matchOrdinal : 0}"><span class="cs-match-role">${icon}</span><span class="cs-match-text">${highlighted}</span></div>`;
    }
    html += `</div>`;
  }
  if (data.truncated) html += `<div class="cs-more">… 结果过多已截断</div>`;
  list.innerHTML = html;
}

function chatPaneRender(container: HTMLElement): void {
  container.style.cssText = "display:flex;flex-direction:column;height:100%;min-height:0";
  container.innerHTML = `
    <div class="ch-new" id="ch-new-btn">
      <span class="ch-new-icon">+</span> 开启新对话
    </div>
    <div class="ch-search">
      <span class="ch-search-icon">${S('isearch', 14)}</span>
      <input class="ch-search-input" id="chat-search-input" placeholder="搜索会话…">
      <button class="ch-search-clear" id="ch-search-clear">✕</button>
    </div>
    <div class="session-list" id="sl">加载中...</div>
  `.trim();

  // 恢复搜索状态（面板重建时保持搜索结果）
  const q = _convQuery.trim();
  if (q && _convCache && _convCacheQuery === q) {
    const list = document.getElementById("sl");
    if (list) renderConvResults(list, _convCache);
  } else if (q && _convSearching && _convPendingQuery === q) {
    const list = document.getElementById("sl");
    if (list) list.innerHTML = '<div class="search-status">搜索中…</div>';
  } else {
    loadSessions();
  }

  // ─── 事件绑定（无 inline onclick）─────────────────────

  // 新会话按钮
  const newBtn = document.getElementById("ch-new-btn");
  if (newBtn) {
    newBtn.addEventListener("click", () => {
      (window as any).App?.Session?.newSession?.();
    });
  }

  // 清除搜索按钮
  const clearBtn = document.getElementById("ch-search-clear");
  if (clearBtn) {
    clearBtn.addEventListener("click", clearConvSearch);
  }

  // 搜索结果点击委托（cs-match / sess-item with data-msg-index）
  const sl = document.getElementById("sl");
  if (sl) {
    sl.addEventListener("click", (e: MouseEvent) => {
      // 1. search match line
      const matchLine = (e.target as HTMLElement).closest(".cs-match") as HTMLElement | null;
      if (matchLine) {
        e.stopPropagation();
        const sid = matchLine.dataset.sessionId;
        const msgIdx = matchLine.dataset.msgIndex;
        const ordinal = matchLine.dataset.matchOrdinal;
        if (sid) {
          openConvMatch(sid, msgIdx !== "" ? Number(msgIdx) : undefined, ordinal !== "" ? Number(ordinal) : 0);
          return;
        }
      }
      // 2. search result card（仅处理带 data-msg-index 的 sess-item）
      const card = (e.target as HTMLElement).closest(".sess-item") as HTMLElement | null;
      if (card && card.dataset.msgIndex !== undefined && card.dataset.msgIndex !== "") {
        const sid = card.dataset.sessionId;
        if (sid) {
          openConvResult(sid, Number(card.dataset.msgIndex), 0);
        }
      }
    });
  }

  // 搜索输入
  const input = document.getElementById("chat-search-input") as HTMLInputElement | null;
  if (input) {
    input.value = _convQuery;
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

// 暴露给外部模块和测试
(window as any).openConvResult = openConvResult;
(window as any).openConvMatch = openConvMatch;
(window as any).isConversationSearchActive = isConversationSearchActive;

registerPane('chat', chatPaneRender);

