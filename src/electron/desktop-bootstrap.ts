import { isAbsolute, join, normalize, resolve } from "node:path";

export interface DesktopProcessPaths {
  dataRoot: string;
  dataRootPointerFile: string;
  electronUserData: string;
  electronCache: string;
  userRoot: string;
}

export interface DesktopProcessPathOptions {
  osUserData: string;
  runtimeRoot: string;
  configuredDataRoot?: string;
}

function requireAbsolutePath(value: string, name: string): string {
  if (!isAbsolute(value)) throw new Error(`${name} must be an absolute path`);
  return resolve(value);
}

function comparablePath(value: string): string {
  const normalized = normalize(value);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

export function resolveDesktopProcessPaths(options: DesktopProcessPathOptions): DesktopProcessPaths {
  const osUserData = requireAbsolutePath(options.osUserData, "osUserData");
  const runtimeRoot = requireAbsolutePath(options.runtimeRoot, "runtimeRoot");
  const dataRoot = options.configuredDataRoot === undefined
    ? join(runtimeRoot, "data")
    : requireAbsolutePath(options.configuredDataRoot, "configuredDataRoot");

  return {
    dataRoot,
    dataRootPointerFile: join(osUserData, "data-root.json"),
    electronUserData: join(dataRoot, "electron-user-data"),
    electronCache: join(dataRoot, "cache", "electron"),
    userRoot: join(dataRoot, "user"),
  };
}

export function validateSecondLaunchDataRoot(activeDataRoot: string, requestedDataRoot?: string): void {
  const active = requireAbsolutePath(activeDataRoot, "activeDataRoot");
  if (requestedDataRoot === undefined) return;

  const requested = requireAbsolutePath(requestedDataRoot, "requestedDataRoot");
  if (comparablePath(active) !== comparablePath(requested)) {
    throw new Error(
      `Second launch data root "${requested}" does not match the active Electron process data root "${active}"`,
    );
  }
}
