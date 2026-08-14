/// <reference path="../../dashboard.d.ts" />

class ExplorerEmptyView {
  static render(): string {
    return [
      `<div class="sg-t">资源管理器</div>`,
      `<div style="padding:12px;font-size:.72rem;color:var(--tm);text-align:center">`,
      `  <p style="margin-bottom:10px">尚未选择工作区</p>`,
      `  <button class="sa-btn" data-explorer-action="select-workspace">选择文件夹</button>`,
      `</div>`,
    ].join("");
  }
}

class ExplorerPanelView {
  static render(): string {
    return [
      `<div class="sg-t" style="display:flex;align-items:center;justify-content:space-between">资源管理器<button class="sg-more" data-explorer-action="toggle-filter" title="显示选项">···</button></div>`,
      `<div id="exp-tree-cont" style="flex:1;min-height:0"></div>`,
    ].join("");
  }
}

class ExplorerFilterMenuView {
  private menu: HTMLElement | null = null;
  private outsideClick: (() => void) | null = null;

  show(anchor: HTMLElement, filterEnabled: boolean, onChange: (enabled: boolean) => void): void {
    this.dispose();
    const rect = anchor.getBoundingClientRect();
    const menu = document.createElement("div");
    menu.className = "ctx-menu";
    menu.style.position = "fixed";
    menu.style.left = `${rect.right + 4}px`;
    menu.style.top = `${rect.bottom + 8}px`;

    const items = [
      { label: "显示被过滤的文件", checked: !filterEnabled, enabled: false },
      { label: "隐藏被过滤的文件", checked: filterEnabled, enabled: true },
    ];
    for (const itemData of items) {
      const item = document.createElement("div");
      item.className = "ctx-item";
      item.style.display = "flex";
      item.style.alignItems = "center";
      item.style.gap = "8px";
      item.innerHTML = `<span style="width:14px;text-align:center;flex-shrink:0">${itemData.checked ? "✓" : ""}</span><span>${itemData.label}</span>`;
      item.addEventListener("click", () => {
        this.dispose();
        onChange(itemData.enabled);
      });
      menu.appendChild(item);
    }

    this.menu = menu;
    document.body.appendChild(menu);
    setTimeout(() => {
      if (this.menu !== menu) return;
      this.outsideClick = () => this.dispose();
      document.addEventListener("click", this.outsideClick, { once: true });
    }, 0);
  }

  dispose(): void {
    this.menu?.remove();
    this.menu = null;
    if (this.outsideClick) document.removeEventListener("click", this.outsideClick);
    this.outsideClick = null;
  }
}

const explorerFilterMenuView = new ExplorerFilterMenuView();
const explorerViewsApp = (window as any).App || ((window as any).App = {});
explorerViewsApp.ExplorerViews = {
  renderEmpty: () => ExplorerEmptyView.render(),
  renderPanel: () => ExplorerPanelView.render(),
  showFilterMenu: (anchor: HTMLElement, enabled: boolean, onChange: (enabled: boolean) => void) => {
    explorerFilterMenuView.show(anchor, enabled, onChange);
  },
  dispose: () => explorerFilterMenuView.dispose(),
};
