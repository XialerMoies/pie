/**
 * MCP Servers pane — MCP 服务器列表面板
 *
 * 两个标签页：
 * - [已安装] 已配置的 MCP server 状态列表
 * - [探索]   从内置目录安装 MCP server（数据来自 GET /api/mcp/catalog）
 */
/// <reference path="../../dashboard.d.ts" />

interface McpServerStatus {
  name: string;
  state: "connected" | "connecting" | "disconnected" | "error";
  tools: string[];
  error?: string;
  config?: { command?: string; args?: string[]; url?: string; transport?: string; enabled?: boolean };
  canDelete?: boolean;
}

interface CatalogEntry {
  id: string;
  name: string;
  description: string;
  category: string;
  command: string;
  args: string[];
  envHints?: string[];
  postInstallHint?: string;
}

// ─── 状态 ──────────────────────────────────────

let _mcpRefreshTimer: ReturnType<typeof setInterval> | null = null;
const MCP_PANEL_ID = "mcp-panel-root";
let _activeMcpTab: "installed" | "explore" = "installed";

// ─── 面板入口 ──────────────────────────────────

function mcpPaneRender(container: HTMLElement): void {
  container.innerHTML = `<div id="${MCP_PANEL_ID}">${renderMcpPanel()}</div>`;
  switchTab("installed");

  clearInterval(_mcpRefreshTimer!);
  _mcpRefreshTimer = setInterval(() => {
    if (!document.getElementById(MCP_PANEL_ID)) {
      clearInterval(_mcpRefreshTimer!);
      _mcpRefreshTimer = null;
      return;
    }
    if (_activeMcpTab === "installed") fetchMcpServers();
  }, 6000);
}

function renderMcpPanel(): string {
  return `
    <div class="mcp-panel">
      <div class="mcp-tabs">
        <button class="mcp-tab" data-tab="installed">已安装</button>
        <button class="mcp-tab" data-tab="explore">探索</button>
      </div>
      <div class="mcp-content" id="mcp-content">
        <div class="mcp-empty">加载中…</div>
      </div>
    </div>
  `;
}

// ─── 标签切换 ──────────────────────────────────

function switchTab(tab: "installed" | "explore"): void {
  _activeMcpTab = tab;
  const content = document.getElementById("mcp-content");
  if (!content) return;

  document.querySelectorAll(".mcp-tab").forEach((el) => {
    el.classList.toggle("active", (el as HTMLElement).dataset.tab === tab);
  });

  if (tab === "installed") {
    content.innerHTML = `<div class="mcp-empty">加载中…</div>`;
    fetchMcpServers();
  } else {
    renderExploreTab(content);
  }
}

// ─── [已安装] 标签页 ────────────────────────────

async function fetchMcpServers(): Promise<void> {
  const content = document.getElementById("mcp-content");
  if (!content) return;

  try {
    const res = await fetch("/api/mcp/servers");
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const servers: McpServerStatus[] = await res.json();

    if (_activeMcpTab !== "installed") return;

    const barCount = document.getElementById("mcp-bar-count");

    if (servers.length === 0) {
      content.innerHTML = '<div class="mcp-empty">未发现 MCP 服务器配置<br>切换到「探索」页签安装</div>';
      if (barCount) barCount.textContent = "0";
      return;
    }

    if (barCount) barCount.textContent = String(servers.length);

    content.innerHTML = servers.map((s) => `
      <div class="mcp-server" data-source="${E(s.name)}">
        <div class="mcp-server-top">
          <span class="mcp-dot mcp-dot--${s.state}"></span>
          <span class="mcp-server-name">${E(s.name)}</span>
          <span class="mcp-server-state mcp-state--${s.state}">${stateLabel(s.state)}</span>
        </div>
        ${s.error ? `<div class="mcp-server-error">${E(s.error)}</div>` : ""}
        ${s.tools.length > 0 ? `<div class="mcp-server-tools">${s.tools.map((t) => `<span class="mcp-tool-tag">${E(t)}</span>`).join("")}</div>` : ""}
        <div class="mcp-server-actions">
          ${s.config ? `<button class="mcp-btn mcp-btn-toggle" data-name="${E(s.name)}">${s.config.enabled !== false ? "停用" : "启用"}</button>` : ""}
          ${s.error?.includes("未信任") ? `<button class="mcp-btn mcp-btn-trust" data-name="${E(s.name)}">信任</button>` : ""}
          ${s.canDelete !== false ? `<button class="mcp-btn mcp-btn-remove" data-name="${E(s.name)}">删除</button>` : ""}
        </div>
        ${s.config ? `<div class="mcp-server-cmd">${s.config.transport === "http" || s.config.transport === "sse" ? E(s.config.url ?? "") : E(s.config.command ?? "") + " " + (s.config.args || []).map(a => E(a)).join(" ")}</div>` : ""}
      </div>
    `).join("");

    bindToggleEvents(content);
    bindTrustEvents(content);
    bindRemoveEvents(content);
  } catch (err) {
    content.innerHTML = `<div class="mcp-empty mcp-error">加载失败: ${E((err as Error).message)}</div>`;
  }
}

function bindToggleEvents(container: HTMLElement): void {
  container.querySelectorAll(".mcp-btn-toggle").forEach((btn) => {
    btn.addEventListener("click", async (e) => {
      const name = (e.currentTarget as HTMLElement).dataset.name;
      if (!name) return;
      try {
        const r = await fetch(`/api/mcp/servers/${encodeURIComponent(name)}/toggle`, { method: "POST" });
        const data = await r.json();
        if (data.restartNeeded) toast(`MCP ${data.enabled ? "已启用" : "已停用"} — ${data.message}`, "info");
        fetchMcpServers();
      } catch (err) { toast(`切换失败: ${(err as Error).message}`, "error"); }
    });
  });
}

