// Tree widget core — 类定义 + 状态 + 公共 API
// 渲染和事件处理在 tree-render.ts / tree-events.ts 中通过 prototype 挂载

interface TreeNode {
  id: string;
  label: string;
  icon: string;
  isDir: boolean;
  children?: TreeNode[];
}

interface TreeOptions {
  indent?: number;
}

export class Tree {
  private el: HTMLDivElement;
  private _expanded = new Set<string>();
  private _selected = "";
  private _data: TreeNode[] = [];
  private _childCache = new Map<string, TreeNode[]>();
  private _indent: number;
  private _onSelect: ((node: TreeNode) => void) | null = null;
  private _fetchGen = new Map<string, number>();
  private _searchBuf = "";
  private _searchTimer: ReturnType<typeof setTimeout> | null = null;

  private _ctxMenu: HTMLDivElement | null = null;
  private _ctxNode: TreeNode | null = null;
  private _stateKey = 'explorer-state';
  private _loadQueued = false;

  // 拖放状态
  private _dropTarget: string | null = null;
  private _dragAutoExpand: ReturnType<typeof setTimeout> | null = null;
  private _onDragMove: ((nodeId: string, targetParentId: string) => void) | null = null;
  private _onExternalDrop: ((files: File[], dt: DataTransfer) => void) | null = null;

  // 右键菜单动作
  private _ctxActions: { label: string; action: (node: TreeNode, tree: Tree) => void; disabled?: (node: TreeNode) => boolean }[] = [];
  private _blankCtxActions: { label: string; action: () => void }[] = [];

  // 行内编辑
  private _editingNode: TreeNode | null = null;
  private _ctxCloseHandler: (() => void) | null = null;

  constructor(container: HTMLElement, opts: TreeOptions = {}) {
    this._indent = opts.indent || 14;
    this.el = document.createElement('div');
    this.el.className = 'explorer-tree';
    this.el.tabIndex = 0;
    this.el.addEventListener('keydown', (e) => this._onKeyDown(e));
    this.el.addEventListener('contextmenu', (e) => this._onContextMenu(e));
    this.el.addEventListener('dragover', (e) => this._onDragOver(e));
    this.el.addEventListener('dragleave', (e) => this._onDragLeave(e));
    this.el.addEventListener('drop', (e) => this._onDrop(e));
    container.appendChild(this.el);
  }

  set onSelect(fn: ((node: TreeNode) => void) | null) { this._onSelect = fn; }

  // ─── 公共 API ─────────────────────────────────────────────

  setData(data: TreeNode[]): void {
    this._data = data;
    if (!this._loadQueued) {
      this._loadQueued = true;
      try {
        const raw = localStorage.getItem(this._stateKey);
        if (!raw) { this._loadQueued = false; this.render(); return; }
        const s = JSON.parse(raw);
        const toExpand: string[] = s.expanded || [];
        if (s.selected) this._selected = s.selected;
        this.render();
        const expandNext = (ids: string[]) => {
          if (!ids.length) { this._loadQueued = false; return; }
          const id = ids.shift()!;
          this._expanded.add(id);
          const node = this._findNodeById(id);
          if (!node || !node.isDir) { expandNext(ids); return; }
          const cached = this._childCache.get(id);
          if (cached) {
            this.render();
            expandNext(ids);
          } else {
            this._onExpand?.(node, (children) => {
              this._childCache.set(id, children || []);
              if (!this._expanded.has(id)) { expandNext(ids); return; }
              this.render();
              expandNext(ids);
            });
          }
        };
        expandNext(toExpand);
      } catch {
        this._loadQueued = false;
        this.render();
      }
    } else {
      this.render();
    }
  }

  setChildren(parentId: string, children: TreeNode[]): void {
    this._childCache.set(parentId, children);
    this._expanded.add(parentId);
    this.render();
  }

  set onDragMove(cb: ((nodeId: string, targetParentId: string) => void) | null) { this._onDragMove = cb; }
  get onDragMove() { return this._onDragMove; }

  set onExternalDrop(cb: ((files: File[], dt: DataTransfer) => void) | null) { this._onExternalDrop = cb; }

  set contextMenu(actions: { label: string; action: (node: TreeNode, tree: Tree) => void; disabled?: (node: TreeNode) => boolean }[]) {
    this._ctxActions = actions;
  }

  set blankContextMenu(actions: { label: string; action: () => void }[]) {
    this._blankCtxActions = actions;
  }

  expandAll(paths: string[]): void {
    for (const p of paths) this._expanded.add(p);
    this.render();
  }

  inlineCreate(parentId: string, isDir: boolean, onCreate: (name: string) => void): void {
    const isRoot = parentId === '';
    if (!isRoot && !this._childCache.has(parentId)) {
      this._onExpand?.(this._findNodeById(parentId)!, (children) => {
        this._childCache.set(parentId, children || []);
        this._expanded.add(parentId);
        this.inlineCreate(parentId, isDir, onCreate);
      });
      return;
    }
    const tempId = isRoot ? '__new__' : parentId + '/__new__';
    const tempNode: TreeNode = { id: tempId, label: '', icon: '', isDir: false };
    if (isRoot) {
      this._data.unshift(tempNode);
    } else {
      const children = this._childCache.get(parentId) || [];
      children.unshift(tempNode);
      this._childCache.set(parentId, children);
      this._expanded.add(parentId);
    }
    this.render();

    const cleanup = () => {
      if (isRoot) {
        const idx = this._data.findIndex(c => c.id === tempId);
        if (idx >= 0) this._data.splice(idx, 1);
      } else {
        const cc = this._childCache.get(parentId) || [];
        const idx = cc.findIndex(c => c.id === tempId);
        if (idx >= 0) cc.splice(idx, 1);
        this._childCache.set(parentId, cc);
      }
    };
    requestAnimationFrame(() => {
      this.inlineRename(tempId, (name) => { cleanup(); if (name) onCreate(name); else this.render(); },
        () => { cleanup(); this.render(); });
    });
  }

