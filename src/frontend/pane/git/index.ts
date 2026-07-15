/**
 * Git pane — 只读版本控制面板
 *
 * 参考 VSCode Git 视图：
 *   - Changes（变更文件列表，着色：M/A/D）
 *   - History（最近提交历史）
 */
/// <reference path="../../dashboard.d.ts" />

interface GitStatusEntry {
  x: string;   // index status
  y: string;   // working tree status
  path: string;
  renamePath?: string;
}

interface GitStatusResponse {
  gitRoot: string;
  branch?: string;
  ahead?: number;
  behind?: number;
  lastCommit?: string;
  entries: GitStatusEntry[];
  total: number;
  modified: number;
  added: number;
  deleted: number;
  error?: string;
  message?: string;
}

interface GitLogEntry {
  hash: string;
  date: string;
  message: string;
}

interface GitLogResponse {
  gitRoot: string;
  entries: GitLogEntry[];
  error?: string;
  message?: string;
}

// ─── State ───────────────────────────────────────────────────────

let _statusData: GitStatusResponse | null = null;
let _logData: GitLogResponse | null = null;
let _loading = false;
let _error: string | null = null;
let _notRepo = false;

// ─── Helpers ─────────────────────────────────────────────────────

function el(id: string): HTMLElement | null {
  return document.getElementById(id);
}

function getRoot(): string {
  return localStorage.getItem(App.Constants.WS_KEY) || "";
}

// ─── Status label & color ───────────────────────────────────────

function statusIconClass(x: string, y: string): string {
  const code = y !== " " ? y : x;
  switch (code) {
    case "M": return "git-status-m";
    case "A": return "git-status-a";
    case "D": return "git-status-d";
    case "R": return "git-status-r";
    case "?":
    case "!": return "git-status-u";
    case "U": return "git-status-u";
    default: return "";
  }
}

function statusLabel(x: string, y: string): string {
  if (y === "?" || y === "!") return "U";   // Untracked
  if (y !== " ") return stageLabel(y);     // Working tree
  return stageLabel(x);                     // Staged only
}

function stageLabel(c: string): string {
  switch (c) {
    case "M": return "M";
    case "A": return "A";
    case "D": return "D";
    case "R": return "R";
    case "U": return "U";
    default: return "?";
  }
}

// ─── Fetch data ──────────────────────────────────────────────────

async function fetchStatus(root: string): Promise<GitStatusResponse> {
  const r = await fetch(`/api/git/status?root=${encodeURIComponent(root)}`);
  return r.json();
}

async function fetchLog(root: string, count = 10): Promise<GitLogResponse> {
  const r = await fetch(`/api/git/log?root=${encodeURIComponent(root)}&count=${count}`);
  return r.json();
}

// ─── Render ─────────────────────────────────────────────────────

function renderGit(): void {
  const container = el("git-container");
  if (!container) return;

  if (_notRepo) {
    const curPath = getRoot() || "(未设置)";
    container.innerHTML = `<div class="git-empty">当前工作区不是 Git 仓库</div>
      <div style="font-size:.6rem;color:var(--tm);text-align:center;padding:0 8px;word-break:break-all">路径: ${E(curPath)}</div>
      <div class="git-action" onclick="App.Git.refreshGit()" style="justify-content:center;padding:8px">${_svg("irefresh",12)} 刷新</div>`;
    return;
  }

  if (_error) {
    container.innerHTML = `<div class="git-empty error">${E(_error)}</div>`;
    return;
  }

  if (_loading) {
    container.innerHTML = '<div class="git-empty">加载中…</div>';
    return;
  }

  let html = "";

  // ─── Branch & remote status bar ────────────
  const branch = _statusData?.branch;
  const ahead = _statusData?.ahead;
  const behind = _statusData?.behind;
  const lastCommit = _statusData?.lastCommit;
  if (branch) {
    html += `<div class="git-branch-bar">`;
    html += `<span class="git-branch-name">${E(branch)}</span>`;
    if (ahead !== undefined && behind !== undefined) {
      if (ahead > 0 && behind > 0) html += `<span class="git-remote">↑${ahead} ↓${behind}</span>`;
      else if (ahead > 0) html += `<span class="git-remote">↑${ahead}</span>`;
      else if (behind > 0) html += `<span class="git-remote">↓${behind}</span>`;
      else html += `<span class="git-remote git-remote-clean">✓</span>`;
    }
    if (lastCommit) html += `<span class="git-last-commit">${E(lastCommit)}</span>`;
    html += `</div>`;
  }

  // ─── Changes section ───────────────────────
  const entries = _statusData?.entries || [];
  const modified = _statusData?.modified || 0;
  const added = _statusData?.added || 0;
  const deleted = _statusData?.deleted || 0;

  html += `<div class="sg-t" style="display:flex;align-items:center;justify-content:space-between">`;
  html += `变更 <span class="git-count">${entries.length}</span>`;
  html += `</div>`;

  if (entries.length === 0) {
    html += '<div class="git-clean">工作区干净，无变更</div>';
  } else {
    // Summary chips
    html += `<div class="git-summary">`;
    if (modified > 0) html += `<span class="git-chip git-chip-m">${modified} 修改</span>`;
    if (added > 0) html += `<span class="git-chip git-chip-a">${added} 新增</span>`;
    if (deleted > 0) html += `<span class="git-chip git-chip-d">${deleted} 删除</span>`;
    html += `</div>`;

    for (const e of entries) {
      const iconClass = statusIconClass(e.x, e.y);
      const label = statusLabel(e.x, e.y);
      const fileName = e.path.split("/").pop() || e.path;
      const iconHtml = (window as any).ExplorerService?.iconFor(fileName, false) || "";
      html += `<div class="git-file" onclick="App.Git.openGitFile('${E(e.path)}')">`;
      html += `<span class="git-status-badge ${iconClass}">${label}</span>`;
      html += `${iconHtml} `;
      html += `<span class="git-file-name">${E(e.path)}</span>`;
      if (e.renamePath) html += `<span class="git-rename"> → ${E(e.renamePath)}</span>`;
      html += "</div>";
    }
  }

  // ─── Commit area ────────────────────────────
  html += `<div class="git-commit-area">`;
  html += `<textarea class="git-commit-msg" id="git-commit-msg" rows="2" placeholder="提交信息…"></textarea>`;
  html += `<div class="git-commit-actions">`;
  html += `<button class="git-btn git-btn-commit" onclick="App.Git.commit()" id="git-commit-btn">提交</button>`;
  html += `</div>`;
  html += `</div>`;

  // ─── History section ────────────────────────
  const logEntries = _logData?.entries || [];
  html += `<div class="sg-t" style="display:flex;align-items:center;justify-content:space-between;margin-top:12px">`;
  html += `最近提交 <span class="git-count">${logEntries.length}</span>`;
  html += `</div>`;

  if (logEntries.length === 0) {
    html += '<div class="git-clean">暂无提交记录</div>';
  } else {
    for (const e of logEntries) {
      html += `<div class="git-commit">`;
      html += `<span class="git-hash">${E(e.hash)}</span>`;
      html += `<span class="git-msg">${E(e.message)}</span>`;
      html += "</div>";
    }
  }

  // ─── Actions bar ────────────────────────────
  html += `<div class="git-actions-bar">`;
  html += `<span class="git-action" onclick="App.Git.push()">${_svg("iup", 12)} 推送</span>`;
  html += `<span class="git-action" onclick="App.Git.pull()">${_svg("idown", 12)} 拉取</span>`;
  html += `<span class="git-action git-action-refresh" onclick="App.Git.refreshGit()">${_svg("irefresh", 12)} 刷新</span>`;
  html += `</div>`;

  container.innerHTML = html;
}

