import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Window } from "happy-dom";

describe("扩展与集成 pane", () => {
  it("renders VS Code-style groups and sends a host-managed enable action", async () => {
    const win = new Window();
    const doc = win.document;
    global.window = win;
    global.document = doc;
    const registrations = new Map();
    const notices = [];
    const opened = [];
    const catalog = {
      extensions: [{
        manifest: { id: "ui.pane.search", kind: "optional", capability: "desktop.ui-pane", source: "builtin", productClass: "native", hostSurface: "desktop", providedBy: "my-code-agent.ui.search-pane", description: "工作区搜索" },
        enabled: false, trusted: true, health: "healthy", status: "disabled",
      }, {
        manifest: { id: "tool.search", kind: "optional", capability: "agent-tool", source: "builtin", productClass: "native", hostSurface: "agent", providedBy: "my-code-agent.tool.search", description: "工作区搜索工具" },
        enabled: true, trusted: true, health: "healthy", status: "active",
      }, {
        manifest: { id: "tool.third-party", kind: "optional", capability: "agent-tool", source: "user", productClass: "third-party", hostSurface: "agent", providedBy: "vendor.tool", description: "第三方工具" },
        enabled: true, trusted: true, health: "healthy", status: "active",
      }, {
        manifest: { id: "route.chat", kind: "optional", capability: "server.route", source: "builtin", productClass: "native", hostSurface: "server", providedBy: "my-code-agent.route.chat", description: "聊天路由" },
        enabled: true, trusted: true, health: "healthy", status: "active",
      }, {
        manifest: { id: "model-adapter.openai", kind: "optional", capability: "model-protocol", source: "builtin", providedBy: "my-code-agent.model-adapter.openai", description: "OpenAI 协议适配" },
        enabled: true, trusted: true, health: "healthy", status: "active",
      }],
      integrations: [{
        manifest: { id: "mcp.server.demo", kind: "optional", capability: "mcp.server", source: "mcp", productClass: "mcp", hostSurface: "mcp-service", providedBy: "demo" },
        enabled: true, trusted: true, health: "healthy", status: "active",
      }],
      availableExtensions: [{ packageId: "my-code-agent.ui.search-pane", packageVersion: "1.0.0", component: { id: "ui.pane.search", kind: "optional", capability: "desktop.ui-pane", source: "builtin", providedBy: "my-code-agent.ui.search-pane" } }],
    };
    win.App = {
      UI: { confirmAsync: async () => true, openComponentTab(component) { opened.push(component); } },
      UIContributions: { register(definition) { registrations.set(definition.id.replace("ui.pane.", ""), definition.mount); return { id: definition.id }; }, get() { return undefined; } },
      StatusBar: { setNotice(message, kind) { notices.push({ message, kind }); } },
    };
    global.fetch = async (url, options = {}) => {
      if (url === "/api/components?view=management" && !options.method) return { ok: true, json: async () => catalog };
      assert.equal(url, "/api/components/ui.pane.search/enable");
      assert.equal(options.method, "POST");
      return { ok: true, json: async () => ({ ok: true }) };
    };

    await import(`../src/frontend/pane/components/index.ts?test=${Date.now()}`);
    const render = registrations.get("components");
    assert.equal(typeof render, "function");
    const container = doc.createElement("div");
    doc.body.append(container);
    render(container);
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(container.querySelector(".components-title")?.textContent, "扩展与集成");
    assert.deepEqual([...container.querySelectorAll(".components-group-label")].map((group) => group.textContent), ["扩展", "集成"]);
    assert.deepEqual([...container.querySelectorAll(".components-origin-label")].map((group) => group.textContent), ["桌面端", "Agent", "服务端", "MCP Server"]);
    const agentCollection = container.querySelector('[data-component-id="extension.agent-tools"] .component-row-main');
    assert.ok(agentCollection, "第一方 Agent 工具应合并为一个集合条目");
    agentCollection?.dispatchEvent(new win.Event("click", { bubbles: true }));
    assert.equal(opened[0]?.id, "extension.agent-tools");
    assert.equal(opened[0]?.children?.[0]?.id, "tool.search");
    const addMcp = container.querySelector('[aria-label="添加 MCP Server"]');
    assert.ok(addMcp, "MCP Server 分组应提供集合级新增动作");
    addMcp?.click();
    assert.ok(doc.querySelector("#components-mcp-install-modal"), "MCP Server 新增动作应在组件栏打开自定义安装对话框");
    doc.querySelector("#components-mcp-install-modal .mcp-modal-close")?.dispatchEvent(new win.Event("click", { bubbles: true }));
    const addExtension = container.querySelector('[aria-label="安装扩展"]');
    assert.ok(addExtension, "扩展分组应提供集合级安装动作");
    addExtension?.dispatchEvent(new win.Event("click", { bubbles: true }));
    const extensionModal = doc.querySelector("#components-extension-install-modal");
    assert.ok(extensionModal, "扩展安装动作应打开轻量安装对话框");
    assert.equal(extensionModal?.querySelector('[aria-label="manifest 文件路径"]') !== null, true);
    extensionModal?.querySelector(".extension-install-mode-button:nth-child(2)")?.dispatchEvent(new win.Event("click", { bubbles: true }));
    assert.equal(extensionModal?.querySelector('[aria-label="manifest HTTPS 地址"]') !== null, true);
    assert.equal(extensionModal?.querySelector('[aria-label="选择本地 manifest"]')?.hidden, true);
    assert.ok(extensionModal?.querySelector('[aria-label="选择本地 manifest"] use[href="#if"]'), "本地 manifest 按钮应使用已登记的文件图标");
    extensionModal?.querySelector(".mcp-modal-close")?.dispatchEvent(new win.Event("click", { bubbles: true }));
    container.querySelector('[data-component-id="mcp.server.demo"] .component-row-main')?.dispatchEvent(new win.Event("click", { bubbles: true }));
    assert.equal(opened[1]?.id, "mcp.server.demo", "MCP Server 实例应直接打开自己的详情页");
    const desktopOrigin = container.querySelector('[data-group="extensions"] .components-origin-heading');
    assert.equal(desktopOrigin?.getAttribute("aria-expanded"), "true");
    desktopOrigin?.dispatchEvent(new win.Event("click", { bubbles: true }));
    assert.equal(container.querySelector('[data-group="extensions"] .components-origin-heading')?.getAttribute("aria-expanded"), "false");
    container.querySelector('[data-group="extensions"] .components-origin-heading')?.dispatchEvent(new win.Event("click", { bubbles: true }));
    assert.ok(container.querySelector(".ch-search"));
    assert.ok(container.querySelector(".ch-search-icon"));
    const searchInput = container.querySelector(".ch-search-input");
    assert.ok(searchInput);
    assert.ok(container.querySelector(".ch-search-clear"));
    searchInput.value = "search";
    searchInput.dispatchEvent(new win.Event("input", { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    const clearButton = container.querySelector(".ch-search-clear");
    assert.ok(clearButton);
    clearButton.click();
    assert.equal(container.querySelector(".ch-search-input")?.value, "");
    assert.ok(container.querySelector(".components-group-count"));
    assert.ok(container.querySelector(".component-row-icon svg use[href='#ipuzzle']"));
    assert.equal(container.querySelector(".components-header-actions use[href='#imore']"), null);
    assert.equal(container.querySelectorAll(".components-header-actions button").length, 1);
    container.querySelector('[data-component-id="tool.third-party"] .component-row-main')?.dispatchEvent(new win.Event("click", { bubbles: true }));
    assert.equal(opened[2]?.id, "tool.third-party");
    const action = container.querySelector('[data-component-id="ui.pane.search"] .component-action');
    assert.equal(action?.getAttribute("aria-label"), "启用 ui.pane.search", action?.outerHTML || container.innerHTML);
    action.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepEqual(notices, [{ message: "ui.pane.search 已启用", kind: "success" }]);
  });
});
