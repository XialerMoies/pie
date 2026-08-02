import { before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Window } from "happy-dom";

const win = new Window();
const storage = new Map();

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
global.toast = () => {};
global.getD = () => {};
win.__state = { D: null };
win.App = { Settings: {} };
global.App = win.App;

let fetchImpl = async () => ({ ok: true, json: async () => ({}) });
global.fetch = (...args) => fetchImpl(...args);

before(async () => {
  await import(`../src/frontend/services/chat-runtime-store.ts?settings-ui=${Date.now()}`);
  await import(`../src/frontend/services/preferences.ts?settings-ui=${Date.now()}`);
  await import("../src/frontend/dashboard/dashboard-settings.ts");
});

beforeEach(() => {
  document.body.innerHTML = "";
  document.documentElement.classList.remove("theme-light");
  storage.clear();
  delete win.__monaco;
  win.__state.D = null;
  win._provOrder = [];
  fetchImpl = async (url) => {
    if (String(url) === "/api/auth") return { ok: true, json: async () => ({ providers: [] }) };
    if (String(url) === "/api/models") return { ok: true, json: async () => ({ models: [] }) };
    return { ok: true, json: async () => ({ ok: true }) };
  };
});

async function flushAsyncWork() {
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
  await Promise.resolve();
}

describe("settings DOM boundary", () => {
  it("does not use inline event attributes", () => {
    const source = readFileSync(resolve(process.cwd(), "src/frontend/dashboard/dashboard-settings.ts"), "utf8");
    assert.doesNotMatch(source, /\son(?:click|change|dragstart|dragover|drop)\s*=/i);
  });

  it("keeps hostile provider names as inert data and handles selection through DOM events", async () => {
    const hostileProvider = 'bad" onclick="globalThis.__settingsInjected=true';
    storage.set("providers_order", JSON.stringify([hostileProvider, "openai"]));

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
    storage.set("providers_order", JSON.stringify(["openai"]));
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
});
