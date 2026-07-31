async function startDashboard(): Promise<void> {
  await bootstrapApi();
  await (window as any).ExplorerService?.startEvents?.();
  await syncStartupWorkspace();
  layout();
  getD();
  loadSessions();
  setInterval(refresh, 3000);
}

void startDashboard().catch((error) => {
  console.error("[dashboard-startup] bootstrap failed", error);
  toast("Desktop authentication failed. Restart the application.", "error");
});
