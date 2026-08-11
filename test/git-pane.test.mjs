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
        entries: [
          { x: " ", y: "M", path: maliciousPath },
          { x: "?", y: "?", path: "data/" },
          { x: "?", y: "?", path: "nul" },
        ],
        total: 3,
        modified: 1,
        added: 0,
        deleted: 0,
      }),
    };
  }
  if (String(url).startsWith("/api/git/log")) {
    return { ok: true, json: async () => ({ gitRoot: "E:/my-code-agent", entries: [] }) };
  }
  if (String(url).startsWith("/api/git/diff")) {
    return {
      ok: true,
      json: async () => ({
        gitRoot: "E:/my-code-agent",
        filePath: maliciousPath,
        type: "update",
        linesAdded: 2,
        linesRemoved: 1,
        structuredPatch: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 2, lines: ["-old", "+new", "+next"] }],
      }),
    };
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
  await import(`../src/frontend/services/file-diff-render.ts?t=${Date.now()}`);
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
    assert.strictEqual(openedFile, null, "selecting a change should preview its diff first");
    assert.ok(requests.some(request => request.url.startsWith("/api/git/diff")));
    assert.ok(container.querySelector(".trace-diff"), container.innerHTML);
    const activeFile = container.querySelector(".git-file.is-active");
    assert.ok(activeFile, "selected change should remain highlighted");
    assert.strictEqual(activeFile.nextElementSibling, container.querySelector(".git-diff-preview"), "diff preview should follow its selected file row");
    assert.match(container.textContent, /\+2/);
    assert.match(container.textContent, /-1/);

    const toggle = activeFile.querySelector(".git-file-disclosure");
    assert.ok(toggle, "the selected Git file row should expose a disclosure control");
    assert.strictEqual(container.querySelector(".trace-diff-toggle"), null, "the diff card should not own the disclosure control");
    assert.strictEqual(toggle.getAttribute("aria-expanded"), "true");
    assert.ok(toggle.innerHTML.includes("#itriangle-down"), "expanded diff should use the down triangle");

    toggle.click();
    const collapsedToggle = container.querySelector(".git-file.is-active .git-file-disclosure");
    assert.strictEqual(collapsedToggle?.getAttribute("aria-expanded"), "false");
    assert.ok(collapsedToggle?.innerHTML.includes("#itriangle-up"), "collapsed diff should use the up triangle");
    assert.strictEqual(container.querySelector(".git-diff-preview"), null, "collapsing should hide the complete diff preview");

    collapsedToggle.click();
    const expandedToggle = container.querySelector(".git-file.is-active .git-file-disclosure");
    assert.strictEqual(expandedToggle?.getAttribute("aria-expanded"), "true");
    assert.ok(expandedToggle?.innerHTML.includes("#itriangle-down"), "expanding should restore the down triangle");
    assert.ok(container.querySelector(".git-diff-preview"), "expanding should restore the diff preview");

    container.querySelector("[data-git-action='refresh']")?.click();
    const refreshedToggle = await waitFor(".git-file.is-active .git-file-disclosure");
    assert.strictEqual(refreshedToggle?.getAttribute("aria-expanded"), "true", "refresh should preserve the disclosure state");

    container.querySelector(".trace-diff-path")?.click();
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
    assert.ok(requests.filter(request => request.url.startsWith("/api/git/diff")).length >= 2, "refresh should reload the selected diff");
  });
});
