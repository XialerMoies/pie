App.Events.subscribe('dashboard.changed', () => { void getD(); });
App.Events.subscribe('resync', () => { void getD(); });

async function startDashboard(): Promise<void> {
  await bootstrapApi();
  layout();

  void (async () => {
    try {
      await App.Events.start();
    } catch (error) {
      console.warn("[dashboard-startup] event channel unavailable", error);
    }

    try {
      await syncStartupWorkspace();
    } catch (error) {
      console.warn("[dashboard-startup] workspace recovery failed", error);
      App.State.resetWorkspace("");
      toast("上次工作区无法恢复，已回到默认工作区。", "error");
    }

    getD();
    App.Session.loadSessions();
  })();
}

void startDashboard().catch((error) => {
  console.error("[dashboard-startup] bootstrap failed", error);
  toast("Desktop authentication failed. Restart the application.", "error");
});
