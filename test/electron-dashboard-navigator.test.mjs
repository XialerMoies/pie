import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

const moduleUrl = new URL("../src/electron/electron-dashboard-navigator.ts", import.meta.url);
const mainUrl = new URL("../src/electron/electron-main.ts", import.meta.url);

function createWindow({ loadURL } = {}) {
  const calls = { loadURL: [], sent: [], show: 0 };
  let currentUrl = "about:blank";
  const window = {
    webContents: {
      getURL: () => currentUrl,
      send: (...args) => calls.sent.push(args),
    },
    isDestroyed: () => false,
    show: () => { calls.show++; },
    loadURL: async (url) => {
      calls.loadURL.push(url);
      if (loadURL) await loadURL(url);
      currentUrl = url;
    },
  };
  return { window, calls };
}

function createContext(id, window, origin = "http://127.0.0.1:43123") {
  return {
    id,
    window,
    workspace: "C:\\workspace",
    server: { origin },
  };
}

async function createNavigator(overrides = {}) {
  const { createElectronDashboardNavigator } = await import(moduleUrl.href);
  return createElectronDashboardNavigator({
    dashboardUrl: "http://127.0.0.1:5173/dashboard.html",
    vitePort: 5173,
    isE2EMode: false,
    isInitialContext: (context) => context.id === "initial",
    recordContext: () => {},
    recordTiming: () => {},
    logError: () => {},
    ...overrides,
  });
}

test("dashboard navigation helpers live outside electron-main", () => {
  assert.equal(existsSync(moduleUrl), true, "electron-dashboard-navigator.ts should exist");

  const mainSource = readFileSync(mainUrl, "utf8");
  const navigatorSource = readFileSync(moduleUrl, "utf8");
  assert.match(mainSource, /from "\.\/electron-dashboard-navigator\.js"/);
  assert.match(navigatorSource, /export\s+function\s+createElectronDashboardNavigator\s*\(/);
  for (const name of ["workspaceStatusLoads", "dashboardStatusUrl", "showContextDashboard", "loadContextApplication"]) {
    assert.doesNotMatch(mainSource, new RegExp(`(?:const|let|function)\\s+${name}\\b`));
  }
});

test("shows idle status through the real dashboard and marks the shell visible", async () => {
  const { window, calls } = createWindow();
  const timings = [];
  const contexts = [];
  const navigator = await createNavigator({
    recordContext: (context) => contexts.push(context.id),
    recordTiming: (_context, event) => timings.push(event),
  });

  navigator.showWindowStatus(createContext("empty", window), { state: "idle" });
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(calls.show, 1);
  assert.deepEqual(new URL(calls.loadURL[0]).searchParams.get("empty-workspace"), "1");
  assert.deepEqual(calls.sent, [["workspace-status", { state: "idle" }]]);
  assert.deepEqual(contexts, ["empty"]);
  assert.deepEqual(timings, ["shell-visible"]);
});

test("updates an in-flight status page without starting a second navigation", async () => {
  let release;
  const pending = new Promise((resolve) => { release = resolve; });
  const { window, calls } = createWindow({ loadURL: () => pending });
  const navigator = await createNavigator();
  const context = createContext("failed", window);

  navigator.showWindowStatus(context, { state: "starting", workspace: "C:\\workspace" });
  navigator.showWindowStatus(context, {
    state: "failed",
    workspace: "C:\\workspace",
    message: "server failed",
  });
  assert.equal(calls.loadURL.length, 1);

  release();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(calls.sent, [["workspace-status", {
    state: "failed",
    workspace: "C:\\workspace",
    message: "server failed",
  }]]);
});

test("loads the initial development context from Vite", async () => {
  const { window, calls } = createWindow();
  const timings = [];
  const navigator = await createNavigator({
    recordTiming: (_context, event) => timings.push(event),
  });

  await navigator.loadApplication(createContext("initial", window, "http://server.invalid"));

  assert.deepEqual(calls.loadURL, ["http://127.0.0.1:5173"]);
  assert.equal(calls.show, 1);
  assert.deepEqual(timings, ["server-ready", "workbench-loaded"]);
});

test("loads secondary contexts from their owned server origin", async () => {
  const { window, calls } = createWindow();
  const navigator = await createNavigator();

  await navigator.loadApplication(createContext("secondary", window, "http://127.0.0.1:6507"));

  assert.deepEqual(calls.loadURL, ["http://127.0.0.1:6507"]);
});

test("keeps E2E shell hidden until its status page has loaded", async () => {
  const { window, calls } = createWindow();
  const navigator = await createNavigator({ isE2EMode: true });

  navigator.showWindowStatus(createContext("e2e", window), { state: "idle" });
  assert.equal(calls.show, 0);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(calls.show, 1);
});

