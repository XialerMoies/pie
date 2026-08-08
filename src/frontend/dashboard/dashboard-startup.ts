App.Events.subscribe('dashboard.changed', () => { void getD(); });
App.Events.subscribe('resync', () => { void getD(); });

function applyHydratedTheme(): void {
  const theme = App.Preferences.get('editor-theme', 'vs-dark');
  document.documentElement.classList.toggle('theme-light', theme === 'vs');
}

const PREFERENCE_HYDRATION_STARTUP_TIMEOUT_MS = 5000;

async function hydratePreferencesForStartup(): Promise<void> {
  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  try {
    await Promise.race([
      App.Preferences.hydrate(),
      new Promise<void>((resolve) => {
        timeoutId = setTimeout(resolve, PREFERENCE_HYDRATION_STARTUP_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timeoutId !== null) clearTimeout(timeoutId);
  }
}

let preferenceStartupComplete = false;

function waitForDashboardContentPaint(): Promise<void> {
  if (typeof requestAnimationFrame !== 'function') return Promise.resolve();
  return new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  });
}

function dashboardStartupNow(): number {
  return typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now();
}

function applyLateHydratedPreferences(): void {
  applyExplorerPreferences();
  applyHydratedTheme();
  App.Chat?.loadModeState?.();
  App.Chat?.refreshReadingSettings?.();
  window.__monaco?.updateSettings?.();
}

App.Preferences.onHydrated?.(() => {
  if (!preferenceStartupComplete) return;
  applyLateHydratedPreferences();
});

async function startDashboard(): Promise<void> {
  const t0 = dashboardStartupNow();
  let tBootstrap = t0, tHydrate = t0, tLayout = t0;
  await bootstrapApi();
  tBootstrap = dashboardStartupNow();
  try {
    await hydratePreferencesForStartup();
  } catch (error) {
    console.warn("[dashboard-startup] preference hydration failed", error);
  } finally {
    tHydrate = dashboardStartupNow();
    applyExplorerPreferences();
    applyHydratedTheme();
    document.documentElement.classList.remove("preferences-loading");
  }
  layout();
  tLayout = dashboardStartupNow();
  preferenceStartupComplete = true;

  void (async () => {
    try {
      await App.Events.start();
    } catch (error) {
      console.warn("[dashboard-startup] event channel unavailable", error);
    }
    const tEvents = dashboardStartupNow();
    await Promise.all([
      Promise.resolve(getD()),
      Promise.resolve(App.Session.whenReady?.()),
      Promise.resolve(App.Session.loadSessions()),
    ]);
    const tData = dashboardStartupNow();
    await waitForDashboardContentPaint();
    const tPaint = dashboardStartupNow();
    console.info(
      `[startup] content-ready wall=${Date.now()}`
      + ` total=${(tPaint - t0).toFixed(0)}ms`
      + ` bootstrap=${(tBootstrap - t0).toFixed(0)}ms`
      + ` preferences=${(tHydrate - tBootstrap).toFixed(0)}ms`
      + ` layout=${(tLayout - tHydrate).toFixed(0)}ms`
      + ` events=${(tEvents - tLayout).toFixed(0)}ms`
      + ` content=${(tData - tEvents).toFixed(0)}ms`
      + ` paint=${(tPaint - tData).toFixed(0)}ms`,
    );
  })();
}

void startDashboard().catch((error) => {
  document.documentElement.classList.remove("preferences-loading");
  console.error("[dashboard-startup] bootstrap failed", error);
  toast("Desktop authentication failed. Restart the application.", "error");
});
