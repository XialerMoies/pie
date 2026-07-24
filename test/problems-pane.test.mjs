import { describe, it, beforeEach } from "node:test";
import assert from "node:assert";
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
    const ts = Date.now() + Math.random();
    await import(`../src/frontend/pane/problems/index.ts?t=${ts}`);
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
});