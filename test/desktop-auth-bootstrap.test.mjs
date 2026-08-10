import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Window } from "happy-dom";
import { resumeQuitAfterDisposal } from "../src/electron/quit-coordinator.ts";

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
const {
  createIntentionalProcessStops,
  handleElectronChildError,
} = await import("../scripts/dev-electron-reload.mjs");

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

  it("starts the development server directly with Node without npx or a shell", () => {
    const devScript = readFileSync(new URL("../scripts/dev.mjs", import.meta.url), "utf8");
    const serverStart = devScript.slice(
      devScript.indexOf("async function startServerInner"),
      devScript.indexOf("function stopServer"),
    );

    assert.match(serverStart, /spawn\(process\.execPath, \[/);
    assert.match(serverStart, /["']--import["']/);
    assert.match(serverStart, /["']--import["'],\s*["']tsx["']/);
    assert.match(serverStart, /path\.resolve\(ROOT, ["']src["'], ["']server["'], ["']server\.ts["']\)/);
    assert.doesNotMatch(serverStart, /spawn\(["']npx["'],\s*\[["']tsx["']/);
    assert.match(serverStart, /shell:\s*false/);
  });

  it("prepares a writable Windows tsx cache without dropping inherited environment", () => {
    const devScript = readFileSync(new URL("../scripts/dev.mjs", import.meta.url), "utf8");
    const serverEnv = devScript.slice(
      devScript.indexOf("function createDevServerEnv"),
      devScript.indexOf("async function startVite"),
    );

    assert.match(serverEnv, /\.\.\.process\.env/);
    assert.match(serverEnv, /node_modules["'], ["']\.cache["'], ["']my-code-agent-dev["']/);
    assert.match(serverEnv, /env\.TEMP = tempDir/);
    assert.match(serverEnv, /env\.TMP = tempDir/);
    assert.match(serverEnv, /tsx-windows-sandbox\.cjs/);
    assert.match(serverEnv, /env\.NODE_OPTIONS = \[/);
  });

  it("passes the Vite origin, PI API port, and desktop token to Electron", () => {
    const devScript = readFileSync(new URL("../scripts/dev.mjs", import.meta.url), "utf8");
    const start = devScript.indexOf("function startElectron()");
    const end = devScript.indexOf("function ", start + 1);
    const electronLaunch = devScript.slice(start, end < 0 ? undefined : end);

    assert.match(electronLaunch, /VITE_DEV_PORT:\s*String\(VITE_PORT\)/);
    assert.match(electronLaunch, /PI_DEV_PORT:\s*String\(DEV_PORT\)/);
    assert.match(electronLaunch, /MY_CODE_AGENT_DESKTOP_TOKEN:\s*DESKTOP_SECURITY_TOKEN/);
  });

  it("keeps dev-server ownership in the launcher and cleans it up when Electron exits", () => {
    const devScript = readFileSync(new URL("../scripts/dev.mjs", import.meta.url), "utf8");
    const serverEnv = devScript.slice(
      devScript.indexOf("function createDevServerEnv"),
      devScript.indexOf("async function startVite"),
    );
    const electronStart = devScript.slice(
      devScript.indexOf("function startElectron()"),
      devScript.indexOf("function setupWatcher"),
    );

    assert.match(serverEnv, /VITE_DEV_PORT:\s*String\(VITE_PORT\)/);
    assert.match(serverEnv, /PI_DEV_PORT:\s*String\(DEV_PORT\)/);
    assert.match(electronStart, /intentionalElectronStops\.mark\(electronProcess\)/);
    assert.match(electronStart, /intentionalElectronStops\.consume\(child\)/);
    assert.match(electronStart, /child\.on\(["']error["'][\s\S]*handleElectronChildError\(/);
    assert.match(electronStart, /child\.on\(["']exit["'][\s\S]*cleanup\(\);[\s\S]*process\.exit\(/);
    assert.doesNotMatch(electronStart, /setTimeout\(startElectron/);
    assert.doesNotMatch(devScript, /intentionalElectronStop\s*=/);
  });

  it("tracks intentional Electron exits by child identity across consecutive restarts", () => {
    const intentionalStops = createIntentionalProcessStops();
    const childA = { name: "A" };
    const childB = { name: "B" };
    const childC = { name: "C" };
    const cleanups = [];
    let current = childA;
    const restart = (next) => {
      intentionalStops.mark(current);
      current = next;
    };
    const exit = (child) => {
      if (current === child) current = null;
      if (intentionalStops.consume(child)) return;
      cleanups.push(child);
    };

    restart(childB);
    restart(childC);
    exit(childA);
    exit(childB);

    assert.strictEqual(current, childC);
    assert.deepEqual(cleanups, []);

    exit(childC);
    assert.strictEqual(current, null);
    assert.deepEqual(cleanups, [childC]);
  });

  it("treats only the current Electron child spawn error as fatal", () => {
    const childA = { name: "A" };
    const childB = { name: "B" };
    const failure = new Error("spawn failed");
    const events = [];
    let current = childB;
    const handleError = (child) => handleElectronChildError({
      child,
      currentChild: current,
      error: failure,
      clearCurrent: () => {
        current = null;
        events.push(`clear:${child.name}`);
      },
      reportError: (error) => events.push(`error:${error.message}`),
      cleanup: () => events.push("cleanup"),
      exit: (code) => events.push(`exit:${code}`),
    });

    assert.equal(handleError(childA), false);
    assert.strictEqual(current, childB);
    assert.deepEqual(events, []);

    assert.equal(handleError(childB), true);
    assert.equal(current, null);
    assert.deepEqual(events, [
      "clear:B",
      "error:spawn failed",
      "cleanup",
      "exit:1",
    ]);
  });

  it("stops development startup instead of retrying a workspace lock conflict", () => {
    const devScript = readFileSync(new URL("../scripts/dev.mjs", import.meta.url), "utf8");

    assert.ok(devScript.includes('stdio: ["pipe", "pipe", "pipe"]'), "development startup must capture server stderr");
    assert.ok(devScript.includes("isNonRetryableServerStartupError(errorOutput)"), "startup must classify deterministic server failures");
    assert.ok(devScript.includes("reject(createServerStartupError"), "workspace lock conflicts must reject startup instead of entering the restart loop");
    assert.match(devScript, /main\(\)\.catch\(err => \{\r?\n\s+cleanup\(\);/, "failed startup must clean up Vite and Electron children");
    assert.doesNotMatch(devScript, /taskkill \/F \/IM electron\.exe/, "development cleanup must not kill unrelated Electron instances");
    assert.ok(devScript.includes("fs.readFileSync(PID_FILE"), "development cleanup should target only its recorded process tree");
  });

  it("waits for an independent window server to exit before Electron quits", () => {
    const electronMain = readFileSync(new URL("../src/electron/electron-main.ts", import.meta.url), "utf8");

    assert.ok(electronMain.includes("function stopPiServer(): Promise<void>"), "server shutdown must be awaitable");
    assert.ok(electronMain.includes("event.preventDefault()"), "before-quit must pause Electron shutdown");
    assert.match(electronMain, /resumeQuitAfterDisposal\(\{[\s\S]*dispose:\s*stopPiServer,[\s\S]*resumeQuit:\s*\(\)\s*=>\s*\{[\s\S]*allowAppQuit\s*=\s*true;[\s\S]*app\.quit\(\);[\s\S]*reportFailure:/);
    assert.doesNotMatch(electronMain, /stopPiServer\(\)\.finally/);
    assert.doesNotMatch(electronMain, /}, 2000\)\.unref\(\)/, "the forced server cleanup timer must keep Electron alive");
    assert.match(electronMain, /void stopPiServer\(\)\.catch\(/, "window-all-closed must consume shutdown failures");
  });

  it("resumes Electron quit only after successful disposal", async () => {
    const events = [];
    let allowAppQuit = false;

    await resumeQuitAfterDisposal({
      dispose: async () => { events.push("disposed"); },
      resumeQuit: () => {
        allowAppQuit = true;
        events.push("quit");
      },
      reportFailure: (error) => { events.push(`failure:${String(error)}`); },
    });

    assert.equal(allowAppQuit, true);
    assert.deepEqual(events, ["disposed", "quit"]);
  });

  it("keeps Electron alive and reports a rejected disposal", async () => {
    const failure = new Error("termination not confirmed");
    const events = [];
    let allowAppQuit = false;

    await resumeQuitAfterDisposal({
      dispose: async () => {
        events.push("dispose-attempted");
        throw failure;
      },
      resumeQuit: () => {
        allowAppQuit = true;
        events.push("quit");
      },
      reportFailure: (error) => { events.push(error); },
    });

    assert.equal(allowAppQuit, false);
    assert.deepEqual(events, ["dispose-attempted", failure]);
  });

  it("shows the real dashboard before its server is ready", () => {
    const electronMain = readFileSync(new URL("../src/electron/electron-main.ts", import.meta.url), "utf8");
    const packagedStartup = electronMain.indexOf("const earlyServerReady = process.env.VITE_DEV_PORT ? null : startPiServer()");
    const createWindow = electronMain.indexOf("createWindow();", electronMain.indexOf("const serverReady = earlyServerReady"));
    const awaitServer = electronMain.indexOf("await serverReady", createWindow);

    assert.ok(packagedStartup >= 0, "packaged and independent windows should retain a server readiness promise");
    assert.ok(createWindow > packagedStartup, "the window shell should be created after server startup begins");
    assert.ok(awaitServer > createWindow, "the visible window shell must not wait for server readiness");
    assert.match(electronMain, /showWindowStatus:\s*showContextDashboard/);
    assert.match(electronMain, /loadURL\(dashboardStatusUrl\(/);
    assert.match(electronMain, /webContents\.send\(["']workspace-status["']/);
    assert.match(electronMain, /if\s*\(!E2E_MODE\)\s*win\.show\(\)/, "normal dashboard windows should be visible immediately");
    assert.doesNotMatch(electronMain, /Force-showing window|}, 5000\)/, "window visibility must not depend on a five-second fallback");
  });

  it("renders an empty window with the real dashboard layout", () => {
    const electronMain = readFileSync(new URL("../src/electron/electron-main.ts", import.meta.url), "utf8");
    const startup = readFileSync(new URL("../src/frontend/dashboard/dashboard-startup.ts", import.meta.url), "utf8");

    assert.match(electronMain, /params\.set\(["']empty-workspace["'],\s*["']1["']\)/);
    assert.match(electronMain, /DASHBOARD_URL[\s\S]*dashboard\.html/);
    assert.match(electronMain, /status\.state === ["']idle["']/);
    assert.match(startup, /empty-workspace/);
    assert.match(startup, /layout\(\)/);
    assert.match(startup, /bootstrapApi\(\)/);
    assert.match(startup, /if \(EMPTY_WORKSPACE_MODE \|\| WORKSPACE_STATUS_MODE\)[\s\S]*return;/);
    assert.match(electronMain, /dashboardUrl: DASHBOARD_URL/);
    assert.match(startup, /onWorkspaceStatus/);
  });

  it("reports initial server failures only while the startup context is active", () => {
    const electronMain = readFileSync(new URL("../src/electron/electron-main.ts", import.meta.url), "utf8");
    const startupCatch = electronMain.slice(
      electronMain.indexOf("} catch (err) {", electronMain.indexOf("const port = await serverReady")),
      electronMain.indexOf("secondLaunchHandlingReady = true"),
    );

    assert.match(startupCatch, /if \(windowManager\.reportWorkspaceFailure\(context, err\)\) \{/);
    assert.match(startupCatch, /dialog\.showErrorBox/);
    assert.match(startupCatch, /context\.window\.focus\(\)/);
  });

  it("keeps the development primary window on Vite while secondary windows use the dashboard", () => {
    const electronMain = readFileSync(new URL("../src/electron/electron-main.ts", import.meta.url), "utf8");

    assert.match(electronMain, /context\s*===\s*initialContext[\s\S]*VITE_DEV_PORT/);
    assert.match(electronMain, /server\.kind\s*===\s*["']external["'][\s\S]*loadContextApplication/);
    assert.doesNotMatch(electronMain, /showContextDashboard\([^)]*server\.origin/);
  });

  it("routes dashboard retry through the sender context without exposing a server origin", () => {
    const electronMain = readFileSync(new URL("../src/electron/electron-main.ts", import.meta.url), "utf8");
    const desktopIpc = readFileSync(new URL("../src/electron/desktop-ipc.ts", import.meta.url), "utf8");
    const preload = readFileSync(new URL("../src/electron/preload.ts", import.meta.url), "utf8");

    assert.match(electronMain, /retryWorkspace:\s*async\s*\(context\)[\s\S]*await windowManager\.retryWorkspace/);
    assert.match(desktopIpc, /handle\(["']workspace-retry["'][\s\S]*resolveContext\(event\)/);
    assert.doesNotMatch(electronMain, /ipcMain\.handle\(["']workspace-retry["']/);
    assert.match(preload, /onWorkspaceStatus\s*:/);
  });

  it("starts an independent server without cmd or npx and overlaps Electron readiness", () => {
    const electronMain = readFileSync(new URL("../src/electron/electron-main.ts", import.meta.url), "utf8");
    const earlyStart = electronMain.indexOf("const earlyServerReady = process.env.VITE_DEV_PORT ? null : startPiServer()");
    const whenReady = electronMain.indexOf("app.whenReady().then");

    assert.ok(earlyStart >= 0, "independent server startup should begin before Electron is ready");
    assert.ok(earlyStart < whenReady, "server startup should overlap Electron app readiness");
    assert.match(electronMain, /spawn\(process\.execPath, \["--import", "tsx", script\]/, "development server should use Electron's Node mode directly");
    assert.match(electronMain, /ELECTRON_RUN_AS_NODE:\s*"1"/, "the direct child must run as Node");
    assert.doesNotMatch(electronMain, /isWin \? "cmd" : "npx"|\["\/c", "npx", "tsx", script\]/, "independent startup must not traverse cmd or npx");
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
