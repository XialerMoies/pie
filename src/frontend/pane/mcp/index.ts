/**
 * MCP Servers pane — MCP 服务器列表面板
 *
 * 两个标签页：
 * - [已安装] 已配置的 MCP server 状态列表
 * - [探索]   从内置目录安装 MCP server（数据来自 GET /api/mcp/catalog）
 */
/// <reference path="../../dashboard.d.ts" />

interface McpPaneDependencies {
  events: AppEvents;
  views: AppMcpViews;
}

const mcpPaneApp = (window as any).App;
const mcpPaneDependencies: McpPaneDependencies = {
  events: mcpPaneApp.Events,
  views: mcpPaneApp.McpViews,
};
const mcpPaneEvents = mcpPaneDependencies.events;
const mcpPaneViews = mcpPaneDependencies.views;

// ─── 状态 ──────────────────────────────────────

const MCP_PANEL_ID = "mcp-panel-root";
let _activeMcpTab: "installed" | "explore" = "installed";
let _mcpDirty = true;
let _mcpUpdateUnsubscribers: Array<() => void> = [];

function stopMcpUpdates(): void {
  for (const unsubscribe of _mcpUpdateUnsubscribers) unsubscribe();
  _mcpUpdateUnsubscribers = [];
}

function refreshMcpIfVisible(): void {
  if (!document.getElementById(MCP_PANEL_ID) || _activeMcpTab !== "installed") return;
  if (!_mcpDirty) return;
  _mcpDirty = false;
  void fetchMcpServers();
}

function handleMcpInvalidation(): void {
  _mcpDirty = true;
  refreshMcpIfVisible();
}

function startMcpUpdates(): void {
  stopMcpUpdates();
  _mcpUpdateUnsubscribers = [
    mcpPaneEvents.subscribe('mcp.changed', handleMcpInvalidation),
    mcpPaneEvents.subscribe('resync', handleMcpInvalidation),
  ];
}

// ─── 面板入口 ──────────────────────────────────

function mcpPaneRender(container: HTMLElement): () => void {
  container.innerHTML = `<div id="${MCP_PANEL_ID}">${mcpPaneViews.renderPanel()}</div>`;
  startMcpUpdates();
  switchMcpTab(container.getAttribute?.("data-mcp-mode") === "catalog" ? "explore" : "installed");
  return () => stopMcpUpdates();
}

// ─── 标签切换 ──────────────────────────────────

function switchMcpTab(tab: "installed" | "explore"): void {
  _activeMcpTab = tab;
  const content = document.getElementById("mcp-content");
  if (!content) return;

  document.querySelectorAll(".mcp-tab").forEach((el) => {
    el.classList.toggle("active", (el as HTMLElement).dataset.tab === tab);
  });

  if (tab === "installed") {
    content.innerHTML = `<div class="mcp-empty">加载中…</div>`;
    _mcpDirty = true;
    refreshMcpIfVisible();
  } else {
    void renderExploreTab(content);
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

    content.innerHTML = mcpPaneViews.renderServers(servers);

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
      const btnEl = e.currentTarget as HTMLElement;
      const name = btnEl.dataset.name;
      if (!name) return;
      try {
        const r = await fetch(`/api/mcp/servers/${encodeURIComponent(name)}/trust`, { method: "POST" });
        const data = await r.json();
        if (!data.ok) { toast(`信任失败: ${data.error}`, "error"); return; }
        toast(`已信任 ${name}，重启后生效`, "info");
        // 立即更新显示，不再显示旧错误
        const serverEl = btnEl.closest(".mcp-server");
        if (serverEl) {
          const errorEl = serverEl.querySelector(".mcp-server-error");
          if (errorEl) errorEl.textContent = "✅ 已信任，重启后生效";
          btnEl.remove();
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

    container.innerHTML = mcpPaneViews.renderCatalog(catalog);

    bindInstallEvents(container);
    bindCustomInstall(container);
  } catch (err) {
    container.innerHTML = `<div class="mcp-empty mcp-error">加载目录失败: ${E((err as Error).message)}</div>`;
  }
}

function bindCustomInstall(container: HTMLElement): void {
  const modal = container.querySelector("#mcp-custom-modal") as HTMLElement;
  const nameInput = container.querySelector("#mcp-custom-name") as HTMLInputElement;
  const cmdInput = container.querySelector("#mcp-custom-cmd") as HTMLInputElement;
  const msgEl = container.querySelector("#mcp-custom-msg") as HTMLElement;
  const installBtn = container.querySelector("#mcp-btn-custom") as HTMLElement;

  function openModal(): void { if (modal) modal.style.display = ""; }
  function closeModal(): void {
    if (modal) modal.style.display = "none";
    if (msgEl) msgEl.textContent = "";
    if (nameInput) nameInput.value = "";
    if (cmdInput) cmdInput.value = "";
  }

  // 打开弹窗
  container.querySelector("#mcp-btn-custom-open")?.addEventListener("click", openModal);
  // 关闭弹窗 — 取消按钮
  container.querySelector("#mcp-btn-cancel")?.addEventListener("click", closeModal);
  // 关闭弹窗 — × 按钮
  container.querySelector("#mcp-modal-close")?.addEventListener("click", closeModal);
  // 关闭弹窗 — 点击遮罩
  modal?.addEventListener("click", (e) => { if (e.target === modal) closeModal(); });

  // 安装
  installBtn?.addEventListener("click", async () => {
    const name = nameInput?.value?.trim();
    const cmd = cmdInput?.value?.trim();
    if (!name || !cmd) { if (msgEl) msgEl.textContent = "名称和命令不能为空"; return; }
    try {
      const parts = cmd.split(/\s+/);
      const command = parts[0];
      const args = parts.slice(1);
      installBtn.textContent = "安装中…";
      (installBtn as HTMLButtonElement).disabled = true;
      const r = await fetch("/api/mcp/install/custom", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, command, args }),
      });
      const data = await r.json();
      if (!data.ok) { if (msgEl) msgEl.textContent = `安装失败: ${data.error}`; return; }
      if (msgEl) { msgEl.textContent = `✅ 已添加 ${name}，重启后生效`; msgEl.style.color = "var(--em)"; }
      setTimeout(closeModal, 1500);
    } catch (err) { if (msgEl) msgEl.textContent = `安装失败: ${(err as Error).message}`; }
    finally { installBtn.textContent = "安装"; (installBtn as HTMLButtonElement).disabled = false; }
  });
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

// ─── 初始化 ────────────────────────────────────

document.addEventListener("click", (e) => {
  const tab = (e.target as HTMLElement)?.closest?.(".mcp-tab") as HTMLElement;
  if (tab?.dataset?.tab) switchMcpTab(tab.dataset.tab as "installed" | "explore");
});

const mcpContributionRegistry = (window as any).App?.UIContributions;
if (mcpContributionRegistry && !mcpContributionRegistry.get?.("ui.pane.mcp")) {
  mcpContributionRegistry.register({ id: "ui.pane.mcp", componentId: "ui.pane.mcp", kind: "pane", mount: mcpPaneRender });
}
