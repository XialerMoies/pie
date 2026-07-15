/**
 * Search pane — 文件搜索/全文搜索面板
 *
 * 参考 VSCode 搜索模式：
 *   - 文件名搜索（fileSearch）和全文搜索（textSearch）
 *   - 输入防抖
 *   - 结果列表可点击打开文件
 */
/// <reference path="../../dashboard.d.ts" />

interface SearchMatch {
  line: number;
  column: number;
  text: string;
  length: number;
}

interface SearchResult {
  file: string;       // relative path
  absolutePath: string;
  matches: SearchMatch[];
}

interface SearchResponse {
  results: SearchResult[];
  total: number;
  truncated: boolean;
}

// ─── State ───────────────────────────────────────────────────────

let _searchQuery = "";
let _searchType: "filename" | "text" = "filename";
let _searchCase = false;
let _results: SearchResult[] = [];
let _isSearching = false;
let _debounceTimer: ReturnType<typeof setTimeout> | null = null;
let _hasSearched = false;

// NOTE: WS_KEY is in App.Constants.WS_KEY — don't redeclare const
function getSearchRoot(): string {
  return localStorage.getItem(App.Constants.WS_KEY) || "";
}

// ─── DOM refs ───────────────────────────────────────────────────

function el(id: string): HTMLElement | null {
  return document.getElementById(id);
}

// ─── Search API call ────────────────────────────────────────────

