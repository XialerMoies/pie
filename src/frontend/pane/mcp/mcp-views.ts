/// <reference path="../../dashboard.d.ts" />

const mcpViewsApp = (window as any).App || ((window as any).App = {});
const mcpViewsState: AppMcpState = mcpViewsApp.McpState;

class McpPanelView {
  static render(): string {
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
}

class McpServerListView {
  static render(servers: McpServerStatus[]): string {
    if (servers.length === 0) {
      return '<div class="mcp-empty">未发现 MCP 服务器配置<br>切换到「探索」页签安装</div>';
    }

    return servers.map((server) => {
      const state = mcpViewsState.normalize(server.state);
      const command = server.config?.transport === "http" || server.config?.transport === "sse"
        ? E(server.config.url ?? "")
        : `${E(server.config?.command ?? "")} ${(server.config?.args || []).map((arg) => E(arg)).join(" ")}`;
      return `
        <div class="mcp-server" data-source="${E(server.name)}">
          <div class="mcp-server-top">
            <span class="mcp-dot mcp-dot--${state}"></span>
            <span class="mcp-server-name">${E(server.name)}</span>
            <span class="mcp-server-state mcp-state--${state}">${mcpViewsState.label(state)}</span>
          </div>
          ${server.error ? `<div class="mcp-server-error">${E(server.error)}</div>` : ""}
          ${server.tools.length > 0 ? `<div class="mcp-server-tools">${server.tools.map((tool) => `<span class="mcp-tool-tag">${E(tool)}</span>`).join("")}</div>` : ""}
          <div class="mcp-server-actions">
            ${server.config ? `<button class="mcp-btn mcp-btn-toggle" data-name="${E(server.name)}">${server.config.enabled !== false ? "停用" : "启用"}</button>` : ""}
            ${server.error?.includes("未信任") ? `<button class="mcp-btn mcp-btn-trust" data-name="${E(server.name)}">信任</button>` : ""}
            ${server.canDelete !== false ? `<button class="mcp-btn mcp-btn-remove" data-name="${E(server.name)}">删除</button>` : ""}
          </div>
          ${server.config ? `<div class="mcp-server-cmd">${command}</div>` : ""}
        </div>
      `;
    }).join("");
  }
}

class McpCustomInstallView {
  static render(): string {
    return `
      <div class="mcp-explore-section">
        <div class="mcp-explore-category">自定义安装</div>
        <div class="mcp-custom-trigger">
          <button class="mcp-btn mcp-btn-custom-open" id="mcp-btn-custom-open">+ 自定义安装</button>
        </div>
      </div>
      <div class="mcp-modal-overlay" id="mcp-custom-modal" style="display:none">
        <div class="mcp-modal">
          <div class="mcp-modal-header">
            <span class="mcp-modal-title">自定义安装 MCP Server</span>
            <button class="mcp-modal-close" id="mcp-modal-close">&times;</button>
          </div>
          <div class="mcp-modal-body">
            <div class="mcp-modal-field">
              <label class="mcp-modal-label" for="mcp-custom-name">名称</label>
              <input type="text" id="mcp-custom-name" placeholder="如 my-server" class="mcp-input">
            </div>
            <div class="mcp-modal-field">
              <label class="mcp-modal-label" for="mcp-custom-cmd">启动命令</label>
              <input type="text" id="mcp-custom-cmd" placeholder="如 npx -y @modelcontextprotocol/server-filesystem /path" class="mcp-input">
            </div>
            <div id="mcp-custom-msg" class="mcp-custom-msg"></div>
          </div>
          <div class="mcp-modal-footer">
            <button class="mcp-btn mcp-btn-cancel" id="mcp-btn-cancel">取消</button>
            <button class="mcp-btn mcp-btn-install-custom" id="mcp-btn-custom">安装</button>
          </div>
        </div>
      </div>`;
  }
}

class McpCatalogView {
  static render(catalog: CatalogEntry[]): string {
    const categories = [...new Set(catalog.map((entry) => entry.category))];
    return categories.map((category) => `
      <div class="mcp-explore-section">
        <div class="mcp-explore-category">${E(category)}</div>
        ${catalog.filter((entry) => entry.category === category).map((entry) => `
          <div class="mcp-explore-item" data-id="${E(entry.id)}">
            <div class="mcp-explore-info">
              <div class="mcp-explore-name">${E(entry.name)}</div>
              <div class="mcp-explore-desc">${E(entry.description)}</div>
              <div class="mcp-explore-cmd">${E(entry.command)} ${entry.args.map((arg) => E(arg)).join(" ")}</div>
              ${entry.envHints ? `<div class="mcp-explore-env">需要环境变量: ${entry.envHints.map((hint) => E(hint)).join(", ")}</div>` : ""}
              ${entry.postInstallHint ? `<div class="mcp-explore-note">⚠️ ${E(entry.postInstallHint)}</div>` : ""}
            </div>
            <button class="mcp-btn mcp-btn-install" data-id="${E(entry.id)}">安装</button>
          </div>
        `).join("")}
      </div>
    `).join("") + McpCustomInstallView.render();
  }
}

mcpViewsApp.McpViews = {
  renderPanel: () => McpPanelView.render(),
  renderServers: (servers: McpServerStatus[]) => McpServerListView.render(servers),
  renderCatalog: (catalog: CatalogEntry[]) => McpCatalogView.render(catalog),
};
