// 用户扩展与集成面板。核心宿主能力由 server 的 management 投影过滤，不在这里伪装成可卸载项。

type ComponentPaneCategory = "extensions" | "integrations";
type ComponentPaneManifestClass = "system" | "native" | "third-party" | "mcp";
type ComponentPaneSubgroup = "desktop" | "agent" | "server" | "mcp-server";
type ComponentPaneFilter = "all" | "active" | "disabled" | "required";

interface ComponentPaneManifest {
  id: string;
  kind: "required" | "optional";
  capability: string;
  source?: "builtin" | "workspace" | "user" | "mcp";
  providedBy?: string;
  productClass?: ComponentPaneManifestClass;
  hostSurface?: ComponentPaneSubgroup;
  displayName?: string;
  description?: string;
}

interface ComponentPaneState {
  manifest: ComponentPaneManifest;
  enabled: boolean;
  trusted: boolean;
  health: "unknown" | "healthy" | "broken" | "unavailable";
  status: "active" | "disabled" | "untrusted" | "unhealthy";
}

interface ComponentPanePackage {
  packageId: string;
  packageVersion: string;
  component: ComponentPaneManifest;
}

interface ComponentPaneCatalog {
  extensions: ComponentPaneState[];
  integrations: ComponentPaneState[];
  availableExtensions?: ComponentPanePackage[];
}

const componentPaneApp = (window as any).App;

