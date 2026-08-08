import { before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Window } from "happy-dom";

const win = new Window();
const storage = new Map();
const settingsSpies = {
  refreshCalls: [],
};

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
  await import(`../src/frontend/services/chat-runtime-store.ts?settings-ui=${Date.now()}`);
  await import(`../src/frontend/services/preferences.ts?settings-ui=${Date.now()}`);
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
    if (String(url) === "/api/models") return { ok: true, json: async () => ({ models: [] }) };
    return { ok: true, json: async () => ({ ok: true }) };
  };
});

async function flushAsyncWork() {
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
  await Promise.resolve();
}

async function openGeneralSettings() {
  win.App.Settings.openSettingsModal();
  await flushAsyncWork();
  const generalTab = document.querySelector('.ms-item[data-st="general"]');
  assert.ok(generalTab, "General settings tab should be rendered");
  generalTab.click();
}

function getControl(id) {
  const control = document.getElementById(id);
  assert.ok(control, `${id} should be rendered`);
  return control;
}

describe("settings DOM boundary", () => {
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
      { value: "true", label: "平滑" },
      { value: "false", label: "立即" },
    ]);
    assert.strictEqual(jumpSmooth.value, "true");
    assert.strictEqual(document.getElementById("gs-jump-threshold")?.value, "72");
  });

  it("selects a storage root through Electron and stages it for restart", async () => {
    const selectedRoot = "E:\\agent-data";
    let postedRoot = null;
    win.electronAPI = { openFolder: async () => selectedRoot };
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
    assert.match(document.getElementById("gs-data-root-status")?.textContent || "", /重启后生效/);
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
