// Tree rendering — prototype 挂载 render/renderNodes/buildRow
// 这些方法在 tree-core.ts 中有空桩，这里用真实实现覆盖

{
  const T = (window as any).Tree;
  if (!T) { console.error("[tree-render] Tree class not loaded"); throw new Error("Tree not found"); }

  T.prototype.render = function() {
    this.el.innerHTML = '';
    this.renderNodes(this._data, 0, []);
  };

  T.prototype.renderNodes = function(nodes: TreeNode[], depth: number, pg: boolean[], insertAfter?: HTMLElement) {
    const folders = nodes.filter((n: TreeNode) => n.isDir);
    const guideAtDepth = folders.length > 1 && folders.some((n: TreeNode) => this._expanded.has(n.id));

    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i];
      const guides = [...pg, guideAtDepth];
      const row = this.buildRow(n, depth, guides);

      if (insertAfter) {
        insertAfter.parentNode!.insertBefore(row, insertAfter.nextSibling);
      } else {
        this.el.appendChild(row);
      }
      insertAfter = row;

      if (n.isDir && this._expanded.has(n.id)) {
        const cc = this._childCache.get(n.id);
        if (cc && cc.length > 0) {
          this.renderNodes(cc, depth + 1, guides, row);
          insertAfter = this.el.lastElementChild as HTMLElement || row;
        } else if (cc) {
          insertAfter = row;
        }
      }

      row.onclick = (e: MouseEvent) => { e.stopPropagation(); this._selectAndActivate(n); };
    }
  };

  T.prototype.buildRow = function(n: TreeNode, depth: number, guides: boolean[]) {
    const row = document.createElement('div');
    row.className = 'exp-row' + (n.id === this._selected ? ' active' : '');
    row.dataset.id = n.id;
    row.dataset.depth = String(depth);
    row.draggable = true;
    row.style.paddingLeft = (2 + depth * 14) + 'px';
    row.addEventListener('dragstart', (e: DragEvent) => {
      e.dataTransfer?.setData('text/tree-node', n.id);
      e.dataTransfer?.setData('text/plain', 'tree-node:' + n.id);
      e.dataTransfer!.effectAllowed = 'move';
    });

    let html = '';
    for (let d = 0; d < depth; d++) {
      html += '<span class="indent-guide"></span>';
    }

    const drawOwnLine = n.isDir && guides[depth];
    const tw = n.isDir
      ? `<span class="exp-twistie${this._expanded.has(n.id) ? ' open' : ''}${drawOwnLine ? ' draw-line' : ''}"></span>`
      : `<span class="exp-twistie hidden"></span>`;

    row.innerHTML = `<span class="exp-indent">${html}</span>${tw}${n.icon}<span class="exp-name">${E(n.label)}</span>`;
    return row;
  };
}
