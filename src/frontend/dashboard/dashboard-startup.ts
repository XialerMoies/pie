async function startDashboard(): Promise<void> {
  await bootstrapApi();
  layout();
  setInterval(refresh, 3000);

  void (async () => {
    try {
      await (window as any).ExplorerService?.startEvents?.();
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
    loadSessions();
  })();
}

void startDashboard().catch((error) => {
  console.error("[dashboard-startup] bootstrap failed", error);
  toast("Desktop authentication failed. Restart the application.", "error");
});
