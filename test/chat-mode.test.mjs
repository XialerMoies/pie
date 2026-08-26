import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Window } from "happy-dom";

describe("chat mode server-state boundary", () => {
  it("renders the server profile catalog inside the strategy popup", async () => {
    const win = new Window();
    global.window = win;
    global.document = win.document;
    global.self = win;
    global.$ = (id) => win.document.getElementById(id);
    global.E = (value) => String(value).replace(/[&<>\"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
    global.toast = () => {};
    win.document.body.innerHTML = '<span id="fi-mode-name"></span>';
    global.App = win.App = {
      Chat: {},
      Permissions: { getMode: () => "standard", refreshMode: async () => "standard", setMode() {} },
      Preferences: { get: (_key, fallback = "") => fallback, set() {} },
    };
    global.fetch = async (url) => ({
      ok: true,
      json: async () => url === "/api/profiles"
        ? { current: { id: "minimal" }, catalogs: [
          { id: "standard", health: "ready", featureGates: "*", tools: [{ enabled: true, executable: true }, { enabled: true, executable: true }] },
          { id: "minimal", health: "ready", featureGates: ["planning"], tools: [{ enabled: true, executable: true }] },
          { id: "broken-profile", health: "broken", featureGates: [], tools: [] },
        ] }
        : { supportsThinking: false },
    });

    await import(`../src/frontend/chat/chat-mode.ts?profiles-${Date.now()}-${Math.random()}`);
    win.App.Chat.loadModeState();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const button = win.document.createElement("button");
    win.document.body.appendChild(button);
    win.App.Chat.showModePopup(button);
    await new Promise((resolve) => setTimeout(resolve, 0));

    const popup = win.document.getElementById("mode-popup");
    assert.ok(popup);
    assert.equal(popup.querySelector('[data-profile="minimal"]')?.classList.contains("active"), true);
    assert.equal(popup.querySelector('[data-profile="broken-profile"]'), null);
    assert.deepEqual(
      [...popup.querySelectorAll('[data-profile]')].map((option) => option.dataset.profile),
      ["standard", "minimal"],
    );
    assert.equal(win.App.Chat.getProfile(), "minimal");
  });

  it("keeps the current profile when the host rejects switching a non-empty session", async () => {
    const win = new Window();
    global.window = win;
    global.document = win.document;
    global.self = win;
    global.$ = (id) => win.document.getElementById(id);
    global.E = (value) => String(value);
    const notices = [];
    global.toast = (message, type) => notices.push({ message, type });
    win.document.body.innerHTML = '<span id="fi-mode-name"></span>';
    global.App = win.App = {
      Chat: {},
      Permissions: { getMode: () => "standard", refreshMode: async () => "standard", setMode() {} },
      Preferences: { get: (_key, fallback = "") => fallback, set() {} },
    };
    global.fetch = async (url, options = {}) => {
      if (url === "/api/profiles") return { ok: true, json: async () => ({ current: { id: "standard" }, catalogs: [
        { id: "standard", health: "ready", featureGates: "*", tools: [] },
        { id: "minimal", health: "ready", featureGates: [], tools: [] },
      ] }) };
      if (url === "/api/sessions/profile" && options.method === "POST") return { ok: false, json: async () => ({ error: "非空会话不可切换能力" }) };
      return { ok: true, json: async () => ({ supportsThinking: false }) };
    };

    await import(`../src/frontend/chat/chat-mode.ts?profile-reject-${Date.now()}-${Math.random()}`);
    win.App.Chat.loadModeState();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const button = win.document.createElement("button");
    win.document.body.appendChild(button);
    win.App.Chat.showModePopup(button);
    await new Promise((resolve) => setTimeout(resolve, 0));
    win.document.querySelector('[data-profile="minimal"]').click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(win.App.Chat.getProfile(), "standard");
    assert.equal(notices.at(-1)?.type, "error");
  });

  it("keeps permission and profile highlights when changing conversation mode", async () => {
    const win = new Window();
    global.window = win;
    global.document = win.document;
    global.self = win;
    global.$ = (id) => win.document.getElementById(id);
    global.E = (value) => String(value);
    global.toast = () => {};
    win.document.body.innerHTML = '<span id="fi-mode-name"></span>';
    global.App = win.App = {
      Chat: {},
      Permissions: { getMode: () => "dontAsk", refreshMode: async () => "dontAsk", setMode() {} },
      Preferences: { get: (_key, fallback = "") => fallback, set() {} },
    };
    global.fetch = async (url) => ({
      ok: true,
      json: async () => url === "/api/profiles"
        ? { current: { id: "minimal" }, catalogs: [
          { id: "standard", health: "ready" }, { id: "minimal", health: "ready" },
        ] }
        : { supportsThinking: false },
    });
    await import(`../src/frontend/chat/chat-mode.ts?highlights-${Date.now()}-${Math.random()}`);
    win.App.Chat.loadModeState();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const button = win.document.createElement("button");
    win.document.body.appendChild(button);
    win.App.Chat.showModePopup(button);
    const popup = win.document.getElementById("mode-popup");
    popup.querySelector('[data-mode="plan"]').click();
    assert.equal(popup.querySelector('[data-permission-mode="dontAsk"]').classList.contains("active"), true);
    assert.equal(popup.querySelector('[data-profile="minimal"]').classList.contains("active"), true);
  });

  it("keeps the strategy popup open and highlights the selected permission mode", async () => {
    const win = new Window();
    global.window = win;
    global.document = win.document;
    global.self = win;
    global.$ = (id) => win.document.getElementById(id);
    global.E = (value) => String(value);
    global.toast = () => {};
    win.document.body.innerHTML = '<span id="fi-mode-name"></span>';
    let selectedPermissionMode = "standard";
    global.App = win.App = {
      Chat: {},
      Permissions: {
        getMode: () => selectedPermissionMode,
        refreshMode: async () => selectedPermissionMode,
        setMode: (mode) => { selectedPermissionMode = mode; },
      },
      Preferences: { get: (_key, fallback = "") => fallback, set() {} },
    };
    global.fetch = async () => ({ ok: true, json: async () => ({ supportsThinking: false, current: { id: "standard" }, catalogs: [
      { id: "standard", health: "ready" }, { id: "minimal", health: "ready" },
    ] }) });
    await import(`../src/frontend/chat/chat-mode.ts?permission-popup-${Date.now()}-${Math.random()}`);
    win.App.Chat.loadModeState();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const button = win.document.createElement("button");
    win.document.body.appendChild(button);
    win.App.Chat.showModePopup(button);
    const popup = win.document.getElementById("mode-popup");
    popup.querySelector('[data-permission-mode="dontAsk"]').click();
    assert.equal(win.document.getElementById("mode-popup"), popup);
    assert.equal(popup.querySelector('[data-permission-mode="dontAsk"]').classList.contains("active"), true);
    assert.equal(popup.querySelector('[data-mode="auto"]').classList.contains("active"), true);
  });

  it("uses the draft-session materializer for capability switching", async () => {
    const win = new Window();
    global.window = win;
    global.document = win.document;
    global.self = win;
    global.$ = (id) => win.document.getElementById(id);
    global.E = (value) => String(value);
    global.toast = () => {};
    win.document.body.innerHTML = '<span id="fi-mode-name"></span>';
    const requests = [];
    global.App = win.App = {
      Chat: { ensureSessionForProfile: async () => ({ profile: { id: "minimal", revision: 1 } }) },
      Permissions: { getMode: () => "standard", refreshMode: async () => "standard", setMode() {} },
      Preferences: { get: (_key, fallback = "") => fallback, set() {} },
    };
    global.fetch = async (url, options = {}) => {
      requests.push({ url, options });
      return { ok: true, json: async () => url === "/api/profiles"
        ? { current: { id: "standard" }, catalogs: [{ id: "standard", health: "ready" }, { id: "minimal", health: "ready" }] }
        : { supportsThinking: false } };
    };
    await import(`../src/frontend/chat/chat-mode.ts?draft-profile-${Date.now()}-${Math.random()}`);
    win.App.Chat.loadModeState();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const button = win.document.createElement("button");
    win.document.body.appendChild(button);
    win.App.Chat.showModePopup(button);
    const popup = win.document.getElementById("mode-popup");
    win.document.querySelector('[data-profile="minimal"]').click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(win.App.Chat.getProfile(), "minimal");
    assert.equal(requests.some(({ url }) => url === "/api/sessions/profile"), false);
    assert.equal(win.document.getElementById("mode-popup"), popup);
    assert.equal(popup.querySelector('[data-profile="minimal"]').classList.contains("active"), true);
  });

  it("uses the host plan-state API instead of permissionMode or a prompt-only flag", async () => {
    const win = new Window();
    global.window = win;
    global.document = win.document;
    global.self = win;
    global.$ = (id) => win.document.getElementById(id);
    win.document.body.innerHTML = '<span id="fi-mode-name"></span>';
    const requests = [];
    global.App = win.App = {
      Chat: {},
      Permissions: { getMode: () => "standard", refreshMode: async () => "standard", setMode() {} },
      Preferences: { get: (_key, fallback = "") => fallback, set() {} },
    };
    let state = { status: "committed", revision: 0 };
    global.fetch = async (url, options = {}) => {
      requests.push({ url, options });
      if (url === "/api/plan-state" && options.method === "POST") {
        state = { status: JSON.parse(options.body).target, revision: state.revision + 1 };
        return { ok: true, json: async () => ({ ok: true, state }) };
      }
      if (url === "/api/plan-state") return { ok: true, json: async () => ({ ok: true, state }) };
      return { ok: true, json: async () => ({ supportsThinking: false }) };
    };

    await import(`../src/frontend/chat/chat-mode.ts?plan-${Date.now()}-${Math.random()}`);
    win.App.Chat.loadModeState();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const button = win.document.createElement("button");
    win.document.body.appendChild(button);
    win.App.Chat.showModePopup(button);
    win.document.querySelector('[data-mode="plan"]').click();
    await new Promise((resolve) => setTimeout(resolve, 0));

    const mutation = requests.find((request) => request.url === "/api/plan-state" && request.options.method === "POST");
    assert.equal(JSON.parse(mutation.options.body).target, "active");
    assert.equal(win.document.getElementById("fi-mode-name").textContent, "计划 · 标准");
    assert.equal(win.App.Chat.buildInstruction("检查代码"), "检查代码");
    win.App.Chat.applyPlanState({ status: "committed", revision: 2 });
    assert.equal(win.document.getElementById("fi-mode-name").textContent, "自动 · 标准");
  });

  it("shows request-scoped evidence without changing the selected profile", async () => {
    const win = new Window();
    global.window = win;
    global.document = win.document;
    global.self = win;
    global.$ = (id) => win.document.getElementById(id);
    global.E = (value) => String(value);
    global.toast = () => {};
    win.document.body.innerHTML = '<span id="fi-mode-name"></span><span id="fi-evidence-state"></span><button id="fi-mode-btn"></button>';
    global.App = win.App = {
      Chat: {},
      Permissions: { getMode: () => "standard", refreshMode: async () => "standard", setMode() {} },
      Preferences: { get: (_key, fallback = "") => fallback, set() {} },
    };
    global.fetch = async (url) => ({ ok: true, json: async () => url === "/api/profiles"
      ? { current: { id: "minimal" }, catalogs: [
        { id: "standard", health: "ready" }, { id: "minimal", health: "ready" },
      ] }
      : { supportsThinking: false } });

    await import(`../src/frontend/chat/chat-mode.ts?evidence-${Date.now()}-${Math.random()}`);
    win.App.Chat.loadModeState();
    await new Promise((resolve) => setTimeout(resolve, 0));
    win.App.Chat.applyEvidenceState({ status: "active", kind: "fact_verification", revision: 1 });
    assert.equal(win.App.Chat.getProfile(), "minimal");
    assert.equal(win.document.getElementById("fi-evidence-state").textContent, "核验中");
    const button = win.document.getElementById("fi-mode-btn");
    win.App.Chat.showModePopup(button);
    assert.equal(win.document.querySelector("[data-evidence-state]").textContent, "本轮事实核验 · 进行中");
    win.App.Chat.clearEvidenceState();
    assert.equal(win.document.getElementById("fi-evidence-state").hidden, true);
    assert.equal(win.App.Chat.getProfile(), "minimal");
  });

  it("keeps unknown thinking levels out of the strategy popup DOM", async () => {
    const win = new Window();
    global.window = win;
    global.document = win.document;
    global.self = win;
    global.$ = (id) => win.document.getElementById(id);
    win.document.body.innerHTML = '<span id="fi-mode-name"></span>';
    let selectedPermissionMode = null;
    global.App = win.App = {
      Chat: {},
      Permissions: {
        getMode: () => "standard",
        setMode: (mode) => { selectedPermissionMode = mode; },
      },
      Preferences: {
        get: (_key, fallback = "") => fallback,
        set: () => {},
      },
    };

    const injectedLevel = '\" data-thinking-level-injected="yes';
    global.fetch = async () => ({
      ok: true,
      json: async () => ({
        supportsThinking: true,
        availableLevels: ["low", injectedLevel, "high"],
        level: injectedLevel,
      }),
    });

    await import(`../src/frontend/chat/chat-mode.ts?${Date.now()}-${Math.random()}`);
    win.App.Chat.loadModeState();
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(win.App.Chat.getEffort(), "low");
    assert.equal(win.document.getElementById("fi-mode-name").textContent, "自动 · 标准");

    const button = win.document.createElement("button");
    win.document.body.appendChild(button);
    win.App.Chat.showModePopup(button);

    const popup = win.document.getElementById("mode-popup");
    assert.ok(popup);
    assert.equal(popup.querySelector("[data-thinking-level-injected]"), null);
    assert.deepEqual(
      [...popup.querySelectorAll("[data-permission-mode]")].map((option) => option.dataset.permissionMode),
      ["plan", "standard", "dontAsk", "yes"],
    );
    assert.equal(popup.querySelectorAll(".effort-dot").length, 0);
    popup.querySelector('[data-permission-mode="dontAsk"]').click();
    assert.equal(selectedPermissionMode, "dontAsk");
  });

  it("provides the thinking depth control for the model picker", async () => {
    const win = new Window();
    global.window = win;
    global.document = win.document;
    global.self = win;
    global.$ = (id) => win.document.getElementById(id);
    global.App = win.App = {
      Chat: {},
      Preferences: {
        get: (_key, fallback = "") => fallback,
        set: () => {},
      },
    };
    global.fetch = async () => ({
      ok: true,
      json: async () => ({
        supportsThinking: true,
        availableLevels: ["low", "high"],
        level: "high",
      }),
    });

    await import(`../src/frontend/chat/chat-mode.ts?${Date.now()}-${Math.random()}`);
    win.App.Chat.loadModeState();
    await new Promise((resolve) => setTimeout(resolve, 0));

    const container = win.document.createElement("div");
    win.App.Chat.mountThinkingControl(container);
    assert.deepEqual(
      [...container.querySelectorAll(".effort-dot")].map((dot) => dot.dataset.effort),
      ["low", "high"],
    );
  });
});
