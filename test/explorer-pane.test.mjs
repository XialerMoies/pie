import { describe, it, before, beforeEach } from "node:test";
import assert from "node:assert";
import { Window } from "happy-dom";

const win = new Window();
const doc = win.document;

global.window = win;
global.document = doc;
global.self = win;
global.$ = (id) => doc.getElementById(id);
global.toast = () => {};
global.mark = () => {};
win.App = { UI: { openFileTab() {} }, Tabs: {} };

let workspace = "";
let applyCount = 0;
let refreshCount = 0;
let filterEnabled = true;
const registerCalls = [];

global.ExplorerService = {
  getWorkspacePath: () => workspace,
  applyWorkspace: () => { applyCount += 1; },
  getFilterEnabled: () => filterEnabled,
  setFilterEnabled: (value) => { filterEnabled = value; },
  refreshTree: () => { refreshCount += 1; },
  fetchDir: async () => ({ items: [] }),
  reconcilePendingDeletes: (_parent, items) => items,
  toTreeNodes: (items) => items,
  _makeRefreshKey: () => "empty",
  _setTree: () => {},
  fileOp: async () => {},
};
win.ExplorerService = global.ExplorerService;

global.Tree = class {
  setData() {}
};
global.registerPane = (name, render) => registerCalls.push([name, render]);

before(async () => {
  await import(`../src/frontend/pane/explorer/explorer-views.ts?t=${Date.now()}`);
  global.App = win.App;
  await import(`../src/frontend/pane/explorer/index.ts?t=${Date.now()}`);
});

beforeEach(() => {
  doc.body.innerHTML = "";
  workspace = "";
  applyCount = 0;
  refreshCount = 0;
  filterEnabled = true;
});

describe("explorer pane actions", () => {
  it("selects a workspace without inline handlers", () => {
    const container = doc.createElement("div");
    doc.body.appendChild(container);
    registerCalls[0][1](container);

    assert.strictEqual(container.querySelectorAll("[onclick], [onchange], [oninput]").length, 0);
    container.querySelector("[data-explorer-action='select-workspace']")?.click();
    assert.strictEqual(applyCount, 1);
  });

  it("opens the filter menu through pane delegation", async () => {
    workspace = "E:/my-code-agent";
    const container = doc.createElement("div");
    doc.body.appendChild(container);
    registerCalls[0][1](container);
    await new Promise(resolve => queueMicrotask(resolve));

    assert.strictEqual(container.querySelectorAll("[onclick], [onchange], [oninput]").length, 0);
    container.querySelector("[data-explorer-action='toggle-filter']")?.click();
    const menu = doc.querySelector(".ctx-menu");
    assert.ok(menu);
    menu.querySelector(".ctx-item")?.click();
    assert.strictEqual(refreshCount, 1);
  });
});
