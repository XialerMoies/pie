import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Window } from "happy-dom";

async function loadUtils() {
  const win = new Window();
  global.window = win;
  global.document = win.document;
  global.self = win;

  const moduleUrl = `../src/frontend/dashboard/settings-provider-utils.ts?${Date.now()}-${Math.random()}`;
  const { ProviderSettingsUtils } = await import(moduleUrl);
  return ProviderSettingsUtils;
}

async function loadViews() {
  const win = new Window();
  global.window = win;
  global.document = win.document;
  global.self = win;

  const utilsUrl = `../src/frontend/dashboard/settings-provider-utils.ts?${Date.now()}-${Math.random()}`;
  const { ProviderSettingsUtils } = await import(utilsUrl);
  global.ProviderSettingsUtils = ProviderSettingsUtils;

  const viewsUrl = `../src/frontend/dashboard/settings-provider-views.ts?${Date.now()}-${Math.random()}`;
  return import(viewsUrl);
}

function response(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

function controllerCustomProvider(overrides = {}) {
  return {
    id: "acme",
    name: "Acme Gateway",
    protocol: "openai-responses",
    baseUrl: "https://api.example.test/v1",
    authMode: "apiKey",
    apiKeyConfigured: true,
    headers: [],
    models: [{
      id: "acme-chat",
      name: "Acme Chat",
      contextWindow: 128000,
      maxTokens: 8192,
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    }],
    ...overrides,
  };
}

function controllerCapabilities() {
  return response({
    protocols: ["openai-responses", "anthropic-messages"].map(id => ({
      id,
      authModes: ["none", "apiKey"],
      supportsCompatibility: true,
    })),
    price: { currency: "USD", unit: "millionTokens" },
  });
}

async function flushControllerWork() {
  await Promise.resolve();
  await new Promise(resolve => setTimeout(resolve, 0));
  await Promise.resolve();
}

async function loadController({ fetchImpl, dashboard = null, order = [] } = {}) {
  const win = new Window();
  global.window = win;
  global.document = win.document;
  global.self = win;
  global.$ = id => document.getElementById(id);

  const utilsUrl = `../src/frontend/dashboard/settings-provider-utils.ts?controller-${Date.now()}-${Math.random()}`;
  const { ProviderSettingsUtils } = await import(utilsUrl);
  global.ProviderSettingsUtils = ProviderSettingsUtils;
  const viewsUrl = `../src/frontend/dashboard/settings-provider-views.ts?controller-${Date.now()}-${Math.random()}`;
  const views = await import(viewsUrl);
  global.ProviderCardListView = views.ProviderCardListView;
  global.ProviderPickerView = views.ProviderPickerView;
  global.OfficialProviderEditorView = views.OfficialProviderEditorView;

  const editorCalls = [];
  let editorDependencies;
  class FakeCustomEditor {
    constructor(dependencies) {
      editorDependencies = dependencies;
    }
    setProtocols(protocols) {
      editorCalls.push(["setProtocols", [...protocols]]);
    }
    mount(container, provider, revision) {
      editorCalls.push(["mount", provider.id, revision]);
      const root = document.createElement("div");
      root.className = "cpe-editor";
      root.textContent = provider.name;
      container.replaceChildren(root);
    }
    startNew(container, revision, options) {
      editorCalls.push(["startNew", revision, options]);
      const root = document.createElement("div");
      root.className = "cpe-editor";
      container.replaceChildren(root);
    }
    unmount() {
      editorCalls.push(["unmount"]);
    }
  }

  const preferences = {
    get: key => key === "providers_order" ? JSON.stringify(order) : "",
    setJson() {},
  };
  let refreshes = 0;
  win.App = {
    Preferences: preferences,
    ChatState: { getDashboard: () => dashboard },
    Ui: { ListAddAction: { create: () => document.createElement("button") } },
    SettingsCustomProviderEditor: FakeCustomEditor,
    isCustomProviderRevision: value => Number.isSafeInteger(value) && value >= 0,
  };
  global.App = win.App;
  global.toast = () => {};
  global.getD = () => { refreshes += 1; };
  global.fetch = fetchImpl;

  const controllerUrl = `../src/frontend/dashboard/settings-provider-model.ts?controller-${Date.now()}-${Math.random()}`;
  await import(controllerUrl);
  const host = document.createElement("div");
  document.body.append(host);
  const controller = win.App.SettingsComponents.providers;
  controller.renderTab(host);
  await flushControllerWork();
  return { controller, host, editorCalls, editorDependencies, getRefreshes: () => refreshes };
}

function standardControllerFetch({ requests = [] } = {}) {
  return async (url, init = {}) => {
    const path = String(url);
    requests.push([path, init]);
    if (path === "/api/auth") return response({
      providers: [
        { provider: "openai", hasKey: false, canReveal: false, keyPreview: "" },
        { provider: "anthropic", hasKey: true, canReveal: false, keyPreview: "" },
      ],
    });
    if (path === "/api/custom-providers") return response({
      revision: 4,
      official: [
        { id: "openai", name: "OpenAI", configured: false },
        { id: "anthropic", name: "Anthropic", configured: true },
      ],
      custom: [controllerCustomProvider()],
    });
    if (path === "/api/custom-providers/capabilities") return controllerCapabilities();
    if (path === "/api/models") return response({
      models: [
        { provider: "openai", id: "gpt-5", name: "GPT-5" },
        { provider: "anthropic", id: "claude-sonnet", name: "Claude Sonnet" },
      ],
    });
    if (path === "/api/model/switch") return response({ ok: true });
    if (path === "/api/auth/reveal") return response({ ok: true, apiKey: "sk-revealed" });
    return response({ ok: true });
  };
}

describe("provider settings presentation utilities", () => {
  it("derives stable provider ids with a collision suffix", async () => {
    const { deriveProviderId } = await loadUtils();

    assert.equal(deriveProviderId("Acme Relay", new Set()), "acme-relay");
    assert.equal(deriveProviderId("我的服务", new Set()), "custom-provider");
    assert.equal(
      deriveProviderId("我的服务", new Set(["custom-provider", "custom-provider-2"])),
      "custom-provider-3",
    );
  });

  it("derives OpenAI model discovery paths from safe HTTP URLs", async () => {
    const { deriveOpenAiDiscoveryPath } = await loadUtils();

    assert.equal(deriveOpenAiDiscoveryPath("https://api.example.test/v1"), "/v1/models");
    assert.equal(deriveOpenAiDiscoveryPath("https://api.example.test/v1/"), "/v1/models");
    assert.equal(deriveOpenAiDiscoveryPath("https://api.example.test/"), "/models");
    assert.equal(deriveOpenAiDiscoveryPath("not a url"), null);
    assert.equal(deriveOpenAiDiscoveryPath("ftp://api.example.test/v1"), null);
    assert.equal(deriveOpenAiDiscoveryPath("https://user:secret@api.example.test/v1"), null);
  });

  it("uses official icons and derives custom provider initials", async () => {
    const source = readFileSync(resolve("src/frontend/dashboard/settings-provider-utils.ts"), "utf8");
    assert.match(source, /interface\s+ProviderIdentityDescriptor\s*\{/);
    assert.match(source, /function\s+identity\([^)]*\):\s*ProviderIdentityDescriptor\s*\{/);

    const { identity } = await loadUtils();

    const deepseek = identity("deepseek", "DeepSeek", false);
    assert.equal(deepseek.label, "DeepSeek");
    assert.equal(deepseek.iconPath, "./icons/providers/deepseek.svg");
    for (const id of ["anthropic", "google", "openai", "openrouter"]) {
      assert.equal(identity(id, id, false).iconPath, `./icons/providers/${id}.svg`);
    }

    const chineseCustom = identity("custom-provider", "我的服务", true);
    assert.equal(chineseCustom.label, "我的服务");
    assert.equal(chineseCustom.initials, "我的");
    assert.equal(Object.hasOwn(chineseCustom, "iconPath"), false);

    const acmeCustom = identity("acme-gateway", "Acme Gateway", true);
    assert.equal(acmeCustom.label, "Acme Gateway");
    assert.equal(acmeCustom.initials, "AG");
    assert.equal(Object.hasOwn(acmeCustom, "iconPath"), false);

    const unsupported = identity("unsupported", "Unsupported Relay", false);
    assert.equal(unsupported.label, "Unsupported Relay");
    assert.equal(Object.hasOwn(unsupported, "iconPath"), false);
  });

  it("returns only the hostname for valid provider URLs", async () => {
    const { providerHost } = await loadUtils();

    assert.equal(
      providerHost("https://user:secret@api.example.test:8443/v1?token=hidden#models"),
      "api.example.test",
    );
    assert.equal(providerHost("not a url"), "");
  });
});

describe("provider settings views", () => {
  it("renders compact provider cards without turning the card into an action", async () => {
    const { ProviderCardListView } = await loadViews();
    const host = document.createElement("div");
    const calls = [];
    const view = new ProviderCardListView({
      onUse: (providerId, modelId) => calls.push(["use", providerId, modelId]),
      onEdit: (providerId) => calls.push(["edit", providerId]),
      onAdd: () => calls.push(["add"]),
    });

    view.render(host, {
      current: { providerId: "deepseek", modelId: "deepseek-chat" },
      providers: [{
        id: "deepseek",
        name: "DeepSeek",
        custom: false,
        configured: true,
        baseUrl: "https://api.deepseek.com/v1",
        protocolLabel: "官方",
        models: [
          { id: "deepseek-chat", name: "DeepSeek Chat" },
          { id: "deepseek-reasoner", name: "DeepSeek Reasoner" },
        ],
      }],
    });

    const card = host.querySelector('article.provider-card[data-provider-id="deepseek"]');
    assert.ok(card);
    assert.ok(host.querySelector('img[src="./icons/providers/deepseek.svg"]'));
    card.click();
    assert.deepEqual(calls, []);

    const select = card.querySelector("select");
    assert.deepEqual([...select.options].map(option => option.value), ["deepseek-chat", "deepseek-reasoner"]);
    select.value = "deepseek-reasoner";
    card.querySelector('[data-provider-action="use"]').click();
    assert.deepEqual(calls, [["use", "deepseek", "deepseek-reasoner"]]);

    const edit = card.querySelector('[data-provider-action="edit"]');
    assert.equal(edit.textContent, "···");
    assert.equal(edit.getAttribute("aria-label"), "编辑厂商");
    assert.equal(edit.title, "编辑厂商");
    edit.click();
    assert.deepEqual(calls.at(-1), ["edit", "deepseek"]);
  });

  it("keeps each provider select scoped to that provider's models", async () => {
    const { ProviderCardListView } = await loadViews();
    const host = document.createElement("div");
    new ProviderCardListView({ onUse() {}, onEdit() {}, onAdd() {} }).render(host, {
      current: null,
      providers: [
        {
          id: "first", name: "First", custom: true, configured: true,
          baseUrl: "https://first.example.test/v1", protocolLabel: "OpenAI 兼容",
          models: [{ id: "first-model", name: "First Model" }],
        },
        {
          id: "second", name: "Second", custom: true, configured: true,
          baseUrl: "https://second.example.test/v1", protocolLabel: "Anthropic 兼容",
          models: [{ id: "second-model", name: "Second Model" }],
        },
      ],
    });

    const cards = [...host.querySelectorAll(".provider-card")];
    assert.deepEqual([...cards[0].querySelectorAll("option")].map(option => option.value), ["first-model"]);
    assert.deepEqual([...cards[1].querySelectorAll("option")].map(option => option.value), ["second-model"]);
  });

  it("keeps the active model visible while a different model is pending in the select", async () => {
    const { ProviderCardListView } = await loadViews();
    const host = document.createElement("div");
    new ProviderCardListView({ onUse() {}, onEdit() {}, onAdd() {} }).render(host, {
      current: { providerId: "deepseek", modelId: "deepseek-chat" },
      providers: [{
        id: "deepseek", name: "DeepSeek", custom: false, configured: true,
        baseUrl: "https://api.deepseek.com/v1", protocolLabel: "官方",
        models: [
          { id: "deepseek-chat", name: "DeepSeek Chat" },
          { id: "deepseek-reasoner", name: "DeepSeek Reasoner" },
        ],
      }],
    });

    const card = host.querySelector('.provider-card[data-provider-id="deepseek"]');
    const select = card.querySelector("select");
    assert.equal(card.getAttribute("aria-current"), "true");
    assert.equal(card.querySelector(".provider-card-current")?.textContent, "当前：DeepSeek Chat");
    select.value = "deepseek-reasoner";
    select.dispatchEvent(new window.Event("change", { bubbles: true }));
    assert.equal(card.querySelector(".provider-card-current")?.textContent, "当前：DeepSeek Chat");
  });

  it("disables both model controls when a provider has no models", async () => {
    const { ProviderCardListView } = await loadViews();
    const host = document.createElement("div");
    new ProviderCardListView({ onUse() {}, onEdit() {}, onAdd() {} }).render(host, {
      current: null,
      providers: [{
        id: "empty", name: "Empty", custom: true, configured: true,
        baseUrl: "https://empty.example.test/v1", protocolLabel: "OpenAI 兼容", models: [],
      }],
    });

    assert.equal(host.querySelector(".provider-card-model-select").disabled, true);
    assert.equal(host.querySelector('[data-provider-action="use"]').disabled, true);
  });

  it("renders an empty state instead of opening an editor", async () => {
    const { ProviderCardListView } = await loadViews();
    const host = document.createElement("div");
    const calls = [];
    new ProviderCardListView({ onUse() {}, onEdit() {}, onAdd: () => calls.push("add") }).render(host, {
      current: null,
      providers: [],
    });

    assert.match(host.querySelector(".provider-empty")?.textContent ?? "", /添加厂商/);
    assert.equal(host.querySelector(".cpe-editor"), null);
    host.querySelector('[data-provider-action="add"]').click();
    assert.deepEqual(calls, ["add"]);
  });

  it("separates official providers from the three custom templates", async () => {
    const { ProviderPickerView } = await loadViews();
    const host = document.createElement("div");
    const calls = [];
    new ProviderPickerView({
      onBack: () => calls.push(["back"]),
      onOfficial: providerId => calls.push(["official", providerId]),
      onCustom: template => calls.push(["custom", template]),
    }).render(host, {
      official: [{ id: "openai", name: "OpenAI", configured: false }],
      customAvailable: true,
    });

    assert.equal(host.querySelectorAll(".provider-preset-official").length, 1);
    assert.deepEqual(
      [...host.querySelectorAll("[data-custom-template]")].map(node => node.dataset.customTemplate),
      ["openai", "anthropic", "other"],
    );
    assert.deepEqual(
      [...host.querySelectorAll("[data-custom-template]")].map(node => node.textContent.trim()),
      ["OpenAI 兼容", "Anthropic 兼容", "其他协议"],
    );

    host.querySelector('[data-provider-id="openai"]').click();
    host.querySelector('[data-custom-template="anthropic"]').click();
    host.querySelector('[data-provider-action="back"]').click();
    assert.deepEqual(calls, [["official", "openai"], ["custom", "anthropic"], ["back"]]);
  });

  it("disables all custom templates when custom providers are unavailable", async () => {
    const { ProviderPickerView } = await loadViews();
    const host = document.createElement("div");
    const calls = [];
    new ProviderPickerView({
      onBack() {},
      onOfficial() {},
      onCustom: template => calls.push(template),
    }).render(host, { official: [], customAvailable: false });

    const templates = [...host.querySelectorAll("[data-custom-template]")];
    assert.equal(templates.length, 3);
    assert.ok(templates.every(button => button.disabled));
    templates[0].click();
    assert.deepEqual(calls, []);
  });

  it("renders provider identities with local icons or inert text fallbacks", async () => {
    const { ProviderIdentityView } = await loadViews();
    const official = ProviderIdentityView.create("deepseek", "DeepSeek", false);
    assert.equal(official.querySelector("img")?.getAttribute("alt"), "");
    assert.equal(official.querySelector(".provider-identity-name")?.textContent, "DeepSeek");

    const unsafeName = '<img src=x onerror="alert(1)">';
    const custom = ProviderIdentityView.create("relay", unsafeName, true);
    assert.equal(custom.querySelector("img"), null);
    assert.equal(custom.querySelector(".provider-identity-fallback")?.getAttribute("aria-hidden"), "true");
    assert.equal(custom.querySelector(".provider-identity-name")?.textContent, unsafeName);
  });

  it("renders the official editor as a callback-driven DOM view", async () => {
    const { OfficialProviderEditorView } = await loadViews();
    const host = document.createElement("div");
    const calls = [];
    const view = new OfficialProviderEditorView({
      onBack: () => calls.push(["back"]),
      onReveal: providerId => calls.push(["reveal", providerId]),
      onApiKeyChange: (providerId, value) => calls.push(["key-change", providerId, value]),
      onKeyVisibilityChange: (providerId, revealed) => calls.push(["visibility", providerId, revealed]),
      onSave: (providerId, apiKey) => calls.push(["save", providerId, apiKey]),
      onUse: (providerId, modelId) => calls.push(["use", providerId, modelId]),
    });
    const state = {
      provider: { id: "official-test", name: '<b>Official Test</b>', configured: true },
      apiKey: {
        value: "sk-preview",
        placeholder: "输入 API Key...",
        revealed: false,
        canReveal: true,
        saving: false,
      },
      models: { status: "loading", items: [], activeModelId: null, error: "" },
    };

    view.render(host, state);
    assert.equal(host.querySelector("b"), null);
    assert.equal(host.querySelector(".provider-identity-name")?.textContent, '<b>Official Test</b>');
    assert.match(host.querySelector(".rp-models")?.textContent ?? "", /加载中/);
    const input = host.querySelector(".rp-key-input");
    const label = host.querySelector('label[for="key-input"]');
    assert.equal(label?.textContent, "API Key");
    assert.equal(label?.htmlFor, input.id);
    assert.equal(input.type, "password");
    host.querySelector('[data-provider-action="reveal-key"]').click();
    assert.deepEqual(calls, [["reveal", "official-test"]]);
    input.value = "sk-new";
    input.dispatchEvent(new window.Event("input", { bubbles: true }));
    host.querySelector('[data-provider-action="save-key"]').click();
    host.querySelector('[data-provider-action="back"]').click();
    assert.deepEqual(calls, [
      ["reveal", "official-test"],
      ["key-change", "official-test", "sk-new"],
      ["save", "official-test", "sk-new"],
      ["back"],
    ]);

    view.render(host, {
      ...state,
      models: { status: "error", items: [], activeModelId: null, error: "<em>模型加载失败</em>" },
    });
    assert.equal(host.querySelector("em"), null);
    assert.equal(host.querySelector(".rp-models")?.textContent, "<em>模型加载失败</em>");

    view.render(host, {
      ...state,
      models: {
        status: "ready",
        items: [
          { id: "official-model", name: '<i>Official Model</i>' },
          { id: "other-model", name: "Other Model" },
        ],
        activeModelId: "official-model",
        error: "",
      },
    });
    assert.equal(host.querySelector("i"), null);
    const model = host.querySelector('[data-model-id="official-model"]');
    assert.equal(model.textContent, '<i>Official Model</i>');
    model.click();
    assert.deepEqual(calls.at(-1), ["use", "official-test", "official-model"]);
  });

  it("exposes active official models through aria-pressed", async () => {
    const { OfficialProviderEditorView } = await loadViews();
    const host = document.createElement("div");
    new OfficialProviderEditorView({
      onBack() {},
      onReveal() {},
      onApiKeyChange() {},
      onKeyVisibilityChange() {},
      onSave() {},
      onUse() {},
    }).render(host, {
      provider: { id: "openai", name: "OpenAI", configured: true },
      apiKey: {
        value: "",
        placeholder: "输入 API Key...",
        revealed: false,
        canReveal: false,
        saving: false,
      },
      models: {
        status: "ready",
        items: [
          { id: "active-model", name: "Active Model" },
          { id: "other-model", name: "Other Model" },
        ],
        activeModelId: "active-model",
        error: "",
      },
    });

    assert.equal(host.querySelector('[data-model-id="active-model"]').getAttribute("aria-pressed"), "true");
    assert.equal(host.querySelector('[data-model-id="other-model"]').getAttribute("aria-pressed"), "false");
  });

  it("hides and re-shows an already revealed API key without another reveal request", async () => {
    const { OfficialProviderEditorView } = await loadViews();
    const host = document.createElement("div");
    const revealCalls = [];
    const visibilityCalls = [];
    new OfficialProviderEditorView({
      onBack() {},
      onReveal: providerId => revealCalls.push(providerId),
      onApiKeyChange() {},
      onKeyVisibilityChange: (providerId, revealed) => visibilityCalls.push([providerId, revealed]),
      onSave() {},
      onUse() {},
    }).render(host, {
      provider: { id: "openai", name: "OpenAI", configured: true },
      apiKey: {
        value: "sk-revealed",
        placeholder: "输入 API Key...",
        revealed: true,
        canReveal: true,
        saving: false,
      },
      models: { status: "idle", items: [], activeModelId: null, error: "" },
    });

    const input = host.querySelector(".rp-key-input");
    const toggle = host.querySelector('[data-provider-action="reveal-key"]');
    assert.equal(input.type, "text");
    assert.equal(toggle.textContent, "隐藏");
    assert.equal(toggle.title, "隐藏 API Key");
    assert.equal(toggle.getAttribute("aria-label"), "隐藏 API Key");
    toggle.click();
    assert.equal(input.type, "password");
    assert.equal(toggle.textContent, "显示");
    assert.equal(toggle.title, "显示 API Key");
    assert.equal(toggle.getAttribute("aria-label"), "显示 API Key");
    toggle.click();
    assert.equal(input.type, "text");
    assert.deepEqual(revealCalls, []);
    assert.deepEqual(visibilityCalls, [["openai", false], ["openai", true]]);
  });

  it("shows and hides a newly typed API key locally when stored reveal is unavailable", async () => {
    const { OfficialProviderEditorView } = await loadViews();
    const host = document.createElement("div");
    const revealCalls = [];
    const keyChanges = [];
    const visibilityCalls = [];
    new OfficialProviderEditorView({
      onBack() {},
      onReveal: providerId => revealCalls.push(providerId),
      onApiKeyChange: (providerId, value) => keyChanges.push([providerId, value]),
      onKeyVisibilityChange: (providerId, revealed) => visibilityCalls.push([providerId, revealed]),
      onSave() {},
      onUse() {},
    }).render(host, {
      provider: { id: "openai", name: "OpenAI", configured: false },
      apiKey: {
        value: "",
        placeholder: "输入 API Key...",
        revealed: false,
        canReveal: false,
        saving: false,
      },
      models: { status: "idle", items: [], activeModelId: null, error: "" },
    });

    const input = host.querySelector(".rp-key-input");
    const toggle = host.querySelector('[data-provider-action="reveal-key"]');
    assert.equal(toggle.disabled, true);
    input.value = "sk-new";
    input.dispatchEvent(new window.Event("input", { bubbles: true }));
    assert.equal(toggle.disabled, false);
    toggle.click();
    assert.equal(input.type, "text");
    assert.equal(toggle.textContent, "隐藏");
    assert.equal(toggle.title, "隐藏 API Key");
    assert.equal(toggle.getAttribute("aria-label"), "隐藏 API Key");
    toggle.click();
    assert.equal(input.type, "password");
    assert.deepEqual(revealCalls, []);
    assert.deepEqual(keyChanges, [["openai", "sk-new"]]);
    assert.deepEqual(visibilityCalls, [["openai", true], ["openai", false]]);
  });

  it("preserves controller-owned API key drafts and visibility across rerenders", async () => {
    const { OfficialProviderEditorView } = await loadViews();
    const host = document.createElement("div");
    const revealCalls = [];
    let draft = "";
    let revealed = false;
    const view = new OfficialProviderEditorView({
      onBack() {},
      onReveal: providerId => revealCalls.push(providerId),
      onApiKeyChange: (_providerId, value) => { draft = value; },
      onKeyVisibilityChange: (_providerId, value) => { revealed = value; },
      onSave() {},
      onUse() {},
    });
    const render = status => view.render(host, {
      provider: { id: "openai", name: "OpenAI", configured: false },
      apiKey: {
        value: draft,
        placeholder: "输入 API Key...",
        revealed,
        canReveal: false,
        saving: false,
      },
      models: { status, items: [], activeModelId: null, error: "" },
    });

    render("loading");
    const input = host.querySelector(".rp-key-input");
    input.value = "sk-draft";
    input.dispatchEvent(new window.Event("input", { bubbles: true }));
    host.querySelector('[data-provider-action="reveal-key"]').click();
    render("ready");

    assert.equal(draft, "sk-draft");
    assert.equal(revealed, true);
    assert.equal(host.querySelector(".rp-key-input").value, "sk-draft");
    assert.equal(host.querySelector(".rp-key-input").type, "text");
    assert.deepEqual(revealCalls, []);
  });

  it("keeps a preserved hidden draft locally revealable immediately after rerender", async () => {
    const { OfficialProviderEditorView } = await loadViews();
    const host = document.createElement("div");
    const revealCalls = [];
    const visibilityCalls = [];
    const view = new OfficialProviderEditorView({
      onBack() {},
      onReveal: providerId => revealCalls.push(providerId),
      onApiKeyChange() {},
      onKeyVisibilityChange: (providerId, revealed) => visibilityCalls.push([providerId, revealed]),
      onSave() {},
      onUse() {},
    });
    const render = status => view.render(host, {
      provider: { id: "openai", name: "OpenAI", configured: false },
      apiKey: {
        value: "sk-preserved-draft",
        placeholder: "输入 API Key...",
        revealed: false,
        canReveal: false,
        saving: false,
      },
      models: { status, items: [], activeModelId: null, error: "" },
    });

    render("loading");
    render("ready");
    const input = host.querySelector(".rp-key-input");
    const toggle = host.querySelector('[data-provider-action="reveal-key"]');
    assert.equal(input.value, "sk-preserved-draft");
    assert.equal(input.type, "password");
    assert.equal(toggle.disabled, false);
    toggle.click();
    assert.equal(input.type, "text");
    assert.deepEqual(visibilityCalls, [["openai", true]]);
    assert.deepEqual(revealCalls, []);
  });
});

describe("provider settings controller", () => {
  it("shows configured official providers and saved custom providers only", async () => {
    const { host } = await loadController({
      fetchImpl: standardControllerFetch(),
      order: ["acme", "openai", "anthropic"],
    });

    assert.deepEqual(
      [...host.querySelectorAll(".provider-card")].map(card => card.dataset.providerId),
      ["acme", "anthropic"],
    );
  });

  it("keeps the current unconfigured official provider visible", async () => {
    const { host } = await loadController({
      fetchImpl: standardControllerFetch(),
      dashboard: { modelProvider: "openai", modelId: "gpt-5" },
    });

    const openai = host.querySelector('.provider-card[data-provider-id="openai"]');
    assert.ok(openai);
    assert.equal(openai.getAttribute("aria-current"), "true");
  });

  it("opens the provider picker without mounting a custom editor", async () => {
    const { host, editorCalls } = await loadController({ fetchImpl: standardControllerFetch() });
    const callsBeforeAdd = editorCalls.length;
    const add = host.querySelector('[data-provider-action="add"]');
    assert.ok(add, "card list add action should render");

    add.click();

    assert.ok(host.querySelector(".provider-picker"));
    assert.equal(host.querySelector(".cpe-editor"), null);
    assert.equal(editorCalls.slice(callsBeforeAdd).some(([name]) => name === "startNew"), false);
  });

  it("opens official presets and starts custom templates with occupied provider ids", async () => {
    const first = await loadController({ fetchImpl: standardControllerFetch() });
    const firstAdd = first.host.querySelector('[data-provider-action="add"]');
    assert.ok(firstAdd, "card list add action should render");
    firstAdd.click();
    const officialPreset = first.host.querySelector('.provider-preset-official[data-provider-id="openai"]');
    assert.ok(officialPreset, "OpenAI preset should render");
    officialPreset.click();
    assert.ok(first.host.querySelector(".rp-official"));
    assert.equal(first.host.querySelector(".cpe-editor"), null);

    const second = await loadController({ fetchImpl: standardControllerFetch() });
    const secondAdd = second.host.querySelector('[data-provider-action="add"]');
    assert.ok(secondAdd, "card list add action should render");
    secondAdd.click();
    const customPreset = second.host.querySelector('[data-custom-template="anthropic"]');
    assert.ok(customPreset, "Anthropic custom template should render");
    customPreset.click();
    const start = second.editorCalls.find(([name]) => name === "startNew");
    assert.equal(start?.[2]?.template, "anthropic");
    assert.deepEqual([...start[2].occupiedProviderIds], ["openai", "anthropic", "acme"]);
  });

  it("switches models only when the use action is clicked", async () => {
    const requests = [];
    const { host } = await loadController({
      fetchImpl: standardControllerFetch({ requests }),
      dashboard: { modelProvider: "anthropic", modelId: "claude-sonnet" },
    });
    const card = host.querySelector('.provider-card[data-provider-id="acme"]');
    assert.ok(card, "custom provider card should render");
    const select = card.querySelector("select");
    assert.ok(select, "provider model select should render");

    select.value = "acme-chat";
    select.dispatchEvent(new window.Event("change", { bubbles: true }));
    assert.equal(requests.filter(([url, init]) => url === "/api/model/switch" && init.method === "POST").length, 0);

    card.querySelector('[data-provider-action="use"]').click();
    await flushControllerWork();
    const switches = requests.filter(([url, init]) => url === "/api/model/switch" && init.method === "POST");
    assert.equal(switches.length, 1);
    assert.deepEqual(JSON.parse(switches[0][1].body), { provider: "acme", modelId: "acme-chat" });
  });

  it("unmounts the custom editor when returning to the card list", async () => {
    const { host, editorCalls } = await loadController({ fetchImpl: standardControllerFetch() });
    const edit = host.querySelector('.provider-card[data-provider-id="acme"] [data-provider-action="edit"]');
    assert.ok(edit, "custom provider edit action should render");
    edit.click();
    assert.ok(host.querySelector(".cpe-editor"));
    const unmountsBeforeBack = editorCalls.filter(([name]) => name === "unmount").length;

    const back = host.querySelector('[data-provider-action="back"]');
    assert.ok(back, "custom provider back action should render");
    back.click();

    assert.ok(host.querySelector(".provider-card-list"));
    assert.equal(host.querySelector(".cpe-editor"), null);
    assert.equal(editorCalls.filter(([name]) => name === "unmount").length, unmountsBeforeBack + 1);
  });
});
