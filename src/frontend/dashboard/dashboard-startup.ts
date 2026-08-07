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
  await bootstrapApi();
  try {
    await hydratePreferencesForStartup();
  } catch (error) {
    console.warn("[dashboard-startup] preference hydration failed", error);
  } finally {
    applyExplorerPreferences();
    applyHydratedTheme();
    document.documentElement.classList.remove("preferences-loading");
  }
  layout();
  preferenceStartupComplete = true;

  void (async () => {
    try {
      await App.Events.start();
    } catch (error) {
      console.warn("[dashboard-startup] event channel unavailable", error);
    }

    getD();
    App.Session.loadSessions();
  })();
}

void startDashboard().catch((error) => {
  document.documentElement.classList.remove("preferences-loading");
  console.error("[dashboard-startup] bootstrap failed", error);
  toast("Desktop authentication failed. Restart the application.", "error");
});
