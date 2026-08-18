import type { Server } from "http";
import type { ServerResponse } from "http";
import type { StructuredLogger } from "./observability.js";

export interface ServerLifecycleOptions {
  server: Server;
  appEvents: { closeAll(): void };
  chatStream: { response: ServerResponse | null };
  cancelResponseConfirmations(response: ServerResponse): void;
  unsubscribeMcpEvents(): void;
  unsubscribeWorkspaceWatcher(): void;
  workspaceWatcher: { close(): void };
  tsServer: { stop(): void };
  flushPermissionAudit(): Promise<void>;
  logger: StructuredLogger;
  awaitOpenedWorkspaceRecords(): Promise<void>;
  disposeSubagentHost(): Promise<void>;
  disposeEngine(): Promise<void>;
  releaseWorkspaceLock(): Promise<void>;
  removeRuntimeData(): Promise<void>;
  electronParented?: boolean;
}

export function createServerLifecycle(options: ServerLifecycleOptions) {
  let releasePromise: Promise<void> | null = null;
  const closeStreams = (): void => {
    options.appEvents.closeAll();
    const response = options.chatStream.response;
    if (!response) return;
    options.cancelResponseConfirmations(response);
    try { response.end(); } catch {}
    if (options.chatStream.response === response) options.chatStream.response = null;
  };
  const release = (removeRuntimeData: boolean): Promise<void> => {
    if (releasePromise) return releasePromise;
    releasePromise = (async () => {
      closeStreams();
      options.unsubscribeMcpEvents();
      options.unsubscribeWorkspaceWatcher();
      options.workspaceWatcher.close();
      options.tsServer.stop();
      try { await options.flushPermissionAudit(); }
      catch (error) { console.error("Failed to flush permission audit:", error); }
      await options.logger.flush();
      try { await options.awaitOpenedWorkspaceRecords(); }
      catch (error) { console.warn("Failed to finish opened workspace recording:", error); }
      try { await options.disposeSubagentHost(); }
      catch (error) { console.error("Failed to dispose subagent host:", error); }
      await options.disposeEngine();
      try { await options.releaseWorkspaceLock(); }
      catch (error) { console.error("Failed to release workspace lock:", error); }
      if (removeRuntimeData) {
        try { await options.removeRuntimeData(); }
        catch (error) { console.error("Failed to remove instance runtime data:", error); }
      }
    })();
    return releasePromise;
  };

  options.server.on("close", () => {
    void release(false);
  });
  options.server.on("error", (error) => {
    console.error("Server error:", error);
    void release(false).finally(() => process.exit(1));
  });

  let shuttingDown = false;
  const shutdown = (signal: NodeJS.Signals | "stdin"): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[server] ${signal}, shutting down`);
    closeStreams();
    options.server.close();
    void release(true).finally(() => process.exit(0));
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    if (String(chunk).split(/\r?\n/).includes("PI_SERVER_SHUTDOWN")) shutdown("stdin");
  });
  if (options.electronParented) {
    process.stdin.once("end", () => shutdown("stdin"));
    process.stdin.once("close", () => shutdown("stdin"));
  }

  return { release, shutdown };
}