async function runSearch(query: string, type: string, root: string, cs: boolean): Promise<SearchResponse> {
  const url = `/api/search?q=${encodeURIComponent(query)}&type=${type}&root=${encodeURIComponent(root)}&caseSensitive=${cs}&maxResults=100`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

// ─── Highlight helper ─────────────────────────────────────────

function highlightText(text: string, query: string, cs: boolean): string {
  if (!query) return E(text);
  const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const flags = cs ? "g" : "gi";
  try {
    const re = new RegExp(`(${escaped})`, flags);
    return E(text).replace(re, '<span class="search-hl">$1</span>');
  } catch {
    return E(text);
  }
}

// ─── Render results ────────────────────────────────────────────

function renderResults(): void {
  const list = el("search-results");
  if (!list) return;

  if (_isSearching) {
    list.innerHTML = '<div class="search-status">搜索中…</div>';
    return;
  }

  if (!_hasSearched) {
    list.innerHTML = '<div class="search-status dim">输入关键词开始搜索</div>';
    return;
  }

  if (_results.length === 0) {
    list.innerHTML = '<div class="search-status dim">未找到匹配结果</div>';
    return;
  }

  const query = _searchQuery.trim();
  const total = _results.reduce((s, r) => s + r.matches.length, 0);
  let html = `<div class="search-count">${_results.length} 个文件${_searchType === "text" ? `，${total} 处匹配` : ""}</div>`;

  for (const result of _results) {
    const fileName = result.file.split("/").pop() || result.file;
    const iconHtml = (window as any).ExplorerService?.iconFor(fileName, false) || S("ifolder", 14);
    const nameHtml = _searchType === "filename" ? highlightText(fileName, query, _searchCase) : E(fileName);

    html += `<div class="search-file" data-file="${E(result.file)}">`;
    html += `<div class="search-file-name" onclick="App.File.openSearchResult('${E(result.file)}')">`;
    html += `${iconHtml} ${nameHtml} <span class="search-file-path">${E(result.file)}</span>`;
    html += "</div>";

    if (_searchType === "text" && result.matches.length > 0) {
      for (const m of result.matches.slice(0, 5)) {
        const matchText = highlightText(m.text.trim(), query, _searchCase);
        html += `<div class="search-match" onclick="App.File.openSearchResult('${E(result.file)}', ${m.line})">`;
        html += `<span class="search-match-line">${m.line}</span>`;
        html += `<span class="search-match-text">${matchText}</span>`;
        html += "</div>";
      }
      if (result.matches.length > 5) {
        html += `<div class="search-more">… 还有 ${result.matches.length - 5} 处匹配</div>`;
      }
    }
    html += "</div>";
  }

  list.innerHTML = html;
}

// ─── doSearch ───────────────────────────────────────────────────

async function doSearch(): Promise<void> {
  const root = getSearchRoot();
  if (!_searchQuery.trim() || !root) return;

  _isSearching = true;
  _hasSearched = true;
  renderResults();

  try {
    _results = (await runSearch(_searchQuery.trim(), _searchType, root, _searchCase)).results;
  } catch (e: unknown) {
    _results = [];
    const msg = e instanceof Error ? e.message : String(e);
    const list = el("search-results");
    if (list) list.innerHTML = `<div class="search-status error">搜索失败: ${E(msg)}</div>`;
  }
  _isSearching = false;
  renderResults();
}

// ─── Search input handler (debounced) ──────────────────────────

function onSearchInput(): void {
  const input = el("search-input") as HTMLInputElement | null;
  if (!input) return;
  _searchQuery = input.value;

  if (_debounceTimer) clearTimeout(_debounceTimer);

  if (!_searchQuery.trim()) {
    _results = [];
    _hasSearched = false;
    renderResults();
    return;
  }

  _debounceTimer = setTimeout(doSearch, 300);
}

// ─── Toggle type ──────────────────────────────────────────────

function setSearchType(type: "filename" | "text"): void {
  _searchType = type;
  const btnFile = el("search-type-file");
  const btnText = el("search-type-text");
  if (btnFile) btnFile.classList.toggle("on", type === "filename");
  if (btnText) btnText.classList.toggle("on", type === "text");
  // Re-run search if there's already a query
  if (_searchQuery.trim()) {
    if (_debounceTimer) clearTimeout(_debounceTimer);
    _debounceTimer = setTimeout(doSearch, 150);
  }
}

function toggleCaseSensitive(): void {
  _searchCase = !_searchCase;
  const btn = el("search-case");
  if (btn) btn.classList.toggle("on", _searchCase);
  if (_searchQuery.trim()) {
    if (_debounceTimer) clearTimeout(_debounceTimer);
    _debounceTimer = setTimeout(doSearch, 150);
  }
}

// ─── Open file from search result ─────────────────────────────

async function openSearchResult(filePath: string, line?: number): Promise<void> {
  const root = getSearchRoot();
  if (!root) return;
  try {
    const r = await fetch(`/api/file/read?root=${encodeURIComponent(root)}&path=${encodeURIComponent(filePath)}`);
    const d = await r.json();
    if (!r.ok) { toast(d.error || "读取失败", "error"); return; }
    const content = d.encoding === "base64" ? "[二进制文件，无法预览]" : d.content;
    const lang = filePath.split(".").pop() || "";
    openFileTab(filePath, content, lang);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    toast("读取失败: " + msg, "error");
  }
}

// ─── Export for App namespace ─────────────────────────────────

(window as any).openSearchResult = openSearchResult;

// ─── Main render function ─────────────────────────────────────

function searchPaneRender(container: HTMLElement): void {
  container.style.cssText = "display:flex;flex-direction:column;height:100%;min-height:0";
  container.innerHTML = [
    `<div class="sg-t">${S("isearch", 14)} 搜索</div>`,
    // Search controls
    `<div class="search-controls">`,
    // Type toggle
    `<div class="search-type-toggle">`,
    `<button class="search-type-btn on" id="search-type-file" onclick="App.Settings?.setSearchType?.('filename') || setSearchType('filename')">文件名</button>`,
    `<button class="search-type-btn" id="search-type-text" onclick="App.Settings?.setSearchType?.('text') || setSearchType('text')">全文</button>`,
    `<button class="search-case-btn" id="search-case" onclick="App.Settings?.toggleCaseSensitive?.() || toggleCaseSensitive()" title="区分大小写">Aa</button>`,
    `</div>`,
    // Input
    `<input class="s-search" id="search-input" placeholder="搜索文件..." autofocus>`,
    `</div>`,
    // Results
    `<div class="search-results" id="search-results"><div class="search-status dim">输入关键词开始搜索</div></div>`,
  ].join("");

  // Bind input
  const input = el("search-input") as HTMLInputElement | null;
  if (input) {
    input.addEventListener("input", onSearchInput);
    input.addEventListener("keydown", (e: KeyboardEvent) => {
      if (e.key === "Enter") {
        if (_debounceTimer) clearTimeout(_debounceTimer);
        doSearch();
      }
    });
    // Focus input after a short delay
    setTimeout(() => input.focus(), 100);
  }
}

// Export for App.File namespace
function addAppBindings(): void {
  const App = (window as any).App;
  if (App) {
    App.File.openSearchResult = openSearchResult;
    App.Settings.setSearchType = setSearchType;
    App.Settings.toggleCaseSensitive = toggleCaseSensitive;
  }
}
addAppBindings();

registerPane("search", searchPaneRender);
