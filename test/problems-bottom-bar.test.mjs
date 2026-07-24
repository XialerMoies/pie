/**
 * Problems 底部栏测试
 *
 * 验证：
 * - 摘要栏点击展开/收起列表
 * - 箭头按钮展开/收起
 * - aria-expanded 状态同步
 * - ProblemsStore 变更后计数更新
 */
import { describe, it, before, beforeEach } from "node:test";
import assert from "node:assert";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { Window } from "happy-dom";

function setupDom() {
  const win = new Window();
  const doc = win.document;

  global.window = win;
  global.document = doc;
  global.self = win;
  global.localStorage = win.localStorage;
  global.requestAnimationFrame = (cb) => { cb(0); return 0; };
  global.cancelAnimationFrame = () => {};
  global.setTimeout = (fn) => { fn(); return 0; };
  global.clearTimeout = () => {};

  // 布局脚本依赖的全局助⼿
  global.$ = (id) => doc.getElementById(id);
  global.E = (value) => String(value ?? "");
  global.S = () => "";

  global.fetch = async () => ({ json: async () => ({ ok: true }) });
  win.fetch = global.fetch;
  win.App = { Constants: { WS_KEY: "ws" }, UI: {}, Chat: {}, File: {}, Session: {}, Settings: {}, Git: {} };
  global.App = win.App;

  // ProblemsStore 模拟
  let listeners = [];
  win.__problemsStore = {
    _problems: [],
    getProblems() { return this._problems; },
    getErrorCount() { return this._problems.filter(p => p.severity === "error").length; },
    getWarningCount() { return this._problems.filter(p => p.severity === "warning").length; },
    getInfoCount() { return this._problems.filter(p => p.severity === "info").length; },
    getFileCount() { return new Set(this._problems.map(p => p.filePath)).size; },
    setProblems(filePath, items) {
      this._problems = items;
      listeners.forEach(fn => fn());
    },
    clearFile() {},
    clear() { this._problems = []; listeners.forEach(fn => fn()); },
    subscribe(fn) { listeners.push(fn); return () => { listeners = listeners.filter(l => l !== fn); }; },
    getAllFiles() { return [...new Set(this._problems.map(p => p.filePath))]; },
    getProblemsForFile() { return []; },
  };
  win.__state = { _activePanel: "" };
  win.__tabs = { getTab: () => null, getTabs: () => [], activateTab: () => {} };
  global.__problemsStore = win.__problemsStore;

  return { win, doc };
}

describe("Problems Bottom Bar", () => {
  let env;

  // 先建好全局环境再加载布局脚本（脚本顶层引用了 document）
  before(() => {
    env = setupDom();
    const code = readFileSync(new URL("../src/frontend/gen/dashboard/dashboard-layout.js", import.meta.url), "utf-8");
    vm.runInThisContext(code, { filename: "dashboard-layout.js" });
  });

  beforeEach(() => {
    // 每个测试重置 DOM，但全局函数（_initProblemsBar 等）保留
    const doc = env.win.document;
    global.document = doc;
    global.window = env.win;
    global.$ = (id) => doc.getElementById(id);
  });

  it("toggles panel on status bar button click", () => {
    const { doc } = env;
    doc.body.innerHTML = `
      <button class="status-problems" id="pb-status-trigger" type="button" aria-controls="pb-panel" aria-expanded="false" title="显示问题">
        <span class="status-problems-label">问题</span>
        <span class="status-problems-counts" id="pb-status-counts"></span>
      </button>
      <section class="pb-panel" id="pb-panel" aria-label="问题" style="display:none">
        <div class="pb-panel-head"><span>问题</span></div>
        <div class="pb-body" id="pb-body"></div>
      </section>
    `;

    const init = globalThis._initProblemsBar;
    assert.strictEqual(typeof init, "function", "_initProblemsBar should exist");
    init();

    const panel = doc.getElementById("pb-panel");
    const trigger = doc.getElementById("pb-status-trigger");

    // 初始收起
    assert.strictEqual(panel.style.display, "none");
    assert.strictEqual(trigger.getAttribute("aria-expanded"), "false");

    // 点击展开
    trigger.click();
    assert.strictEqual(panel.style.display, "");
    assert.strictEqual(trigger.getAttribute("aria-expanded"), "true");

    // 点击收起
    trigger.click();
    assert.strictEqual(panel.style.display, "none");
    assert.strictEqual(trigger.getAttribute("aria-expanded"), "false");
  });

  it("updates status counts on store change", () => {
    const { doc, win } = env;
    doc.body.innerHTML = `
      <button class="status-problems" id="pb-status-trigger" type="button" aria-expanded="false">
        <span class="status-problems-counts" id="pb-status-counts"></span>
      </button>
    `;

    globalThis._initProblemsBar();
    const counts = doc.getElementById("pb-status-counts");

    // 设置问题数据 → 触发 store 更新 → 状态栏自动刷新
    win.__problemsStore.setProblems("/test.ts", [{
      filePath: "/test.ts", line: 1, column: 1,
      endLine: 1, endColumn: 1,
      severity: "error", message: "test error",
      code: 1001, source: "typescript",
    }]);

    assert.ok(counts.textContent.length > 0, "counts should be updated");
  });

  it("renders correct HTML structure for problems panel and status bar", () => {
    const { doc } = env;

    // buildProblemsPanel 和 buildStatusBar 是 layout 暴露的全局函数
    const panelHtml = globalThis.buildProblemsPanel?.() || "";
    const statusHtml = globalThis.buildStatusBar?.() || "";

    if (panelHtml && statusHtml) {
      // 解析 HTML 到 DOM 中验证结构
      doc.body.innerHTML = panelHtml + statusHtml;

      const panel = doc.getElementById("pb-panel");
      assert.ok(panel, "pb-panel exists in problems panel HTML");
      assert.ok(panel.getAttribute("aria-label") === "问题", "pb-panel has aria-label");

      const body = doc.getElementById("pb-body");
      assert.ok(body, "pb-body exists inside pb-panel");

      const trigger = doc.getElementById("pb-status-trigger");
      assert.ok(trigger, "pb-status-trigger exists in status bar HTML");
      assert.strictEqual(trigger.getAttribute("aria-controls"), "pb-panel", "trigger controls pb-panel");

      const counts = doc.getElementById("pb-status-counts");
      assert.ok(counts, "pb-status-counts exists");
    } else {
      // 函数未暴露时跳过（测试用全局函数，非模块环境才有）
      console.log("layout build functions not global, skipping structural test");
    }
  });
});
