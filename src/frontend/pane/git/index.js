let _statusData = null;
let _logData = null;
let _loading = false;
let _error = null;
let _notRepo = false;
function el(id) {
  return document.getElementById(id);
}
function getRoot() {
  return localStorage.getItem("workspace_path") || "";
}
function statusIconClass(x, y) {
  const code = y !== " " ? y : x;
  switch (code) {
    case "M":
      return "git-status-m";
    case "A":
      return "git-status-a";
    case "D":
      return "git-status-d";
    case "R":
      return "git-status-r";
    case "?":
    case "!":
      return "git-status-u";
    case "U":
      return "git-status-u";
    default:
      return "";
  }
}
function statusLabel(x, y) {
  if (y === "?" || y === "!") return "U";
  if (y !== " ") return stageLabel(y);
  return stageLabel(x);
}
function stageLabel(c) {
  switch (c) {
    case "M":
      return "M";
    case "A":
      return "A";
    case "D":
      return "D";
    case "R":
      return "R";
    case "U":
      return "U";
    default:
      return "?";
  }
}
async function fetchStatus(root) {
  const r = await fetch(`/api/git/status?root=${encodeURIComponent(root)}`);
  return r.json();
}
async function fetchLog(root, count = 10) {
  const r = await fetch(`/api/git/log?root=${encodeURIComponent(root)}&count=${count}`);
  return r.json();
}
function renderGit() {
  const container = el("git-container");
  if (!container) return;
  if (_notRepo) {
    const curPath = getRoot() || "(\u672A\u8BBE\u7F6E)";
    container.innerHTML = `<div class="git-empty">\u5F53\u524D\u5DE5\u4F5C\u533A\u4E0D\u662F Git \u4ED3\u5E93</div>
      <div style="font-size:.6rem;color:var(--tm);text-align:center;padding:0 8px;word-break:break-all">\u8DEF\u5F84: ${E(curPath)}</div>
      <div class="git-action" onclick="App.Git.refreshGit()" style="justify-content:center;padding:8px">${_svg("irefresh", 12)} \u5237\u65B0</div>`;
    return;
  }
  if (_error) {
    container.innerHTML = `<div class="git-empty error">${E(_error)}</div>`;
    return;
  }
  if (_loading) {
    container.innerHTML = '<div class="git-empty">\u52A0\u8F7D\u4E2D\u2026</div>';
    return;
  }
  let html = "";
  const entries = _statusData?.entries || [];
  const modified = _statusData?.modified || 0;
  const added = _statusData?.added || 0;
  const deleted = _statusData?.deleted || 0;
  html += `<div class="sg-t" style="display:flex;align-items:center;justify-content:space-between">`;
  html += `\u53D8\u66F4 <span class="git-count">${entries.length}</span>`;
  html += `</div>`;
  if (entries.length === 0) {
    html += '<div class="git-clean">\u5DE5\u4F5C\u533A\u5E72\u51C0\uFF0C\u65E0\u53D8\u66F4</div>';
  } else {
    html += `<div class="git-summary">`;
    if (modified > 0) html += `<span class="git-chip git-chip-m">${modified} \u4FEE\u6539</span>`;
    if (added > 0) html += `<span class="git-chip git-chip-a">${added} \u65B0\u589E</span>`;
    if (deleted > 0) html += `<span class="git-chip git-chip-d">${deleted} \u5220\u9664</span>`;
    html += `</div>`;
    for (const e of entries) {
      const iconClass = statusIconClass(e.x, e.y);
      const label = statusLabel(e.x, e.y);
      const fileName = e.path.split("/").pop() || e.path;
      const iconHtml = window.ExplorerService?.iconFor(fileName, false) || "";
      html += `<div class="git-file" onclick="App.Git.openGitFile('${E(e.path)}')">`;
      html += `<span class="git-status-badge ${iconClass}">${label}</span>`;
      html += `${iconHtml} `;
      html += `<span class="git-file-name">${E(e.path)}</span>`;
      if (e.renamePath) html += `<span class="git-rename"> \u2192 ${E(e.renamePath)}</span>`;
      html += "</div>";
    }
  }
  html += `<div class="git-commit-area">`;
  html += `<textarea class="git-commit-msg" id="git-commit-msg" rows="2" placeholder="\u63D0\u4EA4\u4FE1\u606F\u2026"></textarea>`;
  html += `<div class="git-commit-actions">`;
  html += `<button class="git-btn git-btn-commit" onclick="App.Git.commit()" id="git-commit-btn">\u63D0\u4EA4</button>`;
  html += `</div>`;
  html += `</div>`;
  const logEntries = _logData?.entries || [];
  html += `<div class="sg-t" style="display:flex;align-items:center;justify-content:space-between;margin-top:12px">`;
  html += `\u6700\u8FD1\u63D0\u4EA4 <span class="git-count">${logEntries.length}</span>`;
  html += `</div>`;
  if (logEntries.length === 0) {
    html += '<div class="git-clean">\u6682\u65E0\u63D0\u4EA4\u8BB0\u5F55</div>';
  } else {
    for (const e of logEntries) {
      html += `<div class="git-commit">`;
      html += `<span class="git-hash">${E(e.hash)}</span>`;
      html += `<span class="git-msg">${E(e.message)}</span>`;
      html += "</div>";
    }
  }
  html += `<div class="git-actions-bar">`;
  html += `<span class="git-action" onclick="App.Git.push()">${_svg("iup", 12)} \u63A8\u9001</span>`;
  html += `<span class="git-action" onclick="App.Git.pull()">${_svg("idown", 12)} \u62C9\u53D6</span>`;
  html += `<span class="git-action git-action-refresh" onclick="App.Git.refreshGit()">${_svg("irefresh", 12)} \u5237\u65B0</span>`;
  html += `</div>`;
  container.innerHTML = html;
}
async function refreshGit() {
  const root = getRoot();
  if (!root) return;
  _loading = true;
  _error = null;
  _notRepo = false;
  renderGit();
  const [statusRes, logRes] = await Promise.all([
    fetchStatus(root).catch(() => null),
    fetchLog(root).catch(() => null)
  ]);
  if (statusRes?.error === "not_a_repo") {
    _notRepo = true;
    _statusData = null;
    _logData = null;
  } else {
    _error = statusRes?.error === "git_error" ? statusRes.message || "Git \u6267\u884C\u9519\u8BEF" : null;
    _statusData = statusRes;
    _logData = logRes;
  }
  _loading = false;
  renderGit();
}
async function openGitFile(filePath) {
  const root = getRoot();
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
function _svg(name, size = 16) {
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24"><use href="#${name}"/></svg>`;
}
async function commit() {
  const btn = el("git-commit-btn");
  const input = el("git-commit-msg");
  if (!input || !btn) return;
  const msg = input.value.trim();
  if (!msg) {
    toast("\u8BF7\u8F93\u5165\u63D0\u4EA4\u4FE1\u606F", "error");
    return;
  }
  btn.disabled = true;
  btn.textContent = "\u63D0\u4EA4\u4E2D\u2026";
  try {
    const root = getRoot();
    const r = await fetch(`/api/git/commit`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ root, message: msg })
    });
    const d = await r.json();
    if (d.ok) {
      toast("\u2705 " + d.message);
      input.value = "";
      refreshGit();
    } else toast("\u274C " + (d.message || "\u63D0\u4EA4\u5931\u8D25"), "error");
  } catch {
    toast("\u63D0\u4EA4\u5931\u8D25", "error");
  }
  btn.disabled = false;
  btn.textContent = "\u63D0\u4EA4";
}
async function push() {
  toast("\u63A8\u9001\u4E2D\u2026");
  try {
    const root = getRoot();
    const r = await fetch(`/api/git/push`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ root })
    });
    const d = await r.json();
    if (d.ok) {
      toast("\u2705 " + d.message);
      refreshGit();
    } else toast("\u274C " + (d.message || "\u63A8\u9001\u5931\u8D25"), "error");
  } catch {
    toast("\u63A8\u9001\u5931\u8D25", "error");
  }
}
async function pull() {
  toast("\u62C9\u53D6\u4E2D\u2026");
  try {
    const root = getRoot();
    const r = await fetch(`/api/git/pull`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ root })
    });
    const d = await r.json();
    if (d.ok) {
      toast("\u2705 " + d.message);
      refreshGit();
    } else toast("\u274C " + (d.message || "\u62C9\u53D6\u5931\u8D25"), "error");
  } catch {
    toast("\u62C9\u53D6\u5931\u8D25", "error");
  }
}
function gitPaneRender(container) {
  container.style.cssText = "display:flex;flex-direction:column;height:100%;min-height:0";
  container.innerHTML = [
    `<div class="sg-t">${_svg("igit", 14)} Git</div>`,
    `<div id="git-container" style="flex:1;min-height:0;overflow-y:auto;padding:0 4px"></div>`
  ].join("");
  refreshGit();
}
function addAppBindings() {
  const App = window.App;
  if (App) {
    App.Git = App.Git || {};
    App.Git.refreshGit = refreshGit;
    App.Git.openGitFile = openGitFile;
    App.Git.commit = commit;
    App.Git.push = push;
    App.Git.pull = pull;
  }
}
addAppBindings();
registerPane("git", gitPaneRender);
