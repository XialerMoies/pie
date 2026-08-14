import * as fs from "fs";
import * as path from "path";
import {
  createElectronE2EDiagnostics,
  type ElectronE2EContext,
  type ElectronE2EDiagnosticSnapshot,
  type ElectronE2ETimingEvent,
} from "./e2e-diagnostics.js";

interface ElectronE2ERuntimeContext extends ElectronE2EContext {
  lifecycle: "active" | "closing" | "closed";
  window: ElectronE2EContext["window"] & { isDestroyed(): boolean };
}

interface ElectronE2ERuntimeOptions {
  enabled: boolean;
  electronPid: number;
  resultFile: string | null;
  appRoot: string;
  runtimeRoot: string;
  dataRoot: string;
  e2eDataRoot?: string | null;
  desktopSecurityToken: string;
  ensureDir(directory: string): void;
  now?: () => number;
  log?: (message: string) => void;
  writeFile?: (file: string, data: string, encoding: "utf8") => void;
}

export function createElectronE2ERuntime(options: ElectronE2ERuntimeOptions) {
  const now = options.now || Date.now;
  const log = options.log || console.log;
  const writeFile = options.writeFile || ((file: string, data: string, encoding: "utf8") => {
    fs.writeFileSync(file, data, encoding);
  });
  const diagnostics: string[] = [];
  const recorder = options.enabled
    ? createElectronE2EDiagnostics({ electronPid: options.electronPid, now })
    : null;
  const windowCreatedAt = new WeakMap<object, number>();
  const recordedContexts = new Set<string>();
  const trackedContexts = new Set<ElectronE2ERuntimeContext>();

  function emptySnapshot(): ElectronE2EDiagnosticSnapshot {
    return {
      electronPid: options.electronPid,
      windows: [],
      timings: [],
    };
  }

  function markWindowCreated(window: object, at = now()): void {
    if (!recorder) return;
    windowCreatedAt.set(window, at);
  }

  function recordContext(context: ElectronE2ERuntimeContext): void {
    if (!recorder || recordedContexts.has(context.id)) return;
    recordedContexts.add(context.id);
    trackedContexts.add(context);
    recorder.record(
      context,
      "window-created",
      windowCreatedAt.get(context.window) || now(),
    );
  }

  function recordTiming(
    context: ElectronE2ERuntimeContext,
    event: Exclude<ElectronE2ETimingEvent, "window-created">,
  ): number | null {
    if (!recorder) return null;
    recordContext(context);
    return recorder.record(context, event);
  }

  function latestTiming(
    context: ElectronE2ERuntimeContext,
    event: ElectronE2ETimingEvent,
  ): number | null {
    if (!recorder) return null;
    return [...recorder.snapshot([]).timings].reverse().find((timing) => (
      timing.contextId === context.id && timing.event === event
    ))?.at || null;
  }

  function failureSnapshot(): ElectronE2EDiagnosticSnapshot {
    if (!recorder) return emptySnapshot();
    const contexts = [...trackedContexts].filter((context) => (
      context.lifecycle !== "closed" && !context.window.isDestroyed()
    ));
    return recorder.snapshot(contexts);
  }

  function snapshot(contexts: Iterable<ElectronE2ERuntimeContext>): ElectronE2EDiagnosticSnapshot {
    return recorder?.snapshot(contexts) || emptySnapshot();
  }

  function failureRedactions() {
    const roots: Array<{ value: string; label: string }> = [];
    const addRoot = (value: string | null | undefined, label: string) => {
      if (!value) return;
      roots.push({ value, label });
      if (value.includes("\\")) roots.push({ value: value.replaceAll("\\", "/"), label });
    };

    addRoot(options.appRoot, "<app-root>");
    addRoot(options.runtimeRoot, "<runtime-root>");
    addRoot(options.dataRoot, "<data-root>");
    addRoot(options.e2eDataRoot, "<e2e-data-root>");
    addRoot(options.resultFile ? path.dirname(options.resultFile) : null, "<temp-root>");
    for (const context of trackedContexts) {
      addRoot(context.workspace, "<workspace-root>");
      if (context.layout) {
        for (const value of Object.values(context.layout)) addRoot(value, "<private-root>");
      }
    }

    return {
      secrets: [
        options.desktopSecurityToken,
        ...[...trackedContexts].map((context) => context.server.token),
      ].filter(Boolean),
      roots,
    };
  }

  function stage(message: string): void {
    if (!recorder) return;
    diagnostics.push(message);
    log(`[e2e] ${message}`);
  }

  function captureDiagnostic(message: string): void {
    if (!recorder) return;
    diagnostics.push(message);
  }

  function writeResult(result: Record<string, unknown>): void {
    if (!recorder || !options.resultFile) return;
    options.ensureDir(path.dirname(options.resultFile));
    writeFile(options.resultFile, JSON.stringify(result, null, 2), "utf8");
  }

  function countOwnedServerChildren(): number {
    return [...trackedContexts].filter((context) => (
      context.lifecycle === "active"
        && context.server.kind === "owned"
        && context.server.process?.pid
    )).length;
  }

  return {
    diagnostics,
    markWindowCreated,
    recordContext,
    recordTiming,
    latestTiming,
    failureSnapshot,
    snapshot,
    failureRedactions,
    stage,
    captureDiagnostic,
    writeResult,
    countOwnedServerChildren,
  };
}
