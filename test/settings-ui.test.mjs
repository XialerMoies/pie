import { before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Window } from "happy-dom";

const win = new Window();
const storage = new Map();
const settingsSpies = {
  refreshCalls: [],
  toastCalls: [],
};
let ListAddAction;
let SettingsCustomProviderEditor;

global.window = win;
global.document = win.document;
global.self = win;
global.localStorage = {
  getItem: (key) => storage.get(key) ?? null,
  setItem: (key, value) => storage.set(key, String(value)),
  removeItem: (key) => storage.delete(key),
};
global.$ = (id) => document.getElementById(id);
global.E = (value) => String(value)
  .replaceAll("&", "&amp;")
  .replaceAll('"', "&quot;")
  .replaceAll("<", "&lt;")
  .replaceAll(">", "&gt;")
  .replaceAll("'", "&#39;");
global.toast = (message, type) => settingsSpies.toastCalls.push([message, type]);
global.getD = () => {};
win.__state = { D: null };
win.App = {
  Settings: {},
  ChatTimeline: {
    refreshSettings: (...args) => settingsSpies.refreshCalls.push({ label: "timeline-refresh", args }),
  },
  Chat: {
    refreshReadingSettings: (...args) => settingsSpies.refreshCalls.push({ label: "reading-refresh", args }),
  },
  Permissions: {
    mount: (...args) => {
      settingsSpies.refreshCalls.push({ label: "permissions-mount", args });
      const host = args[0] && typeof args[0].append === "function"
        ? args[0]
        : document.getElementById("mc-settings") || document.body;
      const marker = document.createElement("div");
      marker.dataset.permissionsMounted = "true";
      marker.textContent = "mounted";
      host.append(marker);
    },
    refresh: (...args) => settingsSpies.refreshCalls.push({ label: "permissions-refresh", args }),
    unmount: (...args) => settingsSpies.refreshCalls.push({ label: "permissions-unmount", args }),
  },
};
global.App = win.App;

let fetchImpl = async () => ({ ok: true, json: async () => ({}) });
global.fetch = (...args) => fetchImpl(...args);

before(async () => {
  ({ ListAddAction } = await import("../src/frontend/ui/list-add-action.ts"));
  await import(`../src/frontend/services/chat-runtime-store.ts?settings-ui=${Date.now()}`);
  await import(`../src/frontend/services/preferences.ts?settings-ui=${Date.now()}`);
  await import("../src/frontend/dashboard/settings-general.ts");
  ({ SettingsCustomProviderEditor } = await import("../src/frontend/dashboard/settings-custom-provider-editor.ts"));
  await import("../src/frontend/dashboard/settings-provider-model.ts");
  await import("../src/frontend/dashboard/settings-custom-subagents.ts");
  await import("../src/frontend/dashboard/settings-storage.ts");
  await import("../src/frontend/dashboard/dashboard-settings.ts");
});

beforeEach(() => {
  document.body.innerHTML = "";
  document.documentElement.classList.remove("theme-light");
  storage.clear();
  Object.values(settingsSpies).forEach((calls) => { calls.length = 0; });
  delete win.__monaco;
  delete win.electronAPI;
  win.__state.D = null;
  win._provOrder = [];
  fetchImpl = async (url) => {
    if (String(url) === "/api/auth") return { ok: true, json: async () => ({ providers: [] }) };
    if (String(url) === "/api/custom-providers") return { ok: true, json: async () => ({ revision: 0, official: [], custom: [] }) };
    if (String(url) === "/api/custom-providers/capabilities") {
      return { ok: true, json: async () => ({
        protocols: [
          "openai-completions",
          "openai-responses",
          "anthropic-messages",
          "mistral-conversations",
          "azure-openai-responses",
          "pi-messages",
        ].map((id) => ({ id, authModes: ["none", "apiKey"], supportsCompatibility: true })),
        price: { currency: "USD", unit: "millionTokens" },
      }) };
    }
    if (String(url) === "/api/models") return { ok: true, json: async () => ({ models: [] }) };
    if (String(url) === "/api/subagents") return { ok: true, json: async () => ({ agents: [] }) };
    return { ok: true, json: async () => ({ ok: true }) };
  };
});

async function flushAsyncWork() {
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
  await Promise.resolve();
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

function customProvider(overrides = {}) {
  return {
    id: "acme",
    name: "Acme Gateway",
    protocol: "openai-responses",
    baseUrl: "https://api.example.test/v1",
    authMode: "apiKey",
    apiKeyConfigured: true,
    headers: [{ name: "X-Tenant", configured: true }],
    modelDiscovery: "/models",
    models: [
      {
        id: "model-a",
        name: "Model A",
        contextWindow: 128000,
        maxTokens: 8192,
        reasoning: true,
        input: ["text", "image"],
        cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0.2 },
        samplingParams: { temperature: 0.2 },
        compatibility: { supportsStore: false },
      },
      {
        id: "model-b",
        name: "Model B",
        contextWindow: 64000,
        maxTokens: 4096,
        reasoning: false,
        input: ["text"],
        cost: { input: 3, output: 4, cacheRead: 0, cacheWrite: 0 },
      },
    ],
    ...overrides,
  };
}

