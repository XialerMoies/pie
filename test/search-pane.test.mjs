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
global.E = (value) => String(value ?? "");
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
global.openFileTab = (filePath, content, lang) => {
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

global.fetch = async (url) => {
  if (String(url).startsWith("/api/file/read")) {
    return { ok: true, json: async () => ({ content: "one\ntwo\nthree", encoding: "utf-8" }) };
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
  delete global.openFileTab;
});

describe("search pane", () => {
  it("does not double-call App.Settings fallbacks for search mode buttons", () => {
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

    const runHandler = (button) => new Function(
      "App",
      "setSearchType",
      "toggleCaseSensitive",
      `return (${button.getAttribute("onclick")});`
    );
    runHandler(textBtn)(win.App, global.setSearchType, global.toggleCaseSensitive);
    runHandler(caseBtn)(win.App, global.setSearchType, global.toggleCaseSensitive);
    assert.strictEqual(searchCounts.text, 1, "App.Settings.setSearchType should be called once");
    assert.strictEqual(searchCounts.case, 1, "App.Settings.toggleCaseSensitive should be called once");
    assert.strictEqual(searchCounts.fallback, 0, "local fallback should not run when App.Settings exists");
    container.remove();
  });

  it("opens search result and reveals the requested line", async () => {
    win.localStorage.setItem("workspace_path", "E:/my-code-agent");
    win.__currentFile = null;
    win.__revealed = null;
    openFileArg = null;

    await win.openSearchResult("demo.txt", 2);

    assert.deepStrictEqual(openFileArg, {
      filePath: "demo.txt",
      content: "one\ntwo\nthree",
      lang: "txt",
    });
    assert.deepStrictEqual(win.__revealed, { line: 2, col: 1 });
  });
});
