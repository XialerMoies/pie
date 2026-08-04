import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Script } from "node:vm";
import { transform } from "esbuild";

function createEventSourceMock() {
  const instances = [];

  class FakeEventSource {
    constructor(url) {
      this.url = url;
      this.onopen = null;
      this.onmessage = null;
      this.onerror = null;
      this.closed = false;
      instances.push(this);
    }

    close() {
      this.closed = true;
    }
  }

  return { FakeEventSource, instances };
}

function createTimerMock() {
  const timers = [];
  return {
    timers,
    setTimeout(callback, delay) {
      const timer = { callback, delay, cleared: false };
      timers.push(timer);
      return timer;
    },
    clearTimeout(timer) {
      if (timer) timer.cleared = true;
    },
  };
}

async function loadAppEvents() {
  const stamp = `${Date.now()}-${Math.random()}`;
  return import(`../src/frontend/services/app-events.ts?app-events=${stamp}`);
}

async function compileClassicScript(file) {
  const source = readFileSync(resolve(process.cwd(), file), "utf8");
  const result = await transform(source, { loader: "ts", minify: false });
  return result.code.replace(/^export\s+/gm, "");
}

function resetWindow() {
  global.window = { App: {} };
}

describe("App.Events frontend event bus", () => {
  let hadWindow;
  let originalWindow;

  beforeEach(() => {
    hadWindow = Object.prototype.hasOwnProperty.call(global, "window");
    originalWindow = global.window;
    resetWindow();
  });

  afterEach(() => {
    if (hadWindow) global.window = originalWindow;
    else delete global.window;
  });

  it("preserves App.Events through the production initialization order", async () => {
    const namespaces = {
      Constants: { legacyConstant: true },
      UI: { legacyUI: true },
      Chat: { legacyChat: true },
      File: { legacyFile: true },
      Session: { legacySession: true },
      Settings: { legacySettings: true },
      Tabs: { legacyTabs: true },
    };
    const context = {
      window: { App: namespaces },
      document: { getElementById: () => null, createElement: () => ({}) },
      console,
      setTimeout,
      clearTimeout,
    };
    const appEventsScript = await compileClassicScript("src/frontend/services/app-events.ts");
    const dashboardHelpersScript = await compileClassicScript("src/frontend/dashboard/dashboard-helpers.ts");

    new Script(appEventsScript, { filename: "app-events.js" }).runInNewContext(context);
    const appNamespace = context.window.App;
    const events = context.window.App.Events;
    assert.ok(events);

    new Script(dashboardHelpersScript, { filename: "dashboard-helpers.js" }).runInNewContext(context);

    assert.strictEqual(context.window.App, appNamespace);
    assert.strictEqual(context.window.App.Events, events);
    assert.strictEqual(typeof context.window.App.UI.bootstrapApi, "function");
    for (const [name, namespace] of Object.entries(namespaces)) {
      assert.strictEqual(context.window.App[name], namespace, `${name} reference should be preserved`);
    }
    assert.strictEqual(context.window.App.Constants.legacyConstant, true);
    assert.strictEqual(context.window.App.Tabs.legacyTabs, true);
  });

  it("keeps event and UI state subscriptions isolated in the concatenated bundle", async () => {
    const { FakeEventSource, instances } = createEventSourceMock();
    const context = {
      window: { App: {} },
      EventSource: FakeEventSource,
      console,
      setTimeout,
      clearTimeout,
    };
    const appEventsScript = await compileClassicScript("src/frontend/services/app-events.ts");
    const uiStateStoreScript = await compileClassicScript("src/frontend/services/ui-state-store.ts");
    const bundle = `${appEventsScript}\n${uiStateStoreScript}`;

    new Script(bundle, { filename: "dashboard.js" }).runInNewContext(context);

    let eventNotifications = 0;
    let uiStateNotifications = 0;
    context.window.App.Events.subscribe("explorer.changed", () => { eventNotifications += 1; });
    context.window.__uiStateStore.subscribe(() => { uiStateNotifications += 1; });

    assert.doesNotThrow(() => context.window.__uiStateStore.patchState({}));
    const ready = context.window.App.Events.start();
    instances[0].onopen?.();
    await ready;
    instances[0].onmessage?.({
      data: JSON.stringify({ type: "explorer.changed", revision: 1 }),
    });

    assert.strictEqual(uiStateNotifications, 1);
    assert.strictEqual(eventNotifications, 1);
    context.window.App.Events.stop();
  });

  it("creates one EventSource for repeated starts and resolves on first open", async () => {
    resetWindow();
    const { FakeEventSource, instances } = createEventSourceMock();
    const oldEventSource = global.EventSource;
    global.EventSource = FakeEventSource;

    try {
      await loadAppEvents();
      const App = global.window.App;
      const first = App.Events.start();
      const second = App.Events.start();

      assert.strictEqual(instances.length, 1);
      assert.strictEqual(first, second);
      assert.strictEqual(instances[0].url, "/api/events");
      instances[0].onopen?.(new Event("open"));
      await Promise.all([first, second]);
    } finally {
      global.window.App.Events?.stop();
      global.EventSource = oldEventSource;
    }
  });

  it("dispatches typed messages and resync on every open", async () => {
    resetWindow();
    const { FakeEventSource, instances } = createEventSourceMock();
    const oldEventSource = global.EventSource;
    global.EventSource = FakeEventSource;

    try {
      await loadAppEvents();
      const App = global.window.App;
      const received = [];
      const resyncs = [];
      App.Events.subscribe("dashboard.changed", (event) => received.push(event));
      App.Events.subscribe("resync", (event) => resyncs.push(event));

      const ready = App.Events.start();
      instances[0].onopen?.(new Event("open"));
      await ready;
      instances[0].onmessage?.({ data: JSON.stringify({ type: "dashboard.changed", revision: 7, payload: { reason: "model" } }) });
      instances[0].onmessage?.({ data: JSON.stringify({ type: "usage.changed", revision: 8 }) });
      instances[0].onopen?.(new Event("open"));

      assert.deepStrictEqual(received, [{ type: "dashboard.changed", revision: 7, payload: { reason: "model" } }]);
      assert.deepStrictEqual(resyncs, [
        { type: "resync", revision: 0 },
        { type: "resync", revision: 0 },
      ]);
    } finally {
      global.window.App.Events?.stop();
      global.EventSource = oldEventSource;
    }
  });

  it("ignores malformed messages and isolates handler exceptions", async () => {
    resetWindow();
    const { FakeEventSource, instances } = createEventSourceMock();
    const oldEventSource = global.EventSource;
    const oldConsoleError = console.error;
    global.EventSource = FakeEventSource;
    console.error = () => {};

    try {
      await loadAppEvents();
      const App = global.window.App;
      const received = [];
      App.Events.subscribe("dashboard.changed", () => { throw new Error("handler failed"); });
      App.Events.subscribe("dashboard.changed", (event) => received.push(event));
      const ready = App.Events.start();
      instances[0].onopen?.(new Event("open"));
      await ready;

      instances[0].onmessage?.({ data: "not json" });
      instances[0].onmessage?.({ data: JSON.stringify({ type: "dashboard.changed", revision: 1 }) });

      assert.strictEqual(received.length, 1);
    } finally {
      global.window.App.Events?.stop();
      global.EventSource = oldEventSource;
      console.error = oldConsoleError;
    }
  });

  it("ignores events from an old generation after stop and restart", async () => {
    resetWindow();
    const { FakeEventSource, instances } = createEventSourceMock();
    const oldEventSource = global.EventSource;
    global.EventSource = FakeEventSource;

    try {
      await loadAppEvents();
      const App = global.window.App;
      const received = [];
      const resyncs = [];
      App.Events.subscribe("dashboard.changed", (event) => received.push(event));
      App.Events.subscribe("resync", (event) => resyncs.push(event));

      const firstReady = App.Events.start();
      const first = instances[0];
      first.onopen?.(new Event("open"));
      await firstReady;
      const staleOpen = first.onopen;
      const staleMessage = first.onmessage;
      const staleError = first.onerror;
      App.Events.stop();

      const secondReady = App.Events.start();
      const second = instances[1];
      let secondOpened = false;
      void secondReady.then(() => { secondOpened = true; });
      staleOpen?.(new Event("open"));
      staleMessage?.({ data: JSON.stringify({ type: "dashboard.changed", revision: 1 }) });
      staleError?.(new Event("error"));
      await Promise.resolve();
      assert.strictEqual(secondOpened, false);
      second.onopen?.(new Event("open"));
      await secondReady;
      second.onmessage?.({ data: JSON.stringify({ type: "dashboard.changed", revision: 2 }) });

      assert.deepStrictEqual(received, [{ type: "dashboard.changed", revision: 2 }]);
      assert.strictEqual(resyncs.length, 2);
      assert.strictEqual(first.closed, true);
    } finally {
      global.window.App.Events?.stop();
      global.EventSource = oldEventSource;
    }
  });

  it("rejects after the five-second handshake timeout without creating a second source", async () => {
    resetWindow();
    const { FakeEventSource, instances } = createEventSourceMock();
    const oldEventSource = global.EventSource;
    const oldSetTimeout = global.setTimeout;
    const oldClearTimeout = global.clearTimeout;
    const timerMock = createTimerMock();
    global.EventSource = FakeEventSource;
    global.setTimeout = timerMock.setTimeout;
    global.clearTimeout = timerMock.clearTimeout;

    try {
      await loadAppEvents();
      const App = global.window.App;
      const resyncs = [];
      App.Events.subscribe("resync", (event) => resyncs.push(event));
      const ready = App.Events.start();
      assert.strictEqual(instances.length, 1);
      assert.strictEqual(timerMock.timers[0].delay, 5000);
      instances[0].onerror?.(new Event("error"));
      timerMock.timers[0].callback();
      await assert.rejects(ready, /event channel handshake timed out/);
      assert.strictEqual(timerMock.timers[0].cleared, true);
      assert.strictEqual(instances.length, 1);
      assert.strictEqual(instances[0].closed, false);
      instances[0].onopen?.(new Event("open"));
      assert.deepStrictEqual(resyncs, [{ type: "resync", revision: 0 }]);
      await App.Events.start();

      App.Events.stop();
      const restarted = App.Events.start();
      assert.strictEqual(instances.length, 2);
      instances[1].onopen?.(new Event("open"));
      await restarted;
      assert.strictEqual(timerMock.timers[1].cleared, true);
    } finally {
      global.window.App.Events?.stop();
      global.EventSource = oldEventSource;
      global.setTimeout = oldSetTimeout;
      global.clearTimeout = oldClearTimeout;
    }
  });

  it("turns EventSource construction failures into rejected readiness and permits retry", async () => {
    resetWindow();
    const instances = [];
    let failConstruction = true;
    class FakeEventSource {
      constructor(url) {
        if (failConstruction) throw new Error("constructor failed");
        this.url = url;
        this.onopen = null;
        this.onmessage = null;
        this.onerror = null;
        this.closed = false;
        instances.push(this);
      }

      close() {
        this.closed = true;
      }
    }
    const oldEventSource = global.EventSource;
    global.EventSource = FakeEventSource;

    try {
      await loadAppEvents();
      const App = global.window.App;
      let readiness;
      assert.doesNotThrow(() => { readiness = App.Events.start(); });
      await assert.rejects(readiness, /constructor failed/);

      failConstruction = false;
      const retry = App.Events.start();
      assert.strictEqual(instances.length, 1);
      instances[0].onopen?.(new Event("open"));
      await retry;
    } finally {
      global.window.App.Events?.stop();
      global.EventSource = oldEventSource;
    }
  });

  it("stops a pre-handshake connection and rebuilds it without stale readiness", async () => {
    resetWindow();
    const { FakeEventSource, instances } = createEventSourceMock();
    const oldEventSource = global.EventSource;
    const oldSetTimeout = global.setTimeout;
    const oldClearTimeout = global.clearTimeout;
    const timerMock = createTimerMock();
    global.EventSource = FakeEventSource;
    global.setTimeout = timerMock.setTimeout;
    global.clearTimeout = timerMock.clearTimeout;

    try {
      await loadAppEvents();
      const App = global.window.App;
      const firstReadiness = App.Events.start();
      const firstTimer = timerMock.timers[0];
      App.Events.stop();
      await assert.rejects(firstReadiness, /event channel stopped/);
      assert.strictEqual(instances[0].closed, true);
      assert.strictEqual(firstTimer.cleared, true);

      const secondReadiness = App.Events.start();
      assert.strictEqual(instances.length, 2);
      firstTimer.callback();
      let secondOpened = false;
      void secondReadiness.then(() => { secondOpened = true; });
      await Promise.resolve();
      assert.strictEqual(secondOpened, false);
      instances[1].onopen?.(new Event("open"));
      await secondReadiness;
      assert.strictEqual(timerMock.timers[1].cleared, true);
    } finally {
      global.window.App.Events?.stop();
      global.EventSource = oldEventSource;
      global.setTimeout = oldSetTimeout;
      global.clearTimeout = oldClearTimeout;
    }
  });

  it("unsubscribes handlers and clears the source state on stop", async () => {
    resetWindow();
    const { FakeEventSource, instances } = createEventSourceMock();
    const oldEventSource = global.EventSource;
    global.EventSource = FakeEventSource;

    try {
      await loadAppEvents();
      const App = global.window.App;
      const received = [];
      const unsubscribe = App.Events.subscribe("dashboard.changed", (event) => received.push(event));
      const ready = App.Events.start();
      instances[0].onopen?.(new Event("open"));
      await ready;
      unsubscribe();
      instances[0].onmessage?.({ data: JSON.stringify({ type: "dashboard.changed", revision: 1 }) });
      App.Events.stop();

      assert.deepStrictEqual(received, []);
      assert.strictEqual(instances[0].closed, true);
      assert.strictEqual(instances[0].onopen, null);
      assert.strictEqual(instances[0].onmessage, null);
      assert.strictEqual(instances[0].onerror, null);
      App.Events.stop();
    } finally {
      global.EventSource = oldEventSource;
    }
  });

  it("places the event bus before dashboard consumers in the bundle", () => {
    const compiler = readFileSync(resolve(process.cwd(), "scripts/compile-frontend-ts.mjs"), "utf8");
    const eventsIndex = compiler.indexOf('"gen/services/app-events.js"');
    const helpersIndex = compiler.indexOf('"gen/dashboard/dashboard-helpers.js"');
    const explorerIndex = compiler.indexOf('"gen/service/explorer-service.js"');
    assert.notStrictEqual(eventsIndex, -1);
    assert.ok(eventsIndex < helpersIndex);
    assert.ok(eventsIndex < explorerIndex);
  });

  it("executes the dashboard startup with one shared EventSource", async () => {
    const { FakeEventSource, instances } = createEventSourceMock();
    const calls = [];
    const intervals = [];
    const context = {
      window: { App: {} },
      EventSource: FakeEventSource,
      console,
      setTimeout,
      clearTimeout,
      setInterval: (callback, delay) => { intervals.push({ callback, delay }); return 1; },
      bootstrapApi: async () => { calls.push("bootstrap"); },
      layout: () => { calls.push("layout"); },
      refresh: () => {},
      syncStartupWorkspace: async () => { calls.push("workspace"); },
      getD: () => { calls.push("dashboard"); },
      loadSessions: () => { calls.push("sessions"); },
      toast: () => {},
    };
    context.App = context.window.App;
    const appEventsScript = await compileClassicScript("src/frontend/services/app-events.ts");
    const startupScript = await compileClassicScript("src/frontend/dashboard/dashboard-startup.ts");

    new Script(appEventsScript, { filename: "app-events.js" }).runInNewContext(context);
    const start = context.App.Events.start;
    let startCalls = 0;
    context.App.Events.start = () => {
      startCalls += 1;
      return start();
    };
    new Script(startupScript, { filename: "dashboard-startup.js" }).runInNewContext(context);
    await new Promise((resolve) => setImmediate(resolve));

    assert.strictEqual(startCalls, 1);
    assert.strictEqual(instances.length, 1);
    assert.deepStrictEqual(intervals, []);
    assert.strictEqual(instances[0].url, "/api/events");
    instances[0].onopen?.(new Event("open"));
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepStrictEqual(calls, ["bootstrap", "layout", "dashboard", "workspace", "dashboard", "sessions"]);
    context.App.Events.stop();
  });

  it("continues workspace recovery when shared event startup rejects", async () => {
    const calls = [];
    const context = {
      window: {},
      console: { ...console, warn: () => {} },
      setInterval: () => { throw new Error("Dashboard polling should not be installed"); },
      bootstrapApi: async () => { calls.push("bootstrap"); },
      layout: () => { calls.push("layout"); },
      refresh: () => {},
      syncStartupWorkspace: async () => { calls.push("workspace"); },
      getD: () => { calls.push("dashboard"); },
      loadSessions: () => { calls.push("sessions"); },
      toast: () => {},
      App: {
        Events: {
          subscribe: () => () => {},
          start: async () => { calls.push("events"); throw new Error("offline"); },
        },
        State: { resetWorkspace: () => { calls.push("reset"); } },
      },
    };
    context.window.App = context.App;
    const startupScript = await compileClassicScript("src/frontend/dashboard/dashboard-startup.ts");

    new Script(startupScript, { filename: "dashboard-startup.js" }).runInNewContext(context);
    await new Promise((resolve) => setImmediate(resolve));

    assert.deepStrictEqual(calls, ["bootstrap", "layout", "events", "workspace", "dashboard", "sessions"]);
  });

  it("coalesces dashboard events into one follow-up request without stale overwrite", async () => {
    const { FakeEventSource, instances } = createEventSourceMock();
    const dashboardRequests = [];
    const dashboardData = [
      { modelId: "first", runtime: 10 },
      { modelId: "second", runtime: 20 },
    ];
    const dashboardResolvers = [];
    const context = {
      window: {
        App: {
          State: { getWorkspacePath: () => "" },
          Chat: { updateModelName: () => {} },
          ChatState: { setDashboard: (data) => dashboardRequests.push({ type: "state", data }), getDashboard: () => null },
        },
        electronAPI: { getDesktopSessionToken: async () => "desktop-token" },
      },
      EventSource: FakeEventSource,
      console: { ...console, warn: () => {} },
      setTimeout,
      clearTimeout,
      fetch: async (url) => {
        if (url === "/api/bootstrap") return { ok: true };
        if (url !== "/api/dashboard") return { ok: true, json: async () => ({}) };
        const index = dashboardRequests.filter((entry) => entry.type === "request").length;
        dashboardRequests.push({ type: "request", index });
        return new Promise((resolve) => dashboardResolvers.push(() => resolve({ ok: true, json: async () => dashboardData[index] })));
      },
      bootstrapApi: undefined,
      layout: () => {},
      syncStartupWorkspace: async () => {},
      loadSessions: () => {},
      toast: () => {},
    };
    context.App = context.window.App;

    const appEventsScript = await compileClassicScript("src/frontend/services/app-events.ts");
    const helpersScript = await compileClassicScript("src/frontend/dashboard/dashboard-helpers.ts");
    const startupScript = await compileClassicScript("src/frontend/dashboard/dashboard-startup.ts");
    new Script(`${appEventsScript}\n${helpersScript}\n${startupScript}`, { filename: "dashboard.js" }).runInNewContext(context);

    await new Promise((resolve) => setImmediate(resolve));
    instances[0].onopen?.(new Event("open"));
    await new Promise((resolve) => setImmediate(resolve));
    assert.strictEqual(dashboardRequests.filter((entry) => entry.type === "request").length, 1);

    instances[0].onmessage?.({ data: JSON.stringify({ type: "dashboard.changed", revision: 1 }) });
    instances[0].onmessage?.({ data: JSON.stringify({ type: "dashboard.changed", revision: 2 }) });
    assert.strictEqual(dashboardRequests.filter((entry) => entry.type === "request").length, 1);

    dashboardResolvers.shift()();
    await new Promise((resolve) => setImmediate(resolve));
    assert.strictEqual(dashboardRequests.filter((entry) => entry.type === "request").length, 2);

    dashboardResolvers.shift()();
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepStrictEqual(
      dashboardRequests.filter((entry) => entry.type === "state").map((entry) => entry.data.modelId),
      ["first", "second"],
    );
    context.App.Events.stop();
  });

  it("keeps the development HTML startup on the shared bus", () => {
    const html = readFileSync(resolve(process.cwd(), "src/frontend/dashboard.html"), "utf8");
    assert.doesNotMatch(html, /setInterval\(refresh,\s*3000\)/);
    assert.match(html, /<script\s+src=["']\.\/gen\/dashboard\.js["']><\/script>/);
    assert.match(html, /<script\s+src=["']\.\/gen\/dashboard\/dashboard-startup\.js["']><\/script>/);
    assert.strictEqual((html.match(/App\.Events\.start\(\)/g) || []).length, 0);
    assert.ok(!html.includes("ExplorerService?.startEvents"));
  });
});