function response(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

function capabilities(protocolIds = [
  "openai-completions",
  "openai-responses",
  "anthropic-messages",
  "mistral-conversations",
  "azure-openai-responses",
  "pi-messages",
]) {
  return {
    protocols: protocolIds.map((id) => ({ id, authModes: ["none", "apiKey"], supportsCompatibility: true })),
    price: { currency: "USD", unit: "millionTokens" },
  };
}

function editorDependencies(overrides = {}) {
  return {
    notify: global.toast,
    listAddAction: ListAddAction,
    onSaved: () => {},
    onDeleted: () => {},
    ...overrides,
  };
}

function createCustomProviderEditor(overrides = {}) {
  const editor = new SettingsCustomProviderEditor(editorDependencies(overrides));
  editor.setProtocols(capabilities().protocols.map((protocol) => protocol.id));
  return editor;
}

function setInput(selector, value) {
  const input = document.querySelector(selector);
  assert.ok(input, `${selector} should be rendered`);
  input.value = value;
  input.dispatchEvent(new win.Event("input", { bubbles: true }));
  return input;
}

function activateButtonFromKeyboard(button, key) {
  const keydown = new win.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
  const keyup = new win.KeyboardEvent("keyup", { key, bubbles: true, cancelable: true });
  const allowKeydownDefault = button.dispatchEvent(keydown);
  if (!button.disabled && key === "Enter" && allowKeydownDefault) button.click();
  const allowKeyupDefault = button.dispatchEvent(keyup);
  if (!button.disabled && key === " " && allowKeyupDefault) button.click();
}

async function openGeneralSettings() {
  win.App.Settings.openSettingsModal();
  await flushAsyncWork();
  const generalTab = document.querySelector('.ms-item[data-st="general"]');
  assert.ok(generalTab, "General settings tab should be rendered");
  generalTab.click();
}

async function openSubagentSettings() {
  win.App.Settings.openSettingsModal();
  await flushAsyncWork();
  const tab = document.querySelector('.ms-item[data-st="subagents"]');
  assert.ok(tab, "Subagent settings tab should be rendered");
  tab.click();
}

function getControl(id) {
  const control = document.getElementById(id);
  assert.ok(control, `${id} should be rendered`);
  return control;
}

describe("settings DOM boundary", () => {
  it("publishes a native ListAddAction with single click and keyboard activation", () => {
    assert.strictEqual(win.App.Ui.ListAddAction, ListAddAction);

    for (const [name, activate] of [
      ["click", (button) => button.click()],
      ["Enter", (button) => activateButtonFromKeyboard(button, "Enter")],
      ["Space", (button) => activateButtonFromKeyboard(button, " ")],
    ]) {
      let activations = 0;
      const button = ListAddAction.create({
        id: `list-add-${name}`,
        label: `Add with ${name}`,
        onActivate: () => { activations += 1; },
      });
      document.body.append(button);
      activate(button);
      assert.strictEqual(activations, 1, `${name} should activate exactly once`);
      assert.strictEqual(button.type, "button");
    }
  });

  it("keeps disabled ListAddAction inert and renders hostile labels as text", () => {
    let activations = 0;
    const hostileLabel = '<img src=x onerror="globalThis.__listAddInjected=true">';
    const button = ListAddAction.create({
      label: hostileLabel,
      disabled: true,
      onActivate: () => { activations += 1; },
    });
    document.body.append(button);

    button.click();
    activateButtonFromKeyboard(button, "Enter");
    activateButtonFromKeyboard(button, " ");

    assert.strictEqual(activations, 0);
    assert.strictEqual(button.disabled, true);
    assert.strictEqual(button.querySelector(".list-add-action-label")?.textContent, hostileLabel);
    assert.strictEqual(button.querySelector("img"), null);
    assert.strictEqual(globalThis.__listAddInjected, undefined);
  });

  it("renders official and custom providers in one ordered list with a shared add action", async () => {
    storage.set("providers_order", JSON.stringify(["acme", "openai", "removed-provider"]));
    fetchImpl = async (url) => {
      if (String(url) === "/api/auth") return response({ providers: [{ provider: "openai", hasKey: false, keyPreview: "" }] });
      if (String(url) === "/api/custom-providers") return response({
        revision: 7,
        official: [
          { id: "openai", name: "OpenAI", configured: false },
          { id: "anthropic", name: "Anthropic", configured: true },
        ],
        custom: [customProvider()],
      });
      if (String(url) === "/api/custom-providers/capabilities") return response(capabilities());
      return response({ models: [] });
    };

    win.App.Settings.openSettingsModal();
    await flushAsyncWork();

    const list = document.querySelector(".msl-list");
    assert.ok(list);
    const items = [...list.querySelectorAll(".msl-item")];
    assert.deepStrictEqual(items.map((item) => item.dataset.prov), ["acme", "openai", "anthropic"]);
    assert.deepStrictEqual(win._provOrder, ["acme", "openai", "anthropic"]);
    assert.strictEqual(items[0].querySelector(".msl-kind")?.textContent, "自定义");
    assert.strictEqual(items[1].querySelector(".msl-kind"), null);
    const add = document.querySelector(".ms-left > .list-add-action-mount .list-add-action");
    assert.ok(add);
    assert.strictEqual(add.querySelector(".list-add-action-label")?.textContent, "添加自定义厂商");
  });

  it("requires an explicit auth choice for new drafts and exposes only six supported protocols", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    const editor = createCustomProviderEditor();
    editor.startNew(host, 3);

    const auth = [...host.querySelectorAll('input[name="cpe-auth-mode"]')];
    assert.deepStrictEqual(auth.map((input) => input.value), ["none", "apiKey"]);
    assert.strictEqual(auth.some((input) => input.checked), false);
    const protocols = [...host.querySelectorAll("#cpe-protocol option")].map((option) => option.value).filter(Boolean);
    assert.deepStrictEqual(protocols, [
      "openai-completions",
      "openai-responses",
      "anthropic-messages",
      "mistral-conversations",
      "azure-openai-responses",
      "pi-messages",
    ]);
    assert.strictEqual(protocols.includes("google-generative-ai"), false);
    assert.strictEqual(host.querySelector("details.cpe-advanced")?.hasAttribute("open"), false);

    await editor.save();
    assert.match(host.querySelector('[data-field-error="authMode"]')?.textContent ?? "", /选择/);
  });

  it("uses capabilities as the protocol option source and excludes unsupported protocols", async () => {
    fetchImpl = async (url) => {
      if (String(url) === "/api/auth") return response({ providers: [] });
      if (String(url) === "/api/custom-providers") return response({ revision: 3, official: [], custom: [] });
      if (String(url) === "/api/custom-providers/capabilities") {
        return response(capabilities([
          "openai-responses",
          "anthropic-messages",
          "google-generative-ai",
          "future-unsupported-protocol",
        ]));
      }
      return response({});
    };

    win.App.Settings.openSettingsModal();
    await flushAsyncWork();
    document.querySelector("#msl-add-action .list-add-action")?.click();

    const protocols = [...document.querySelectorAll("#cpe-protocol option")]
      .map((option) => option.value)
      .filter(Boolean);
    assert.deepStrictEqual(protocols, ["openai-responses", "anthropic-messages"]);
    assert.strictEqual(protocols.includes("google-generative-ai"), false);
  });

  it("keeps existing IDs readonly and treats configured Header values as write-only secrets", () => {
    const host = document.createElement("div");
    document.body.append(host);
    let revealRequests = 0;
    fetchImpl = async (url) => {
      if (String(url).includes("reveal")) revealRequests += 1;
      return response({});
    };
    const editor = createCustomProviderEditor();
    editor.mount(host, customProvider(), 4);

    assert.strictEqual(host.querySelector("#cpe-id")?.readOnly, true);
    assert.strictEqual(host.querySelector(".cpe-header-name")?.readOnly, true);
    assert.strictEqual(host.querySelector(".cpe-header-status")?.textContent, "已保存");
    assert.strictEqual(host.querySelector(".cpe-header-value")?.value, "");
    assert.match(host.querySelector(".cpe-header-value")?.placeholder ?? "", /留空保留/);
    assert.strictEqual(revealRequests, 0);
  });

  it("adds and removes multiple model rows while advanced settings remain collapsed", () => {
    const host = document.createElement("div");
    document.body.append(host);
    const editor = createCustomProviderEditor();
    editor.mount(host, customProvider(), 4);

    assert.strictEqual(host.querySelectorAll(".cpe-model-row").length, 2);
    host.querySelector('[data-cpe-action="add-model"]').click();
    assert.strictEqual(host.querySelectorAll(".cpe-model-row").length, 3);
    host.querySelector('.cpe-model-row [data-cpe-action="remove-model"]').click();
    assert.strictEqual(host.querySelectorAll(".cpe-model-row").length, 2);
    assert.strictEqual(host.querySelector("details.cpe-advanced")?.hasAttribute("open"), false);
  });

  it("creates providers with expectedRevision, then locks the ID and reports collisions inline", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    const requests = [];
    let savedSelection = null;
    fetchImpl = async (url, init = {}) => {
      if (String(url) === "/api/custom-providers" && init.method === "POST") {
        requests.push(JSON.parse(init.body));
        if (requests.length === 1) return response({ code: "provider_id_conflict", providerId: "openai" }, 409);
        return response({ schemaVersion: 1, revision: 6, providers: [customProvider({ id: "fresh", name: "Fresh" })] }, 201);
      }
      return response({});
    };
    const editor = createCustomProviderEditor({
      onSaved: (_snapshot, selectedId) => { savedSelection = selectedId; },
    });
    editor.startNew(host, 5);
    setInput("#cpe-name", "Fresh");
    setInput("#cpe-id", "openai");
    setInput("#cpe-base-url", "https://fresh.example/v1");
    setInput(".cpe-model-id", "fresh-model");
    setInput(".cpe-model-name", "Fresh Model");
    host.querySelector("#cpe-protocol").value = "openai-responses";
    host.querySelector('input[name="cpe-auth-mode"][value="none"]').click();

    await editor.save();
    assert.deepStrictEqual(requests[0].expectedRevision, 5);
    assert.match(host.querySelector('[data-field-error="id"]')?.textContent ?? "", /占用/);

    setInput("#cpe-id", "fresh");
    await editor.save();
    assert.strictEqual(savedSelection, "fresh");
    assert.strictEqual(host.querySelector("#cpe-id")?.readOnly, true);
  });

  it("omits unchanged secrets and sends explicit API key/header clears", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    const bodies = [];
    fetchImpl = async (_url, init = {}) => {
      bodies.push(JSON.parse(init.body));
      return response({ schemaVersion: 1, revision: 9, providers: [customProvider()] });
    };
    const editor = createCustomProviderEditor();
    editor.mount(host, customProvider(), 8);
    await editor.save();
    assert.strictEqual("apiKey" in bodies[0].provider, false);
    assert.deepStrictEqual(bodies[0].provider.headers, [{ name: "X-Tenant" }]);

    host.querySelector('[data-cpe-action="clear-api-key"]').click();
    host.querySelector('[data-cpe-action="remove-header"]').click();
    await editor.save();
    assert.strictEqual(bodies[1].provider.apiKey, null);
    assert.deepStrictEqual(bodies[1].provider.headers, [{ name: "X-Tenant", remove: true }]);
  });

  it("cancels API key clear intent when a replacement is entered", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    const bodies = [];
    fetchImpl = async (_url, init = {}) => {
      bodies.push(JSON.parse(init.body));
      return response({ schemaVersion: 1, revision: 9, providers: [customProvider()] });
    };
    const editor = createCustomProviderEditor();
    editor.mount(host, customProvider(), 8);

    host.querySelector('[data-cpe-action="clear-api-key"]').click();
    setInput("#cpe-api-key", "abc");
    await editor.save();
    assert.strictEqual(bodies[0].provider.apiKey, "abc");

    setInput("#cpe-api-key", "");
    await editor.save();
    assert.strictEqual("apiKey" in bodies[1].provider, false);
  });

  it("keeps configured Header names immutable and replaces them through explicit remove plus add", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    const bodies = [];
    fetchImpl = async (_url, init = {}) => {
      bodies.push(JSON.parse(init.body));
      return response({ schemaVersion: 1, revision: 9, providers: [customProvider()] });
    };
    const editor = createCustomProviderEditor();
    editor.mount(host, customProvider(), 8);

    const configuredName = host.querySelector(".cpe-header-name");
    assert.strictEqual(configuredName.readOnly, true);
    assert.match(configuredName.title, /删除.*新增/);
    assert.match(configuredName.getAttribute("aria-label") ?? "", /已配置/);
    setInput(".cpe-header-name", "X-Renamed");
    await editor.save();
    assert.deepStrictEqual(bodies[0].provider.headers, [{ name: "X-Tenant" }]);

    host.querySelector('[data-cpe-action="remove-header"]').click();
    host.querySelector('[data-cpe-action="add-header"]').click();
    const newName = host.querySelector('.cpe-header-row:not([data-configured="true"]) .cpe-header-name');
    const newValue = host.querySelector('.cpe-header-row:not([data-configured="true"]) .cpe-header-value');
    assert.strictEqual(newName.readOnly, false);
    newName.value = "X-New-Tenant";
    newName.dispatchEvent(new win.Event("input", { bubbles: true }));
    newValue.value = "new-secret";
    newValue.dispatchEvent(new win.Event("input", { bubbles: true }));
    await editor.save();
    assert.deepStrictEqual(bodies[1].provider.headers, [
      { name: "X-Tenant", remove: true },
      { name: "X-New-Tenant", value: "new-secret" },
    ]);
  });

  it("renders hostile configured Header names as inert readonly values", () => {
    const host = document.createElement("div");
    document.body.append(host);
    const hostile = '<img id="header-name-xss" src=x>';
    const editor = createCustomProviderEditor();
    editor.mount(host, customProvider({ headers: [{ name: hostile, configured: true }] }), 8);

    const name = host.querySelector(".cpe-header-name");
    assert.strictEqual(name.value, hostile);
    assert.strictEqual(name.readOnly, true);
    assert.strictEqual(host.querySelector("#header-name-xss"), null);
  });

  it("blocks unconfigured Headers with an empty or invalid name without dropping the row", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    let requests = 0;
    fetchImpl = async () => {
      requests += 1;
      return response({});
    };
    const editor = createCustomProviderEditor();
    editor.mount(host, customProvider({ headers: [] }), 8);
    host.querySelector('[data-cpe-action="add-header"]').click();
    assert.strictEqual(host.querySelector(".cpe-header-name")?.readOnly, false);
    setInput(".cpe-header-value", "xy");

    await editor.save();
    assert.strictEqual(requests, 0);
    assert.strictEqual(host.querySelectorAll(".cpe-header-row").length, 1);
    assert.match(host.querySelector(".cpe-header-error")?.textContent ?? "", /Header/);

    setInput(".cpe-header-name", "bad header");
    await editor.save();
    assert.strictEqual(requests, 0);
    assert.match(host.querySelector(".cpe-header-error")?.textContent ?? "", /Header/);
  });

  it("imports discovered model IDs only after explicit user confirmation", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    const discoveryDrafts = [];
    fetchImpl = async (url, init = {}) => {
      if (!String(url).endsWith("discover-models")) return response({});
      discoveryDrafts.push(JSON.parse(init.body).provider);
      return response({ ids: ["model-a", "discovered-x"] });
    };
    const editor = createCustomProviderEditor();
    editor.mount(host, customProvider({ models: [customProvider().models[0]] }), 2);
    const originalConfirm = win.confirm;
    win.confirm = () => false;
    await editor.discoverModels();
    assert.deepStrictEqual([...host.querySelectorAll(".cpe-model-id")].map((input) => input.value), ["model-a"]);
    assert.strictEqual(discoveryDrafts[0].modelDiscovery, "/models");
    win.confirm = () => true;
    await editor.discoverModels();
    assert.deepStrictEqual([...host.querySelectorAll(".cpe-model-id")].map((input) => input.value), ["model-a", "discovered-x"]);
    win.confirm = originalConfirm;
  });

  it("redacts hostile short draft secrets from failed connection text and notifications", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    const apiKey = "abc";
    const headerSecret = "xy";
    fetchImpl = async () => response({
      ok: false,
      code: "authentication",
      message: `bad key=${apiKey} header=${headerSecret} <img id=network-xss>`,
    });
    const editor = createCustomProviderEditor();
    editor.mount(host, customProvider(), 2);
    setInput("#cpe-api-key", apiKey);
    setInput(".cpe-header-value", headerSecret);

    await editor.test();
    const result = host.querySelector(".cpe-result");
    assert.ok(result);
    assert.strictEqual(result.textContent.includes(apiKey), false);
    assert.strictEqual(result.textContent.includes(headerSecret), false);
    assert.strictEqual(result.textContent.includes("[REDACTED]"), true);
    assert.strictEqual(host.querySelector("#network-xss"), null);
    assert.strictEqual(host.querySelector('[data-cpe-action="save"]').disabled, false);
    assert.strictEqual(JSON.stringify(settingsSpies.toastCalls).includes(apiKey), false);
    assert.strictEqual(JSON.stringify(settingsSpies.toastCalls).includes(headerSecret), false);
  });

  it("keeps official auth, reveal, and models usable when capabilities cannot be decoded", async () => {
    const unhandled = [];
    const onUnhandled = (error) => { unhandled.push(error); };
    process.on("unhandledRejection", onUnhandled);
    try {
      for (const failure of ["reject", "invalid-json"]) {
        document.body.innerHTML = '<div id="provider-host"></div>';
        win._provOrder = [];
        let revealRequests = 0;
        let modelRequests = 0;
        fetchImpl = async (url) => {
          if (String(url) === "/api/auth") {
            return response({ providers: [{ provider: "openai", hasKey: true, canReveal: true, keyPreview: "sk-preview" }] });
          }
          if (String(url) === "/api/auth/reveal") {
            revealRequests += 1;
            return response({ ok: true, apiKey: "sk-official-secret" });
          }
          if (String(url) === "/api/models") {
            modelRequests += 1;
            return response({ models: [{ provider: "openai", id: "official-model" }] });
          }
          if (String(url) === "/api/custom-providers") {
            return response({ revision: 4, official: [{ id: "openai", name: "OpenAI", configured: true }], custom: [] });
          }
          if (String(url) === "/api/custom-providers/capabilities") {
            if (failure === "reject") throw new Error("capabilities offline");
            return { ok: true, json: async () => { throw new SyntaxError("invalid capabilities JSON"); } };
          }
          return response({});
        };

        win.App.SettingsComponents.providers.renderTab(document.querySelector("#provider-host"));
        await flushAsyncWork();
        await flushAsyncWork();

        assert.ok(document.querySelector('.msl-item[data-prov="openai"]'), `${failure}: official provider should render`);
        assert.strictEqual(document.querySelector(".rp-prov-name")?.textContent, "openai");
        assert.strictEqual(document.querySelector("#key-input")?.value, "sk-official-secret");
        assert.strictEqual(document.querySelector(".rp-model-item")?.textContent, "official-model");
        assert.ok(revealRequests > 0, `${failure}: reveal should run`);
        assert.ok(modelRequests > 0, `${failure}: models should run`);
        assert.strictEqual(document.querySelector("#msl-add-action .list-add-action")?.disabled, true);
        assert.match(document.querySelector(".msl-custom-status")?.textContent ?? "", /自定义厂商不可用/);
      }
      await flushAsyncWork();
      assert.deepStrictEqual(unhandled, []);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("reloads the latest revision after a stale write while preserving unsaved values", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    let calls = 0;
    fetchImpl = async (url, init = {}) => {
      calls += 1;
      if (init.method === "PUT") return response({ code: "revision_conflict", currentRevision: 12 }, 409);
      if (String(url) === "/api/custom-providers") return response({ revision: 12, official: [], custom: [customProvider({ name: "Server Name" })] });
      return response({});
    };
    const editor = createCustomProviderEditor();
    editor.mount(host, customProvider(), 10);
    setInput("#cpe-name", "Unsaved Local Name");

    await editor.save();
    assert.ok(calls >= 2);
    assert.strictEqual(host.querySelector("#cpe-name")?.value, "Unsaved Local Name");
    assert.match(host.querySelector(".cpe-conflict-banner")?.textContent ?? "", /版本冲突/);
    assert.match(host.querySelector(".cpe-conflict-banner")?.textContent ?? "", /12/);
  });

  it("renders provider/model reference conflicts as a structured occupancy list", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    fetchImpl = async () => response({
      code: "provider_in_use",
      references: [
        { kind: "currentModel", providerId: "acme", modelId: "model-a" },
        { kind: "customAgent", providerId: "acme", modelId: "model-b", agentId: "review", agentName: "Review Agent" },
      ],
    }, 409);
    const editor = createCustomProviderEditor();
    editor.mount(host, customProvider(), 4);

    await editor.save();
    const list = host.querySelector(".cpe-occupancy-list");
    assert.ok(list);
    assert.strictEqual(list.querySelectorAll("li").length, 2);
    assert.match(list.textContent, /model-a/);
    assert.match(list.textContent, /Review Agent/);
  });

  it("requires two delete clicks and writes the current revision", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    const requests = [];
    fetchImpl = async (url, init = {}) => {
      requests.push([String(url), init.method, JSON.parse(init.body)]);
      return response({ schemaVersion: 1, revision: 5, providers: [] });
    };
    const editor = createCustomProviderEditor();
    editor.mount(host, customProvider(), 4);

    await editor.delete();
    assert.strictEqual(requests.length, 0);
    assert.strictEqual(host.querySelector('[data-cpe-action="delete"]')?.classList.contains("armed"), true);
    await editor.delete();
    assert.deepStrictEqual(requests, [["/api/custom-providers/acme", "DELETE", { expectedRevision: 4 }]]);
  });

  it("renders hostile custom provider, model, and network error values as inert text", async () => {
    const hostile = '<img id="custom-provider-xss" src=x>';
    const provider = customProvider({
      id: "hostile-id",
      name: hostile,
      models: [{ ...customProvider().models[0], id: hostile, name: hostile }],
    });
    fetchImpl = async (url) => {
      if (String(url) === "/api/auth") return response({ providers: [] });
      if (String(url) === "/api/custom-providers") return response({ revision: 1, official: [], custom: [provider] });
      if (String(url) === "/api/custom-providers/capabilities") return response(capabilities());
      return response({ error: hostile, code: "upstream" }, 502);
    };

    win.App.Settings.openSettingsModal();
    await flushAsyncWork();
    const item = document.querySelector('.msl-item[data-prov="hostile-id"]');
    assert.strictEqual(item?.querySelector(".msl-name")?.textContent, hostile);
    item.click();
    assert.strictEqual(document.querySelector("#cpe-name")?.value, hostile);
    assert.strictEqual(document.querySelector(".cpe-model-id")?.value, hostile);
    await win.App.SettingsComponents.providers.customEditor.test();
    assert.strictEqual(document.querySelector(".cpe-result")?.textContent.includes(hostile), true);
    assert.strictEqual(document.querySelector("#custom-provider-xss"), null);
  });

  it("invalidates pending custom provider queries when another provider is mounted", async () => {
    const beta = customProvider({ id: "beta", name: "Beta Gateway" });
    const outcomes = {
      test: response({ ok: false, code: "late", message: "late test error" }, 502),
      discover: response({ ids: ["late-model"] }),
    };

    for (const action of Object.keys(outcomes)) {
      const host = document.createElement("div");
      document.body.replaceChildren(host);
      settingsSpies.toastCalls.length = 0;
      const pending = deferred();
      const requests = [];
      let confirmations = 0;
      const originalConfirm = win.confirm;
      win.confirm = () => { confirmations += 1; return true; };
      fetchImpl = async (url, init = {}) => {
        requests.push({ url: String(url), signal: init.signal });
        return pending.promise;
      };
      const editor = createCustomProviderEditor();
      editor.mount(host, customProvider(), 4);

      const operation = editor[action === "discover" ? "discoverModels" : action]();
      await Promise.resolve();
      assert.strictEqual(requests.length, 1, `${action}: request should start`);

      editor.mount(host, beta, 9);
      assert.strictEqual(requests[0].signal?.aborted, true, `${action}: switching providers must abort the request`);
      pending.resolve(outcomes[action]);
      await operation;

      assert.strictEqual(host.querySelector("#cpe-id")?.value, "beta", `${action}: late result must not replace provider B`);
      assert.strictEqual(host.querySelector(".cpe-result")?.hidden, true, `${action}: late result must not update provider B status`);
      assert.deepStrictEqual([...host.querySelectorAll(".cpe-model-id")].map((input) => input.value), ["model-a", "model-b"]);
      assert.strictEqual(confirmations, 0, `${action}: stale discovery must not prompt`);
      assert.deepStrictEqual(settingsSpies.toastCalls, []);
      win.confirm = originalConfirm;
    }
  });

  it("keeps save and delete authoritative while releasing their UI lock on a new mount", async () => {
    const beta = customProvider({ id: "beta", name: "Beta Gateway" });
    for (const action of ["save", "delete"]) {
      const host = document.createElement("div");
      document.body.replaceChildren(host);
      const pending = deferred();
      const requests = [];
      const savedSnapshots = [];
      const deletedSnapshots = [];
      fetchImpl = async (url, init = {}) => {
        requests.push({ url: String(url), signal: init.signal });
        return pending.promise;
      };
      const editor = createCustomProviderEditor({
        onSaved: (snapshot) => savedSnapshots.push(snapshot),
        onDeleted: (snapshot) => deletedSnapshots.push(snapshot),
      });
      editor.mount(host, customProvider(), 4);

      let operation;
      if (action === "delete") {
        await editor.delete();
        operation = editor.delete();
      } else operation = editor.save();
      await Promise.resolve();
      const mutationRequest = requests[0];
      assert.ok(mutationRequest);
      for (const selector of ["save", "delete", "test", "discover", "reveal-api-key"]) {
        assert.strictEqual(host.querySelector(`[data-cpe-action="${selector}"]`)?.disabled, true, `${action}: ${selector} must be disabled`);
      }

      await editor.test();
      await editor.discoverModels();
      host.querySelector('[data-cpe-action="reveal-api-key"]')?.click();
      assert.strictEqual(requests.length, 1, `${action}: queries cannot supersede a mutation`);
      assert.strictEqual(mutationRequest.signal?.aborted, false);

      editor.mount(host, beta, 4);
      setInput("#cpe-name", "Unsaved Beta Name");
      assert.strictEqual(mutationRequest.signal?.aborted, false, `${action}: mount must not abort mutation`);
      for (const selector of ["save", "delete", "test", "discover", "reveal-api-key"]) {
        assert.strictEqual(host.querySelector(`[data-cpe-action="${selector}"]`)?.disabled, false, `${action}: ${selector} must be released`);
      }
      assert.strictEqual(requests.length, 1);

      const snapshot = {
        schemaVersion: 1,
        revision: 5,
        providers: action === "save"
          ? [customProvider({ name: "Saved Acme" }), beta]
          : [beta],
      };
      pending.resolve(response(snapshot));
      await operation;

      assert.strictEqual(host.querySelector("#cpe-id")?.value, "beta");
      assert.strictEqual(host.querySelector("#cpe-name")?.value, "Unsaved Beta Name");
      assert.strictEqual(host.querySelector('[data-cpe-action="test"]')?.disabled, false);
      assert.strictEqual(host.querySelector('[aria-busy="true"]'), null);
      assert.deepStrictEqual(savedSnapshots, action === "save" ? [snapshot] : []);
      assert.deepStrictEqual(deletedSnapshots, action === "delete" ? [snapshot] : []);
    }
  });

  it("preserves an active unsaved-new draft when an older provider mutation completes", async () => {
    const beta = customProvider({ id: "beta", name: "Beta Gateway" });
    for (const action of ["save", "delete"]) {
      document.body.innerHTML = "";
      win._provOrder = [];
      const pending = deferred();
      let newDraftRequest;
      fetchImpl = async (url, init = {}) => {
        if (String(url) === "/api/auth") return response({ providers: [] });
        if (String(url) === "/api/custom-providers" && !init.method) {
          return response({ revision: 4, official: [], custom: [customProvider(), beta] });
        }
        if (String(url) === "/api/custom-providers/capabilities") return response(capabilities());
        if (init.method === "PUT" || init.method === "DELETE") return pending.promise;
        if (init.method === "POST") {
          newDraftRequest = JSON.parse(init.body);
          return response({
            schemaVersion: 1,
            revision: 6,
            providers: [beta, customProvider({ id: "fresh", name: "Unsaved Fresh" })],
          }, 201);
        }
        return response({});
      };
      win.App.Settings.openSettingsModal();
      await flushAsyncWork();
      const editor = win.App.SettingsComponents.providers.customEditor;
      let operation;
      if (action === "delete") {
        await editor.delete();
        operation = editor.delete();
      } else operation = editor.save();
      await Promise.resolve();

      document.querySelector("#msl-add-action .list-add-action")?.click();
      setInput("#cpe-name", "Unsaved Fresh");
      setInput("#cpe-id", "fresh");
      setInput("#cpe-base-url", "https://fresh.example.test/v1");
      setInput(".cpe-model-id", "fresh-model");
      setInput(".cpe-model-name", "Fresh Model");
      document.querySelector("#cpe-protocol").value = "openai-responses";
      document.querySelector('input[name="cpe-auth-mode"][value="none"]').click();

      const snapshot = {
        schemaVersion: 1,
        revision: 5,
        providers: action === "save"
          ? [customProvider({ name: "Saved Acme" }), beta]
          : [beta],
      };
      pending.resolve(response(snapshot));
      await operation;

      assert.strictEqual(document.querySelector("#cpe-id")?.value, "fresh");
      assert.strictEqual(document.querySelector("#cpe-name")?.value, "Unsaved Fresh");
      assert.strictEqual(document.querySelector("#cpe-id")?.readOnly, false);
      assert.strictEqual(document.querySelector(".msl-item.on"), null);
      if (action === "save") assert.strictEqual(document.querySelector('.msl-item[data-prov="acme"] .msl-name')?.textContent, "Saved Acme");
      else assert.strictEqual(document.querySelector('.msl-item[data-prov="acme"]'), null);

      await editor.save();
      assert.strictEqual(newDraftRequest?.expectedRevision, 5, `${action}: authority revision must advance without replacing the draft`);
      win.App.Settings.closeSettingsModal();
    }
  });

  it("keeps owner and editor revisions monotonic after a newer reload", async () => {
    const beta = customProvider({ id: "beta", name: "Beta Gateway" });
    const pending = deferred();
    let customLoads = 0;
    let puts = 0;
    let latestWrite;
    const revisionSixProviders = [
      customProvider({ name: "Fresh Acme" }),
      beta,
      customProvider({ id: "gamma", name: "Gamma" }),
    ];
    fetchImpl = async (url, init = {}) => {
      if (String(url) === "/api/auth") return response({ providers: [] });
      if (String(url) === "/api/custom-providers" && !init.method) {
        customLoads += 1;
        return customLoads === 1
          ? response({ revision: 4, official: [], custom: [customProvider(), beta] })
          : response({ revision: 6, official: [], custom: revisionSixProviders });
      }
      if (String(url) === "/api/custom-providers/capabilities") return response(capabilities());
      if (init.method === "PUT") {
        puts += 1;
        if (puts === 1) return pending.promise;
        latestWrite = JSON.parse(init.body);
        return response({ schemaVersion: 1, revision: 7, providers: revisionSixProviders });
      }
      return response({});
    };

    win.App.Settings.openSettingsModal();
    await flushAsyncWork();
    const editor = win.App.SettingsComponents.providers.customEditor;
    const oldSave = editor.save();
    await Promise.resolve();
    win.App.Settings.closeSettingsModal();
    win.App.Settings.openSettingsModal();
    await flushAsyncWork();
    document.querySelector('.msl-item[data-prov="beta"]').click();
    setInput("#cpe-name", "Unsaved Beta Six");

    pending.resolve(response({
      schemaVersion: 1,
      revision: 5,
      providers: [customProvider({ name: "Stale Acme" }), beta],
    }));
    await oldSave;

    assert.strictEqual(document.querySelector('.msl-item[data-prov="acme"] .msl-name')?.textContent, "Fresh Acme");
    assert.ok(document.querySelector('.msl-item[data-prov="gamma"]'));
    assert.strictEqual(document.querySelector("#cpe-name")?.value, "Unsaved Beta Six");
    assert.strictEqual(document.querySelector(".cpe-revision")?.textContent, "Revision 6");
    await editor.save();
    assert.strictEqual(latestWrite?.expectedRevision, 6);
    win.App.Settings.closeSettingsModal();
  });

  it("keeps mutation authority ready when the pending list load later rejects", async () => {
    const pendingMutation = deferred();
    const pendingList = deferred();
    const pendingCapabilities = deferred();
    let customLoads = 0;
    let capabilityLoads = 0;
    fetchImpl = async (url, init = {}) => {
      if (String(url) === "/api/auth") return response({ providers: [] });
      if (String(url) === "/api/custom-providers" && !init.method) {
        customLoads += 1;
        return customLoads === 1
          ? response({ revision: 4, official: [], custom: [customProvider()] })
          : pendingList.promise;
      }
      if (String(url) === "/api/custom-providers/capabilities") {
        capabilityLoads += 1;
        return capabilityLoads === 1 ? response(capabilities()) : pendingCapabilities.promise;
      }
      if (init.method === "PUT") return pendingMutation.promise;
      return response({});
    };

    win.App.Settings.openSettingsModal();
    await flushAsyncWork();
    const editor = win.App.SettingsComponents.providers.customEditor;
    const oldSave = editor.save();
    await Promise.resolve();
    win.App.Settings.closeSettingsModal();
    win.App.Settings.openSettingsModal();
    await flushAsyncWork();

    pendingMutation.resolve(response({
      schemaVersion: 1,
      revision: 5,
      providers: [customProvider({ name: "Mutation Authority" })],
    }));
    await oldSave;
    pendingCapabilities.resolve(response(capabilities()));
    await flushAsyncWork();
    const add = document.querySelector("#msl-add-action .list-add-action");
    assert.strictEqual(add?.disabled, false);
    add.click();
    setInput("#cpe-name", "Unsaved After Authority");
    setInput("#cpe-id", "unsaved-authority");

    pendingList.reject(new Error("late list failure"));
    await flushAsyncWork();

    assert.strictEqual(add.disabled, false);
    assert.strictEqual(document.querySelector(".msl-custom-status")?.hidden, true);
    assert.strictEqual(document.querySelector('.msl-item[data-prov="acme"] .msl-name')?.textContent, "Mutation Authority");
    assert.strictEqual(document.querySelector("#cpe-name")?.value, "Unsaved After Authority");
    assert.strictEqual(document.querySelector("#cpe-id")?.value, "unsaved-authority");
    win.App.Settings.closeSettingsModal();
  });

  it("converges availability when a pending list load equals mutation authority", async () => {
    const pendingMutation = deferred();
    const pendingList = deferred();
    let customLoads = 0;
    fetchImpl = async (url, init = {}) => {
      if (String(url) === "/api/auth") return response({ providers: [] });
      if (String(url) === "/api/custom-providers" && !init.method) {
        customLoads += 1;
        return customLoads === 1
          ? response({ revision: 4, official: [], custom: [customProvider()] })
          : pendingList.promise;
      }
      if (String(url) === "/api/custom-providers/capabilities") return response(capabilities());
      if (init.method === "PUT") return pendingMutation.promise;
      return response({});
    };

    win.App.Settings.openSettingsModal();
    await flushAsyncWork();
    const editor = win.App.SettingsComponents.providers.customEditor;
    const oldSave = editor.save();
    await Promise.resolve();
    win.App.Settings.closeSettingsModal();
    win.App.Settings.openSettingsModal();
    await flushAsyncWork();

    const authority = customProvider({ name: "Mutation Authority" });
    pendingMutation.resolve(response({ schemaVersion: 1, revision: 5, providers: [authority] }));
    await oldSave;

    pendingList.resolve(response({ revision: 5, official: [], custom: [customProvider({ name: "Equal GET" })] }));
    await flushAsyncWork();

    assert.strictEqual(document.querySelector("#msl-add-action .list-add-action")?.disabled, false);
    assert.strictEqual(document.querySelector(".msl-custom-status")?.hidden, true);
    assert.strictEqual(document.querySelector('.msl-item[data-prov="acme"] .msl-name')?.textContent, "Mutation Authority");
    assert.strictEqual(document.querySelector("#cpe-name")?.value, "Mutation Authority");
    win.App.Settings.closeSettingsModal();
  });

  it("does not roll expectedRevision back from stale conflict metadata", async () => {
    const host = document.createElement("div");
    document.body.replaceChildren(host);
    let writes = 0;
    let retryBody;
    fetchImpl = async (url, init = {}) => {
      if (init.method === "PUT") {
        writes += 1;
        if (writes === 1) return response({ code: "revision_conflict", currentRevision: 5 }, 409);
        retryBody = JSON.parse(init.body);
        return response({ schemaVersion: 1, revision: 7, providers: [customProvider()] });
      }
      if (String(url) === "/api/custom-providers") return response({ revision: 5, official: [], custom: [customProvider()] });
      return response({});
    };
    const editor = createCustomProviderEditor();
    editor.mount(host, customProvider(), 6);

    await editor.save();
    await editor.save();

    assert.strictEqual(retryBody?.expectedRevision, 6);
  });

  it("detaches hanging mutations so a remount remains usable and observes late settle", async () => {
    const beta = customProvider({ id: "beta", name: "Beta Gateway" });
    for (const outcome of ["resolve", "reject"]) {
      const host = document.createElement("div");
      document.body.replaceChildren(host);
      const pending = deferred();
      const requests = [];
      const snapshots = [];
      const unhandled = [];
      const onUnhandled = (error) => { unhandled.push(error); };
      process.on("unhandledRejection", onUnhandled);
      fetchImpl = async (url, init = {}) => {
        requests.push({ url: String(url), signal: init.signal });
        if (String(url) === "/api/custom-providers/test") return response({ ok: true, modelId: "beta-model" });
        return pending.promise;
      };
      const editor = createCustomProviderEditor({ onSaved: (snapshot) => snapshots.push(snapshot) });
      editor.mount(host, customProvider(), 4);
      const oldSave = editor.save();
      await Promise.resolve();

      editor.unmount();
      editor.mount(host, beta, 6);
      setInput("#cpe-name", "Unsaved Beta Active");
      for (const selector of ["save", "delete", "test", "discover", "reveal-api-key"]) {
        assert.strictEqual(host.querySelector(`[data-cpe-action="${selector}"]`)?.disabled, false, `${outcome}: ${selector} must be usable`);
      }
      await editor.test();
      assert.strictEqual(requests.length, 2);
      assert.strictEqual(requests[0].signal?.aborted, false);

      const lateSnapshot = { schemaVersion: 1, revision: 5, providers: [customProvider(), beta] };
      if (outcome === "resolve") pending.resolve(response(lateSnapshot));
      else pending.reject(new Error("late detached failure"));
      await oldSave;
      await flushAsyncWork();

      assert.strictEqual(host.querySelector("#cpe-id")?.value, "beta");
      assert.strictEqual(host.querySelector("#cpe-name")?.value, "Unsaved Beta Active");
      assert.strictEqual(host.querySelector(".cpe-result")?.textContent.includes("late detached failure"), false);
      assert.deepStrictEqual(snapshots, outcome === "resolve" ? [lateSnapshot] : []);
      assert.deepStrictEqual(unhandled, []);
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("accepts only non-negative safe-integer custom provider snapshot revisions", async () => {
    for (const revision of [-1, 4.5, "5", Number.NaN, Number.MAX_SAFE_INTEGER + 1]) {
      const host = document.createElement("div");
      document.body.replaceChildren(host);
      let saved = 0;
      fetchImpl = async () => response({ schemaVersion: 1, revision, providers: [customProvider()] });
      const editor = createCustomProviderEditor({ onSaved: () => { saved += 1; } });
      editor.mount(host, customProvider(), 4);

      await editor.save();

      assert.strictEqual(saved, 0, String(revision));
      assert.match(host.querySelector(".cpe-result")?.textContent ?? "", /响应无效/);
    }

    const host = document.createElement("div");
    document.body.replaceChildren(host);
    let requestBody;
    let saved = 0;
    fetchImpl = async (_url, init = {}) => {
      requestBody = JSON.parse(init.body);
      return response({
        schemaVersion: 1,
        revision: Number.MAX_SAFE_INTEGER,
        providers: [customProvider()],
      });
    };
    const editor = createCustomProviderEditor({ onSaved: () => { saved += 1; } });
    editor.mount(host, customProvider(), Number.MAX_SAFE_INTEGER - 1);

    await editor.save();

    assert.strictEqual(requestBody.expectedRevision, Number.MAX_SAFE_INTEGER - 1);
    assert.strictEqual(saved, 1);
    assert.strictEqual(host.querySelector(".cpe-revision")?.textContent, `Revision ${Number.MAX_SAFE_INTEGER}`);
  });

  it("rejects unsafe owner and conflict revisions without changing authority", async () => {
    fetchImpl = async (url) => {
      if (String(url) === "/api/auth") return response({ providers: [] });
      if (String(url) === "/api/custom-providers") {
        return response({
          revision: Number.MAX_SAFE_INTEGER + 1,
          official: [],
          custom: [customProvider({ name: "Unsafe Owner" })],
        });
      }
      if (String(url) === "/api/custom-providers/capabilities") return response(capabilities());
      return response({});
    };
    win.App.Settings.openSettingsModal();
    await flushAsyncWork();
    assert.strictEqual(document.querySelector('.msl-item[data-prov="acme"]'), null);
    assert.strictEqual(document.querySelector("#msl-add-action .list-add-action")?.disabled, true);
    win.App.Settings.closeSettingsModal();

    for (const { currentRevision, reloadRevision, expectedRevision } of [
      { currentRevision: Number.MAX_SAFE_INTEGER, reloadRevision: Number.MAX_SAFE_INTEGER + 1, expectedRevision: Number.MAX_SAFE_INTEGER },
      { currentRevision: Number.MAX_SAFE_INTEGER + 1, reloadRevision: Number.MAX_SAFE_INTEGER, expectedRevision: Number.MAX_SAFE_INTEGER },
      { currentRevision: Number.MAX_SAFE_INTEGER + 1, reloadRevision: Number.NaN, expectedRevision: 6 },
    ]) {
      const host = document.createElement("div");
      document.body.replaceChildren(host);
      let writes = 0;
      let retryBody;
      fetchImpl = async (_url, init = {}) => {
        if (init.method === "PUT") {
          writes += 1;
          if (writes === 1) return response({ code: "revision_conflict", currentRevision }, 409);
          retryBody = JSON.parse(init.body);
          return response({ schemaVersion: 1, revision: expectedRevision, providers: [customProvider()] });
        }
        return response({ revision: reloadRevision, official: [], custom: [customProvider()] });
      };
      const editor = createCustomProviderEditor();
      editor.mount(host, customProvider(), 6);

      await editor.save();
      await editor.save();

      assert.strictEqual(retryBody?.expectedRevision, expectedRevision, `${currentRevision}/${reloadRevision}`);
    }
  });

  it("treats an equal-revision mutation snapshot as an idempotent authority no-op", async () => {
    const host = document.createElement("div");
    document.body.replaceChildren(host);
    const snapshots = [];
    fetchImpl = async () => response({
      schemaVersion: 1,
      revision: 4,
      providers: [customProvider({ name: "Divergent Equal Name" })],
    });
    const editor = createCustomProviderEditor({ onSaved: (snapshot) => snapshots.push(snapshot) });
    editor.mount(host, customProvider(), 4);

    await editor.save();

    assert.strictEqual(host.querySelector("#cpe-name")?.value, "Acme Gateway");
    assert.strictEqual(host.querySelector(".cpe-revision")?.textContent, "Revision 4");
    assert.strictEqual(settingsSpies.toastCalls.some(([message]) => message === "已保存"), false);
    assert.strictEqual(snapshots.length, 1, "equal snapshots remain observed by the authority channel");
  });

  it("applies late mutation snapshots in the owner without replacing the newly selected draft", async () => {
    const beta = customProvider({ id: "beta", name: "Beta Gateway" });
    for (const action of ["save", "delete"]) {
      document.body.innerHTML = "";
      win._provOrder = [];
      const pending = deferred();
      let mutationSignal;
      fetchImpl = async (url, init = {}) => {
        if (String(url) === "/api/auth") return response({ providers: [] });
        if (String(url) === "/api/custom-providers") {
          return response({ revision: 4, official: [], custom: [customProvider(), beta] });
        }
        if (String(url) === "/api/custom-providers/capabilities") return response(capabilities());
        if (init.method === "PUT" || init.method === "DELETE") {
          mutationSignal = init.signal;
          return pending.promise;
        }
        return response({});
      };
      win.App.Settings.openSettingsModal();
      await flushAsyncWork();
      const editor = win.App.SettingsComponents.providers.customEditor;
      let operation;
      if (action === "delete") {
        await editor.delete();
        operation = editor.delete();
      } else operation = editor.save();
      await Promise.resolve();

      document.querySelector('.msl-item[data-prov="beta"]').click();
      setInput("#cpe-name", "Unsaved Beta Name");
      const snapshot = {
        schemaVersion: 1,
        revision: 5,
        providers: action === "save"
          ? [customProvider({ name: "Saved Acme" }), beta]
          : [beta],
      };
      pending.resolve(response(snapshot));
      await operation;

      assert.strictEqual(mutationSignal?.aborted, false);
      assert.strictEqual(document.querySelector('.msl-item[data-prov="beta"]')?.classList.contains("on"), true);
      assert.strictEqual(document.querySelector("#cpe-id")?.value, "beta");
      assert.strictEqual(document.querySelector("#cpe-name")?.value, "Unsaved Beta Name");
      if (action === "save") assert.strictEqual(document.querySelector('.msl-item[data-prov="acme"] .msl-name')?.textContent, "Saved Acme");
      else assert.strictEqual(document.querySelector('.msl-item[data-prov="acme"]'), null);
      win.App.Settings.closeSettingsModal();
    }
  });

  it("deduplicates an action and lets a newer different action supersede it", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    const first = deferred();
    const second = deferred();
    const requests = [];
    fetchImpl = async (url, init = {}) => {
      requests.push({ url: String(url), signal: init.signal });
      return requests.length === 1 ? first.promise : second.promise;
    };
    const editor = createCustomProviderEditor();
    editor.mount(host, customProvider(), 4);

    const firstTest = editor.test();
    const duplicateTest = editor.test();
    await Promise.resolve();
    const testButton = host.querySelector('[data-cpe-action="test"]');
    assert.strictEqual(requests.length, 1);
    assert.strictEqual(testButton?.disabled, true);
    assert.strictEqual(testButton?.getAttribute("aria-busy"), "true");

    const save = editor.save();
    await Promise.resolve();
    assert.strictEqual(requests.length, 2);
    assert.strictEqual(requests[0].signal?.aborted, true);
    first.resolve(response({ ok: false, code: "late", message: "must stay hidden" }, 502));
    second.resolve(response({ schemaVersion: 1, revision: 5, providers: [customProvider()] }));
    await Promise.all([firstTest, duplicateTest, save]);

    assert.strictEqual(host.querySelector(".cpe-result")?.textContent.includes("must stay hidden"), false);
    assert.strictEqual(host.querySelector('[data-cpe-action="save"]')?.disabled, false);
    assert.strictEqual(host.querySelector('[data-cpe-action="save"]')?.hasAttribute("aria-busy"), false);
  });

  it("aborts custom provider work when leaving the model settings tab", async () => {
    const pending = deferred();
    let actionSignal;
    fetchImpl = async (url, init = {}) => {
      if (String(url) === "/api/auth") return response({ providers: [] });
      if (String(url) === "/api/custom-providers") {
        return response({ revision: 4, official: [], custom: [customProvider()] });
      }
      if (String(url) === "/api/custom-providers/capabilities") return response(capabilities());
      if (String(url) === "/api/custom-providers/test") {
        actionSignal = init.signal;
        return pending.promise;
      }
      return response({});
    };
    win.App.Settings.openSettingsModal();
    await flushAsyncWork();
    const operation = win.App.SettingsComponents.providers.customEditor.test();
    await Promise.resolve();

    document.querySelector('.ms-item[data-st="general"]').click();
    assert.strictEqual(actionSignal?.aborted, true);
    pending.resolve(response({ ok: false, message: "late tab error" }, 502));
    await operation;

    assert.ok(document.querySelector("#gs-theme"));
    assert.strictEqual(document.body.textContent.includes("late tab error"), false);
  });

  it("reveals a configured custom API key only on explicit active-mount request", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    const first = deferred();
    const revealRequests = [];
    fetchImpl = async (url, init = {}) => {
      if (String(url) === "/api/custom-providers/reveal") {
        revealRequests.push({ body: JSON.parse(init.body), signal: init.signal });
        if (revealRequests.length === 1) return first.promise;
        return response({ apiKey: "active-secret" });
      }
      return response({});
    };
    const editor = createCustomProviderEditor();
    editor.mount(host, customProvider(), 4);
    const reveal = host.querySelector('.rp-key-toggle[data-cpe-action="reveal-api-key"]');
    assert.ok(reveal, "configured custom API keys need an eye reveal action");
    assert.strictEqual(reveal.type, "button");
    assert.match(reveal.getAttribute("aria-label") ?? "", /API Key/);
    assert.ok(reveal.title);
    assert.strictEqual(host.querySelector(".cpe-header-row .rp-key-toggle"), null, "Headers must never expose reveal");
    assert.strictEqual(revealRequests.length, 0);

    reveal.click();
    reveal.click();
    await Promise.resolve();
    assert.strictEqual(revealRequests.length, 1, "double-click reveal should be deduplicated");
    assert.deepStrictEqual(revealRequests[0].body, { providerId: "acme" });
    assert.strictEqual(reveal.disabled, true);

    editor.mount(host, customProvider({ id: "beta", name: "Beta" }), 5);
    assert.strictEqual(revealRequests[0].signal?.aborted, true);
    first.resolve(response({ apiKey: "late-secret" }));
    await flushAsyncWork();
    assert.strictEqual(host.querySelector("#cpe-api-key")?.value, "");

    host.querySelector('[data-cpe-action="reveal-api-key"]').click();
    await flushAsyncWork();
    assert.strictEqual(host.querySelector("#cpe-api-key")?.value, "active-secret");
  });

  it("redacts hostile custom API key reveal errors", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    const secret = 'xy"\\z';
    const variants = [secret, encodeURIComponent(secret), JSON.stringify(secret).slice(1, -1)];
    fetchImpl = async () => response({
      code: "reveal_failed",
      error: `reveal rejected ${variants.join(" | ")} <img id="reveal-error-xss">`,
    }, 502);
    const editor = createCustomProviderEditor();
    editor.mount(host, customProvider(), 4);
    setInput("#cpe-api-key", secret);

    host.querySelector('[data-cpe-action="reveal-api-key"]').click();
    await flushAsyncWork();

    const observable = JSON.stringify({
      text: host.querySelector(".cpe-result")?.textContent,
      notifications: settingsSpies.toastCalls,
    });
    for (const variant of variants) assert.strictEqual(observable.includes(variant), false);
    assert.strictEqual(host.querySelector("#reveal-error-xss"), null);
    assert.strictEqual(host.querySelector(".cpe-result")?.getAttribute("role"), "alert");
  });

  it("validates Header and model rows against the backend contract before requesting", async () => {
    const cases = [
      {
        path: "headers[1].value",
        mutate: (host) => {
          host.querySelector('[data-cpe-action="add-header"]').click();
          setInput('.cpe-header-row:not([data-configured="true"]) .cpe-header-name', "X-New");
        },
      },
      { path: "models", mutate: (host) => [...host.querySelectorAll('[data-cpe-action="remove-model"]')].forEach((button) => button.click()) },
      { path: "models[0].id", mutate: () => setInput(".cpe-model-id", "") },
      { path: "models[0].name", mutate: () => setInput(".cpe-model-name", "") },
      { path: "models[1].id", mutate: () => setInput(".cpe-model-row:nth-child(2) .cpe-model-id", "model-a") },
      { path: "models[1].name", mutate: () => setInput(".cpe-model-row:nth-child(2) .cpe-model-name", "MODEL A") },
      { path: "models[0].contextWindow", mutate: () => setInput(".cpe-model-context", "0") },
      { path: "models[0].maxTokens", mutate: () => setInput(".cpe-model-max", "1.5") },
      { path: "models[0].maxTokens", mutate: () => setInput(".cpe-model-max", "999999") },
      { path: "models[0].samplingParams", mutate: () => setInput(".cpe-model-sampling", "[]") },
      { path: "models[0].compatibility", mutate: () => setInput(".cpe-model-compatibility", "{") },
    ];
    let requests = 0;
    fetchImpl = async () => { requests += 1; return response({}); };

    for (const testCase of cases) {
      const host = document.createElement("div");
      document.body.replaceChildren(host);
      const editor = createCustomProviderEditor();
      editor.mount(host, customProvider(), 4);
      testCase.mutate(host);
      await editor.save();
      const error = host.querySelector(`[data-field-error="${testCase.path}"]`);
      assert.ok(error, `${testCase.path}: exact field error should be rendered`);
      assert.notStrictEqual(error.textContent, "", `${testCase.path}: field error should explain the violation`);
    }
    assert.strictEqual(requests, 0);
  });

  it("maps indexed backend field paths to their exact Header and model controls", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    const paths = ["provider.headers[0].value", "provider.models[1].maxTokens"];
    fetchImpl = async () => response({ code: "invalid_request", fieldPath: paths.shift() }, 400);
    const editor = createCustomProviderEditor();
    editor.mount(host, customProvider(), 4);

    await editor.save();
    const headerValue = host.querySelector('.cpe-header-row:nth-child(1) .cpe-header-value');
    assert.strictEqual(headerValue?.getAttribute("aria-invalid"), "true");
    assert.notStrictEqual(host.querySelector('[data-field-error="headers[0].value"]')?.textContent, "");

    await editor.save();
    const secondMax = host.querySelector('.cpe-model-row:nth-child(2) .cpe-model-max');
    assert.strictEqual(secondMax?.getAttribute("aria-invalid"), "true");
    assert.notStrictEqual(host.querySelector('[data-field-error="models[1].maxTokens"]')?.textContent, "");
  });

  it("treats hostile backend field paths as inert data and always clears mutation busy state", async () => {
    const paths = ['provider.models[0].x"]', `provider.${"x[".repeat(4096)}`];
    for (const fieldPath of paths) {
      const host = document.createElement("div");
      document.body.replaceChildren(host);
      fetchImpl = async () => response({ code: "invalid_request", fieldPath }, 400);
      const editor = createCustomProviderEditor();
      editor.mount(host, customProvider(), 4);

      await assert.doesNotReject(() => editor.save());

      const save = host.querySelector('[data-cpe-action="save"]');
      assert.strictEqual(save?.disabled, false);
      assert.strictEqual(save?.hasAttribute("aria-busy"), false);
      assert.strictEqual(host.querySelector('[aria-busy="true"]'), null);
      assert.strictEqual(host.querySelector(".cpe-result")?.getAttribute("role"), "alert");
      assert.strictEqual(host.querySelector("script, img"), null);
    }
  });

  it("keeps Header validation errors on their real DOM row indexes", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    let requests = 0;
    fetchImpl = async () => { requests += 1; return response({}); };
    const editor = createCustomProviderEditor();
    editor.mount(host, customProvider({ headers: [] }), 4);
    host.querySelector('[data-cpe-action="add-header"]').click();
    host.querySelector('[data-cpe-action="add-header"]').click();
    const rows = host.querySelectorAll(".cpe-header-row");
    setInput(".cpe-header-row:nth-child(1) .cpe-header-value", "first-value");
    setInput(".cpe-header-row:nth-child(2) .cpe-header-name", "X-Second");

    await editor.save();

    assert.strictEqual(requests, 0);
    assert.notStrictEqual(rows[0].querySelector('[data-field-error="headers[0].name"]')?.textContent, "");
    assert.strictEqual(rows[0].querySelector(".cpe-header-name")?.getAttribute("aria-invalid"), "true");
    assert.notStrictEqual(rows[1].querySelector('[data-field-error="headers[1].value"]')?.textContent, "");
    assert.strictEqual(rows[1].querySelector(".cpe-header-value")?.getAttribute("aria-invalid"), "true");
  });

  it("mirrors advanced JSON, Header secret, and discovery URL contract validation", async () => {
    const invalidCases = [
      { path: "headers[1].value", mutate: (host) => { host.querySelector('[data-cpe-action="add-header"]').click(); setInput('.cpe-header-row:nth-child(2) .cpe-header-name', "X-Blank"); setInput('.cpe-header-row:nth-child(2) .cpe-header-value', "   "); } },
      { path: "models[0].samplingParams", mutate: () => setInput(".cpe-model-sampling", '{"nested":{"value":1e400}}') },
      { path: "models[0].compatibility", mutate: () => setInput(".cpe-model-compatibility", JSON.stringify({ text: "汉".repeat(5460) })) },
      ...["javascript:alert(1)", "data:text/plain,models", "ftp://example.test/models", "https://user:password@api.example.test/models", "https://other.example.test/models"].map((modelDiscovery) => ({
        path: "modelDiscovery",
        mutate: () => setInput("#cpe-model-discovery", modelDiscovery),
      })),
    ];
    let requests = 0;
    fetchImpl = async () => { requests += 1; return response({}); };
    for (const testCase of invalidCases) {
      const host = document.createElement("div");
      document.body.replaceChildren(host);
      const editor = createCustomProviderEditor();
      editor.mount(host, customProvider(), 4);
      testCase.mutate(host);
      await editor.save();
      assert.notStrictEqual(host.querySelector(`[data-field-error="${testCase.path}"]`)?.textContent, "", testCase.path);
    }
    assert.strictEqual(requests, 0);

    const host = document.createElement("div");
    document.body.replaceChildren(host);
    let body;
    fetchImpl = async (_url, init = {}) => {
      body = JSON.parse(init.body);
      return response({ schemaVersion: 1, revision: 5, providers: [customProvider()] });
    };
    const editor = createCustomProviderEditor();
    editor.mount(host, customProvider(), 4);
    setInput(".cpe-model-sampling", JSON.stringify({ x: "a".repeat(16376) }));
    setInput("#cpe-model-discovery", "../models");
    await editor.save();
    assert.ok(body, "exactly 16 KiB advanced JSON and a safe relative URL should be accepted");
    assert.strictEqual(Buffer.byteLength(JSON.stringify(body.provider.models[0].samplingParams), "utf8"), 16 * 1024);
    assert.strictEqual(body.provider.modelDiscovery, "../models");
  });

  it("stable-deduplicates normalized discovery IDs before confirmation and import", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    fetchImpl = async () => response({ ids: [" model-a ", "new-b", "", "   ", "new-b", "new-c", " new-c "] });
    const editor = createCustomProviderEditor();
    editor.mount(host, customProvider({ models: [customProvider().models[0]] }), 4);
    const originalConfirm = win.confirm;
    let prompt = "";
    win.confirm = (message) => { prompt = message; return true; };

    await editor.discoverModels();

    assert.match(prompt, /导入 2 个模型 ID/);
    assert.strictEqual((prompt.match(/new-b/g) ?? []).length, 1);
    assert.strictEqual((prompt.match(/new-c/g) ?? []).length, 1);
    assert.deepStrictEqual([...host.querySelectorAll(".cpe-model-id")].map((input) => input.value), ["model-a", "new-b", "new-c"]);
    win.confirm = originalConfirm;
  });

  it("provides keyboard-operable provider items and accessible dynamic editor controls", async () => {
    fetchImpl = async (url) => {
      if (String(url) === "/api/auth") return response({ providers: [{ provider: "openai", hasKey: false }] });
      if (String(url) === "/api/custom-providers") return response({
        revision: 4,
        official: [{ id: "openai", name: "OpenAI", configured: false }],
        custom: [customProvider()],
      });
      if (String(url) === "/api/custom-providers/capabilities") return response(capabilities());
      return response({ models: [] });
    };
    win.App.Settings.openSettingsModal();
    await flushAsyncWork();

    const providerItems = [...document.querySelectorAll(".msl-item")];
    assert.ok(providerItems.length >= 2);
    for (const item of providerItems) {
      assert.strictEqual(item.tagName, "BUTTON");
      assert.strictEqual(item.type, "button");
    }
    const customItem = providerItems.find((item) => item.dataset.prov === "acme");
    activateButtonFromKeyboard(customItem, "Enter");
    assert.strictEqual(document.querySelector("#cpe-id")?.value, "acme");

    const dynamicControls = document.querySelectorAll([
      ".cpe-header-name", ".cpe-header-value", ".cpe-model-id", ".cpe-model-name",
      ".cpe-model-context", ".cpe-model-max", ".cpe-model-reasoning", ".cpe-model-image",
      ".cpe-model-sampling", ".cpe-model-compatibility",
    ].join(","));
    assert.ok(dynamicControls.length > 0);
    for (const control of dynamicControls) {
      assert.ok(control.getAttribute("aria-label") || control.closest("label"), `${control.className}: needs an accessible label`);
    }
    for (const button of document.querySelectorAll(".cpe-editor button")) assert.strictEqual(button.type, "button");
    for (const button of document.querySelectorAll('[data-cpe-action="remove-header"], [data-cpe-action="remove-model"]')) {
      assert.ok(button.getAttribute("aria-label"));
      assert.ok(button.title);
    }
    for (const error of document.querySelectorAll(".cpe-field-error")) assert.strictEqual(error.getAttribute("role"), "alert");
    assert.strictEqual(document.querySelector(".cpe-result")?.getAttribute("aria-live"), "polite");
    assert.strictEqual(document.querySelector(".cpe-conflict-banner")?.getAttribute("role"), "alert");
    assert.strictEqual(document.querySelector(".msl-custom-status")?.getAttribute("aria-live"), "polite");
  });

  it("redacts raw, percent-encoded, and JSON-escaped draft secrets from errors", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    const apiKey = 'a"b\\nc\\d';
    const headerSecret = "xy";
    const variants = [
      apiKey,
      encodeURIComponent(apiKey),
      encodeURIComponent(apiKey).replace(/%[0-9A-F]{2}/g, (part) => part.toLowerCase()),
      JSON.stringify(apiKey).slice(1, -1),
      headerSecret,
      encodeURIComponent(headerSecret),
    ];
    const message = `upstream rejected ${variants.join(" | ")} <img id="encoded-secret-xss">`;
    fetchImpl = async () => { throw new Error(message); };
    const editor = createCustomProviderEditor();
    editor.mount(host, customProvider(), 4);
    setInput("#cpe-api-key", apiKey);
    setInput(".cpe-header-value", headerSecret);

    await editor.test();
    const observable = JSON.stringify({
      text: host.querySelector(".cpe-result")?.textContent,
      notifications: settingsSpies.toastCalls,
    });
    for (const variant of variants) {
      assert.strictEqual(observable.includes(variant), false, `must redact ${JSON.stringify(variant)} from ${observable}`);
    }
    assert.strictEqual(host.querySelector("#encoded-secret-xss"), null);
  });

  it("redacts every representative mixed-case percent encoding without decoding ordinary text", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    const secret = 'a/"\\z';
    const encodedVariants = ["a%2f%22%5Cz", "a%2F%22%5cz", "a%2f%22%5cz", "a%2F%22%5Cz"];
    const jsonEscaped = JSON.stringify(secret).slice(1, -1);
    const ordinary = "%3Cimg%20id%3Dordinary-text%3E";
    fetchImpl = async () => response({
      ok: false,
      code: "mixed_percent",
      message: `${secret} | ${jsonEscaped} | ${encodedVariants.join(" | ")} | ${ordinary}`,
    }, 502);
    const editor = createCustomProviderEditor();
    editor.mount(host, customProvider(), 4);
    setInput("#cpe-api-key", secret);

    await editor.test();

    const text = host.querySelector(".cpe-result")?.textContent ?? "";
    assert.strictEqual(text.includes(secret), false);
    assert.strictEqual(text.includes(jsonEscaped), false);
    for (const encoded of encodedVariants) assert.strictEqual(text.includes(encoded), false, encoded);
    assert.strictEqual(text.includes(ordinary), true, "unrelated percent text must stay encoded and inert");
    assert.strictEqual(host.querySelector("#ordinary-text"), null);
  });

  it("removes the standalone Permissions sidebar entry while keeping the mode badge", () => {
    const source = readFileSync(resolve(process.cwd(), "src/frontend/dashboard/dashboard-layout.ts"), "utf8");

    assert.doesNotMatch(source, /data-side=["']permissions["']/);
    assert.match(source, /permission-mode-badge/);
  });

  it("declares the settings refresh and embedded Permissions contracts", () => {
    const source = readFileSync(resolve(process.cwd(), "src/frontend/dashboard.d.ts"), "utf8");

    assert.match(source, /interface AppChatTimeline[\s\S]*?refreshSettings\(\): void;/);
    assert.match(source, /interface AppChat[\s\S]*?refreshReadingSettings\(\): void;/);
    assert.match(source, /interface AppPermissions[\s\S]*?mount\(container: HTMLElement\): void;[\s\S]*?refresh\(forceToast\?: boolean\): Promise<void>;[\s\S]*?unmount\(\): void;/);
    assert.match(source, /interface AppNamespace[\s\S]*?Permissions: AppPermissions;/);
    assert.match(source, /refreshPermissionsPanel\?: \(forceToast\?: boolean\) => Promise<void>;/);
  });

  it("does not use inline event attributes", () => {
    const files = [
      "dashboard-settings.ts",
      "settings-general.ts",
      "settings-custom-provider-editor.ts",
      "settings-provider-model.ts",
      "settings-custom-subagents.ts",
      "settings-storage.ts",
    ];
    for (const file of files) {
      const source = readFileSync(resolve(process.cwd(), "src/frontend/dashboard", file), "utf8");
      assert.doesNotMatch(source, /\son(?:click|change|dragstart|dragover|drop)\s*=/i, `${file} must use delegated events`);
    }
  });

  it("renders a dedicated Subagent tab with independently persisted 1..30 limits", async () => {
    storage.set("subagent-max-tasks", "12");
    storage.set("subagent-max-concurrent", "5");
    await openSubagentSettings();

    const maxTasks = getControl("gs-subagent-max-tasks");
    const maxConcurrent = getControl("gs-subagent-max-concurrent");
    assert.strictEqual(maxTasks.type, "number");
    assert.strictEqual(maxTasks.min, "1");
    assert.strictEqual(maxTasks.max, "30");
    assert.strictEqual(maxTasks.value, "12");
    assert.strictEqual(maxConcurrent.value, "5");
    assert.strictEqual(document.querySelectorAll(".gs-subagent-copy .gs-label").length, 2);
    assert.strictEqual(document.querySelectorAll(".gs-subagent-copy .gs-desc").length, 2);
    assert.strictEqual(document.querySelectorAll('[data-settings-action="subagent-decrease"]').length, 2);
    assert.strictEqual(document.querySelectorAll('[data-settings-action="subagent-increase"]').length, 2);

    document.querySelector('[data-settings-action="subagent-increase"][data-settings-target="gs-subagent-max-tasks"]').click();
    assert.strictEqual(maxTasks.value, "13");
    assert.strictEqual(storage.get("subagent-max-tasks"), "13");

    maxTasks.value = "30";
    maxTasks.dispatchEvent(new win.Event("change", { bubbles: true }));
    maxConcurrent.value = "8";
    maxConcurrent.dispatchEvent(new win.Event("change", { bubbles: true }));
    assert.strictEqual(storage.get("subagent-max-tasks"), "30");
    assert.strictEqual(storage.get("subagent-max-concurrent"), "8");

    maxConcurrent.value = "99";
    maxConcurrent.dispatchEvent(new win.Event("change", { bubbles: true }));
    assert.strictEqual(maxConcurrent.value, "30");
    assert.strictEqual(storage.get("subagent-max-concurrent"), "30");
  });

  it("creates, edits, and deletes custom read-only Agents", async () => {
    const requests = [];
    const existing = {
      id: "security-reviewer",
      name: "安全审查",
      description: "检查安全边界",
      prompt: "优先检查权限与输入验证。",
      tools: ["search", "file_read"],
      model: { provider: "openai", id: "gpt-test" },
    };
    fetchImpl = async (url, init = {}) => {
      if (String(url) === "/api/subagents" && init.method === "PUT") {
        requests.push(JSON.parse(init.body));
        return { ok: true, json: async () => ({ ok: true, agents: requests.at(-1).agents }) };
      }
      if (String(url) === "/api/subagents") return { ok: true, json: async () => ({ agents: [existing] }) };
      if (String(url) === "/api/models") return { ok: true, json: async () => ({ models: [existing.model] }) };
      return { ok: true, json: async () => ({}) };
    };

    await openSubagentSettings();
    await flushAsyncWork();
    assert.strictEqual(document.querySelector('.sa-section-title')?.textContent, '自定义 Agent');
    const addAction = document.querySelector('.sa-agent-pane .list-add-action');
    assert.ok(addAction);
    assert.strictEqual(addAction.textContent?.replace('+', '').trim(), '新建 Agent');
    addAction.click();
    assert.strictEqual(getControl("sa-name").value, "");
    document.querySelector(`.sa-agent-item[data-agent-id="${existing.id}"]`).click();
    assert.strictEqual(document.querySelectorAll(".sa-agent-item").length, 1);
    const deleteButton = document.querySelector('.sa-agent-item [data-settings-action="delete-subagent"]');
    assert.ok(deleteButton, 'delete action should live inside the Agent list item');
    assert.strictEqual(deleteButton.getAttribute('data-agent-id'), existing.id);
    assert.ok(deleteButton.querySelector('svg use[href="#itrash"]'));
    assert.strictEqual(getControl("sa-name").value, "安全审查");
    assert.strictEqual(getControl("sa-tool-search").checked, true);
    assert.strictEqual(getControl("sa-tool-git_log").checked, false);

    getControl("sa-description").value = "更新后的安全边界说明";
    document.querySelector('[data-settings-action="save-subagent"]').click();
    await flushAsyncWork();
    assert.strictEqual(requests.length, 1);
    assert.strictEqual(requests[0].agents[0].description, "更新后的安全边界说明");

    const currentDeleteButton = document.querySelector(`.sa-agent-item [data-settings-action="delete-subagent"][data-agent-id="${existing.id}"]`);
    assert.ok(currentDeleteButton);
    currentDeleteButton.click();
    assert.strictEqual(requests.length, 1, "first delete click only arms confirmation");
    const armedDeleteButton = document.querySelector(`.sa-agent-item [data-settings-action="delete-subagent"][data-agent-id="${existing.id}"]`);
    assert.ok(armedDeleteButton?.classList.contains("armed"));
    armedDeleteButton.click();
    await flushAsyncWork();
    assert.deepStrictEqual(requests.at(-1), { agents: [] });
    assert.strictEqual(document.querySelectorAll(".sa-agent-item").length, 0);
  });

  it("keeps hostile provider names as inert data and handles selection through DOM events", async () => {
    const hostileProvider = 'bad" onclick="globalThis.__settingsInjected=true';
    storage.set("providers_order", JSON.stringify([hostileProvider, "openai"]));
    fetchImpl = async (url) => {
      if (String(url) === "/api/auth") return response({ providers: [] });
      if (String(url) === "/api/custom-providers") return response({
        revision: 1,
        official: [
          { id: hostileProvider, name: hostileProvider, configured: false },
          { id: "openai", name: "OpenAI", configured: false },
        ],
        custom: [],
      });
      if (String(url) === "/api/custom-providers/capabilities") return response({ protocols: [], price: { currency: "USD", unit: "millionTokens" } });
      return response({ models: [] });
    };

    win.App.Settings.openSettingsModal();
    await flushAsyncWork();

    const providers = [...document.querySelectorAll(".msl-item[data-prov]")];
    const hostileItem = providers.find((item) => item.dataset.prov === hostileProvider);
    assert.ok(hostileItem, "provider should remain an exact data attribute value");
    assert.strictEqual(hostileItem.textContent.includes(hostileProvider), true);
    assert.strictEqual(hostileItem.hasAttribute("onclick"), false);
    assert.strictEqual(global.__settingsInjected, undefined);

    const openaiItem = providers.find((item) => item.dataset.prov === "openai");
    assert.ok(openaiItem);
    openaiItem.click();
    assert.strictEqual(document.querySelector(".rp-prov-name")?.textContent, "openai");
  });

  it("keeps hostile model ids as inert data and submits the exact selected model", async () => {
    const hostileModel = 'model" onclick="globalThis.__settingsInjected=true';
    win.App.Preferences.set("providers_order", JSON.stringify(["openai"]));
    let switchRequest = null;
    fetchImpl = async (url, init) => {
      if (String(url) === "/api/auth") {
        return { ok: true, json: async () => ({ providers: [{ provider: "openai", hasKey: true, keyPreview: "sk-test" }] }) };
      }
      if (String(url) === "/api/models") {
        return { ok: true, json: async () => ({ models: [{ provider: "openai", id: hostileModel }] }) };
      }
      if (String(url) === "/api/model/switch") {
        switchRequest = JSON.parse(String(init?.body || "{}"));
        return { ok: true, json: async () => ({ ok: true }) };
      }
      return { ok: true, json: async () => ({ ok: true }) };
    };

    win.App.Settings.openSettingsModal();
    await flushAsyncWork();
    await flushAsyncWork();

    const model = document.querySelector(".rp-model-item");
    assert.ok(model);
    assert.strictEqual(model.dataset.modelId, hostileModel);
    assert.strictEqual(model.hasAttribute("onclick"), false);
    model.click();
    await flushAsyncWork();

    assert.deepStrictEqual(switchRequest, { provider: "openai", modelId: hostileModel });
    assert.strictEqual(global.__settingsInjected, undefined);
  });

  it("shows the configured key after the explicit reveal request", async () => {
    fetchImpl = async (url) => {
      if (String(url) === "/api/auth") {
        return { ok: true, json: async () => ({ providers: [{ provider: "openai", hasKey: true, canReveal: true, keyPreview: "sk-test-..." }] }) };
      }
      if (String(url) === "/api/auth/reveal") {
        return { ok: true, json: async () => ({ ok: true, apiKey: "sk-test-secret-value" }) };
      }
      if (String(url) === "/api/models") {
        return { ok: true, json: async () => ({ models: [] }) };
      }
      return { ok: true, json: async () => ({ ok: true }) };
    };

    win.App.Settings.openSettingsModal();
    await flushAsyncWork();
    await flushAsyncWork();

    const input = document.querySelector("#key-input");
    assert.strictEqual(input?.type, "text");
    assert.strictEqual(input?.value, "sk-test-secret-value");
  });

  it("does not reveal providers configured without a stored API key", async () => {
    let revealRequests = 0;
    fetchImpl = async (url) => {
      if (String(url) === "/api/auth") {
        return { ok: true, json: async () => ({ providers: [{ provider: "openai", hasKey: true, canReveal: false, keyPreview: "" }] }) };
      }
      if (String(url) === "/api/auth/reveal") {
        revealRequests += 1;
        return { ok: false, json: async () => ({ error: "provider key unavailable" }) };
      }
      if (String(url) === "/api/models") {
        return { ok: true, json: async () => ({ models: [] }) };
      }
      return { ok: true, json: async () => ({ ok: true }) };
    };

    win.App.Settings.openSettingsModal();
    await flushAsyncWork();
    await flushAsyncWork();

    const input = document.querySelector("#key-input");
    assert.strictEqual(revealRequests, 0);
    assert.strictEqual(input?.type, "password");
    assert.strictEqual(input?.value, "");
  });

  it("does not render persisted numeric preferences as HTML", async () => {
    storage.set("editor-font-size", '<img id="settings-preference-injection">');

    win.App.Settings.openSettingsModal();
    await flushAsyncWork();
    document.querySelector('.ms-item[data-st="general"]')?.click();

    assert.strictEqual(document.getElementById("gs-fontsize")?.textContent, "13");
    assert.strictEqual(document.getElementById("settings-preference-injection"), null);
  });

  it("routes general settings and close controls through modal event delegation", async () => {
    win.App.Settings.openSettingsModal();
    await flushAsyncWork();

    document.querySelector('.ms-item[data-st="general"]')?.click();
    document.querySelector('[data-settings-action="font-increase"]')?.click();
    assert.strictEqual(storage.get("editor-font-size"), "14");

    const autosave = document.getElementById("gs-autosave");
    autosave.checked = true;
    autosave.dispatchEvent(new win.Event("change", { bubbles: true }));
    assert.strictEqual(storage.get("auto-save"), "1");

    document.querySelector('[data-settings-action="close"]')?.click();
    assert.strictEqual(document.getElementById("settings-modal"), null);
    assert.strictEqual(settingsSpies.refreshCalls.filter((call) => call.label === "permissions-unmount").length, 0);
  });

  it("applies the theme immediately before Monaco is ready", async () => {
    win.App.Settings.openSettingsModal();
    await flushAsyncWork();

    document.querySelector('.ms-item[data-st="general"]')?.click();
    const theme = document.getElementById("gs-theme");
    assert.ok(theme);

    theme.value = "vs";
    theme.dispatchEvent(new win.Event("change", { bubbles: true }));
    assert.strictEqual(document.documentElement.classList.contains("theme-light"), true);

    theme.value = "vs-dark";
    theme.dispatchEvent(new win.Event("change", { bubbles: true }));
    assert.strictEqual(document.documentElement.classList.contains("theme-light"), false);
  });

  it("renders Timeline and jump-to-latest General controls with their defaults", async () => {
    await openGeneralSettings();

    assert.strictEqual(document.getElementById("gs-timeline-enabled")?.checked, true);
    assert.strictEqual(document.getElementById("gs-timeline-window")?.value, "9");
    assert.strictEqual(document.getElementById("gs-jump-enabled")?.checked, true);
    const jumpSmooth = getControl("gs-jump-smooth");
    assert.strictEqual(jumpSmooth.tagName, "SELECT");
    assert.deepStrictEqual([...jumpSmooth.options].map((option) => ({ value: option.value, label: option.textContent })), [
      { value: "true", label: "平滑滚动" },
      { value: "false", label: "立即到达" },
    ]);
    assert.strictEqual(jumpSmooth.value, "true");
    assert.strictEqual(document.getElementById("gs-jump-threshold")?.value, "72");
  });

  it("keeps storage values and actions readable without vertical button text", async () => {
    const longRoot = "E:\\my-code-agent\\data\\with-a-very-long-storage-directory-name";
    const longInstanceId = "instance-3b87ebac-5a40-4a31-8483-2cf1dbd-long";
    fetchImpl = async (url) => {
      if (String(url) === "/api/storage-location") {
        return {
          ok: true,
          json: async () => ({
            dataRoot: longRoot,
            instanceId: longInstanceId,
            workspaceLock: { status: "locked", owner: { port: 3099 } },
          }),
        };
      }
      if (String(url) === "/api/storage-migration/preview") {
        return { ok: true, json: async () => ({ fileCount: 0, bytes: 0, conflicts: [], previewId: "preview-storage" }) };
      }
      return { ok: true, json: async () => ({ ok: true }) };
    };

    await openGeneralSettings();
    await flushAsyncWork();

    const storageRows = [...document.querySelectorAll("[data-storage-location] .gs-storage-row")];
    const chooseButton = document.querySelector('[data-settings-action="choose-data-root"]');
    const dataRoot = document.getElementById("gs-data-root-status");
    const instanceId = document.getElementById("gs-instance-id");
    assert.strictEqual(storageRows.length, 5);
    assert.ok(chooseButton?.closest(".gs-storage-actions"));
    assert.strictEqual(dataRoot?.title, longRoot);
    assert.strictEqual(instanceId?.title, longInstanceId);

    const css = readFileSync(resolve(process.cwd(), "src/frontend/dashboard.css"), "utf8");
    assert.match(css, /\.gs-storage-row\s*\{[^}]*display:grid[^}]*grid-template-columns:/);
    assert.match(css, /\.gs-value\.gs-storage-value\s*\{[^}]*font-size:\.72rem[^}]*color:var\(--ts\)[^}]*font-weight:400/);
    assert.match(css, /\.gs-btn\.gs-storage-btn\s*\{[^}]*width:auto[^}]*white-space:nowrap/);
  });

  it("selects a storage root through Electron and stages it for restart", async () => {
    const selectedRoot = "E:\\agent-data";
    let postedRoot = null;
    let selectFolderCalls = 0;
    let openWorkspaceFolderCalls = 0;
    let legacyOpenFolderCalls = 0;
    win.electronAPI = {
      selectFolder: async () => { selectFolderCalls += 1; return selectedRoot; },
      openWorkspaceFolder: async () => { openWorkspaceFolderCalls += 1; return null; },
      openFolder: async () => { legacyOpenFolderCalls += 1; return selectedRoot; },
    };
    fetchImpl = async (url, init) => {
      if (String(url) === "/api/storage-location" && init?.method === "POST") {
        postedRoot = JSON.parse(String(init.body)).dataRoot;
        return { ok: true, json: async () => ({ ok: true, restartRequired: true }) };
      }
      if (String(url) === "/api/storage-location") {
        return { ok: true, json: async () => ({ dataRoot: "E:\\current-data", activeDataRoot: "E:\\current-data", restartRequired: false }) };
      }
      return { ok: true, json: async () => ({ ok: true }) };
    };

    await openGeneralSettings();
    await flushAsyncWork();
    document.querySelector('[data-settings-action="choose-data-root"]')?.click();
    await flushAsyncWork();

    assert.strictEqual(postedRoot, selectedRoot);
    assert.strictEqual(selectFolderCalls, 1);
    assert.strictEqual(openWorkspaceFolderCalls, 0);
    assert.strictEqual(legacyOpenFolderCalls, 0);
    assert.match(document.getElementById("gs-data-root-status")?.textContent || "", /重启后生效/);
  });

  it("does nothing when storage folder selection is cancelled", async () => {
    let selectFolderCalls = 0;
    const postCalls = [];
    win.electronAPI = {
      selectFolder: async () => { selectFolderCalls += 1; return null; },
    };
    fetchImpl = async (url, init) => {
      if (init?.method === "POST" && String(url) === "/api/storage-location") postCalls.push([url, init]);
      if (String(url) === "/api/storage-location") {
        return { ok: true, json: async () => ({ dataRoot: "E:\\current-data", activeDataRoot: "E:\\current-data", restartRequired: false }) };
      }
      return { ok: true, json: async () => ({ ok: true }) };
    };

    await openGeneralSettings();
    document.querySelector('[data-settings-action="choose-data-root"]')?.click();
    await flushAsyncWork();

    assert.strictEqual(selectFolderCalls, 1);
    assert.strictEqual(postCalls.length, 0);
  });

  it("shows an error when storage folder selection rejects", async () => {
    let selectFolderCalls = 0;
    const postCalls = [];
    win.electronAPI = {
      selectFolder: async () => { selectFolderCalls += 1; throw new Error("storage picker failed"); },
    };
    fetchImpl = async (url, init) => {
      if (init?.method === "POST" && String(url) === "/api/storage-location") postCalls.push([url, init]);
      if (String(url) === "/api/storage-location") {
        return { ok: true, json: async () => ({ dataRoot: "E:\\current-data", activeDataRoot: "E:\\current-data", restartRequired: false }) };
      }
      return { ok: true, json: async () => ({ ok: true }) };
    };

    await openGeneralSettings();
    document.querySelector('[data-settings-action="choose-data-root"]')?.click();
    await flushAsyncWork();

    assert.strictEqual(selectFolderCalls, 1);
    assert.strictEqual(postCalls.length, 0);
    assert.ok(settingsSpies.toastCalls.some(([message, type]) => (
      message.includes("storage picker failed") && type === "error"
    )), JSON.stringify(settingsSpies.toastCalls));
  });

  it("persists Timeline and jump settings through their refresh facades without changing session state", async () => {
    const sentinelDashboard = { activeSessionId: "sentinel-session" };
    win.__state.D = sentinelDashboard;
    const sentinelMessages = document.createElement("div");
    sentinelMessages.id = "ms";
    sentinelMessages.innerHTML = '<div class="sentinel-message">keep this content</div>';
    sentinelMessages.scrollTop = 314;
    document.body.append(sentinelMessages);
    const activeSessionBefore = sentinelDashboard.activeSessionId;
    const messageContentBefore = sentinelMessages.innerHTML;
    const scrollTopBefore = sentinelMessages.scrollTop;

    await openGeneralSettings();

    const timelineEnabled = getControl("gs-timeline-enabled");
    timelineEnabled.checked = false;
    timelineEnabled.dispatchEvent(new win.Event("change", { bubbles: true }));
    const timelineWindow = getControl("gs-timeline-window");
    timelineWindow.value = "5";
    timelineWindow.dispatchEvent(new win.Event("change", { bubbles: true }));

    const jumpEnabled = getControl("gs-jump-enabled");
    jumpEnabled.checked = false;
    jumpEnabled.dispatchEvent(new win.Event("change", { bubbles: true }));
    const jumpSmooth = getControl("gs-jump-smooth");
    const refreshCallsBeforeSmooth = settingsSpies.refreshCalls.length;
    jumpSmooth.value = "false";
    jumpSmooth.dispatchEvent(new win.Event("change", { bubbles: true }));
    assert.strictEqual(storage.get("chat-jump-latest-smooth"), "0");
    assert.deepStrictEqual(settingsSpies.refreshCalls.slice(refreshCallsBeforeSmooth).map((call) => call.label), ["reading-refresh"]);
    const jumpThreshold = getControl("gs-jump-threshold");
    jumpThreshold.value = "120";
    jumpThreshold.dispatchEvent(new win.Event("change", { bubbles: true }));

    assert.strictEqual(storage.get("chat-timeline-enabled"), "0");
    assert.strictEqual(storage.get("chat-timeline-window-size"), "5");
    assert.strictEqual(storage.get("chat-jump-latest-enabled"), "0");
    assert.strictEqual(storage.get("chat-jump-latest-smooth"), "0");
    assert.strictEqual(storage.get("chat-jump-latest-threshold"), "120");
    assert.deepStrictEqual(settingsSpies.refreshCalls.map((call) => call.label), [
      "timeline-refresh",
      "timeline-refresh",
      "reading-refresh",
      "reading-refresh",
      "reading-refresh",
    ]);
    assert.strictEqual(win.__state.D, sentinelDashboard);
    assert.strictEqual(document.getElementById("ms"), sentinelMessages);
    assert.strictEqual(win.__state.D.activeSessionId, activeSessionBefore);
    assert.strictEqual(sentinelMessages.innerHTML, messageContentBefore);
    assert.strictEqual(sentinelMessages.scrollTop, scrollTopBefore);
  });

  it("mounts Permissions from its Settings entry", async () => {
    win.App.Settings.openSettingsModal();
    await flushAsyncWork();

    const permissionsTab = document.querySelector('.ms-item[data-st="permissions"]');
    assert.ok(permissionsTab, "Permissions settings tab should be rendered");
    permissionsTab.click();
    await flushAsyncWork();

    assert.ok(settingsSpies.refreshCalls.some((call) => call.label === "permissions-mount"));
    assert.ok(document.querySelector('[data-permissions-mounted="true"]'));
    assert.strictEqual(settingsSpies.refreshCalls.filter((call) => call.label === "permissions-refresh").length, 0);
  });

  it("unmounts Permissions when switching to another Settings tab", async () => {
    win.App.Settings.openSettingsModal();
    await flushAsyncWork();

    for (const tab of ["general", "model", "about"]) {
      document.querySelector('.ms-item[data-st="permissions"]')?.click();
      await flushAsyncWork();
      const unmountsBefore = settingsSpies.refreshCalls.filter((call) => call.label === "permissions-unmount").length;
      document.querySelector(`.ms-item[data-st="${tab}"]`)?.click();
      await flushAsyncWork();
      assert.strictEqual(
        settingsSpies.refreshCalls.filter((call) => call.label === "permissions-unmount").length,
        unmountsBefore + 1,
        `switching to ${tab} should unmount Permissions`,
      );
    }
  });

  it("shows the installed PI fork version in About", async () => {
    win.App.Settings.openSettingsModal();
    await flushAsyncWork();

    document.querySelector('.ms-item[data-st="about"]')?.click();
    await flushAsyncWork();

    assert.match(document.getElementById("mc-settings")?.textContent ?? "", /@xiamol\/pi-coding-agent v0\.84\.2-xiamol\.0/);
  });

  it("unmounts Permissions when closing an existing Permissions Settings modal", async () => {
    win.App.Settings.openSettingsModal();
    await flushAsyncWork();
    document.querySelector('.ms-item[data-st="permissions"]')?.click();
    await flushAsyncWork();

    win.App.Settings.openSettingsModal();

    assert.strictEqual(document.getElementById("settings-modal"), null);
    assert.strictEqual(settingsSpies.refreshCalls.filter((call) => call.label === "permissions-unmount").length, 1);
  });
});