function bindTrustEvents(container: HTMLElement): void {
  container.querySelectorAll(".mcp-btn-trust").forEach((btn) => {
    btn.addEventListener("click", async (e) => {
      const name = (e.currentTarget as HTMLElement).dataset.name;
      if (!name) return;
      try {
        const r = await fetch(`/api/mcp/servers/${encodeURIComponent(name)}/trust`, { method: "POST" });
        const data = await r.json();
        if (!data.ok) { toast(`信任失败: ${data.error}`, "error"); return; }
        toast(`已信任 ${name}，重启后生效`, "info");
        // 立即更新显示，不再显示旧错误
        const serverEl = container.querySelector(`.mcp-server-actions .mcp-btn-trust[data-name="${E(name)}"]`)?.closest(".mcp-server");
        if (serverEl) {
          const errorEl = serverEl.querySelector(".mcp-server-error");
          if (errorEl) errorEl.textContent = "✅ 已信任，重启后生效";
          (e.currentTarget as HTMLElement).remove();
        }
      } catch (err) { toast(`信任失败: ${(err as Error).message}`, "error"); }
    });
  });
}

function bindRemoveEvents(container: HTMLElement): void {
  container.querySelectorAll(".mcp-btn-remove").forEach((btn) => {
    btn.addEventListener("click", async (e) => {
      const name = (e.currentTarget as HTMLElement).dataset.name;
      if (!name || !confirm(`确定删除 MCP server "${name}"？`)) return;
      try {
        const r = await fetch("/api/mcp/uninstall", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name }),
        });
        const data = await r.json();
        if (!data.ok) { toast(`删除失败: ${data.error}`, "error"); return; }
        if (data.restartNeeded) toast(data.message, "info");
        fetchMcpServers();
      } catch (err) { toast(`删除失败: ${(err as Error).message}`, "error"); }
    });
  });
}

// ─── [探索] 标签页 ─────────────────────────────

async function renderExploreTab(container: HTMLElement): Promise<void> {
  container.innerHTML = '<div class="mcp-empty">加载目录…</div>';

  try {
    const res = await fetch("/api/mcp/catalog");
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const catalog: CatalogEntry[] = await res.json();

    const categories = [...new Set(catalog.map((e) => e.category))];

    container.innerHTML = categories.map((cat) => `
      <div class="mcp-explore-section">
        <div class="mcp-explore-category">${E(cat)}</div>
        ${catalog.filter((e) => e.category === cat).map((entry) => `
          <div class="mcp-explore-item" data-id="${E(entry.id)}">
            <div class="mcp-explore-info">
              <div class="mcp-explore-name">${E(entry.name)}</div>
              <div class="mcp-explore-desc">${E(entry.description)}</div>
              <div class="mcp-explore-cmd">${E(entry.command)} ${entry.args.map((a) => E(a)).join(" ")}</div>
              ${entry.envHints ? `<div class="mcp-explore-env">需要环境变量: ${entry.envHints.map((h) => E(h)).join(", ")}</div>` : ""}
              ${entry.postInstallHint ? `<div class="mcp-explore-note">⚠️ ${E(entry.postInstallHint)}</div>` : ""}
            </div>
            <button class="mcp-btn mcp-btn-install" data-id="${E(entry.id)}">安装</button>
          </div>
        `).join("")}
      </div>
    `).join("");

    bindInstallEvents(container);
  } catch (err) {
    container.innerHTML = `<div class="mcp-empty mcp-error">加载目录失败: ${E((err as Error).message)}</div>`;
  }
}

function bindInstallEvents(container: HTMLElement): void {
  container.querySelectorAll(".mcp-btn-install").forEach((btn) => {
    btn.addEventListener("click", async (e) => {
      const btnEl = e.currentTarget as HTMLElement;
      const id = btnEl.dataset.id;
      if (!id) return;
      try {
        btnEl.textContent = "安装中…";
        btnEl.setAttribute("disabled", "true");

        const r = await fetch("/api/mcp/install", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id }),
        });
        const data = await r.json();
        if (!data.ok) { toast(`安装失败: ${data.error}`, "error"); btnEl.textContent = "重试"; btnEl.removeAttribute("disabled"); return; }
        if (data.restartNeeded) toast(data.message, "info");
        btnEl.textContent = "✓ 已安装";
      } catch (err) {
        btnEl.textContent = "安装失败";
        toast(`安装失败: ${(err as Error).message}`, "error");
        setTimeout(() => { btnEl.textContent = "安装"; btnEl.removeAttribute("disabled"); }, 2000);
      }
    });
  });
}

// ─── 辅助 ──────────────────────────────────────

function stateLabel(state: string): string {
  switch (state) {
    case "connected": return "已连接";
    case "connecting": return "连接中";
    case "disconnected": return "已断开";
    case "error": return "错误";
    default: return state;
  }
}

// ─── 初始化 ────────────────────────────────────

document.addEventListener("click", (e) => {
  const tab = (e.target as HTMLElement)?.closest?.(".mcp-tab") as HTMLElement;
  if (tab?.dataset?.tab) switchTab(tab.dataset.tab as "installed" | "explore");
});

registerPane("mcp", mcpPaneRender);