function makeElement<K extends keyof HTMLElementTagNameMap>(name: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const element = document.createElement(name);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

function makeIcon(symbol: string, size = 16): SVGSVGElement {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("width", String(size));
  svg.setAttribute("height", String(size));
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
  use.setAttribute("href", `#${symbol}`);
  svg.append(use);
  return svg;
}

function componentKindLabel(component: ComponentPaneState | ComponentPaneManifest): string {
  const manifest = "manifest" in component ? component.manifest : component;
  if (manifest.source === "mcp") return "MCP";
  if (manifest.capability === "desktop.ui-pane") return "界面";
  if (manifest.capability === "desktop.language-service") return "语言服务";
  return "工具";
}

function componentTitle(component: ComponentPaneState | ComponentPaneManifest): string {
  const manifest = "manifest" in component ? component.manifest : component;
  return manifest.displayName || manifest.id;
}

function componentDomain(component: ComponentPaneState | ComponentPaneManifest): ComponentPaneSubgroup {
  const manifest = "manifest" in component ? component.manifest : component;
  if (manifest.hostSurface === "desktop") return "desktop";
  if (manifest.hostSurface === "server") return "server";
  if (manifest.hostSurface === "mcp-service") return "mcp-server";
  const id = manifest.id.toLocaleLowerCase();
  const capability = manifest.capability.toLocaleLowerCase();
  if (manifest.source === "mcp" || capability.startsWith("mcp.") || id.startsWith("mcp.") || id.includes(".mcp")) return "mcp-server";
  if (capability.startsWith("desktop.") || capability.startsWith("ui.") || capability.startsWith("language-service") || id.startsWith("ui.") || id.startsWith("language-service.")) return "desktop";
  if (capability.startsWith("server.") || capability.startsWith("route.") || id.startsWith("server.") || id.startsWith("route.")) return "server";
  return "agent";
}

function componentCategoryLabel(category: ComponentPaneCategory): string {
  return ({ extensions: "扩展", integrations: "集成" })[category];
}

function componentDomainLabel(domain: ComponentPaneSubgroup): string {
  return ({ desktop: "桌面端", agent: "Agent", server: "服务端", "mcp-server": "MCP Server" })[domain];
}

function componentOriginLabel(component: ComponentPaneState | ComponentPaneManifest): string {
  const manifest = "manifest" in component ? component.manifest : component;
  if (manifest.source === "builtin") return "原生组件";
  if (manifest.source === "mcp") return "MCP 组件";
  return "第三方组件";
}

function componentStatusLabel(component: ComponentPaneState): string {
  if (component.status === "active") return "已启用";
  if (component.status === "disabled") return "已停用";
  if (component.status === "untrusted") return "未信任";
  return "不可用";
}

function isManagedBuiltin(component: ComponentPaneState): boolean {
  return component.manifest.kind === "optional" && component.manifest.source === "builtin" && Boolean(component.manifest.providedBy);
}

async function fetchComponentCatalog(): Promise<ComponentPaneCatalog> {
  const response = await fetch("/api/components?view=management", { credentials: "include", cache: "no-store" });
  const body = await response.json().catch(() => null) as ComponentPaneCatalog | null;
  if (!response.ok || !body || !Array.isArray(body.extensions) || !Array.isArray(body.integrations)) throw new Error("无法读取扩展与集成目录");
  return body;
}

async function runComponentAction(path: string): Promise<void> {
  const response = await fetch(path, { method: "POST", credentials: "include" });
  const body = await response.json().catch(() => null) as { error?: unknown } | null;
  if (!response.ok) throw new Error(typeof body?.error === "string" ? body.error : "组件操作失败");
}

async function confirmComponentAction(message: string): Promise<boolean> {
  const confirm = componentPaneApp.UI?.confirmAsync;
  if (typeof confirm === "function") return Boolean(await confirm(message));
  return window.confirm(message);
}

function setNotice(message: string, kind: "success" | "error"): void {
  componentPaneApp.StatusBar?.setNotice?.(message, kind);
}

function componentMatches(component: ComponentPaneState, query: string, filter: ComponentPaneFilter): boolean {
  if (filter === "active" && component.status !== "active") return false;
  if (filter === "disabled" && component.status !== "disabled") return false;
  if (filter === "required" && component.manifest.kind !== "required") return false;
  if (!query) return true;
  const haystack = [component.manifest.id, componentTitle(component), component.manifest.description, componentKindLabel(component), componentOriginLabel(component), componentDomainLabel(componentDomain(component))].join(" ").toLocaleLowerCase();
  return haystack.includes(query.toLocaleLowerCase());
}

function countBadge(value: number): HTMLSpanElement {
  return makeElement("span", "components-group-count", String(value));
}

function renderInstalledRows(container: HTMLElement, components: ComponentPaneState[], refresh: () => void): void {
  if (components.length === 0) {
    container.append(makeElement("div", "components-empty", "没有匹配的组件"));
    return;
  }

  for (const component of components) {
    const row = makeElement("article", "component-row");
    row.dataset.componentId = component.manifest.id;
    row.tabIndex = 0;
    row.setAttribute("role", "button");
    row.setAttribute("aria-label", `查看组件 ${componentTitle(component)}`);
    const icon = makeElement("span", "component-row-icon");
    icon.append(makeIcon("ipuzzle", 17));
    const main = makeElement("div", "component-row-main");
    main.append(
      makeElement("div", "component-name", componentTitle(component)),
      makeElement("div", "component-row-summary", component.manifest.description || componentKindLabel(component)),
      makeElement("div", "component-row-meta", `${componentOriginLabel(component)} · ${componentKindLabel(component)} · ${componentStatusLabel(component)}`),
    );
    row.append(icon, main);
    const openDetails = (): void => componentPaneApp.UI?.openComponentTab?.({ ...component.manifest, enabled: component.enabled, status: component.status, installed: true });
    row.addEventListener("click", (event) => {
      if ((event.target as Element)?.closest("button")) return;
      openDetails();
    });
    row.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") { event.preventDefault(); openDetails(); }
    });

    if (isManagedBuiltin(component)) {
      const actions = makeElement("div", "component-actions");
      const toggle = makeElement("button", "component-action") as HTMLButtonElement;
      toggle.type = "button";
      toggle.title = component.enabled ? "停用组件" : "启用组件";
      toggle.setAttribute("aria-label", `${component.enabled ? "停用" : "启用"} ${component.manifest.id}`);
      toggle.append(makeIcon(component.enabled ? "ipause" : "ipower", 14));
      toggle.addEventListener("click", async () => {
        toggle.disabled = true;
        try {
          await runComponentAction(`/api/components/${encodeURIComponent(component.manifest.id)}/${component.enabled ? "disable" : "enable"}`);
          setNotice(`${component.manifest.id}${component.enabled ? " 已停用" : " 已启用"}`, "success");
          await componentPaneApp.UI?.syncComponents?.();
          refresh();
        } catch (error) {
          setNotice(error instanceof Error ? error.message : "组件操作失败", "error");
          toggle.disabled = false;
        }
      });

      const uninstall = makeElement("button", "component-action component-action-muted") as HTMLButtonElement;
      uninstall.type = "button";
      uninstall.title = "卸载官方组件包";
      uninstall.setAttribute("aria-label", `卸载 ${component.manifest.id}`);
      uninstall.append(makeIcon("itrash", 14));
      uninstall.addEventListener("click", async () => {
        if (!(await confirmComponentAction(`卸载 ${component.manifest.id}？之后可在对应归属分类中恢复。`))) return;
        uninstall.disabled = true;
        try {
          await runComponentAction(`/api/components/${encodeURIComponent(component.manifest.id)}/uninstall`);
          setNotice(`${component.manifest.id} 已卸载`, "success");
          await componentPaneApp.UI?.syncComponents?.();
          refresh();
        } catch (error) {
          setNotice(error instanceof Error ? error.message : "组件卸载失败", "error");
          uninstall.disabled = false;
        }
      });
      actions.append(toggle, uninstall);
      row.append(actions);
    }
    container.append(row);
  }
}

