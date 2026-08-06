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

const registerCalls = [];
global.registerPane = (...args) => registerCalls.push(args);
win.App = {};
global.App = win.App;

const waitTick = () => new Promise((resolve) => setTimeout(resolve, 0));

const state = {
  rules: {
    additionalWorkingDirectories: [],
    alwaysAllowRules: [{ toolName: "Read", ruleContent: "Read(E:\\\\safe\\\\**)", match: "wildcard", scope: "session", index: 0 }],
    alwaysDenyRules: [{ toolName: "Write", ruleContent: "Write(E:\\\\blocked.txt)", match: "exact", scope: "workspace", index: 0 }],
    alwaysAskRules: [],
  },
  mode: "standard",
  modePostFailure: false,
  modeGetFailure: null,
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
  state.mode = "standard";
  state.modePostFailure = false;
  state.modeGetFailure = null;
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
    if (state.modeGetFailure) return state.modeGetFailure;
    return { ok: true, json: async () => ({ mode: state.mode }) };
  }
  if (textUrl === "/api/permissions/mode" && options.method === "POST") {
    const body = JSON.parse(options.body);
    if (state.modePostFailure) {
      return { ok: false, status: 500, json: async () => ({ ok: false, error: "mode rejected" }) };
    }
    state.mode = body.mode;
    return { ok: true, json: async () => ({ ok: true, mode: state.mode }) };
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

describe("permissions pane", { concurrency: 1 }, () => {
  it("publishes a reusable Permissions facade and manages mounted roots", async () => {
    assert.strictEqual(typeof win.App.Permissions?.mount, "function");
    assert.strictEqual(typeof win.App.Permissions?.refresh, "function");
    assert.strictEqual(typeof win.App.Permissions?.unmount, "function");
    assert.strictEqual(typeof win.App.Permissions?.setMode, "function");
    assert.strictEqual(registerCalls.length, 0, "permissions should not register as a legacy pane");

    const first = doc.createElement("div");
    const second = doc.createElement("div");
    doc.body.append(first, second);

    win.App.Permissions.mount(first);
    await waitTick();
    await waitTick();
    const firstRoot = first.querySelector("#permissions-panel-root");
    assert.ok(firstRoot);
    assert.strictEqual(state.calls.length, 3, "the first mount should refresh audit, rules, and mode once");

    win.App.Permissions.mount(first);
    assert.strictEqual(first.querySelector("#permissions-panel-root"), firstRoot);
    assert.strictEqual(state.calls.length, 3, "repeated mounts should reuse the existing root");

    first.querySelector("#perm-refresh").dispatchEvent(new win.MouseEvent("click", { bubbles: true }));
    await waitTick();
    await waitTick();
    assert.strictEqual(state.calls.length, 6, "reused roots should have one refresh listener");

    win.App.Permissions.mount(second);
    await waitTick();
    await waitTick();
    assert.strictEqual(first.querySelector("#permissions-panel-root"), null);
    assert.ok(second.querySelector("#permissions-panel-root"));

    await win.App.Permissions.refresh(true);
    await waitTick();
    await waitTick();
    assert.ok(win.__toasts?.some((toast) => toast.type === "success"));
    second.remove();
  });

  it("changes mode only after acknowledging the Yes risk", async () => {
    const container = doc.createElement("div");
    doc.body.appendChild(container);
    win.App.Permissions.mount(container);
    await waitTick();
    await waitTick();

    const mode = container.querySelector("#perm-mode");
    mode.value = "yes";
    mode.dispatchEvent(new win.Event("change", { bubbles: true }));
    const overlay = doc.querySelector(".permission-risk-overlay");
    assert.ok(overlay);
    const acknowledgement = overlay.querySelector("#permission-risk-ack");
    acknowledgement.checked = true;
    acknowledgement.dispatchEvent(new win.Event("change", { bubbles: true }));
    overlay.querySelector('[data-risk-choice="confirm"]').click();
    await waitTick();
    await waitTick();

    const modeChange = state.calls.find((call) => call.url === "/api/permissions/mode" && call.method === "POST");
    assert.ok(modeChange);
    assert.deepStrictEqual(JSON.parse(modeChange.options.body), { mode: "yes", acknowledgeRisk: true });
    container.remove();
  });

  it("changes mode from the strategy menu when the Permissions pane is unmounted", async () => {
    win.App.Permissions.unmount();
    resetState();
    win.App.Permissions.setMode("dontAsk");
    await waitTick();
    await waitTick();

    const modeChange = state.calls.find((call) => call.url === "/api/permissions/mode" && call.method === "POST");
    assert.ok(modeChange);
    assert.deepStrictEqual(JSON.parse(modeChange.options.body), { mode: "dontAsk" });
    assert.equal(state.mode, "dontAsk");
  });

  it("keeps the pane and bottom Yes badges synchronized with the refreshed mode", async () => {
    const container = doc.createElement("div");
    const bottomBadge = doc.createElement("span");
    bottomBadge.id = "permission-mode-badge";
    doc.body.append(container, bottomBadge);
    win.App.Permissions.mount(container);
    await waitTick();
    await waitTick();

    state.mode = "yes";
    await win.App.Permissions.refresh();
    assert.strictEqual(container.querySelector("#perm-yes-badge").classList.contains("on"), true);
    assert.strictEqual(bottomBadge.classList.contains("on"), true);
    assert.strictEqual(container.querySelector("#perm-yes-badge").textContent, "YES");
    assert.strictEqual(bottomBadge.textContent, "YES");

    state.mode = "standard";
    await win.App.Permissions.refresh();
    assert.strictEqual(container.querySelector("#perm-yes-badge").classList.contains("on"), false);
    assert.strictEqual(bottomBadge.classList.contains("on"), false);
    assert.strictEqual(container.querySelector("#perm-yes-badge").textContent, "");
    assert.strictEqual(bottomBadge.textContent, "");
    container.remove();
    bottomBadge.remove();
  });

  it("resets the mode select after Yes cancellation and failed POST", async () => {
    const container = doc.createElement("div");
    doc.body.appendChild(container);
    win.App.Permissions.mount(container);
    await waitTick();
    await waitTick();

    const mode = container.querySelector("#perm-mode");
    mode.value = "yes";
    mode.dispatchEvent(new win.Event("change", { bubbles: true }));
    doc.querySelector('[data-risk-choice="cancel"]').click();
    await waitTick();
    assert.strictEqual(mode.value, "standard");
    assert.strictEqual(state.calls.some((call) => call.method === "POST"), false);

    state.modePostFailure = true;
    mode.value = "yes";
    mode.dispatchEvent(new win.Event("change", { bubbles: true }));
    const overlay = doc.querySelector(".permission-risk-overlay");
    overlay.querySelector("#permission-risk-ack").checked = true;
    overlay.querySelector("#permission-risk-ack").dispatchEvent(new win.Event("change", { bubbles: true }));
    overlay.querySelector('[data-risk-choice="confirm"]').click();
    await waitTick();
    await waitTick();
    assert.strictEqual(mode.value, "standard");
    assert.ok(state.calls.some((call) => call.method === "POST"));
    container.remove();
  });

  it("does not let an older refresh mode response overwrite a newer mode mutation", async () => {
    const container = doc.createElement("div");
    doc.body.appendChild(container);
    win.App.Permissions.mount(container);
    await waitTick();
    await waitTick();

    const originalFetch = global.fetch;
    const pending = [];
    global.fetch = (url, options = {}) => new Promise((resolve) => pending.push({ url: String(url), options, resolve }));
    win.fetch = global.fetch;
    try {
      const refreshPromise = win.App.Permissions.refresh();
      assert.strictEqual(pending.length, 2);
      const response = (body) => ({ ok: true, json: async () => body });
      pending[0].resolve(response({ audit: [], total: 0 }));
      pending[1].resolve(response({ additionalWorkingDirectories: [], alwaysAllowRules: [], alwaysDenyRules: [], alwaysAskRules: [] }));
      await waitTick();
      await waitTick();
      assert.strictEqual(pending[2].url, "/api/permissions/mode");

      const mode = container.querySelector("#perm-mode");
      mode.value = "dontAsk";
      mode.dispatchEvent(new win.Event("change", { bubbles: true }));
      assert.strictEqual(pending[3].options.method, "POST");
      pending[3].resolve(response({ ok: true, mode: "dontAsk" }));
      await waitTick();
      await waitTick();
      assert.strictEqual(mode.value, "dontAsk");

      pending[2].resolve(response({ mode: "standard" }));
      await refreshPromise;
      assert.strictEqual(mode.value, "dontAsk");
    } finally {
      container.remove();
      global.fetch = originalFetch;
      win.fetch = originalFetch;
    }
  });

  it("does not let a refresh mode response overwrite a mode POST already in flight", async () => {
    const container = doc.createElement("div");
    doc.body.appendChild(container);
    win.App.Permissions.mount(container);
    await waitTick();
    await waitTick();

    const originalFetch = global.fetch;
    const pending = [];
    global.fetch = (url, options = {}) => new Promise((resolve) => pending.push({ url: String(url), options, resolve }));
    win.fetch = global.fetch;
    try {
      const mode = container.querySelector("#perm-mode");
      mode.value = "dontAsk";
      mode.dispatchEvent(new win.Event("change", { bubbles: true }));
      await waitTick();
      assert.strictEqual(pending.length, 1);

      const refreshPromise = win.App.Permissions.refresh();
      assert.strictEqual(pending.length, 3);
      const response = (body) => ({ ok: true, json: async () => body });
      pending[1].resolve(response({ audit: [], total: 0 }));
      pending[2].resolve(response({ additionalWorkingDirectories: [], alwaysAllowRules: [], alwaysDenyRules: [], alwaysAskRules: [] }));
      await waitTick();
      await waitTick();
      assert.strictEqual(pending.length, 4);

      pending[0].resolve(response({ ok: true, mode: "dontAsk" }));
      await waitTick();
      await waitTick();
      pending[3].resolve(response({ mode: "standard" }));
      await refreshPromise;
      assert.strictEqual(mode.value, "dontAsk");
    } finally {
      container.remove();
      global.fetch = originalFetch;
      win.fetch = originalFetch;
    }
  });

  it("serializes mode mutations so the final server state follows user order", async () => {
    const container = doc.createElement("div");
    doc.body.appendChild(container);
    win.App.Permissions.mount(container);
    await waitTick();
    await waitTick();

    const originalFetch = global.fetch;
    const pending = [];
    global.fetch = (url, options = {}) => new Promise((resolve) => pending.push({ url: String(url), options, resolve }));
    win.fetch = global.fetch;
    win.__toasts = [];
    try {
      const mode = container.querySelector("#perm-mode");
      mode.value = "dontAsk";
      mode.dispatchEvent(new win.Event("change", { bubbles: true }));
      await waitTick();
      assert.strictEqual(pending.length, 1);
      mode.value = "plan";
      mode.dispatchEvent(new win.Event("change", { bubbles: true }));
      assert.strictEqual(pending.length, 1);

      const response = (body) => ({ ok: true, json: async () => body });
      pending[0].resolve(response({ ok: true, mode: "dontAsk" }));
      await waitTick();
      await waitTick();
      assert.strictEqual(pending.length, 2);
      assert.deepStrictEqual(JSON.parse(pending[1].options.body), { mode: "plan" });
      pending[1].resolve(response({ ok: true, mode: "plan" }));
      await waitTick();
      await waitTick();

      assert.strictEqual(mode.value, "plan");
      assert.strictEqual(win.__toasts.filter((toast) => toast.type === "success" && toast.msg.includes("切换")).length, 1);
    } finally {
      container.remove();
      global.fetch = originalFetch;
      win.fetch = originalFetch;
    }
  });

  it("ignores stale refresh responses after mounting a new container", async () => {
    const originalFetch = global.fetch;
    const pending = [];
    global.fetch = (url) => new Promise((resolve) => pending.push({ url: String(url), resolve }));
    win.fetch = global.fetch;

    const oldContainer = doc.createElement("div");
    const newContainer = doc.createElement("div");
    doc.body.append(oldContainer, newContainer);
    try {
      win.App.Permissions.mount(oldContainer);
      win.App.Permissions.mount(newContainer);
      assert.strictEqual(pending.length, 4);

      const response = (body) => ({ ok: true, json: async () => body });
      pending[2].resolve(response({ audit: [{ id: 20, timestamp: "2026-08-01T10:00:00.000Z", source: "new.refresh", operation: "write", root: "E:\\new", decision: "deny" }] }));
      pending[3].resolve(response({ additionalWorkingDirectories: [], alwaysAllowRules: [], alwaysDenyRules: [], alwaysAskRules: [] }));
      await waitTick();
      await waitTick();
      assert.strictEqual(pending.length, 5);
      pending[4].resolve(response({ mode: "standard" }));
      await waitTick();
      await waitTick();
      assert.match(newContainer.textContent, /new\.refresh/);

      pending[0].resolve(response({ audit: [{ id: 10, timestamp: "2026-08-01T09:00:00.000Z", source: "old.refresh", operation: "write", root: "E:\\old", decision: "deny" }] }));
      pending[1].resolve(response({ additionalWorkingDirectories: [], alwaysAllowRules: [], alwaysDenyRules: [], alwaysAskRules: [] }));
      await waitTick();
      await waitTick();
      assert.strictEqual(pending.length, 6);
      pending[5].resolve(response({ mode: "yes" }));
      await waitTick();
      await waitTick();

      assert.match(newContainer.textContent, /new\.refresh/);
      assert.doesNotMatch(newContainer.textContent, /old\.refresh/);
    } finally {
      newContainer.remove();
      oldContainer.remove();
      global.fetch = originalFetch;
      win.fetch = originalFetch;
    }
  });

  it("ignores refresh responses for a detached container and remounts it with a new root", async () => {
    const container = doc.createElement("div");
    doc.body.appendChild(container);
    win.App.Permissions.mount(container);
    await waitTick();
    await waitTick();
    const oldRoot = container.querySelector("#permissions-panel-root");
    const originalFetch = global.fetch;
    const pending = [];
    global.fetch = (url) => new Promise((resolve) => pending.push({ url: String(url), resolve }));
    win.fetch = global.fetch;
    try {
      container.remove();
      const refreshPromise = win.App.Permissions.refresh();
      assert.strictEqual(pending.length, 2);
      const response = (body) => ({ ok: true, json: async () => body });
      pending[0].resolve(response({ audit: [{ id: 99, timestamp: "2026-08-02T10:00:00.000Z", source: "detached.refresh", operation: "write", root: "E:\\detached", decision: "deny" }] }));
      pending[1].resolve(response({ additionalWorkingDirectories: [], alwaysAllowRules: [], alwaysDenyRules: [], alwaysAskRules: [] }));
      await waitTick();
      await waitTick();
      assert.strictEqual(pending.length, 3);
      pending[2].resolve(response({ mode: "standard" }));
      await refreshPromise;
      assert.doesNotMatch(oldRoot.textContent, /detached\.refresh/);

      global.fetch = originalFetch;
      win.fetch = originalFetch;
      win.App.Permissions.mount(container);
      const newRoot = container.querySelector("#permissions-panel-root");
      assert.ok(newRoot);
      assert.notStrictEqual(newRoot, oldRoot);
    } finally {
      global.fetch = originalFetch;
      win.fetch = originalFetch;
      container.remove();
    }
  });

  it("unmounts the panel and resolves a pending Yes confirmation", async () => {
    const container = doc.createElement("div");
    doc.body.appendChild(container);
    try {
      win.App.Permissions.mount(container);
      await waitTick();
      await waitTick();
      const mode = container.querySelector("#perm-mode");
      mode.value = "yes";
      mode.dispatchEvent(new win.Event("change", { bubbles: true }));
      assert.ok(doc.querySelector(".permission-risk-overlay"));

      win.App.Permissions.unmount();
      await waitTick();
      assert.strictEqual(doc.querySelector(".permission-risk-overlay"), null);
      assert.strictEqual(container.querySelector("#permissions-panel-root"), null);
    } finally {
      doc.querySelector(".permission-risk-overlay")?.remove();
      container.remove();
    }
  });

  it("ignores a stale mode POST after mounting a new container", async () => {
    const oldContainer = doc.createElement("div");
    const newContainer = doc.createElement("div");
    doc.body.append(oldContainer, newContainer);
    win.App.Permissions.mount(oldContainer);
    await waitTick();
    await waitTick();

    const originalFetch = global.fetch;
    const pending = [];
    global.fetch = (url, options = {}) => new Promise((resolve) => pending.push({ url: String(url), options, resolve }));
    win.fetch = global.fetch;
    win.__toasts = [];
    try {
      const mode = oldContainer.querySelector("#perm-mode");
      mode.value = "yes";
      mode.dispatchEvent(new win.Event("change", { bubbles: true }));
      const overlay = doc.querySelector(".permission-risk-overlay");
      overlay.querySelector("#permission-risk-ack").checked = true;
      overlay.querySelector("#permission-risk-ack").dispatchEvent(new win.Event("change", { bubbles: true }));
      overlay.querySelector('[data-risk-choice="confirm"]').click();
      await waitTick();
      assert.strictEqual(pending[0].options.method, "POST");

      win.App.Permissions.mount(newContainer);
      assert.strictEqual(pending.length, 3);
      const response = (body) => ({ ok: true, json: async () => body });
      pending[1].resolve(response({ audit: [], total: 0 }));
      pending[2].resolve(response({ additionalWorkingDirectories: [], alwaysAllowRules: [], alwaysDenyRules: [], alwaysAskRules: [] }));
      await waitTick();
      await waitTick();
      assert.strictEqual(pending.length, 4);
      pending[3].resolve(response({ mode: "standard" }));
      await waitTick();
      await waitTick();

      const newMode = newContainer.querySelector("#perm-mode");
      newMode.value = "dontAsk";
      newMode.dispatchEvent(new win.Event("change", { bubbles: true }));
      await waitTick();
      assert.strictEqual(pending.length, 5);
      assert.deepStrictEqual(JSON.parse(pending[4].options.body), { mode: "dontAsk" });
      pending[4].resolve(response({ ok: true, mode: "dontAsk" }));
      await waitTick();
      await waitTick();
      assert.strictEqual(newMode.value, "dontAsk");
      const toastCountBeforeStaleResponse = win.__toasts.filter((toast) => toast.msg.includes("切换")).length;

      pending[0].resolve(response({ ok: true, mode: "yes" }));
      await waitTick();
      await waitTick();
      assert.strictEqual(newContainer.querySelector("#perm-mode").value, "dontAsk");
      assert.strictEqual(newContainer.querySelector("#perm-yes-badge").classList.contains("on"), false);
      assert.strictEqual(win.__toasts.filter((toast) => toast.msg.includes("切换")).length, toastCountBeforeStaleResponse);
    } finally {
      oldContainer.remove();
      newContainer.remove();
      global.fetch = originalFetch;
      win.fetch = originalFetch;
    }
  });

  it("ignores a stale rule DELETE after mounting a new container", async () => {
    const oldContainer = doc.createElement("div");
    const newContainer = doc.createElement("div");
    doc.body.append(oldContainer, newContainer);
    win.App.Permissions.mount(oldContainer);
    await waitTick();
    await waitTick();
    oldContainer.querySelector('[data-perm-tab="rules"]').dispatchEvent(new win.MouseEvent("click", { bubbles: true }));
    await waitTick();
    await waitTick();

    const originalFetch = global.fetch;
    const pending = [];
    global.fetch = (url, options = {}) => new Promise((resolve) => pending.push({ url: String(url), options, resolve }));
    win.fetch = global.fetch;
    win.__toasts = [];
    try {
      oldContainer.querySelector('[data-rule-remove="deny:workspace:0"]').dispatchEvent(new win.MouseEvent("click", { bubbles: true }));
      assert.strictEqual(pending[0].options.method, "DELETE");

      win.App.Permissions.mount(newContainer);
      assert.strictEqual(pending.length, 3);
      const response = (body) => ({ ok: true, json: async () => body });
      pending[1].resolve(response({ audit: [], total: 0 }));
      pending[2].resolve(response({ additionalWorkingDirectories: [], alwaysAllowRules: [], alwaysDenyRules: [{ toolName: "Write", ruleContent: "new-rule", scope: "workspace", index: 0 }], alwaysAskRules: [] }));
      await waitTick();
      await waitTick();
      assert.strictEqual(pending.length, 4);
      pending[3].resolve(response({ mode: "standard" }));
      await waitTick();
      await waitTick();
      assert.match(newContainer.textContent, /new-rule/);

      pending[0].resolve(response({ ok: true, rules: { additionalWorkingDirectories: [], alwaysAllowRules: [], alwaysDenyRules: [], alwaysAskRules: [] } }));
      await waitTick();
      await waitTick();
      assert.match(newContainer.textContent, /new-rule/);
      assert.strictEqual(win.__toasts.some((toast) => toast.msg.includes("撤销")), false);
    } finally {
      oldContainer.remove();
      newContainer.remove();
      global.fetch = originalFetch;
      win.fetch = originalFetch;
    }
  });

  it("keeps the current mode and applies audit and rules when mode GET fails or is invalid", async () => {
    const container = doc.createElement("div");
    doc.body.appendChild(container);
    try {
      win.App.Permissions.mount(container);
      await waitTick();
      await waitTick();

      state.mode = "yes";
      await win.App.Permissions.refresh();
      assert.strictEqual(container.querySelector("#perm-mode").value, "yes");
      container.querySelector('[data-perm-tab="audit"]').dispatchEvent(new win.MouseEvent("click", { bubbles: true }));
      await waitTick();
      await waitTick();

      state.audit = [{
        id: 99,
        timestamp: new Date().toISOString(),
        source: "mode-fallback.audit",
        operation: "write",
        root: "E:\\workspace",
        decision: "deny",
      }];
      state.rules = {
        additionalWorkingDirectories: [],
        alwaysAllowRules: [],
        alwaysDenyRules: [{ toolName: "Write", ruleContent: "mode-fallback-rule", match: "exact", scope: "workspace", index: 0 }],
        alwaysAskRules: [],
      };
      win.__toasts = [];

      state.modeGetFailure = { ok: false, status: 503, json: async () => ({ mode: "yes" }) };
      await win.App.Permissions.refresh(true);
      assert.strictEqual(container.querySelector("#perm-mode").value, "yes");
      assert.strictEqual(container.querySelector("#perm-yes-badge").classList.contains("on"), true);
      assert.match(container.textContent, /mode-fallback\.audit/);
      assert.strictEqual(container.querySelector(".perm-error"), null);
      assert.strictEqual(win.__toasts.some((toast) => toast.type === "success"), true);

      container.querySelector('[data-perm-tab="rules"]').dispatchEvent(new win.MouseEvent("click", { bubbles: true }));
      await waitTick();
      await waitTick();
      assert.match(container.textContent, /mode-fallback-rule/);

      state.modeGetFailure = { ok: true, json: async () => ({ mode: "invalid" }) };
      await win.App.Permissions.refresh(true);
      assert.strictEqual(container.querySelector("#perm-mode").value, "yes");
      assert.match(container.textContent, /mode-fallback-rule/);
      assert.strictEqual(container.querySelector(".perm-error"), null);
    } finally {
      container.remove();
    }
  });

  it("removes an active risk overlay when mounting a new container", async () => {
    const oldContainer = doc.createElement("div");
    const newContainer = doc.createElement("div");
    doc.body.append(oldContainer, newContainer);
    try {
      win.App.Permissions.mount(oldContainer);
      await waitTick();
      await waitTick();

      const mode = oldContainer.querySelector("#perm-mode");
      mode.value = "yes";
      mode.dispatchEvent(new win.Event("change", { bubbles: true }));
      assert.ok(doc.querySelector(".permission-risk-overlay"));

      win.App.Permissions.mount(newContainer);
      assert.strictEqual(doc.querySelector(".permission-risk-overlay") === null, true);
    } finally {
      doc.querySelector(".permission-risk-overlay")?.remove();
      oldContainer.remove();
      newContainer.remove();
    }
  });

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
    const container = doc.createElement("div");
    doc.body.appendChild(container);

    win.App.Permissions.mount(container);
    await waitTick();
    await waitTick();
    container.querySelector('[data-perm-tab="audit"]').dispatchEvent(new win.MouseEvent("click", { bubbles: true }));
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
    const container = doc.createElement("div");
    doc.body.appendChild(container);

    win.App.Permissions.mount(container);
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
    const container = doc.createElement("div");
    doc.body.appendChild(container);

    win.App.Permissions.mount(container);
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
