function explorerRender(container) {
  const ws2 = ExplorerService.getWorkspacePath();
  if (!ws2) {
    container.innerHTML = [
      `<div class="sg-t">\u8D44\u6E90\u7BA1\u7406\u5668</div>`,
      `<div style="padding:12px;font-size:.72rem;color:var(--tm);text-align:center">`,
      `  <p style="margin-bottom:10px">\u5C1A\u672A\u9009\u62E9\u5DE5\u4F5C\u533A</p>`,
      `  <button class="sa-btn" onclick="ExplorerService.applyWorkspace()">\u9009\u62E9\u6587\u4EF6\u5939</button>`,
      `</div>`
    ].join("");
    return;
  }
  container.style.cssText = "display:flex;flex-direction:column;height:100%;min-height:0";
  const showAll = !ExplorerService.getFilterEnabled();
  container.innerHTML = [
    `<div class="sg-t" style="display:flex;align-items:center;justify-content:space-between">\u8D44\u6E90\u7BA1\u7406\u5668<button class="sg-more" onclick="toggleExplorerFilter()" title="\u663E\u793A\u9009\u9879">\xB7\xB7\xB7</button></div>`,
    `<div id="exp-tree-cont" style="flex:1;min-height:0"></div>`
  ].join("");
  container.addEventListener("contextmenu", (e) => e.preventDefault());
  const treeContainer = document.getElementById("exp-tree-cont");
  if (!treeContainer) return;
  initTree(treeContainer);
}
function getTree() {
  return ExplorerService._getTree();
}
function ws() {
  return ExplorerService.getWorkspacePath();
}
async function doNewFile(parentId, name) {
  try {
    const relPath = parentId ? parentId + "/" + name : name;
    await ExplorerService.fileOp("new", ws(), relPath);
    ExplorerService.refreshTree();
    toast("\u5DF2\u521B\u5EFA: " + name, "success");
  } catch (e) {
    toast("\u521B\u5EFA\u5931\u8D25: " + (e.message || e), "error");
  }
}
async function doNewFolder(parentId, name) {
  try {
    const relPath = (parentId ? parentId + "/" : "") + name + "/";
    await ExplorerService.fileOp("new", ws(), relPath);
    ExplorerService.refreshTree();
    toast("\u5DF2\u521B\u5EFA: " + name, "success");
  } catch (e) {
    toast("\u521B\u5EFA\u5931\u8D25: " + (e.message || e), "error");
  }
}
function initTree(container) {
  const tree = new Tree(container, { indent: 14 });
  ExplorerService._setTree(tree);
  tree.onExpand = async (node, cb) => {
    try {
      const d = await ExplorerService.fetchDir(ws(), node.id);
      cb(ExplorerService.toTreeNodes(d.items));
    } catch (e) {
      const msg = e.message || "\u52A0\u8F7D\u5931\u8D25";
      if (msg.includes("Access denied") || msg.includes("403")) toast("\u65E0\u6743\u9650\u8BBF\u95EE: " + node.id, "error");
      else if (msg.includes("not found") || msg.includes("404")) toast("\u8DEF\u5F84\u4E0D\u5B58\u5728: " + node.id, "error");
      else if (msg.includes("timeout") || msg.includes("TIMEOUT")) toast("\u52A0\u8F7D\u8D85\u65F6: " + node.id, "error");
      else toast("\u52A0\u8F7D\u5931\u8D25: " + msg, "error");
      cb([]);
    }
  };
  tree.contextMenu = [
    {
      label: "\u590D\u5236\u8DEF\u5F84",
      action: (n) => {
        navigator.clipboard.writeText(n.id).then(() => toast("\u5DF2\u590D\u5236\u8DEF\u5F84")).catch(() => toast("\u590D\u5236\u5931\u8D25", "error"));
      }
    },
    {
      label: "\u6253\u5F00\u6240\u5728\u4F4D\u7F6E",
      action: async (n) => {
        const api = window.electronAPI;
        if (!api?.showItemInFolder) {
          toast("\u4EC5\u5728\u684C\u9762\u7248\u53EF\u7528", "error");
          return;
        }
        try {
          await api.showItemInFolder(ws().replace(/\\/g, "/") + "/" + n.id);
        } catch {
          toast("\u6253\u5F00\u5931\u8D25", "error");
        }
      }
    },
    { label: "-", action: () => {
    } },
    // separator
    {
      label: "\u65B0\u5EFA\u6587\u4EF6",
      action: (n) => {
        if (n.isDir) tree.inlineCreate(n.id, false, (name) => doNewFile(n.id, name));
      },
      disabled: (n) => !n.isDir
    },
    {
      label: "\u65B0\u5EFA\u6587\u4EF6\u5939",
      action: (n) => {
        if (n.isDir) tree.inlineCreate(n.id, true, (name) => doNewFolder(n.id, name));
      },
      disabled: (n) => !n.isDir
    },
    {
      label: "\u91CD\u547D\u540D",
      action: (n) => {
        const parent = n.id.includes("/") ? n.id.slice(0, n.id.lastIndexOf("/")) : "";
        tree.inlineRename(n.id, async (newName) => {
          try {
            await ExplorerService.fileOp("rename", ws(), n.id, parent ? parent + "/" + newName : newName);
            ExplorerService.refreshTree();
            toast("\u5DF2\u91CD\u547D\u540D", "success");
          } catch (e) {
            toast("\u91CD\u547D\u540D\u5931\u8D25: " + (e.message || e), "error");
          }
        });
      }
    },
    {
      label: "\u5220\u9664",
      action: async (n) => {
        const api = window.electronAPI;
        try {
          if (api?.trashItem) {
            await api.trashItem(ws() + "\\" + n.id);
          } else {
            await ExplorerService.fileOp("delete", ws(), n.id);
          }
          ExplorerService.refreshTree();
          toast("\u5DF2\u5220\u9664", "success");
        } catch (e) {
          toast("\u5220\u9664\u5931\u8D25: " + (e.message || e), "error");
        }
      }
    }
  ];
  tree.blankContextMenu = [
    { label: "\u65B0\u5EFA\u6587\u4EF6", action: () => tree.inlineCreate("", false, (name) => doNewFile("", name)) },
    { label: "\u65B0\u5EFA\u6587\u4EF6\u5939", action: () => tree.inlineCreate("", true, (name) => doNewFolder("", name)) }
  ];
  tree.onDragMove = async (srcId, dstId) => {
    const name = srcId.split("/").pop() || "";
    const newPath = dstId ? dstId + "/" + name : name;
    try {
      await ExplorerService.fileOp("move", ws(), srcId, newPath);
      const tr = ExplorerService._getTree();
      if (tr) {
        const srcParent = srcId.includes("/") ? srcId.slice(0, srcId.lastIndexOf("/")) : "";
        const dstParent = dstId || "";
        if (srcParent) tr._childCache?.delete(srcParent);
        if (dstParent && dstParent !== srcParent) tr._childCache?.delete(dstParent);
        const d = await ExplorerService.fetchDir(ws(), "");
        tr.setData(ExplorerService.toTreeNodes(d.items));
        for (const pid of [srcParent, dstParent].filter(Boolean)) {
          tr._expanded?.add(pid);
          tr._onExpand?.(tr._findNodeById(pid), (children) => {
            tr._childCache?.set(pid, children || []);
            if (tr._expanded?.has(pid)) tr.render();
          });
        }
      }
      toast("\u5DF2\u79FB\u52A8", "success");
    } catch (e) {
      toast("\u79FB\u52A8\u5931\u8D25: " + (e.message || e), "error");
    }
  };
  tree.onSelect = async (node) => {
    console.log("[explorer] onSelect:", node.id, node.isDir);
    if (!ws()) {
      console.log("[explorer] no workspace");
      return;
    }
    try {
      const r = await fetch(`/api/file/read?root=${encodeURIComponent(ws())}&path=${encodeURIComponent(node.id)}`);
      const d = await r.json();
      if (!r.ok) {
        toast(d.error || "\u8BFB\u53D6\u5931\u8D25", "error");
        return;
      }
      const content = d.encoding === "base64" ? "[\u4E8C\u8FDB\u5236\u6587\u4EF6\uFF0C\u65E0\u6CD5\u9884\u89C8]" : d.content;
      const lang = d.path?.split(".").pop() || "";
      console.log("[explorer] calling openFileTab:", node.id);
      openFileTab(node.id, content, lang);
    } catch (e) {
      console.error("[explorer] read failed:", e);
      toast("\u8BFB\u53D6\u5931\u8D25: " + (e.message || e), "error");
    }
  };
  ExplorerService.fetchDir(ws(), "").then((d) => tree.setData(ExplorerService.toTreeNodes(d.items))).catch((e) => {
    const msg = e?.message || "";
    if (msg.includes("Access denied") || msg.includes("403")) container.innerHTML += '<div class="sg-item dim" style="color:var(--rs)">\u65E0\u6743\u9650\u8BBF\u95EE\u5DE5\u4F5C\u533A</div>';
    else if (msg.includes("not found") || msg.includes("404")) container.innerHTML += '<div class="sg-item dim">\u5DE5\u4F5C\u533A\u8DEF\u5F84\u4E0D\u5B58\u5728</div>';
    else container.innerHTML += '<div class="sg-item dim">\u52A0\u8F7D\u5931\u8D25</div>';
  });
}
function toggleExplorerFilter() {
  document.querySelectorAll(".ctx-menu").forEach((el) => el.remove());
  const btn = document.querySelector(".sg-more");
  if (!btn) return;
  const rect = btn.getBoundingClientRect();
  const on = ExplorerService.getFilterEnabled();
  const menu = document.createElement("div");
  menu.className = "ctx-menu";
  menu.style.position = "fixed";
  menu.style.left = rect.right + 4 + "px";
  menu.style.top = rect.bottom + 8 + "px";
  const items = [
    { label: "\u663E\u793A\u88AB\u8FC7\u6EE4\u7684\u6587\u4EF6", checked: !on, fn: () => {
      ExplorerService.setFilterEnabled(false);
      ExplorerService.refreshTree();
    } },
    { label: "\u9690\u85CF\u88AB\u8FC7\u6EE4\u7684\u6587\u4EF6", checked: on, fn: () => {
      ExplorerService.setFilterEnabled(true);
      ExplorerService.refreshTree();
    } }
  ];
  for (const a of items) {
    const item = document.createElement("div");
    item.className = "ctx-item";
    item.style.display = "flex";
    item.style.alignItems = "center";
    item.style.gap = "8px";
    item.innerHTML = `<span style="width:14px;text-align:center;flex-shrink:0">${a.checked ? "\u2713" : ""}</span><span>${a.label}</span>`;
    item.onclick = () => {
      menu.remove();
      a.fn();
    };
    menu.appendChild(item);
  }
  document.body.appendChild(menu);
  setTimeout(() => document.addEventListener("click", () => menu.remove(), { once: true }), 0);
}
window.toggleExplorerFilter = toggleExplorerFilter;
registerPane("explorer", explorerRender);
