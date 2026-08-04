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

    assert.match(html, /<script\s+src=["']\.\/gen\/dashboard\/dashboard-startup\.js["']><\/script>/);
    const layout = startup.indexOf("layout()");
    const sync = startup.indexOf("syncStartupWorkspace()", layout);
    assert.ok(layout >= 0, "canonical startup should render the shell");
    assert.ok(sync > layout, "canonical startup should recover the workspace after rendering");

    assert.match(startup, /catch[\s\S]*App\.State\.resetWorkspace\(""\)/);
  });

  it("syncs the persisted workspace once before protected panes load", async () => {
    win.App.State.getWorkspacePath = () => "E:\\workspace";
    const calls = [];
    global.fetch = async (...args) => {
      calls.push(args);
      return { ok: true, status: 200, text: async () => "" };
    };
    win.fetch = global.fetch;

    await dashboardHelpers.syncStartupWorkspace();

    assert.equal(calls.length, 1);
    assert.equal(calls[0][0], "/api/workspace/switch");
    assert.deepEqual(JSON.parse(calls[0][1].body), { workspace: "E:\\workspace" });
  });
});
