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

  it("waits for the permission event channel before rendering protected panes", () => {
    const html = readFileSync(new URL("../src/frontend/dashboard.html", import.meta.url), "utf8");
    const startEvents = html.indexOf("await window.ExplorerService?.startEvents?.()");
    const layout = html.indexOf("layout()", startEvents);

    assert.ok(startEvents >= 0, "startup should await the permission event channel");
    assert.ok(layout > startEvents, "layout should run only after the event channel is ready");
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