  inlineRename(id: string, cb: (newName: string) => void, onCancel?: () => void): void {
    const row = this.el.querySelector(`[data-id="${CSS.escape(id)}"]`) as HTMLElement | null;
    if (!row) return;
    const node = this._findNodeById(id);
    if (!node) return;
    this._editingNode = node;

    const nameEl = row.querySelector('.exp-name') as HTMLElement | null;
    if (!nameEl) return;
    const oldName = nameEl.textContent || '';
    const input = document.createElement('input');
    input.type = 'text'; input.value = oldName;
    input.className = 'sess-rename-input';
    input.style.cssText = 'width:100%;padding:1px 4px;border-radius:3px;border:1px solid var(--am);background:var(--bc);color:var(--tx);font-size:13px;font-family:var(--fm);outline:none;box-sizing:border-box';
    nameEl.innerHTML = '';
    nameEl.appendChild(input);
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);

    let done = false;
    const finish = (save: boolean) => {
      if (done) return;
      done = true;
      const val = input.value.trim();
      if (save && val && val !== oldName) cb(val);
      else if (!save && onCancel) onCancel();
      else nameEl.textContent = save && val ? val : oldName;
      this._editingNode = null;
    };
    input.addEventListener('keydown', (e: KeyboardEvent) => {
      e.stopPropagation();
      if (e.isComposing) return;
      if (e.key === 'Enter') { e.preventDefault(); finish(true); }
      else if (e.key === 'Escape') { e.preventDefault(); finish(false); }
    });
    setTimeout(() => {
      const h = (ce: MouseEvent) => {
        if (!document.contains(input)) return document.removeEventListener('mousedown', h);
        if (!input.contains(ce.target as Node)) finish(false);
      };
      document.addEventListener('mousedown', h);
    }, 0);
  }

  clearChildCache(): void {
    this._childCache.clear();
  }

  // ─── 核心内部方法 ─────────────────────────────────────────

  set onExpand(fn: ((node: TreeNode, cb: (children?: TreeNode[]) => void) => void) | null) { this._onExpand = fn; }
  private _onExpand: ((node: TreeNode, cb: (children?: TreeNode[]) => void) => void) | null = null;

  private _saveState(): void {
    try {
      localStorage.setItem(this._stateKey, JSON.stringify({
        expanded: Array.from(this._expanded),
        selected: this._selected,
      }));
    } catch {}
  }

  private _selectAndActivate(n: TreeNode): void {
    this._selected = n.id;
    this._saveState();
    if (!n.isDir) {
      this._onSelect?.(n);
      this.render();
      this.el.focus();
      return;
    }
    if (this._expanded.has(n.id)) {
      this._expanded.delete(n.id);
      this._saveState();
      this.render();
      this.el.focus();
      return;
    }
    const gen = (this._fetchGen.get(n.id) || 0) + 1;
    this._fetchGen.set(n.id, gen);
    this._expanded.add(n.id);
    this._saveState();
    const cached = this._childCache.get(n.id);
    if (cached) {
      this.render();
      this.el.focus();
    } else {
      this._onExpand?.(n, (children) => {
        this._childCache.set(n.id, children || []);
        if (this._fetchGen.get(n.id) !== gen) return;
        if (!this._expanded.has(n.id)) return;
        this.render();
        this.el.focus();
      });
    }
  }

  private _findNodeById(id: string): TreeNode | undefined {
    const search = (nodes: TreeNode[]): TreeNode | undefined => {
      for (const n of nodes) {
        if (n.id === id) return n;
        const cached = this._childCache.get(n.id);
        if (cached) { const found = search(cached); if (found) return found; }
      }
      return undefined;
    };
    return search(this._data);
  }

  // 以下方法由 tree-render.ts / tree-events.ts 挂载到 prototype
  render() {}
  private renderNodes() {}
  private buildRow() {}
  private _onKeyDown(_e: KeyboardEvent) {}
  private _getRows(): HTMLElement[] { return []; }
  private _focusRow(_rows: HTMLElement[], _idx: number) {}
  private _expandDir(_rows: HTMLElement[], _idx: number) {}
  private _collapseDir(_rows: HTMLElement[], _idx: number) {}
  private _activateRow(_row: HTMLElement) {}
  private _typeAhead(_rows: HTMLElement[], _key: string) {}
  private _onDragOver(_e: DragEvent) {}
  private _onDragLeave(_e: DragEvent) {}
  private _onDrop(_e: DragEvent) {}
  private _handleExternalDrop(_files: FileList, _dt: DataTransfer) {}
  private _setDropTarget(_id: string, _row: HTMLElement) {}
  private _clearDropTarget() {}
  private _onContextMenu(_e: MouseEvent) {}
  private _showNodeCtxMenu(_x: number, _y: number) {}
  private _showBlankCtxMenu(_x: number, _y: number) {}
  private _buildMenu(_items: { label: string; disabled?: boolean; action: () => void }[]): HTMLDivElement { return document.createElement('div'); }
  private _attachMenu(_menu: HTMLDivElement) {}
  private _hideCtxMenu() {
    if (this._ctxMenu) { this._ctxMenu.remove(); this._ctxMenu = null; }
    if (this._ctxCloseHandler) { document.removeEventListener('click', this._ctxCloseHandler); this._ctxCloseHandler = null; }
  }
}

// 暴露到全局（供 inline onclick 及 prototype 挂载使用）
if (typeof window !== 'undefined') (window as any).Tree = Tree;
