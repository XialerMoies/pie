{
  const T = window.Tree;
  if (!T) {
    console.error("[tree-events] Tree class not loaded");
    throw new Error("Tree not found");
  }
  T.prototype._onKeyDown = function(e) {
    const rows = this._getRows();
    if (rows.length === 0) return;
    const curIdx = this._selected ? rows.findIndex((r) => r.dataset.id === this._selected) : -1;
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        this._focusRow(rows, Math.min(curIdx + 1, rows.length - 1));
        break;
      case "ArrowUp":
        e.preventDefault();
        this._focusRow(rows, Math.max(curIdx - 1, 0));
        break;
      case "ArrowRight":
        e.preventDefault();
        this._expandDir(rows, curIdx);
        break;
      case "ArrowLeft":
        e.preventDefault();
        this._collapseDir(rows, curIdx);
        break;
      case "Enter":
        e.preventDefault();
        if (curIdx >= 0) this._activateRow(rows[curIdx]);
        break;
      case "Home":
        e.preventDefault();
        this._focusRow(rows, 0);
        break;
      case "End":
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
  T.prototype._getRows = function() {
    return Array.from(this.el.querySelectorAll(".exp-row:not(.exp-empty)"));
  };
  T.prototype._focusRow = function(rows, idx) {
    if (idx < 0 || idx >= rows.length) return;
    const id = rows[idx].dataset.id || "";
    const node = this._findNodeById(id);
    if (!node) return;
    this._selected = id;
    this.render();
    const newRow = this.el.querySelector(`[data-id="${CSS.escape(id)}"]`);
    if (newRow) newRow.scrollIntoView({ block: "nearest" });
    this.el.focus();
  };
  T.prototype._expandDir = function(rows, idx) {
    if (idx < 0) return;
    const id = rows[idx].dataset.id || "";
    const node = this._findNodeById(id);
    if (!node?.isDir) return;
    if (!this._expanded.has(id)) {
      this._selectAndActivate(node);
    } else {
      const childRows = this._getRows();
      const curIdx = childRows.findIndex((r) => r.dataset.id === id);
      if (curIdx >= 0 && curIdx + 1 < childRows.length) {
        this._focusRow(childRows, curIdx + 1);
      }
    }
  };
  T.prototype._collapseDir = function(rows, idx) {
    if (idx < 0) return;
    const id = rows[idx].dataset.id || "";
    const node = this._findNodeById(id);
    if (!node) return;
    if (node.isDir && this._expanded.has(id)) {
      this._expanded.delete(id);
      this.render();
      this.el.focus();
    } else {
      const depth = parseInt(rows[idx].dataset.depth || "0");
      for (let i = idx - 1; i >= 0; i--) {
        const pd = parseInt(rows[i].dataset.depth || "0");
        if (pd < depth) {
          this._focusRow(rows, i);
          return;
        }
      }
    }
  };
  T.prototype._activateRow = function(row) {
    const id = row.dataset.id || "";
    const node = this._findNodeById(id);
    if (node) this._selectAndActivate(node);
  };
  T.prototype._typeAhead = function(rows, key) {
    this._searchBuf += key.toLowerCase();
    clearTimeout(this._searchTimer);
    this._searchTimer = setTimeout(() => {
      this._searchBuf = "";
    }, 800);
    for (let i = 0; i < rows.length; i++) {
      const label = rows[i].querySelector(".exp-name")?.textContent || "";
      if (label.toLowerCase().startsWith(this._searchBuf)) {
        this._focusRow(rows, i);
        return;
      }
    }
  };
  T.prototype._onDragOver = function(e) {
    e.preventDefault();
    const row = e.target.closest(".exp-row");
    if (!row) {
      this._clearDropTarget();
      return;
    }
    const id = row.dataset.id || "";
    const node = this._findNodeById(id);
    if (!node) return;
    if (!node.isDir) {
      this._clearDropTarget();
      return;
    }
    this._setDropTarget(id, row);
    if (!this._expanded.has(id) && !this._dragAutoExpand) {
      this._dragAutoExpand = setTimeout(() => {
        if (this._dropTarget !== id) {
          this._dragAutoExpand = null;
          return;
        }
        const cc = this._childCache.get(id);
        if (cc) {
          this._expanded.add(id);
          this.render();
        } else {
          this._expanded.add(id);
          this._onExpand?.(this._findNodeById(id), (children) => {
            this._childCache.set(id, children || []);
            if (!this._expanded.has(id)) return;
            this.render();
          });
        }
        this._dragAutoExpand = null;
      }, 600);
    }
    e.dataTransfer.dropEffect = "move";
  };
  T.prototype._onDragLeave = function(e) {
    const related = e.relatedTarget;
    if (related && this.el.contains(related)) return;
    this._clearDropTarget();
  };
  T.prototype._onDrop = function(e) {
    e.preventDefault();
    clearTimeout(this._dragAutoExpand);
    const dstId = this._dropTarget;
    this._clearDropTarget();
    if (e.dataTransfer?.files && e.dataTransfer.files.length > 0) {
      this._handleExternalDrop(e.dataTransfer.files, e.dataTransfer);
      return;
    }
    const srcId = e.dataTransfer?.getData("text/tree-node");
    if (srcId && dstId && srcId !== dstId && this._onDragMove) {
      this._onDragMove(srcId, dstId);
    }
  };
  T.prototype._handleExternalDrop = function(files, dt) {
    const items = Array.from(files);
    if (this._onExternalDrop) this._onExternalDrop(items, dt);
  };
  T.prototype._setDropTarget = function(id, row) {
    if (this._dropTarget === id) return;
    this._clearDropTarget();
    this._dropTarget = id;
    row.classList.add("drop-target");
  };
  T.prototype._clearDropTarget = function() {
    if (this._dropTarget) {
      const old = this.el.querySelector(".drop-target");
      old?.classList.remove("drop-target");
    }
    this._dropTarget = null;
    clearTimeout(this._dragAutoExpand);
    this._dragAutoExpand = null;
  };
  T.prototype._onContextMenu = function(e) {
    e.preventDefault();
    e.stopPropagation();
    const row = e.target.closest(".exp-row");
    if (!row) {
      this._showBlankCtxMenu(e.clientX, e.clientY);
      return;
    }
    const id = row.dataset.id || "";
    const node = this._findNodeById(id);
    if (!node) return;
    this._ctxNode = node;
    this._selected = node.id;
    this.render();
    this._showNodeCtxMenu(e.clientX, e.clientY);
  };
  T.prototype._showNodeCtxMenu = function(x, y) {
    this._hideCtxMenu();
    const menu = this._buildMenu(this._ctxActions.map((a) => ({
      label: a.label,
      disabled: a.disabled?.(this._ctxNode),
      action: () => {
        this._hideCtxMenu();
        a.action(this._ctxNode, this);
      }
    })));
    menu.style.left = x + "px";
    menu.style.top = y + "px";
    this._attachMenu(menu);
  };
  T.prototype._showBlankCtxMenu = function(x, y) {
    if (!this._blankCtxActions.length) return;
    this._hideCtxMenu();
    const menu = this._buildMenu(this._blankCtxActions.map((a) => ({
      label: a.label,
      disabled: false,
      action: () => {
        this._hideCtxMenu();
        a.action();
      }
    })));
    menu.style.left = x + "px";
    menu.style.top = y + "px";
    this._attachMenu(menu);
  };
  T.prototype._buildMenu = function(items) {
    const menu = document.createElement("div");
    menu.className = "ctx-menu";
    for (const a of items) {
      if (a.label === "-") {
        const sep = document.createElement("div");
        sep.className = "ctx-sep";
        menu.appendChild(sep);
        continue;
      }
      const item = document.createElement("div");
      item.className = "ctx-item" + (a.disabled ? " ctx-disabled" : "");
      item.textContent = a.label;
      if (!a.disabled) item.onclick = a.action;
      menu.appendChild(item);
    }
    return menu;
  };
  T.prototype._attachMenu = function(menu) {
    this._ctxMenu = menu;
    document.body.appendChild(menu);
    setTimeout(() => document.addEventListener("click", this._ctxCloseHandler = () => this._hideCtxMenu(), { once: true }), 0);
  };
  T.prototype._hideCtxMenu = function() {
    if (this._ctxMenu) {
      this._ctxMenu.remove();
      this._ctxMenu = null;
    }
    if (this._ctxCloseHandler) {
      document.removeEventListener("click", this._ctxCloseHandler);
      this._ctxCloseHandler = null;
    }
  };
}
