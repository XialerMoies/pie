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
const dashboardHelpers = await import("../src/frontend/dashboard/dashboard-helpers.ts?desktop-auth-suite");

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

  it("does not expose a startup workspace switch helper", () => {
    assert.equal(dashboardHelpers.syncStartupWorkspace, undefined);
  });
});
