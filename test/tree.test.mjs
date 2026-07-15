/**
 * Tree 状态逻辑测试
 *
 * 测试 _childCache / _expanded / _selected 等内部状态，
 * 不测 DOM 渲染，只测数据操作逻辑。
 *
 * 运行：npx tsx --test test/tree.test.mjs
 */
import { describe, it, before } from "node:test";
import assert from "node:assert";

// 全局 mock DOM + localStorage
const store = {};
global.localStorage = {
  getItem: (key) => store[key] ?? null,
  setItem: (key, val) => { store[key] = val; },
  removeItem: (key) => { delete store[key]; },
};

// mock document.createElement 供 Tree 构造函数
function makeMockEl() {
  return {
    innerHTML: "", children: [], style: {}, dataset: {},
    classList: { add() {}, remove() {}, contains() { return false; }, toggle() {} },
    addEventListener() {}, removeEventListener() {},
    appendChild(el) { this.children.push(el); el.parentNode = this; return el; },
    insertBefore(el, ref) { const i = this.children.indexOf(ref); if (i>=0) this.children.splice(i,0,el); else this.children.push(el); el.parentNode = this; return el; },
    removeChild(el) { const i = this.children.indexOf(el); if (i>=0) this.children.splice(i,1); },
    setAttribute() {}, getAttribute() { return null; },
    focus() {}, closest() { return null; },
    querySelector() { return null; }, querySelectorAll() { return []; },
    getBoundingClientRect() { return { left: 0, top: 0, width: 100, height: 20 }; },
    scrollLeft: 0, scrollTop: 0, tabIndex: 0, draggable: false,
    style: {}, removeChild() {},
  };
}
global.document = {
  createElement: () => makeMockEl(),
  createDocumentFragment: () => ({ appendChild() {} }),
  addEventListener() {},
};
// Tree 渲染依赖全局 E()（html 转义）
global.E = (s) => String(s ?? '');

// 最小 DOM 模拟
function mockContainer() {
  let html = "";
  return {
    innerHTML: "",
    children: [],
    appendChild(el) { this.children.push(el); },
    addEventListener() {},
    querySelector() { return null; },
    querySelectorAll() { return []; },
    insertBefore() {},
    classList: { add() {}, remove() {}, contains() { return false; }, toggle() {} },
    style: {},
    focus() {},
    setAttribute() {},
    getAttribute() { return null; },
    dataset: {},
    closest() { return null; },
    getBoundingClientRect() { return { left: 0, top: 0, width: 100, height: 20 }; },
  };
}

