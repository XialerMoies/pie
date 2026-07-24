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

// ─── Replace state ────────────────────────────────────────────────

interface ReplaceMatch {
  line: number; column: number; oldText: string; newText: string;
}
interface ReplaceFileResult {
  file: string; absolutePath: string; matches: ReplaceMatch[];
}
interface ReplaceResponse {
  files: ReplaceFileResult[]; totalChanges: number; preview: boolean;
}

let _replaceQuery = "";
let _replaceRegex = false;
let _replacePreview: ReplaceResponse | null = null;
let _isPreviewing = false;
let _isApplying = false;
let _replaceExpanded = false;

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

  // Toggle replace section
  const replaceSection = document.getElementById("search-replace-section");
  if (replaceSection) {
    const show = _searchType === "text" && _results.length > 0;
    replaceSection.style.display = show ? "" : "none";
    if (!show) { _replacePreview = null; _replaceExpanded = false; }
  }
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
    // 如果有行号，等 Monaco 就绪后定位
    if (line) {
      const m = (window as any).__monaco as any;
      if (m?.revealPosition) {
        for (let attempt = 0; attempt < 40; attempt++) {
          if (m.isReady?.() && m.getCurrentFile?.() === filePath) {
            m.revealPosition(line, 1);
            return;
          }
          await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
        }
        try { m.revealPosition(line, 1); } catch {}
      }
    }
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    toast("读取失败: " + msg, "error");
  }
}

// ─── Replace API calls ────────────────────────────────────────────

async function runReplacePreview(): Promise<ReplaceResponse> {
  const root = getSearchRoot();
  const r = await fetch("/api/search/replace", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      query: _searchQuery.trim(),
      replacement: _replaceQuery,
      root,
      type: "text",
      caseSensitive: _searchCase,
      regex: _replaceRegex,
      previewOnly: true,
    }),
  });
  if (!r.ok) { const e = await r.text(); throw new Error(e); }
  return r.json();
}

async function runReplaceApply(): Promise<ReplaceResponse> {
  const root = getSearchRoot();
  const r = await fetch("/api/search/replace", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      query: _searchQuery.trim(),
      replacement: _replaceQuery,
      root,
      type: "text",
      caseSensitive: _searchCase,
      regex: _replaceRegex,
      previewOnly: false,
    }),
  });
  if (!r.ok) { const e = await r.text(); throw new Error(e); }
  return r.json();
}

// ─── Replace preview ──────────────────────────────────────────────

async function doReplacePreview(): Promise<void> {
  if (_isPreviewing) return;
  const previewContainer = document.getElementById("replace-preview");
  if (!previewContainer) return;
  if (!_searchQuery.trim()) return;

  _isPreviewing = true;
  previewContainer.innerHTML = '<div class="search-status">正在预览…</div>';

  try {
    _replacePreview = await runReplacePreview();
    renderReplacePreview();
  } catch (e: unknown) {
    _replacePreview = null;
    const msg = e instanceof Error ? e.message : String(e);
    previewContainer.innerHTML = `<div class="search-status error">预览失败: ${E(msg)}</div>`;
  }
  _isPreviewing = false;
}

function renderReplacePreview(): void {
  const previewContainer = document.getElementById("replace-preview");
  const allBtn = document.getElementById("replace-all-btn");
  if (!previewContainer) return;

  if (!_replacePreview || _replacePreview.files.length === 0) {
    previewContainer.innerHTML = '<div class="search-status dim">没有匹配的替换内容</div>';
    if (allBtn) allBtn.style.display = "none";
    return;
  }

  const { files, totalChanges } = _replacePreview;
  let html = `<div class="replace-summary">将替换 ${totalChanges} 处匹配，涉及 ${files.length} 个文件</div>`;

  for (const file of files) {
    const fileName = file.file.split("/").pop() || file.file;
    const iconHtml = (window as any).ExplorerService?.iconFor(fileName, false) || S("ifolder", 14);

    html += `<div class="replace-file">`;
    html += `<div class="replace-file-header">`;
    html += `<span class="replace-file-icon">${iconHtml}</span>`;
    html += `<span class="replace-file-name">${E(fileName)}</span>`;
    html += `<span class="replace-file-matches">${file.matches.length} 处</span>`;
    html += `</div>`;

    const shown = file.matches.slice(0, 20);
    for (const m of shown) {
      html += `<div class="replace-match">`;
      html += `<span class="replace-match-line">${m.line}</span>`;
      html += `<span class="replace-match-old">${E(m.oldText)}</span>`;
      html += `<span class="replace-match-arrow">→</span>`;
      html += `<span class="replace-match-new">${E(m.newText)}</span>`;
      html += `</div>`;
    }
    if (file.matches.length > 20) {
      html += `<div class="search-more">… 还有 ${file.matches.length - 20} 处匹配</div>`;
    }
    html += `</div>`;
  }

  previewContainer.innerHTML = html;
  if (allBtn) {
    allBtn.style.display = "";
    allBtn.textContent = `全部替换 (${totalChanges} 处)`;
  }
}

// ─── Replace All ─────────────────────────────────────────────────