function renderRecoverableRows(container: HTMLElement, packages: ComponentPanePackage[], refresh: () => void): void {
  if (packages.length === 0) {
    container.append(makeElement("div", "components-empty", "没有可恢复组件"));
    return;
  }

  for (const entry of packages) {
    const row = makeElement("article", "component-row");
    row.tabIndex = 0;
    row.setAttribute("role", "button");
    row.setAttribute("aria-label", `查看组件 ${componentTitle(entry.component)}`);
    const icon = makeElement("span", "component-row-icon component-row-icon-muted");
    icon.append(makeIcon("ipuzzle", 17));
    const main = makeElement("div", "component-row-main");
    main.append(
      makeElement("div", "component-name", componentTitle(entry.component)),
      makeElement("div", "component-row-summary", entry.component.description || componentKindLabel(entry.component)),
      makeElement("div", "component-row-meta", `${componentOriginLabel(entry.component)} · 已卸载`),
    );
    row.append(icon, main);
    const openDetails = (): void => componentPaneApp.UI?.openComponentTab?.({ ...entry.component, status: "disabled", enabled: false, installed: false });
    row.addEventListener("click", (event) => { if (!(event.target as Element)?.closest("button")) openDetails(); });
    row.addEventListener("keydown", (event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); openDetails(); } });
    const restore = makeElement("button", "component-action component-action-restore") as HTMLButtonElement;
    restore.type = "button";
    restore.title = "恢复官方组件";
    restore.setAttribute("aria-label", `恢复 ${entry.component.id}`);
    restore.append(makeIcon("irefresh", 14));
    restore.addEventListener("click", async () => {
      restore.disabled = true;
      try {
        await runComponentAction(`/api/components/packages/${encodeURIComponent(entry.packageId)}/install`);
        setNotice(`${entry.component.id} 已恢复`, "success");
        await componentPaneApp.UI?.syncComponents?.();
        refresh();
      } catch (error) {
        setNotice(error instanceof Error ? error.message : "组件恢复失败", "error");
        restore.disabled = false;
      }
    });
    row.append(restore);
    container.append(row);
  }
}

