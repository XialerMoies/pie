import { describe, it, before, beforeEach } from "node:test";
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
global.S = (name, size = 16) => `<svg width="${size}" height="${size}" viewBox="0 0 24 24"><use href="#${name}"/></svg>`;
global.E = (value) => String(value ?? "")
  .replaceAll("&", "&amp;")
  .replaceAll("<", "&lt;")
  .replaceAll(">", "&gt;");
global.toast = (msg, type) => {
  win.__toasts = [...(win.__toasts || []), { msg, type }];
};
global.confirmAsync = async () => true;

const registeredPanes = new Map();
global.registerPane = (name, render) => {
  registeredPanes.set(name, render);
};

const waitTick = () => new Promise((resolve) => setTimeout(resolve, 0));

const state = {
  rules: {
    additionalWorkingDirectories: [],
    alwaysAllowRules: [{ toolName: "Read", ruleContent: "Read(E:\\\\safe\\\\**)", match: "wildcard" }],
    alwaysDenyRules: [{ toolName: "Write", ruleContent: "Write(E:\\\\blocked.txt)", match: "exact" }],
    alwaysAskRules: [],
  },
  audit: [
    {
      id: 1,
      timestamp: "2026-07-29T10:00:00.000Z",
      source: "file.write",
      operation: "write",
      root: "E:\\\\workspace",
      path: "E:\\\\workspace\\\\ok.txt",
      relativePath: "ok.txt",
      decision: "allow",
    },
    {
      id: 2,
      timestamp: "2026-07-29T10:01:00.000Z",
      source: "mcp.install",
      operation: "write",
      root: "C:\\\\Users\\\\ASUS",
      path: "C:\\\\Users\\\\ASUS\\\\.pi\\\\agent\\\\mcp.json",
      decision: "deny",
      reason: "denied by session rule",
    },
    {
      id: 3,
      timestamp: "2026-07-29T10:02:00.000Z",
      source: "mcp.external.run",
      operation: "tool",
      root: "E:\\\\workspace",
      decision: "ask",
      toolName: "mcp__external__run",
      riskLevel: "high",
      reason: "External tool requires confirmation",
    },
  ],
  calls: [],
};

function resetState() {
  state.rules = {
    additionalWorkingDirectories: [],
    alwaysAllowRules: [{ toolName: "Read", ruleContent: "Read(E:\\\\safe\\\\**)", match: "wildcard" }],
    alwaysDenyRules: [{ toolName: "Write", ruleContent: "Write(E:\\\\blocked.txt)", match: "exact" }],
    alwaysAskRules: [],
  };
  state.audit = [
    {
      id: 1,
      timestamp: "2026-07-29T10:00:00.000Z",
      source: "file.write",
      operation: "write",
      root: "E:\\\\workspace",
      path: "E:\\\\workspace\\\\ok.txt",
      relativePath: "ok.txt",
      decision: "allow",
    },
    {
      id: 2,
      timestamp: "2026-07-29T10:01:00.000Z",
      source: "mcp.install",
      operation: "write",
      root: "C:\\\\Users\\\\ASUS",
      path: "C:\\\\Users\\\\ASUS\\\\.pi\\\\agent\\\\mcp.json",
      decision: "deny",
      reason: "denied by session rule",
    },
    {
      id: 3,
      timestamp: "2026-07-29T10:02:00.000Z",
      source: "mcp.external.run",
      operation: "tool",
      root: "E:\\\\workspace",
      decision: "ask",
      toolName: "mcp__external__run",
      riskLevel: "high",
      reason: "External tool requires confirmation",
    },
  ];
  state.calls = [];
}

global.fetch = async (url, options = {}) => {
  state.calls.push({ url: String(url), method: options.method || "GET" });
  const textUrl = String(url);
  if (textUrl.startsWith("/api/permissions/audit")) {
    return { ok: true, json: async () => ({ audit: state.audit, total: state.audit.length }) };
  }
  if (textUrl === "/api/permissions/rules" && !options.method) {
    return { ok: true, json: async () => state.rules };
  }
  if (textUrl.startsWith("/api/permissions/rules") && options.method === "DELETE") {
    state.rules.alwaysDenyRules.splice(0, 1);
    return { ok: true, json: async () => ({ ok: true, removed: true, rules: state.rules }) };
  }
  throw new Error(`unexpected fetch: ${textUrl}`);
};
win.fetch = global.fetch;

beforeEach(() => {
  resetState();
});

before(async () => {
  await import("../src/frontend/pane/permissions/index.ts");
});

describe("permissions pane", () => {
  it("renders permission audit and rule controls", async () => {
    const render = registeredPanes.get("permissions");
    assert.ok(render, "permissions pane should be registered");
    const container = doc.createElement("div");
    doc.body.appendChild(container);

    render(container);
    await waitTick();
    await waitTick();

    assert.match(container.textContent, /Allow 1/);
    assert.match(container.textContent, /Deny 1/);
    assert.match(container.textContent, /Tool/);
    assert.match(container.textContent, /mcp\.install/);
    assert.match(container.textContent, /mcp__external__run/);

    const rulesTab = container.querySelector('[data-perm-tab="rules"]');
    assert.ok(rulesTab);
    rulesTab.dispatchEvent(new win.MouseEvent("click", { bubbles: true }));
    await waitTick();
    await waitTick();

    assert.match(container.textContent, /Write\(E:\\\\blocked\.txt\)/);
    assert.ok(container.querySelector('[data-rule-remove="deny:0"]'));
    container.remove();
  });

  it("revokes a session permission rule", async () => {
    const render = registeredPanes.get("permissions");
    const container = doc.createElement("div");
    doc.body.appendChild(container);

    render(container);
    await waitTick();
    const rulesTab = container.querySelector('[data-perm-tab="rules"]');
    rulesTab.dispatchEvent(new win.MouseEvent("click", { bubbles: true }));
    await waitTick();

    const remove = container.querySelector('[data-rule-remove="deny:0"]');
    assert.ok(remove);
    remove.dispatchEvent(new win.MouseEvent("click", { bubbles: true }));
    await waitTick();
    await waitTick();

    assert.ok(state.calls.some((call) => call.method === "DELETE" && call.url.includes("list=deny")));
    assert.strictEqual(state.rules.alwaysDenyRules.length, 0);
    assert.match(container.textContent, /无 Deny 规则/);
    container.remove();
  });
});