// ─── Refresh ────────────────────────────────────────────────────

async function refreshGit(): Promise<void> {
  const root = getRoot();
  if (!root) return;

  _loading = true;
  _error = null;
  _notRepo = false;
  renderGit();

  const [statusRes, logRes] = await Promise.all([
    fetchStatus(root).catch(() => null),
    fetchLog(root).catch(() => null),
  ]);

  if (statusRes?.error === "not_a_repo") {
    _notRepo = true;
    _statusData = null;
    _logData = null;
  } else {
    _error = statusRes?.error === "git_error" ? statusRes.message || "Git 执行错误" : null;
    _statusData = statusRes;
    _logData = logRes;
  }

  _loading = false;
  renderGit();
}

// ─── Open file from git status ──────────────────────────────────

async function openGitFile(filePath: string): Promise<void> {
  const root = getRoot();
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

// ─── Local SVG helper (不会覆盖全局 S) ───────────────────────

function _svg(name: string, size = 16): string {
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24"><use href="#${name}"/></svg>`;
}

// ─── Commit / Push / Pull ──────────────────────────────────────

async function commit(): Promise<void> {
  const btn = el("git-commit-btn") as HTMLButtonElement | null;
  const input = el("git-commit-msg") as HTMLTextAreaElement | null;
  if (!input || !btn) return;
  const msg = input.value.trim();
  if (!msg) { toast("请输入提交信息", "error"); return; }
  btn.disabled = true;
  btn.textContent = "提交中…";
  try {
    const root = getRoot();
    const r = await fetch(`/api/git/commit`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ root, message: msg }),
    });
    const d = await r.json();
    if (d.ok) { toast("✅ " + d.message); input.value = ""; refreshGit(); }
    else toast("❌ " + (d.message || "提交失败"), "error");
  } catch { toast("提交失败", "error"); }
  btn.disabled = false;
  btn.textContent = "提交";
}

async function push(): Promise<void> {
  toast("推送中…");
  try {
    const root = getRoot();
    const r = await fetch(`/api/git/push`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ root }),
    });
    const d = await r.json();
    if (d.ok) { toast("✅ " + d.message); refreshGit(); }
    else toast("❌ " + (d.message || "推送失败"), "error");
  } catch { toast("推送失败", "error"); }
}

async function pull(): Promise<void> {
  toast("拉取中…");
  try {
    const root = getRoot();
    const r = await fetch(`/api/git/pull`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ root }),
    });
    const d = await r.json();
    if (d.ok) { toast("✅ " + d.message); refreshGit(); }
    else toast("❌ " + (d.message || "拉取失败"), "error");
  } catch { toast("拉取失败", "error"); }
}

// ─── Panel render entry ─────────────────────────────────────────

function gitPaneRender(container: HTMLElement): void {
  container.style.cssText = "display:flex;flex-direction:column;height:100%;min-height:0";
  container.innerHTML = [
    `<div class="sg-t">${_svg("igit", 14)} Git</div>`,
    `<div id="git-container" style="flex:1;min-height:0;overflow-y:auto;padding:0 4px"></div>`,
  ].join("");

  // Load data
  refreshGit();
}

// ─── App bindings ─────────────────────────────────────────────

function addAppBindings(): void {
  const App = (window as any).App;
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
