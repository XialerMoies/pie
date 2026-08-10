import { createHash } from "crypto";

export type ElectronE2ETimingEvent =
  | "window-created"
  | "shell-visible"
  | "server-ready"
  | "workbench-loaded";

export interface ElectronE2EContext {
  id: string;
  instanceId: string;
  workspace: string | null;
  layout: { instanceRoot: string } | null;
  window: { webContents: { id: number } };
  server: {
    kind: "none" | "external" | "owned";
    process: { pid?: number } | null;
    port: number;
    token: string;
  };
}

export interface ElectronE2ETiming {
  contextId: string;
  event: ElectronE2ETimingEvent;
  at: number;
}

export interface ElectronE2EWindowDiagnostic {
  contextId: string;
  webContentsId: number;
  workspace: string | null;
  instanceId: string;
  instanceRoot: string | null;
  serverKind: "none" | "external" | "owned";
  serverPid: number | null;
  port: number;
  tokenFingerprint: string;
  loadedAt: number | null;
}

export interface ElectronE2EDiagnosticSnapshot {
  electronPid: number;
  windows: ElectronE2EWindowDiagnostic[];
  timings: ElectronE2ETiming[];
}

export interface ElectronE2EReopenErrorDiagnostic {
  code: "workspace_locked" | "workspace_reopen_failed";
  message: "Workspace is locked" | "Workspace reopen failed";
}

export interface ElectronE2EFailureDiagnostic {
  code: string;
  message: string;
}

export function fingerprintToken(token: string): string {
  if (!token) return "";
  return createHash("sha256").update(token).digest("hex").slice(0, 16);
}

export function sanitizeE2EReopenError(error: unknown): ElectronE2EReopenErrorDiagnostic {
  const candidate = error && typeof error === "object"
    ? error as { code?: unknown; message?: unknown }
    : null;
  const code = typeof candidate?.code === "string" ? candidate.code.toLowerCase() : "";
  const message = typeof candidate?.message === "string" ? candidate.message : "";
  const workspaceLocked = code === "workspace_locked"
    || /workspace(?:\s+is)?\s+(?:already\s+open|locked)/i.test(message);

  return workspaceLocked
    ? { code: "workspace_locked", message: "Workspace is locked" }
    : { code: "workspace_reopen_failed", message: "Workspace reopen failed" };
}

function safeFailureCode(error: unknown): string {
  const candidate = error && typeof error === "object"
    ? error as { code?: unknown; message?: unknown }
    : null;
  const rawCode = typeof candidate?.code === "string" ? candidate.code : "";
  if (/^E2E_TIMEOUT$/i.test(rawCode) || /timed out|timeout/i.test(String(candidate?.message || ""))) {
    return "e2e_timeout";
  }
  if (/^E2E_PROCESS_EXIT$/i.test(rawCode)) return "e2e_process_exit";
  if (/^[A-Z][A-Z0-9_]{0,63}$/i.test(rawCode)) return rawCode.toLowerCase();
  return "e2e_failure";
}

function sanitizeDiagnosticText(
  input: string,
  secrets: readonly string[],
  roots: readonly { value: string; label: string }[],
): string {
  let output = input;
  for (const secret of secrets.filter(Boolean).sort((a, b) => b.length - a.length)) {
    output = output.split(secret).join("[REDACTED]");
  }
  for (const root of roots.filter((entry) => entry.value).sort((a, b) => b.value.length - a.value.length)) {
    const escaped = root.value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    output = output.replace(new RegExp(escaped, "gi"), root.label);
  }
  output = output.replace(
    /\b(authorization|token|access[_-]?token|auth[_-]?token|api[_-]?key|secret|password|cookie)\b\s*([:=])\s*(?:bearer\s+)?(?:\[[^\]]*\]|"[^"]*"|'[^']*'|[^\s,;)}\]]+)/gi,
    "$1$2 [REDACTED]",
  );
  output = output.replace(
    /(["'])(?:(?:[A-Za-z]:[\\/])|(?:\\\\)|(?:\/(?!\/)))[^\r\n"']*\1/g,
    "$1<absolute-path>$1",
  );
  output = output.replace(/\b[A-Za-z]:[\\/][^\r\n"'`,;)}\]]*/g, "<absolute-path>");
  output = output.replace(/(?<![\\\w])\\\\[^\r\n"'`,;)}\]]*/g, "<absolute-path>");
  output = output.replace(/(?<![:/\w>])\/(?!\/)[^\r\n"'`,;)}\]]*/g, "<absolute-path>");
  return output;
}

function sanitizeSnapshot(snapshot: ElectronE2EDiagnosticSnapshot, secrets: readonly string[], roots: readonly { value: string; label: string }[]) {
  return {
    electronPid: snapshot.electronPid,
    windows: snapshot.windows.map((window) => ({
      ...window,
      workspace: window.workspace ? sanitizeDiagnosticText(window.workspace, secrets, roots) : null,
      instanceRoot: window.instanceRoot ? sanitizeDiagnosticText(window.instanceRoot, secrets, roots) : null,
    })),
    timings: snapshot.timings.map((timing) => ({ ...timing })),
  };
}

export function createElectronE2EFailureDiagnostic(options: {
  error: unknown;
  diagnostics: readonly string[];
  snapshot: ElectronE2EDiagnosticSnapshot;
  secrets?: readonly string[];
  roots?: readonly { value: string; label: string }[];
}) {
  const secrets = options.secrets || [];
  const roots = options.roots || [];
  const candidate = options.error && typeof options.error === "object"
    ? options.error as { message?: unknown }
    : null;
  const message = typeof candidate?.message === "string"
    ? sanitizeDiagnosticText(candidate.message, secrets, roots)
    : "Packaged Electron E2E failed";
  return {
    error: {
      code: safeFailureCode(options.error),
      message,
    },
    diagnostics: options.diagnostics.map((entry) => sanitizeDiagnosticText(String(entry), secrets, roots)),
    ...sanitizeSnapshot(options.snapshot, secrets, roots),
  };
}

export function createElectronE2EDiagnostics(options: {
  electronPid: number;
  now?: () => number;
}) {
  const now = options.now || Date.now;
  const timings: ElectronE2ETiming[] = [];

  function record(
    context: ElectronE2EContext,
    event: ElectronE2ETimingEvent,
    at = now(),
  ): number {
    timings.push({ contextId: context.id, event, at });
    return at;
  }

  function snapshot(contexts: Iterable<ElectronE2EContext>): ElectronE2EDiagnosticSnapshot {
    return {
      electronPid: options.electronPid,
      windows: [...contexts].map((context) => ({
        contextId: context.id,
        webContentsId: context.window.webContents.id,
        workspace: context.workspace,
        instanceId: context.instanceId,
        instanceRoot: context.layout?.instanceRoot || null,
        serverKind: context.server.kind,
        serverPid: context.server.process?.pid || null,
        port: context.server.port,
        tokenFingerprint: fingerprintToken(context.server.token),
        loadedAt: [...timings].reverse().find((timing) => (
          timing.contextId === context.id && timing.event === "workbench-loaded"
        ))?.at || null,
      })),
      timings: timings.map((timing) => ({ ...timing })),
    };
  }

  return { record, snapshot };
}
