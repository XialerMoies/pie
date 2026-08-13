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
    if (String(url) === "/api/subagents") return { ok: true, json: async () => ({ agents: [] }) };
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
    assert.ok(document.querySelector('.sa-agent-pane > .sa-sidebar-head [data-settings-action="new-subagent"]'));
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
      if (init?.method === "POST") postCalls.push([url, init]);
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
      if (init?.method === "POST") postCalls.push([url, init]);
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
