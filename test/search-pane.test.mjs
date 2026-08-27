import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { Window } from "happy-dom";

const win = new Window();
const doc = win.document;

global.window = win;
global.document = doc;
global.self = win;
global.localStorage = win.localStorage;
global.requestAnimationFrame = (cb) => { cb(0); return 0; };
global.cancelAnimationFrame = () => {};
global.setTimeout = setTimeout;
global.clearTimeout = clearTimeout;

global.$ = (id) => doc.getElementById(id);
global.E = (value) => String(value ?? "")
  .replaceAll("&", "&amp;")
  .replaceAll("<", "&lt;")
  .replaceAll(">", "&gt;")
  .replaceAll('"', "&quot;")
  .replaceAll("'", "&#39;");
global.S = (name, size = 16) => `<svg width="${size}" height="${size}" viewBox="0 0 24 24"><use href="#${name}"/></svg>`;

global.toast = () => {};
global.confirmAsync = async () => true;

global.ExplorerService = { iconFor: () => "<svg></svg>" };
win.ExplorerService = global.ExplorerService;

const registerCalls = [];
global.registerPane = (name, render) => {
  registerCalls.push([name, render]);
};

const searchCounts = { file: 0, text: 0, case: 0, fallback: 0 };

win.App = {
  Constants: { WS_KEY: "workspace_path" },
  State: {
    getWorkspacePath: () => win.localStorage.getItem("workspace_path") || "",
    setWorkspacePath: (path) => win.localStorage.setItem("workspace_path", path),
  },
  UI: {},
  File: {},
  Settings: {
    setSearchType(type) {
      searchCounts[type === "text" ? "text" : "file"] += 1;
    },
    toggleCaseSensitive() {
      searchCounts.case += 1;
    },
  },
  Chat: {},
  Tabs: {},
  Session: {},
  Git: {},
};
global.App = win.App;

global.setSearchType = () => { searchCounts.fallback += 1; };
global.toggleCaseSensitive = () => { searchCounts.fallback += 1; };

let openFileArg = null;
win.App.UI.openFileTab = (filePath, content, lang) => {
  openFileArg = { filePath, content, lang };
  win.__currentFile = filePath;
};

win.__monaco = {
  isReady: () => true,
  getCurrentFile: () => win.__currentFile,
  revealPosition: (line, col) => {
    win.__revealed = { line, col };
  },
};

let searchResponse = { results: [], total: 0, truncated: false };
global.fetch = async (url) => {
  if (String(url).startsWith("/api/file/read")) {
    return { ok: true, json: async () => ({ content: "one\ntwo\nthree", encoding: "utf-8" }) };
  }
  if (String(url).startsWith("/api/search?")) {
    return { ok: true, json: async () => searchResponse };
  }
  throw new Error(`unexpected fetch: ${url}`);
};
win.fetch = global.fetch;

before(async () => {
  const ts = Date.now();
  await import(`../src/frontend/pane/search/index.ts?t=${ts}`);
});

after(() => {
  delete global.setSearchType;
  delete global.toggleCaseSensitive;
});

describe("search pane", () => {
  it("binds search controls without inline event attributes", () => {
    searchCounts.file = 0;
    searchCounts.text = 0;
    searchCounts.case = 0;
    searchCounts.fallback = 0;
    win.App.Settings.setSearchType = (type) => {
      searchCounts[type === "text" ? "text" : "file"] += 1;
    };
    win.App.Settings.toggleCaseSensitive = () => {
      searchCounts.case += 1;
    };
    const container = doc.createElement("div");
    doc.body.appendChild(container);
    registerCalls[0][1](container);

    const fileBtn = container.querySelector("#search-type-file");
    const textBtn = container.querySelector("#search-type-text");
    const caseBtn = container.querySelector("#search-case");
    assert.ok(fileBtn);
    assert.ok(textBtn);
    assert.ok(caseBtn);

    assert.strictEqual(container.querySelectorAll("[onclick], [onchange], [oninput]").length, 0);

    textBtn.click();
    caseBtn.click();
    assert.strictEqual(searchCounts.text, 1, "App.Settings.setSearchType should be called once");
    assert.strictEqual(searchCounts.case, 1, "App.Settings.toggleCaseSensitive should be called once");
    container.remove();
  });

  it("opens a quote-containing result path through delegated click handling", async () => {
    const maliciousPath = `src/quote'\"<img src=x onerror=alert(1)>.ts`;
    searchResponse = {
      results: [{ file: maliciousPath, absolutePath: `E:/my-code-agent/${maliciousPath}`, matches: [] }],
      total: 1,
      truncated: false,
    };
    win.localStorage.setItem("workspace_path", "E:/my-code-agent");
    openFileArg = null;

    const container = doc.createElement("div");
    doc.body.appendChild(container);
    registerCalls[0][1](container);
    const input = container.querySelector("#search-input");
    input.value = "quote";
    input.dispatchEvent(new win.Event("input", { bubbles: true }));
    input.dispatchEvent(new win.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await new Promise(resolve => setTimeout(resolve, 350));

    const result = container.querySelector(".search-file-name");
    assert.ok(result, container.innerHTML);
    assert.strictEqual(result.getAttribute("onclick"), null);
    result.click();
    await new Promise(resolve => setTimeout(resolve, 0));

    assert.strictEqual(openFileArg?.filePath, maliciousPath);
    assert.strictEqual(container.querySelector("img"), null, "path must remain text, not executable markup");
    container.remove();
  });

  it("opens search result and reveals the requested line", async () => {
    win.localStorage.setItem("workspace_path", "E:/my-code-agent");
    win.__currentFile = null;
    win.__revealed = null;
    openFileArg = null;

    await win.App.File.openSearchResult("demo.txt", 2);

    assert.deepStrictEqual(openFileArg, {
      filePath: "demo.txt",
      content: "one\ntwo\nthree",
      lang: "txt",
    });
    assert.deepStrictEqual(win.__revealed, { line: 2, col: 1 });
  });
});
