import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Window } from "happy-dom";

function setup(win = new Window()) {
  global.window = win;
  global.document = win.document;
  global.localStorage = win.localStorage;
  global.performance = win.performance;
  global.App = win.App = { UI: {}, State: { getWorkspacePath: () => "" } };
  global.$ = () => null;
  global.S = () => "";
  global.E = (value) => String(value ?? "");
  global.F = () => "";
  global.sb = () => "";
  global.toast = () => {};
  global.mark = () => {};
  global.logTiming = () => {};
  return win;
}

const desktopWindow = setup();
const dashboardApp = desktopWindow.App;
const dashboardHelpers = await import("../src/frontend/dashboard/dashboard-helpers.ts?desktop-auth-suite");
const dashboardHelpersRetry = await import("../src/frontend/dashboard/dashboard-helpers.ts?desktop-auth-retry-suite");

describe("desktop API bootstrap", { concurrency: false }, () => {
  const win = desktopWindow;

  beforeEach(() => {
    setup(win);
  });

  it("rejects when the Electron preload token API is unavailable", async () => {
    const calls = [];
    global.fetch = async (...args) => { calls.push(args); };
    win.fetch = global.fetch;

    await assert.rejects(dashboardHelpers.bootstrapApi(), /preload API is unavailable/);
    assert.equal(calls.length, 0);
  });

  it("passes the desktop token to bootstrap and rejects non-success responses", async () => {
    const calls = [];
    win.electronAPI = { getDesktopSessionToken: async () => "desktop-token" };
    global.fetch = async (...args) => {
      calls.push(args);
      return { ok: false, status: 403, text: async () => '{"code":"bad_token"}' };
    };
    win.fetch = global.fetch;

    await assert.rejects(dashboardHelpers.bootstrapApi(), /403/);
    assert.deepEqual(calls[0][1].headers, { "X-My-Code-Agent-Token": "desktop-token" });
  });

  it("seeds the frontend workspace from bootstrap before startup continues", async () => {
    const workspace = "C:\\Users\\ASUS\\Desktop\\project-007";
    const seeded = [];
    dashboardApp.State.getWorkspacePath = () => seeded.at(-1) || "";
    dashboardApp.State.setWorkspacePath = (value) => { seeded.push(value); };
    win.electronAPI = { getDesktopSessionToken: async () => "desktop-token" };
    global.fetch = async () => ({
      ok: true,
      json: async () => ({ ok: true, startup: { workspace } }),
    });
    win.fetch = global.fetch;

    await dashboardHelpers.bootstrapApi();

    assert.deepEqual(seeded, [workspace]);
  });

  it("renders the shell before background workspace recovery in development and packaged startup", () => {
    const html = readFileSync(new URL("../src/frontend/dashboard.html", import.meta.url), "utf8");
    const startup = readFileSync(new URL("../src/frontend/dashboard/dashboard-startup.ts", import.meta.url), "utf8");

    assert.match(html, /<html\s+lang=["']zh-CN["']\s+class=["']preferences-loading["']/);
    assert.match(html, /html\.preferences-loading\s+body\s*\{/);
    assert.doesNotMatch(html, /localStorage\.getItem\(['"]editor-theme['"]\)/);
    assert.match(html, /<script\s+src=["']\.\/gen\/dashboard\/dashboard-startup\.js["']><\/script>/);
    const layout = startup.indexOf("layout()");
    const bootstrap = startup.indexOf("await bootstrapApi()");
    const preferences = startup.indexOf("await hydratePreferencesForStartup()");
    assert.ok(bootstrap >= 0, "canonical startup should bootstrap the API");
    assert.ok(preferences > bootstrap, "canonical startup should hydrate preferences after bootstrap");
    assert.ok(layout > preferences, "canonical startup should render after preference hydration");
    assert.ok(layout >= 0, "canonical startup should render the shell");
    assert.match(startup, /Promise\.race\(\[/, "preference hydration should have a startup deadline");
    assert.match(startup, /App\.Preferences\.hydrate\(\)/, "the bounded startup helper should hydrate preferences");
    assert.doesNotMatch(startup, /syncStartupWorkspace|\/api\/workspace\/switch|resetWorkspace\(""\)/);
  });

  it("spawns the development server before synchronous compilation and starts Electron before server readiness", () => {
    const devScript = readFileSync(new URL("../scripts/dev.mjs", import.meta.url), "utf8");
    const startServer = devScript.indexOf("const serverReady = startServer(markServerSpawned)");
    const awaitSpawn = devScript.indexOf("await Promise.race([serverSpawned, serverReady])", startServer);
    const buildElectron = devScript.indexOf("buildElectron()", awaitSpawn);
    const startElectron = devScript.indexOf("startElectron()", startServer);
    const awaitServer = devScript.indexOf("await serverReady", startElectron);

    assert.ok(startServer >= 0, "development startup should retain the server readiness promise");
    assert.ok(awaitSpawn > startServer, "development startup should wait until the server child is spawned");
    assert.ok(buildElectron > awaitSpawn, "the server child should run while synchronous compilation blocks the launcher");
    assert.ok(startElectron > startServer, "Electron should start after the server process is spawned");
    assert.ok(awaitServer > startElectron, "server readiness should be awaited after Electron starts");
  });

  it("does not expose a startup workspace switch helper", () => {
    assert.equal(dashboardHelpers.syncStartupWorkspace, undefined);
  });

  it("retries transient bootstrap failures while the server is starting", async () => {
    const calls = [];
    const workspace = "C:\\Users\\ASUS\\Desktop\\project-007";
    dashboardApp.State.getWorkspacePath = () => "";
    dashboardApp.State.setWorkspacePath = (value) => calls.push({ type: "workspace", value });
    win.electronAPI = { getDesktopSessionToken: async () => "desktop-token" };
    global.fetch = async (...args) => {
      calls.push({ type: "fetch", args });
      if (calls.filter((entry) => entry.type === "fetch").length === 1) {
        return { ok: false, status: 503, text: async () => "server starting" };
      }
      return { ok: true, json: async () => ({ startup: { workspace } }) };
    };
    win.fetch = global.fetch;

    await dashboardHelpersRetry.bootstrapApi();

    assert.equal(calls.filter((entry) => entry.type === "fetch").length, 2);
    assert.deepEqual(calls.at(-1), { type: "workspace", value: workspace });
  });
});
