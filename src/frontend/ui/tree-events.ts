// Tree events — 键盘导航 / 拖放 / 右键菜单
// 通过 prototype 挂载到 Tree 类

{
  const T = (window as any).Tree;
  if (!T) { console.error("[tree-events] Tree class not loaded"); throw new Error("Tree not found"); }

  // ═══════════════════════════════════════════════════════════════════
  //  键盘导航
  // ═══════════════════════════════════════════════════════════════════

  T.prototype._onKeyDown = function(e: KeyboardEvent) {
    const rows = this._getRows();
    if (rows.length === 0) return;

    const curIdx = this._selected ? rows.findIndex((r: HTMLElement) => r.dataset.id === this._selected) : -1;

    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        this._focusRow(rows, Math.min(curIdx + 1, rows.length - 1));
        break;
      case 'ArrowUp':
        e.preventDefault();
        this._focusRow(rows, Math.max(curIdx - 1, 0));
        break;
      case 'ArrowRight':
        e.preventDefault();
        this._expandDir(rows, curIdx);
        break;
      case 'ArrowLeft':
        e.preventDefault();
        this._collapseDir(rows, curIdx);
        break;
      case 'Enter':
        e.preventDefault();
        if (curIdx >= 0) this._activateRow(rows[curIdx]);
        break;
      case 'Home':
        e.preventDefault();
        this._focusRow(rows, 0);
        break;
      case 'End':
        e.preventDefault();
        this._focusRow(rows, rows.length - 1);
        break;
      default:
        if (e.key.length === 1 && !e.ctrlKey && !e.metaKey) {
          e.preventDefault();
          this._typeAhead(rows, e.key);
        }
        break;
    }
  };

  T.prototype._getRows = function(): HTMLElement[] {
    return Array.from(this.el.querySelectorAll<HTMLElement>(".exp-row:not(.exp-empty)"));
  };

  T.prototype._focusRow = function(rows: HTMLElement[], idx: number) {
    if (idx < 0 || idx >= rows.length) return;
    const id = rows[idx].dataset.id || '';
    const node = this._findNodeById(id);
    if (!node) return;
    this._selected = id;
    this.render();
    const newRow = this.el.querySelector(`[data-id="${CSS.escape(id)}"]`);
    if (newRow) newRow.scrollIntoView({ block: 'nearest' });
    this.el.focus();
  };

  T.prototype._expandDir = function(rows: HTMLElement[], idx: number) {
    if (idx < 0) return;
    const id = rows[idx].dataset.id || '';
    const node = this._findNodeById(id);
    if (!node?.isDir) return;
    if (!this._expanded.has(id)) {
      this._selectAndActivate(node);
    } else {
      const childRows = this._getRows();
      const curIdx = childRows.findIndex((r: HTMLElement) => r.dataset.id === id);
      if (curIdx >= 0 && curIdx + 1 < childRows.length) {
        this._focusRow(childRows, curIdx + 1);
      }
    }
  };

  T.prototype._collapseDir = function(rows: HTMLElement[], idx: number) {
    if (idx < 0) return;
    const id = rows[idx].dataset.id || '';
    const node = this._findNodeById(id);
    if (!node) return;
    if (node.isDir && this._expanded.has(id)) {
      this._expanded.delete(id);
      this.render();
      this.el.focus();
    } else {
      const depth = parseInt(rows[idx].dataset.depth || '0');
      for (let i = idx - 1; i >= 0; i--) {
        const pd = parseInt(rows[i].dataset.depth || '0');
        if (pd < depth) { this._focusRow(rows, i); return; }
      }
    }
  };

  T.prototype._activateRow = function(row: HTMLElement) {
    const id = row.dataset.id || '';
    const node = this._findNodeById(id);
    if (node) this._selectAndActivate(node);
  };

  T.prototype._typeAhead = function(rows: HTMLElement[], key: string) {
    this._searchBuf += key.toLowerCase();
    clearTimeout(this._searchTimer);
    this._searchTimer = setTimeout(() => { this._searchBuf = ''; }, 800);
    for (let i = 0; i < rows.length; i++) {
      const label = rows[i].querySelector('.exp-name')?.textContent || '';
      if (label.toLowerCase().startsWith(this._searchBuf)) {
        this._focusRow(rows, i);
        return;
      }
    }
  };

  // ═══════════════════════════════════════════════════════════════════
  //  拖放
  // ═══════════════════════════════════════════════════════════════════

  T.prototype._onDragOver = function(e: DragEvent) {
    e.preventDefault();
    const row = (e.target as HTMLElement).closest('.exp-row') as HTMLElement | null;
    if (!row) {
      this._clearDropTarget();
      return;
    }
    const id = row.dataset.id || '';
    const node = this._findNodeById(id);
    if (!node) return;
    if (!node.isDir) {
      this._clearDropTarget();
      return;
    }
    this._setDropTarget(id, row);
    if (!this._expanded.has(id) && !this._dragAutoExpand) {
      this._dragAutoExpand = setTimeout(() => {
        if (this._dropTarget !== id) { this._dragAutoExpand = null; return; }
        const cc = this._childCache.get(id);
        if (cc) {
          this._expanded.add(id);
          this.render();
        } else {
          this._expanded.add(id);
          this._onExpand?.(this._findNodeById(id)!, (children) => {
            this._childCache.set(id, children || []);
            if (!this._expanded.has(id)) return;
            this.render();
          });
        }
        this._dragAutoExpand = null;
      }, 600);
    }
    e.dataTransfer!.dropEffect = 'move';
  };

  T.prototype._onDragLeave = function(e: DragEvent) {
    const related = e.relatedTarget as HTMLElement | null;
    if (related && this.el.contains(related)) return;
    this._clearDropTarget();
  };

  T.prototype._onDrop = function(e: DragEvent) {
    e.preventDefault();
    clearTimeout(this._dragAutoExpand);
    const dstId = this._dropTarget;
    this._clearDropTarget();

    if (e.dataTransfer?.files && e.dataTransfer.files.length > 0) {
      this._handleExternalDrop(e.dataTransfer.files, e.dataTransfer);
      return;
    }
    const srcId = e.dataTransfer?.getData('text/tree-node');
    if (srcId && dstId && srcId !== dstId && this._onDragMove) {
      this._onDragMove(srcId, dstId);
    }
  };

  T.prototype._handleExternalDrop = function(files: FileList, dt: DataTransfer) {
    const items = Array.from(files);
    if (this._onExternalDrop) this._onExternalDrop(items, dt);
  };

  T.prototype._setDropTarget = function(id: string, row: HTMLElement) {
    if (this._dropTarget === id) return;
    this._clearDropTarget();
    this._dropTarget = id;
    row.classList.add('drop-target');
  };

  T.prototype._clearDropTarget = function() {
    if (this._dropTarget) {
      const old = this.el.querySelector('.drop-target') as HTMLElement | null;
      old?.classList.remove('drop-target');
    }
    this._dropTarget = null;
    clearTimeout(this._dragAutoExpand);
    this._dragAutoExpand = null;
  };

  // ═══════════════════════════════════════════════════════════════════
  //  右键菜单
  // ═══════════════════════════════════════════════════════════════════

  T.prototype._onContextMenu = function(e: MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    const row = (e.target as HTMLElement).closest('.exp-row') as HTMLElement | null;
    if (!row) {
      this._showBlankCtxMenu(e.clientX, e.clientY);
      return;
    }
    const id = row.dataset.id || '';
    const node = this._findNodeById(id);
    if (!node) return;
    this._ctxNode = node;
    this._selected = node.id;
    this.render();
    this._showNodeCtxMenu(e.clientX, e.clientY);
  };

  T.prototype._showNodeCtxMenu = function(x: number, y: number) {
    this._hideCtxMenu();
    const menu = this._buildMenu(this._ctxActions.map((a: { label: string; action: (n: TreeNode, t: Tree) => void; disabled?: (n: TreeNode) => boolean }) => ({
      label: a.label, disabled: a.disabled?.(this._ctxNode!),
      action: () => { this._hideCtxMenu(); a.action(this._ctxNode!, this); },
    })));
    menu.style.left = x + 'px'; menu.style.top = y + 'px';
    this._attachMenu(menu);
  };

  T.prototype._showBlankCtxMenu = function(x: number, y: number) {
    if (!this._blankCtxActions.length) return;
    this._hideCtxMenu();
    const menu = this._buildMenu(this._blankCtxActions.map((a: { label: string; action: () => void }) => ({
      label: a.label, disabled: false,
      action: () => { this._hideCtxMenu(); a.action(); },
    })));
    menu.style.left = x + 'px'; menu.style.top = y + 'px';
    this._attachMenu(menu);
  };

  T.prototype._buildMenu = function(items: { label: string; disabled: boolean; action: () => void }[]) {
    const menu = document.createElement('div');
    menu.className = 'ctx-menu';
    for (const a of items) {
      if (a.label === '-') {
        const sep = document.createElement('div');
        sep.className = 'ctx-sep'; menu.appendChild(sep);
        continue;
      }
      const item = document.createElement('div');
      item.className = 'ctx-item' + (a.disabled ? ' ctx-disabled' : '');
      item.textContent = a.label;
      if (!a.disabled) item.onclick = a.action;
      menu.appendChild(item);
    }
    return menu;
  };

  T.prototype._attachMenu = function(menu: HTMLDivElement) {
    this._ctxMenu = menu;
    document.body.appendChild(menu);
    setTimeout(() => document.addEventListener('click', this._ctxCloseHandler = () => this._hideCtxMenu(), { once: true }), 0);
  };

  T.prototype._hideCtxMenu = function() {
    if (this._ctxMenu) { this._ctxMenu.remove(); this._ctxMenu = null; }
    if (this._ctxCloseHandler) { document.removeEventListener('click', this._ctxCloseHandler); this._ctxCloseHandler = null; }
  };
}