export function componentsPaneRender(container: HTMLElement): () => void {
  let disposed = false;
  let catalog: ComponentPaneCatalog | null = null;
  let query = "";
  let filter: ComponentPaneFilter = "all";
  const expanded: Record<ComponentPaneCategory, boolean> = { extensions: true, integrations: true };
  const subgroupExpanded: Record<string, boolean> = {};

  const refresh = async (): Promise<void> => {
    if (disposed) return;
    try {
      catalog = await fetchComponentCatalog();
      if (!disposed) paint();
    } catch (error) {
      if (!disposed) paint(error instanceof Error ? error.message : "无法读取组件目录");
    }
  };

  const makeGroup = (group: ComponentPaneCategory, label: string, count: number, body: (container: HTMLElement) => void): HTMLElement => {
    const section = makeElement("section", "components-group");
    section.dataset.group = group;
    const heading = makeElement("button", "components-group-heading") as HTMLButtonElement;
    heading.type = "button";
    heading.setAttribute("aria-expanded", String(expanded[group]));
    const chevron = makeElement("span", "components-chevron");
    chevron.append(makeIcon(expanded[group] ? "ich-down" : "ich-right", 13));
    heading.append(chevron, makeElement("span", "components-group-label", label), countBadge(count));
    heading.addEventListener("click", () => {
      expanded[group] = !expanded[group];
      paint();
    });
    section.append(heading);
    if (expanded[group]) {
      const groupBody = makeElement("div", "components-group-body");
      body(groupBody);
      section.append(groupBody);
    }
    return section;
  };

  const makeSubgroup = (category: ComponentPaneCategory, subgroup: ComponentPaneSubgroup, count: number, body: (container: HTMLElement) => void): HTMLElement => {
    const key = `${category}:${subgroup}`;
    const isExpanded = subgroupExpanded[key] ?? true;
    const section = makeElement("section", "components-origin-group");
    let groupAction: HTMLButtonElement | null = null;
    const heading = makeElement("button", "components-origin-heading") as HTMLButtonElement;
    heading.type = "button";
    heading.setAttribute("aria-expanded", String(isExpanded));
    heading.setAttribute("aria-label", `${isExpanded ? "收起" : "展开"}${componentDomainLabel(subgroup)}`);
    const chevron = makeElement("span", "components-chevron");
    chevron.append(makeIcon(isExpanded ? "ich-down" : "ich-right", 12));
    heading.append(chevron, makeElement("span", "components-origin-label", componentDomainLabel(subgroup)), countBadge(count));
    heading.addEventListener("click", () => {
      subgroupExpanded[key] = !isExpanded;
      paint();
    });
    if (category === "integrations" && subgroup === "mcp-server") {
      groupAction = makeElement("button", "components-group-action") as HTMLButtonElement;
      groupAction.type = "button";
      groupAction.title = "添加 MCP Server";
      groupAction.setAttribute("aria-label", "添加 MCP Server");
      groupAction.append(makeIcon("iplus", 14));
      groupAction.addEventListener("click", (event) => {
        event.stopPropagation();
        componentPaneApp.UI?.openMcpManagementTab?.();
      });
    }
    section.append(heading);
    if (groupAction) section.append(groupAction);
    if (isExpanded) {
      const groupBody = makeElement("div", "components-origin-body");
      body(groupBody);
      section.append(groupBody);
    }
    return section;
  };

  const paint = (error?: string): void => {
    if (disposed) return;
    container.replaceChildren();
    const header = makeElement("header", "components-header");
    const titleLine = makeElement("div", "components-title-line");
    titleLine.append(makeElement("h2", "components-title", "扩展与集成"));
    const headerActions = makeElement("div", "components-header-actions");
    const reload = makeElement("button", "components-icon-button") as HTMLButtonElement;
    reload.type = "button";
    reload.title = "刷新组件目录";
    reload.setAttribute("aria-label", "刷新组件目录");
    reload.append(makeIcon("irefresh", 15));
    reload.addEventListener("click", () => void refresh());
    headerActions.append(reload);
    titleLine.append(headerActions);
    header.append(titleLine);

    const searchRow = makeElement("div", "components-search-row");
    const search = makeElement("div", "ch-search");
    const searchIcon = makeElement("span", "ch-search-icon");
    searchIcon.append(makeIcon("isearch", 14));
    search.append(searchIcon);
    const input = makeElement("input", "ch-search-input") as HTMLInputElement;
    input.type = "text";
    input.value = query;
    input.placeholder = "搜索扩展与集成";
    input.setAttribute("aria-label", "搜索扩展与集成");
    input.addEventListener("input", () => {
      query = input.value.trim();
      const caret = input.selectionStart ?? input.value.length;
      paint();
      const nextInput = container.querySelector<HTMLInputElement>(".ch-search-input");
      nextInput?.focus();
      if (nextInput && typeof nextInput.setSelectionRange === "function") nextInput.setSelectionRange(caret, caret);
    });
    search.append(input);
    const clear = makeElement("button", "ch-search-clear") as HTMLButtonElement;
    clear.type = "button";
    clear.textContent = "✕";
    clear.title = "清除搜索";
    clear.setAttribute("aria-label", "清除搜索");
    clear.addEventListener("click", () => {
      query = "";
      paint();
      container.querySelector<HTMLInputElement>(".ch-search-input")?.focus();
    });
    search.append(clear);
    const filterButton = makeElement("button", `components-filter-button${filter !== "all" ? " on" : ""}`) as HTMLButtonElement;
    filterButton.type = "button";
    filterButton.title = "筛选组件";
    filterButton.setAttribute("aria-label", "筛选组件");
    filterButton.append(makeIcon("ifilter", 15));
    filterButton.addEventListener("click", () => {
      filter = filter === "all" ? "disabled" : "all";
      paint();
    });
    searchRow.append(search, filterButton);
    header.append(searchRow);
    container.append(header);

    if (error) {
      container.append(makeElement("div", "components-empty components-error", error));
      return;
    }
    if (!catalog) {
      container.append(makeElement("div", "components-empty", "正在读取组件目录"));
      return;
    }

    const extensions = catalog.extensions
      .filter((component) => componentMatches(component, query, filter))
      .sort((left, right) => left.manifest.id.localeCompare(right.manifest.id));
    const integrations = catalog.integrations
      .filter((component) => componentMatches(component, query, filter))
      .sort((left, right) => left.manifest.id.localeCompare(right.manifest.id));
    const recoverable = (catalog.availableExtensions || [])
      .filter((entry) => !query || `${entry.component.id} ${entry.component.description || ""}`.toLocaleLowerCase().includes(query.toLocaleLowerCase()))
      .sort((left, right) => left.component.id.localeCompare(right.component.id));
    const groups = makeElement("div", "components-groups");
    const categoryOrder: ComponentPaneCategory[] = ["extensions", "integrations"];
    for (const category of categoryOrder) {
      const categoryInstalled = category === "extensions" ? extensions : integrations;
      const categoryRecoverable = category === "extensions" ? recoverable : [];
      if (categoryInstalled.length === 0 && categoryRecoverable.length === 0 && category === "extensions") continue;
      groups.append(makeGroup(category, componentCategoryLabel(category), categoryInstalled.length + categoryRecoverable.length, (body) => {
        const subgroupOrder: ComponentPaneSubgroup[] = category === "extensions" ? ["desktop", "agent", "server"] : ["mcp-server"];
        for (const subgroup of subgroupOrder) {
          const subgroupInstalled = categoryInstalled.filter((component) => componentDomain(component) === subgroup);
          const subgroupRecoverable = categoryRecoverable.filter((entry) => componentDomain(entry.component) === subgroup);
          const isMcpServerCollection = category === "integrations" && subgroup === "mcp-server";
          if (subgroupInstalled.length === 0 && subgroupRecoverable.length === 0 && !isMcpServerCollection) continue;
          body.append(makeSubgroup(category, subgroup, subgroupInstalled.length + subgroupRecoverable.length, (subgroupBody) => {
            if (subgroupInstalled.length > 0) renderInstalledRows(subgroupBody, subgroupInstalled, () => void refresh());
            if (subgroupRecoverable.length > 0) renderRecoverableRows(subgroupBody, subgroupRecoverable, () => void refresh());
            if (isMcpServerCollection && subgroupInstalled.length === 0 && subgroupRecoverable.length === 0) {
              subgroupBody.append(makeElement("div", "components-empty", "未配置 MCP Server"));
            }
          }));
        }
      }));
    }
    container.append(groups);
  };

  paint();
  void refresh();
  return () => { disposed = true; };
}

componentPaneApp.UI?.registerPane?.("components", componentsPaneRender);