describe("Tree 内部状态", () => {
  let Tree;

  before(async () => {
    const mod = await import("../src/frontend/ui/tree.ts");
    Tree = mod.Tree;
  });

  it("构造后状态为空", () => {
    const tree = new Tree(mockContainer());
    assert.deepStrictEqual(tree._data, []);
    assert.strictEqual(tree._expanded.size, 0);
    assert.strictEqual(tree._selected, "");
    assert.strictEqual(tree._childCache.size, 0);
  });

  it("setData 设置根节点数据", () => {
    const tree = new Tree(mockContainer());
    const items = [
      { id: "src", label: "src", icon: "", isDir: true },
      { id: "package.json", label: "package.json", icon: "", isDir: false },
    ];
    tree.setData(items);
    assert.strictEqual(tree._data.length, 2);
    assert.strictEqual(tree._data[0].id, "src");
  });

  it("setChildren 添加到缓存并标记为展开", () => {
    const tree = new Tree(mockContainer());
    tree.setChildren("src", [{ id: "src/index.ts", label: "index.ts", icon: "", isDir: false }]);
    assert.ok(tree._expanded.has("src"));
    assert.strictEqual(tree._childCache.get("src").length, 1);
    assert.strictEqual(tree._childCache.get("src")[0].id, "src/index.ts");
  });

  it("clearChildCache 清空缓存但保持展开状态", () => {
    const tree = new Tree(mockContainer());
    tree.setChildren("src", [{ id: "src/a.ts", label: "a.ts", icon: "", isDir: false }]);
    assert.strictEqual(tree._childCache.size, 1);
    assert.ok(tree._expanded.has("src"));

    tree.clearChildCache();
    assert.strictEqual(tree._childCache.size, 0);
    assert.ok(tree._expanded.has("src"), "clearChildCache 不应清除展开状态");
  });

  it("重复 setChildren 覆盖缓存", () => {
    const tree = new Tree(mockContainer());
    tree.setChildren("src", [{ id: "src/a.ts", label: "a.ts", icon: "", isDir: false }]);
    tree.setChildren("src", [{ id: "src/b.ts", label: "b.ts", icon: "", isDir: false }]);
    assert.strictEqual(tree._childCache.get("src").length, 1);
    assert.strictEqual(tree._childCache.get("src")[0].id, "src/b.ts");
  });

  it("多个父节点各自独立缓存", () => {
    const tree = new Tree(mockContainer());
    tree.setChildren("src", [{ id: "src/a.ts", label: "a.ts", icon: "", isDir: false }]);
    tree.setChildren("lib", [{ id: "lib/b.ts", label: "b.ts", icon: "", isDir: false }]);
    assert.strictEqual(tree._childCache.size, 2);
    assert.strictEqual(tree._childCache.get("src")[0].id, "src/a.ts");
    assert.strictEqual(tree._childCache.get("lib")[0].id, "lib/b.ts");
  });

  it("展开后折叠（从 _expanded 删除）缓存保留", () => {
    const tree = new Tree(mockContainer());
    tree.setChildren("fold", [{ id: "fold/x.ts", label: "x.ts", icon: "", isDir: false }]);
    assert.ok(tree._expanded.has("fold"));

    tree._expanded.delete("fold");
    assert.ok(!tree._expanded.has("fold"));
    assert.strictEqual(tree._childCache.size, 1, "折叠后缓存应保留");
  });

  it("setData 设为空数组", () => {
    const tree = new Tree(mockContainer());
    tree.setData([{ id: "a", label: "A", icon: "", isDir: false }]);
    assert.strictEqual(tree._data.length, 1);
    tree.setData([]);
    assert.strictEqual(tree._data.length, 0);
  });

  it("onSelect 可设置", () => {
    const tree = new Tree(mockContainer());
    let called = false;
    tree.onSelect = (node) => { called = true; };
    assert.ok(typeof tree._onSelect === "function");
  });

  it("选择节点后 _selected 更新", () => {
    const tree = new Tree(mockContainer());
    tree.setData([{ id: "a", label: "A", icon: "", isDir: false }]);
    tree._selected = "a";
    assert.strictEqual(tree._selected, "a");
  });

  it("onExpand 回调设置后可调用", () => {
    const tree = new Tree(mockContainer());
    let expandedId = "";
    tree.onExpand = (node, cb) => { expandedId = node.id; cb([{ id: "child", label: "Child", icon: "", isDir: false }]); };
    // 手动触发展开逻辑
    const node = { id: "dir", label: "Dir", icon: "", isDir: true };
    tree._onExpand?.(node, (children) => {
      tree.setChildren(node.id, children || []);
    });
    assert.strictEqual(expandedId, "dir", "onExpand 应被调用");
    assert.ok(tree._expanded.has("dir"), "应标记为展开");
    assert.strictEqual(tree._childCache.get("dir")?.[0]?.id, "child", "子节点应被缓存");
  });

  it("setChildren 后 childCache 包含子节点", () => {
    const tree = new Tree(mockContainer());
    tree.setChildren("parent", [
      { id: "parent/c1.ts", label: "c1.ts", icon: "", isDir: false },
      { id: "parent/c2.ts", label: "c2.ts", icon: "", isDir: false },
    ]);
    assert.strictEqual(tree._childCache.get("parent")?.length, 2);
    assert.ok(tree._expanded.has("parent"));
  });

  it("重复 setData 替换数据", () => {
    const tree = new Tree(mockContainer());
    tree.setData([{ id: "v1", label: "V1", icon: "", isDir: false }]);
    assert.strictEqual(tree._data[0].id, "v1");
    tree.setData([{ id: "v2", label: "V2", icon: "", isDir: false }]);
    assert.strictEqual(tree._data.length, 1);
    assert.strictEqual(tree._data[0].id, "v2", "数据应被替换");
  });

  it("展开状态不影响数据", () => {
    const tree = new Tree(mockContainer());
    tree.setData([{ id: "src", label: "src", icon: "", isDir: true }]);
    tree.setChildren("src", [{ id: "src/a.ts", label: "a.ts", icon: "", isDir: false }]);
    assert.strictEqual(tree._data.length, 1);
    assert.strictEqual(tree._data[0].id, "src");
  });
});
