let _searchQuery = "";
let _searchType = "filename";
let _searchCase = false;
let _results = [];
let _isSearching = false;
let _debounceTimer = null;
let _hasSearched = false;
function getSearchRoot() {
  return localStorage.getItem("workspace_path") || "";
}
function el(id) {
  return document.getElementById(id);
}
async function runSearch(query, type, root, cs) {
  const url = `/api/search?q=${encodeURIComponent(query)}&type=${type}&root=${encodeURIComponent(root)}&caseSensitive=${cs}&maxResults=100`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}
function highlightText(text, query, cs) {
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
function renderResults() {
  const list = el("search-results");
  if (!list) return;
  if (_isSearching) {
    list.innerHTML = '<div class="search-status">\u641C\u7D22\u4E2D\u2026</div>';
    return;
  }
  if (!_hasSearched) {
    list.innerHTML = '<div class="search-status dim">\u8F93\u5165\u5173\u952E\u8BCD\u5F00\u59CB\u641C\u7D22</div>';
    return;
  }
  if (_results.length === 0) {
    list.innerHTML = '<div class="search-status dim">\u672A\u627E\u5230\u5339\u914D\u7ED3\u679C</div>';
    return;
  }
  const query = _searchQuery.trim();
  const total = _results.reduce((s, r) => s + r.matches.length, 0);
  let html = `<div class="search-count">${_results.length} \u4E2A\u6587\u4EF6${_searchType === "text" ? `\uFF0C${total} \u5904\u5339\u914D` : ""}</div>`;
  for (const result of _results) {
    const fileName = result.file.split("/").pop() || result.file;
    const iconHtml = window.ExplorerService?.iconFor(fileName, false) || S("ifolder", 14);
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
        html += `<div class="search-more">\u2026 \u8FD8\u6709 ${result.matches.length - 5} \u5904\u5339\u914D</div>`;
      }
    }
    html += "</div>";
  }
  list.innerHTML = html;
}
async function doSearch() {
  const root = getSearchRoot();
  if (!_searchQuery.trim() || !root) return;
  _isSearching = true;
  _hasSearched = true;
  renderResults();
  try {
    _results = (await runSearch(_searchQuery.trim(), _searchType, root, _searchCase)).results;
  } catch (e) {
    _results = [];
    const list = el("search-results");
    if (list) list.innerHTML = `<div class="search-status error">\u641C\u7D22\u5931\u8D25: ${E(e.message || e)}</div>`;
  }
  _isSearching = false;
  renderResults();
}
function onSearchInput() {
  const input = el("search-input");
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
function setSearchType(type) {
  _searchType = type;
  const btnFile = el("search-type-file");
  const btnText = el("search-type-text");
  if (btnFile) btnFile.classList.toggle("on", type === "filename");
  if (btnText) btnText.classList.toggle("on", type === "text");
  if (_searchQuery.trim()) {
    if (_debounceTimer) clearTimeout(_debounceTimer);
    _debounceTimer = setTimeout(doSearch, 150);
  }
}
function toggleCaseSensitive() {
  _searchCase = !_searchCase;
  const btn = el("search-case");
  if (btn) btn.classList.toggle("on", _searchCase);
  if (_searchQuery.trim()) {
    if (_debounceTimer) clearTimeout(_debounceTimer);
    _debounceTimer = setTimeout(doSearch, 150);
  }
}
async function openSearchResult(filePath, line) {
  const root = getSearchRoot();
  if (!root) return;
  try {
    const r = await fetch(`/api/file/read?root=${encodeURIComponent(root)}&path=${encodeURIComponent(filePath)}`);
    const d = await r.json();
    if (!r.ok) {
      toast(d.error || "\u8BFB\u53D6\u5931\u8D25", "error");
      return;
    }
    const content = d.encoding === "base64" ? "[\u4E8C\u8FDB\u5236\u6587\u4EF6\uFF0C\u65E0\u6CD5\u9884\u89C8]" : d.content;
    const lang = filePath.split(".").pop() || "";
    openFileTab(filePath, content, lang);
  } catch (e) {
    toast("\u8BFB\u53D6\u5931\u8D25: " + (e.message || e), "error");
  }
}
window.openSearchResult = openSearchResult;
function searchPaneRender(container) {
  container.style.cssText = "display:flex;flex-direction:column;height:100%;min-height:0";
  container.innerHTML = [
    `<div class="sg-t">${S("isearch", 14)} \u641C\u7D22</div>`,
    // Search controls
    `<div class="search-controls">`,
    // Type toggle
    `<div class="search-type-toggle">`,
    `<button class="search-type-btn on" id="search-type-file" onclick="App.Settings?.setSearchType?.('filename') || setSearchType('filename')">\u6587\u4EF6\u540D</button>`,
    `<button class="search-type-btn" id="search-type-text" onclick="App.Settings?.setSearchType?.('text') || setSearchType('text')">\u5168\u6587</button>`,
    `<button class="search-case-btn" id="search-case" onclick="App.Settings?.toggleCaseSensitive?.() || toggleCaseSensitive()" title="\u533A\u5206\u5927\u5C0F\u5199">Aa</button>`,
    `</div>`,
    // Input
    `<input class="s-search" id="search-input" placeholder="\u641C\u7D22\u6587\u4EF6..." autofocus>`,
    `</div>`,
    // Results
    `<div class="search-results" id="search-results"><div class="search-status dim">\u8F93\u5165\u5173\u952E\u8BCD\u5F00\u59CB\u641C\u7D22</div></div>`
  ].join("");
  const input = el("search-input");
  if (input) {
    input.addEventListener("input", onSearchInput);
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        if (_debounceTimer) clearTimeout(_debounceTimer);
        doSearch();
      }
    });
    setTimeout(() => input.focus(), 100);
  }
}
function addAppBindings() {
  const App = window.App;
  if (App) {
    App.File.openSearchResult = openSearchResult;
    App.Settings.setSearchType = setSearchType;
    App.Settings.toggleCaseSensitive = toggleCaseSensitive;
  }
}
addAppBindings();
registerPane("search", searchPaneRender);
