import { describe, it, before, beforeEach, after } from "node:test";
import assert from "node:assert";
import { Window } from "happy-dom";

const win = new Window();
const doc = win.document;

global.window = win;
global.document = doc;
global.self = win;
global.localStorage = win.localStorage;
global.$ = (id) => doc.getElementById(id);
global.E = (value) => String(value ?? "")
  .replaceAll("&", "&amp;")
  .replaceAll("<", "&lt;")
  .replaceAll(">", "&gt;")
  .replaceAll('"', "&quot;")
  .replaceAll("'", "&#39;");
global.toast = () => {};

const registerCalls = [];
global.registerPane = (name, render) => registerCalls.push([name, render]);

const maliciousPath = `src/quote'\"<img src=x onerror=alert(1)>.ts`;
const requests = [];
let openedFile = null;

win.App = {
  State: { getWorkspacePath: () => "E:/my-code-agent" },
  Git: {},
};
global.App = win.App;
win.ExplorerService = { iconFor: () => "<svg></svg>" };
global.openFileTab = (filePath, content, lang) => {
  openedFile = { filePath, content, lang };
};

global.fetch = async (url, options = {}) => {
  requests.push({ url: String(url), options });
  if (String(url).startsWith("/api/git/status")) {
    return {
      ok: true,
      json: async () => ({
        gitRoot: "E:/my-code-agent",
        branch: "main",
        entries: [{ x: " ", y: "M", path: maliciousPath }],
        total: 1,
        modified: 1,
        added: 0,
        deleted: 0,
      }),
    };
  }
  if (String(url).startsWith("/api/git/log")) {
    return { ok: true, json: async () => ({ gitRoot: "E:/my-code-agent", entries: [] }) };
  }
  if (String(url).startsWith("/api/file/read")) {
    return { ok: true, json: async () => ({ content: "source", encoding: "utf-8" }) };
  }
  if (String(url).startsWith("/api/git/")) {
    return { ok: true, json: async () => ({ ok: false, message: "test response" }) };
  }
  throw new Error(`unexpected fetch: ${url}`);
};
win.fetch = global.fetch;

async function waitFor(selector) {
  for (let attempt = 0; attempt < 20; attempt++) {
    const found = doc.querySelector(selector);
    if (found) return found;
    await new Promise(resolve => setTimeout(resolve, 0));
  }
  return null;
}

before(async () => {
  await import(`../src/frontend/pane/git/index.ts?t=${Date.now()}`);
});

beforeEach(() => {
  doc.body.innerHTML = "";
  requests.length = 0;
  openedFile = null;
});

after(() => {
  delete global.openFileTab;
});

describe("git pane", () => {
  it("uses delegated actions and preserves untrusted file paths as data", async () => {
    const container = doc.createElement("div");
    doc.body.appendChild(container);
    registerCalls[0][1](container);

    const file = await waitFor(".git-file");
    assert.ok(file, container.innerHTML);
    assert.strictEqual(container.querySelectorAll("[onclick], [onchange], [oninput]").length, 0);
    assert.strictEqual(container.querySelector("img"), null, "path must remain text, not executable markup");

    file.click();
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.deepStrictEqual(openedFile, {
      filePath: maliciousPath,
      content: "source",
      lang: "ts",
    });

    const input = container.querySelector("#git-commit-msg");
    input.value = `fix quote'\" safely`;
    container.querySelector("[data-git-action='commit']")?.click();
    container.querySelector("[data-git-action='push']")?.click();
    container.querySelector("[data-git-action='pull']")?.click();
    container.querySelector("[data-git-action='refresh']")?.click();
    await new Promise(resolve => setTimeout(resolve, 0));

    const commitRequest = requests.find(request => request.url === "/api/git/commit");
    assert.ok(commitRequest, "commit action should issue a request");
    assert.deepStrictEqual(JSON.parse(commitRequest.options.body), {
      root: "E:/my-code-agent",
      message: `fix quote'\" safely`,
    });
    assert.ok(requests.some(request => request.url === "/api/git/push"));
    assert.ok(requests.some(request => request.url === "/api/git/pull"));
    assert.ok(requests.filter(request => request.url.startsWith("/api/git/status")).length >= 2);
  });
});
