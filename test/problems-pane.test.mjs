import { describe, it, beforeEach } from "node:test";
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
  global.E = (value) => String(value ?? "");

  doc.body.innerHTML = '<div id="pc"></div>';

  const fetchCalls = [];
  const refreshCalls = [];
  const toastCalls = [];

  global.fetch = async (url, init = {}) => {
    fetchCalls.push([url, init]);
    if (url === "/api/ts/code-actions") {
      return {
        json: async () => ({
          actions: [
            {
              description: "fix it",
              changes: [
                {
                  fileName: "/test.ts",
                  textChanges: [
                    {
                      span: { start: { line: 1, offset: 1 }, end: { line: 1, offset: 1 } },
                      newText: "const fixed = true;\n",
                    },
                  ],
                },
              ],
            },
          ],
        }),
      };
    }
    if (url === "/api/ts/apply-code-action") {
      return { json: async () => ({ ok: true, files: ["/test.ts"] }) };
    }
    return { json: async () => ({ ok: true }) };
  };
  win.fetch = global.fetch;

  win.App = {
    Constants: { WS_KEY: "workspace_path" },
    UI: { toast: (message, type) => toastCalls.push([message, type]) },
    Chat: {},
    File: {},
    Session: {},
    Settings: {},
    Git: {},
  };
  global.App = win.App;
  win.toast = (message, type) => toastCalls.push([message, type]);

  win.__state = { _activePanel: "problems" };
  win.__monaco = {
    getCurrentFile: () => "/test.ts",
    isReady: () => true,
    revealPosition: () => {},
    refreshDiagnosticsForFile: async (filePath) => { refreshCalls.push(filePath); },
  };
  win.__problemsStore = {
    getProblems: () => ([{
      filePath: "/test.ts",
      line: 4,
      column: 2,
      endLine: 4,
      endColumn: 8,
      severity: "error",
      message: "Missing semicolon",
      code: 1001,
      source: "typescript",
      fixCount: 0,
    }]),
    getProblemsForFile: () => [],
    setProblems: () => {},
    clearFile: () => {},
    clear: () => {},
    subscribe: () => () => {},
    getErrorCount: () => 1,
    getWarningCount: () => 0,
    getInfoCount: () => 0,
    getFileCount: () => 1,
    getAllFiles: () => ["/test.ts"],
  };

  localStorage.setItem("workspace_path", "E:\\my-code-agent");

  const panes = {};
  global.registerPane = (name, render) => { panes[name] = render; };

  global.$ = (id) => doc.getElementById(id);

  return { win, doc, fetchCalls, refreshCalls, toastCalls, panes };
}

describe("Problems Pane", () => {
  let env;

  beforeEach(async () => {
    env = setupDom();
    // 使用编译产物（避免 tsx 动态编译源文件时的差异）
    await import(`../src/frontend/gen/pane/problems/index.js?t=${Date.now() + Math.random()}`);
  });

  it("renders workspace filter and quick-fix action", async () => {
    const render = env.panes.problems;
    assert.strictEqual(typeof render, "function");

    const container = env.doc.getElementById("pc");
    render(container);

    assert.match(container.textContent, /工作区/);
    const fixButton = container.querySelector(".pf-act[data-fix='1']");
    assert.ok(fixButton);

    fixButton.dispatchEvent(new env.win.MouseEvent("click", { bubbles: true, cancelable: true }));

    await new Promise((resolve) => setImmediate(resolve));

    assert.ok(env.fetchCalls.some(([url]) => url === "/api/ts/code-actions"));
    assert.ok(env.fetchCalls.some(([url]) => url === "/api/ts/apply-code-action"));
    assert.deepStrictEqual(env.refreshCalls, ["/test.ts"]);
    assert.ok(env.toastCalls.some(([message, type]) => message === "已应用修复" && type === "success"));
  });

  it("bottom bar toggles expand/collapse on summary click", async () => {
    const { doc } = env;
    const win = env.win;

    // 设置底部栏 DOM
    doc.body.innerHTML = `
      <div id="pb-bar">
        <div class="pb-summary" id="pb-summary">
          <span id="pb-summary-text">问题</span>
          <span id="pb-counts"></span>
          <button class="pb-toggle" id="pb-toggle">▴</button>
        </div>
        <div class="pb-body" id="pb-body" style="display:none"></div>
      </div>
    `;

    // 补充 ProblemsStore 用于渲染
    win.__problemsStore.getProblems = () => [{
      filePath: "/test.ts", line: 1, column: 1,
      endLine: 1, endColumn: 1,
      severity: "error", message: "test error",
      code: 1001, source: "typescript",
    }];

    // 加载布局模块获取真实的 _initProblemsBar / _pbToggle
    // 使用 vm.runInThisContext 在全局作用域执行脚本
    const layoutPath = new URL("../src/frontend/gen/dashboard/dashboard-layout.js", import.meta.url);
    const layoutCode = readFileSync(layoutPath, "utf-8");
    vm.runInThisContext(layoutCode, { filename: "dashboard-layout.js" });

    const initFn = globalThis._initProblemsBar;
    assert.strictEqual(typeof initFn, "function", "_initProblemsBar should be a global function");

    // 调用真实初始化逻辑绑定事件
    initFn();

    const summary = doc.getElementById("pb-summary");
    const body = doc.getElementById("pb-body");
    const toggle = doc.getElementById("pb-toggle");

    // 初始状态：收起
    assert.strictEqual(body.style.display, "none");

    // 点击摘要栏展开
    summary.dispatchEvent(new win.MouseEvent("click", { bubbles: true }));
    assert.strictEqual(body.style.display, "");

    // 再次点击收起
    summary.dispatchEvent(new win.MouseEvent("click", { bubbles: true }));
    assert.strictEqual(body.style.display, "none");

    // 点击箭头按钮展开
    toggle.dispatchEvent(new win.MouseEvent("click", { bubbles: true }));
    assert.strictEqual(body.style.display, "");

    // 重新初始化（模拟 layout() 重建 DOM）后保持展开状态
    body.style.display = "none";
    summary.setAttribute("aria-expanded", "false");
    toggle.textContent = "▴";
    initFn();
    assert.strictEqual(body.style.display, "");
    assert.strictEqual(summary.getAttribute("aria-expanded"), "true");
    assert.strictEqual(toggle.textContent, "▾");
  });
});