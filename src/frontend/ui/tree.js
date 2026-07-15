class Tree {
  el;
  _expanded = /* @__PURE__ */ new Set();
  _selected = "";
  _data = [];
  _childCache = /* @__PURE__ */ new Map();
  _indent;
  _onSelect = null;
  /** 每个节点的 fetch 代数 — 防止异步回调过期导致重复渲染 */
  _fetchGen = /* @__PURE__ */ new Map();
  /** 键盘输入查找缓冲 */
  _searchBuf = "";
  _searchTimer = null;
  _ctxMenu = null;
  _ctxNode = null;
  _stateKey = "explorer-state";
  _loadQueued = false;
  constructor(container, opts = {}) {
    this._indent = opts.indent || 14;
    this.el = document.createElement("div");
    this.el.className = "explorer-tree";
    this.el.tabIndex = 0;
    this.el.addEventListener("keydown", (e) => this._onKeyDown(e));
    this.el.addEventListener("contextmenu", (e) => this._onContextMenu(e));
    this.el.addEventListener("dragover", (e) => this._onDragOver(e));
    this.el.addEventListener("dragleave", (e) => this._onDragLeave(e));
    this.el.addEventListener("drop", (e) => this._onDrop(e));
    container.appendChild(this.el);
  }
  set onSelect(fn) {
    this._onSelect = fn;
  }
  setData(data) {
    this._data = data;
    if (!this._loadQueued) {
      this._loadQueued = true;
      try {
        const raw = localStorage.getItem(this._stateKey);
        if (!raw) {
          this._loadQueued = false;
          this.render();
          return;
        }
        const s = JSON.parse(raw);
        const toExpand = s.expanded || [];
        if (s.selected) this._selected = s.selected;
        this.render();
        const expandNext = (ids) => {
          if (!ids.length) {
            this._loadQueued = false;
            return;
          }
          const id = ids.shift();
          this._expanded.add(id);
          const node = this._findNodeById(id);
          if (!node || !node.isDir) {
            expandNext(ids);
            return;
          }
          const cached = this._childCache.get(id);
          if (cached) {
            this.render();
            expandNext(ids);
          } else {
            this._onExpand?.(node, (children) => {
              this._childCache.set(id, children || []);
              if (!this._expanded.has(id)) {
                expandNext(ids);
                return;
              }
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
  setChildren(parentId, children) {
    this._childCache.set(parentId, children);
    this._expanded.add(parentId);
    this.render();
  }
  render() {
    this.el.innerHTML = "";
    this.renderNodes(this._data, 0, []);
  }
  /** 渲染节点列表。 */
  renderNodes(nodes, depth, pg, insertAfter) {
    const folders = nodes.filter((n) => n.isDir);
    const guideAtDepth = folders.length > 1 && folders.some((n) => this._expanded.has(n.id));
    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i];
      const guides = [...pg, guideAtDepth];
      const row = this.buildRow(n, depth, guides);
      if (insertAfter) {
        insertAfter.parentNode.insertBefore(row, insertAfter.nextSibling);
      } else {
        this.el.appendChild(row);
      }
      insertAfter = row;
      if (n.isDir && this._expanded.has(n.id)) {
        const cc = this._childCache.get(n.id);
        if (cc && cc.length > 0) {
          this.renderNodes(cc, depth + 1, guides, row);
          insertAfter = this.el.lastElementChild || row;
        } else if (cc) {
          insertAfter = row;
        }
      }
      row.onclick = (e) => {
        e.stopPropagation();
        this.onRowClick(n);
      };
    }
  }
  buildRow(n, depth, guides) {
    const row = document.createElement("div");
    row.className = "exp-row" + (n.id === this._selected ? " active" : "");
    row.dataset.id = n.id;
    row.dataset.depth = String(depth);
    row.draggable = true;
    row.style.paddingLeft = 2 + depth * 14 + "px";
    row.addEventListener("dragstart", (e) => {
      e.dataTransfer?.setData("text/tree-node", n.id);
      e.dataTransfer?.setData("text/plain", "tree-node:" + n.id);
      e.dataTransfer.effectAllowed = "move";
    });
    let html = "";
    for (let d = 0; d < depth; d++) {
      html += '<span class="indent-guide"></span>';
    }
    const drawOwnLine = n.isDir && guides[depth];
    const tw = n.isDir ? `<span class="exp-twistie${this._expanded.has(n.id) ? " open" : ""}${drawOwnLine ? " draw-line" : ""}"></span>` : `<span class="exp-twistie hidden"></span>`;
    row.innerHTML = `<span class="exp-indent">${html}</span>${tw}${n.icon}<span class="exp-name">${E(n.label)}</span>`;
    return row;
  }
  onRowClick(n) {
    this._selectAndActivate(n);
  }
  /** 选中并激活（展开或打开） */
  _saveState() {
    try {
      localStorage.setItem(this._stateKey, JSON.stringify({
        expanded: Array.from(this._expanded),
        selected: this._selected
      }));
    } catch {
    }
  }
  _selectAndActivate(n) {
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
    } else {
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
  }
  // ─── 拖放 ────────────────────────────────────────────────
  _dropTarget = null;
  _dragAutoExpand = null;
  set onDragMove(cb) {
    this._onDragMove = cb;
  }
  _onDragMove = null;
  _onDragOver(e) {
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
  }
  _onDragLeave(e) {
    const related = e.relatedTarget;
    if (related && this.el.contains(related)) return;
    this._clearDropTarget();
  }
  _onDrop(e) {
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
  }
  _handleExternalDrop(files, dt) {
    const items = Array.from(files);
    if (this._onExternalDrop) this._onExternalDrop(items, dt);
  }
  set onExternalDrop(cb) {
    this._onExternalDrop = cb;
  }
  _onExternalDrop = null;
  _setDropTarget(id, row) {
    if (this._dropTarget === id) return;
    this._clearDropTarget();
    this._dropTarget = id;
    row.classList.add("drop-target");
  }
  _clearDropTarget() {
    if (this._dropTarget) {
      const old = this.el.querySelector(".drop-target");
      old?.classList.remove("drop-target");
    }
    this._dropTarget = null;
    clearTimeout(this._dragAutoExpand);
    this._dragAutoExpand = null;
  }
  // ─── 键盘导航 ─────────────────────────────────────────────
  _onKeyDown(e) {
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
  }
  _getRows() {
    return Array.from(this.el.querySelectorAll(".exp-row:not(.exp-empty)"));
  }
  _focusRow(rows, idx) {
    if (idx < 0 || idx >= rows.length) return;
    const id = rows[idx].dataset.id || "";
    const node = this._findNodeById(id);
    if (!node) return;
    this._selected = id;
    this.render();
    const newRow = this.el.querySelector(`[data-id="${CSS.escape(id)}"]`);
    if (newRow) newRow.scrollIntoView({ block: "nearest" });
    this.el.focus();
  }
  _expandDir(rows, idx) {
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
  }
  _collapseDir(rows, idx) {
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
  }
  _activateRow(row) {
    const id = row.dataset.id || "";
    const node = this._findNodeById(id);
    if (node) this._selectAndActivate(node);
  }
  /** 查找 TreeNode（从 _data 递归 / _childCache） */
  _findNodeById(id) {
    const search = (nodes) => {
      for (const n of nodes) {
        if (n.id === id) return n;
        const cached = this._childCache.get(n.id);
        if (cached) {
          const found = search(cached);
          if (found) return found;
        }
      }
      return void 0;
    };
    return search(this._data);
  }
  /** 输入查找：跳转到第一个匹配文件名的行 */
  _typeAhead(rows, key) {
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
  }
  // ─── 右键菜单 ─────────────────────────────────────────────
  /** 设置右键菜单项。label: 菜单项文本, action: (node, tree) => void */
  set contextMenu(actions) {
    this._ctxActions = actions;
  }
  /** 空白区域右键（如新建文件/文件夹） */
  set blankContextMenu(actions) {
    this._blankCtxActions = actions;
  }
  _ctxActions = [];
  _blankCtxActions = [];
  _onContextMenu(e) {
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
  }
  _showNodeCtxMenu(x, y) {
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
  }
  _showBlankCtxMenu(x, y) {
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
  }
  _buildMenu(items) {
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
  }
  _attachMenu(menu) {
    this._ctxMenu = menu;
    document.body.appendChild(menu);
    setTimeout(() => document.addEventListener("click", this._ctxCloseHandler = () => this._hideCtxMenu(), { once: true }), 0);
  }
  _ctxCloseHandler = null;
  _hideCtxMenu() {
    if (this._ctxMenu) {
      this._ctxMenu.remove();
      this._ctxMenu = null;
    }
    if (this._ctxCloseHandler) {
      document.removeEventListener("click", this._ctxCloseHandler);
      this._ctxCloseHandler = null;
    }
  }
  _onExpand = null;
  /** 行内新建（VS Code 风格）：在 parent 下创建临时行并进入编辑 */
  inlineCreate(parentId, isDir, onCreate) {
    const isRoot = parentId === "";
    if (!isRoot && !this._childCache.has(parentId)) {
      this._onExpand?.(this._findNodeById(parentId), (children) => {
        this._childCache.set(parentId, children || []);
        this._expanded.add(parentId);
        this.inlineCreate(parentId, isDir, onCreate);
      });
      return;
    }
    const tempId = isRoot ? "__new__" : parentId + "/__new__";
    const tempNode = { id: tempId, label: "", icon: "", isDir: false };
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
        const idx = this._data.findIndex((c) => c.id === tempId);
        if (idx >= 0) this._data.splice(idx, 1);
      } else {
        const cc = this._childCache.get(parentId) || [];
        const idx = cc.findIndex((c) => c.id === tempId);
        if (idx >= 0) cc.splice(idx, 1);
        this._childCache.set(parentId, cc);
      }
    };
    requestAnimationFrame(() => {
      this.inlineRename(
        tempId,
        (name) => {
          cleanup();
          if (name) onCreate(name);
          else this.render();
        },
        () => {
          cleanup();
          this.render();
        }
      );
    });
  }
  /** 行内编辑（VS Code 风格）：替换指定节点的标签为 input */
  _editingNode = null;
  inlineRename(id, cb, onCancel) {
    const row = this.el.querySelector(`[data-id="${CSS.escape(id)}"]`);
    if (!row) return;
    const node = this._findNodeById(id);
    if (!node) return;
    this._editingNode = node;
    const nameEl = row.querySelector(".exp-name");
    if (!nameEl) return;
    const oldName = nameEl.textContent || "";
    const input = document.createElement("input");
    input.type = "text";
    input.value = oldName;
    input.className = "sess-rename-input";
    input.style.cssText = "width:100%;padding:1px 4px;border-radius:3px;border:1px solid var(--am);background:var(--bc);color:var(--tx);font-size:13px;font-family:var(--fm);outline:none;box-sizing:border-box";
    nameEl.innerHTML = "";
    nameEl.appendChild(input);
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
    let done = false;
    const finish = (save) => {
      if (done) return;
      done = true;
      const val = input.value.trim();
      if (save && val && val !== oldName) cb(val);
      else if (!save && onCancel) onCancel();
      else nameEl.textContent = save && val ? val : oldName;
      this._editingNode = null;
    };
    input.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.isComposing) return;
      if (e.key === "Enter") {
        e.preventDefault();
        finish(true);
      } else if (e.key === "Escape") {
        e.preventDefault();
        finish(false);
      }
    });
    setTimeout(() => {
      const h = (ce) => {
        if (!document.contains(input)) return document.removeEventListener("mousedown", h);
        if (!input.contains(ce.target)) finish(false);
      };
      document.addEventListener("mousedown", h);
    }, 0);
  }
  /** 清空子节点缓存，强制下次展开时重新获取 */
  clearChildCache() {
    this._childCache.clear();
  }
  set onExpand(fn) {
    this._onExpand = fn;
  }
  expandAll(paths) {
    for (const p of paths) this._expanded.add(p);
    this.render();
  }
}
