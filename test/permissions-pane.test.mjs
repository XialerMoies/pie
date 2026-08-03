import { describe, it, before, beforeEach } from "node:test";
import assert from "node:assert";
import { readFileSync } from "node:fs";
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
    alwaysAllowRules: [{ toolName: "Read", ruleContent: "Read(E:\\\\safe\\\\**)", match: "wildcard", scope: "session", index: 0 }],
    alwaysDenyRules: [{ toolName: "Write", ruleContent: "Write(E:\\\\blocked.txt)", match: "exact", scope: "workspace", index: 0 }],
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
      toolOperations: ["execute"],
      riskLevel: "high",
      workspaceBounded: false,
      permissionRequired: true,
      reason: "External tool requires confirmation",
    },
    {
      id: 4,
      timestamp: "2026-07-29T10:03:00.000Z",
      source: "confirmed.external.write",
      operation: "write",
      root: "E:\\external",
      path: "E:\\external\\ok.txt",
      decision: "allow",
      reason: "Confirmed by user for this session",
    },
  ],
  calls: [],
};

function resetState() {
  state.rules = {
    additionalWorkingDirectories: [],
    alwaysAllowRules: [{ toolName: "Read", ruleContent: "Read(E:\\\\safe\\\\**)", match: "wildcard", scope: "session", index: 0 }],
    alwaysDenyRules: [{ toolName: "Write", ruleContent: "Write(E:\\\\blocked.txt)", match: "exact", scope: "workspace", index: 0 }],
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
      toolOperations: ["execute"],
      riskLevel: "high",
      workspaceBounded: false,
      permissionRequired: true,
      reason: "External tool requires confirmation",
    },
    {
      id: 4,
      timestamp: "2026-07-29T10:03:00.000Z",
      source: "confirmed.external.write",
      operation: "write",
      root: "E:\\external",
      path: "E:\\external\\ok.txt",
      decision: "allow",
      reason: "Confirmed by user for this session",
    },
  ];
  state.calls = [];
}

global.fetch = async (url, options = {}) => {
  state.calls.push({ url: String(url), method: options.method || "GET", options });
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
  if (textUrl === "/api/permissions/rules" && options.method === "POST") {
    const body = JSON.parse(options.body);
    const target = body.list === "deny"
      ? state.rules.alwaysDenyRules
      : body.list === "ask" ? state.rules.alwaysAskRules : state.rules.alwaysAllowRules;
    target.push({ ...body.rule, scope: body.scope, index: target.filter((rule) => rule.scope === body.scope).length });
    return { ok: true, json: async () => ({ ok: true, added: true, rules: state.rules }) };
  }
  if (textUrl === "/api/permissions/mode" && !options.method) {
    return { ok: true, json: async () => ({ mode: "standard" }) };
  }
  if (textUrl === "/api/permissions/rules/clear" && options.method === "POST") {
    const body = JSON.parse(options.body);
    for (const key of ["alwaysAllowRules", "alwaysDenyRules", "alwaysAskRules"]) {
      state.rules[key] = state.rules[key].filter((rule) => rule.scope !== body.scope);
    }
    return { ok: true, json: async () => ({ ok: true, removed: 1, rules: state.rules }) };
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
  it("keeps the pane focused on recent decisions and existing rules", () => {
    const source = readFileSync(new URL("../src/frontend/pane/permissions/index.ts", import.meta.url), "utf-8");
    assert.doesNotMatch(source, /perm-stats/);
    assert.doesNotMatch(source, /perm-add-rule/);
    assert.doesNotMatch(source, /perm-clear-all/);
    assert.match(source, /isRecentPermissionDecision/);
  });

  it("keeps session primary while exposing project-scoped confirmation", () => {
    const source = readFileSync(new URL("../src/frontend/dashboard/dashboard-helpers.ts", import.meta.url), "utf-8");
    assert.match(source, /data-choice="workspace"/);
    assert.match(source, /class="command-confirm-btn primary" data-choice="session"/);
  });

  it("renders only recent final confirmations and user rules", async () => {
    const render = registeredPanes.get("permissions");
    assert.ok(render, "permissions pane should be registered");
    const container = doc.createElement("div");
    doc.body.appendChild(container);

    render(container);
    await waitTick();
    await waitTick();

    assert.strictEqual(container.querySelector(".perm-stats"), null);
    assert.doesNotMatch(container.textContent, /file\.write/);
    assert.doesNotMatch(container.textContent, /mcp__external__run/);
    assert.match(container.textContent, /mcp\.install/);
    assert.match(container.textContent, /confirmed\.external\.write/);

    const rulesTab = container.querySelector('[data-perm-tab="rules"]');
    assert.ok(rulesTab);
    rulesTab.dispatchEvent(new win.MouseEvent("click", { bubbles: true }));
    await waitTick();
    await waitTick();

    assert.match(container.textContent, /Write\(E:\\\\blocked\.txt\)/);
    assert.match(container.textContent, /项目/);
    assert.ok(container.querySelector('[data-rule-remove="deny:workspace:0"]'));
    assert.strictEqual(container.querySelector("#perm-add-rule"), null);
    assert.strictEqual(container.querySelector("#perm-clear-all"), null);
    container.remove();
  });

  it("revokes a workspace permission rule", async () => {
    const render = registeredPanes.get("permissions");
    const container = doc.createElement("div");
    doc.body.appendChild(container);

    render(container);
    await waitTick();
    const rulesTab = container.querySelector('[data-perm-tab="rules"]');
    rulesTab.dispatchEvent(new win.MouseEvent("click", { bubbles: true }));
    await waitTick();

    const remove = container.querySelector('[data-rule-remove="deny:workspace:0"]');
    assert.ok(remove);
    remove.dispatchEvent(new win.MouseEvent("click", { bubbles: true }));
    await waitTick();
    await waitTick();

    assert.ok(state.calls.some((call) => (
      call.method === "DELETE" && call.url.includes("list=deny") && call.url.includes("scope=workspace")
    )));
    assert.strictEqual(state.rules.alwaysDenyRules.length, 0);
    assert.match(container.textContent, /无 Deny 规则/);
    container.remove();
  });

  it("does not expose manual rule creation or bulk clearing", async () => {
    const render = registeredPanes.get("permissions");
    const container = doc.createElement("div");
    doc.body.appendChild(container);

    render(container);
    await waitTick();
    container.querySelector('[data-perm-tab="rules"]').dispatchEvent(new win.MouseEvent("click", { bubbles: true }));
    await waitTick();

    assert.strictEqual(container.querySelector("#perm-add-scope"), null);
    assert.strictEqual(container.querySelector("#perm-add-rule"), null);
    assert.strictEqual(container.querySelector("#perm-clear-all"), null);
    assert.strictEqual(state.calls.some((call) => call.method === "POST"), false);
    container.remove();
  });
});