async function doReplaceAll(): Promise<void> {
  if (_isApplying) return;
  if (!_replacePreview) return;

  const ok = await confirmAsync(
    `确定要替换全部 ${_replacePreview.totalChanges} 处匹配吗？\n涉及 ${_replacePreview.files.length} 个文件。此操作不可撤销。`
  );
  if (!ok) return;

  _isApplying = true;
  const allBtn = document.getElementById("replace-all-btn");
  if (allBtn) allBtn.textContent = "替换中…";

  try {
    await runReplaceApply();
    toast(`已替换 ${_replacePreview.totalChanges} 处匹配`, "success");
    _replacePreview = null;
    _replaceExpanded = false;
    const prevEl = document.getElementById("replace-preview");
    if (prevEl) prevEl.innerHTML = "";
    const allBtnEl = document.getElementById("replace-all-btn");
    if (allBtnEl) allBtnEl.style.display = "none";
    const bodyEl = document.getElementById("search-replace-body");
    if (bodyEl) bodyEl.style.display = "none";
    const arrowEl = document.getElementById("replace-arrow");
    if (arrowEl) arrowEl.innerHTML = "▸";
    if (_debounceTimer) clearTimeout(_debounceTimer);
    await doSearch();
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    toast("替换失败: " + msg, "error");
  }
  _isApplying = false;
  if (allBtn) allBtn.textContent = "全部替换";
}

// ─── Replace section toggle ──────────────────────────────────────

function toggleReplaceSection(): void {
  _replaceExpanded = !_replaceExpanded;
  const body = document.getElementById("search-replace-body");
  const arrow = document.getElementById("replace-arrow");
  if (body) body.style.display = _replaceExpanded ? "" : "none";
  if (arrow) arrow.innerHTML = _replaceExpanded ? "▾" : "▸";
  if (_replaceExpanded) {
    const inp = document.getElementById("replace-input") as HTMLInputElement | null;
    setTimeout(() => inp?.focus(), 50);
  }
}

function clearReplaceUI(): void {
  _replacePreview = null;
  const prevEl = document.getElementById("replace-preview");
  if (prevEl) prevEl.innerHTML = "";
  const allBtn = document.getElementById("replace-all-btn");
  if (allBtn) allBtn.style.display = "none";
}

function toggleReplaceRegex(): void {
  _replaceRegex = !_replaceRegex;
  const btn = document.getElementById("replace-regex");
  if (btn) btn.classList.toggle("on", _replaceRegex);
  clearReplaceUI();
}

// ─── Export for App namespace ─────────────────────────────────

(window as any).openSearchResult = openSearchResult;
(window as any).toggleReplaceSection = toggleReplaceSection;
(window as any).toggleReplaceRegex = toggleReplaceRegex;
(window as any).doReplacePreview = doReplacePreview;
(window as any).doReplaceAll = doReplaceAll;

// ─── Main render function ─────────────────────────────────────

function searchPaneRender(container: HTMLElement): void {
  container.style.cssText = "display:flex;flex-direction:column;height:100%;min-height:0";
  container.innerHTML = [
    `<div class="sg-t">${S("isearch", 14)} 搜索</div>`,
    // Search controls
    `<div class="search-controls">`,
    // Type toggle
    `<div class="search-type-toggle">`,
    `<button class="search-type-btn on" id="search-type-file" onclick="App.Settings?.setSearchType ? App.Settings.setSearchType('filename') : setSearchType('filename')">文件名</button>`,
    `<button class="search-type-btn" id="search-type-text" onclick="App.Settings?.setSearchType ? App.Settings.setSearchType('text') : setSearchType('text')">全文</button>`,
    `<button class="search-case-btn" id="search-case" onclick="App.Settings?.toggleCaseSensitive ? App.Settings.toggleCaseSensitive() : toggleCaseSensitive()" title="区分大小写">Aa</button>`,
    `</div>`,
    // Input
    `<input class="s-search" id="search-input" placeholder="搜索文件..." autofocus>`,
    `</div>`,
    // Replace section (collapsible, only visible for text search with results)
    `<div class="search-replace" id="search-replace-section" style="display:none">`,
    `<div class="search-replace-header" id="search-replace-header" onclick="toggleReplaceSection()">`,
    `<span class="search-replace-arrow" id="replace-arrow">▸</span>`,
    `<span>替换</span>`,
    `</div>`,
    `<div class="search-replace-body" id="search-replace-body" style="display:none">`,
    `<input class="s-search" id="replace-input" placeholder="替换为…">`,
    `<div class="search-replace-controls">`,
    `<button class="search-type-btn${_replaceRegex ? ' on' : ''}" id="replace-regex" onclick="toggleReplaceRegex()" title="使用正则表达式">.*</button>`,
    `<button class="search-replace-preview-btn" id="replace-preview-btn" onclick="doReplacePreview()">预览替换</button>`,
    `</div>`,
    `<div class="replace-preview" id="replace-preview"></div>`,
    `<button class="search-replace-all" id="replace-all-btn" style="display:none" onclick="doReplaceAll()">全部替换</button>`,
    `</div>`,
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

  // Bind replace input
  const replaceInput = el("replace-input") as HTMLInputElement | null;
  if (replaceInput) {
    replaceInput.addEventListener("input", () => {
      _replaceQuery = replaceInput.value;
      clearReplaceUI();
    });
    replaceInput.addEventListener("keydown", (e: KeyboardEvent) => {
      if (e.key === "Enter") doReplacePreview();
    });
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
