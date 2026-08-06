import { randomUUID } from "node:crypto";
import { isAbsolute, join, resolve } from "node:path";
import { canonicalWorkspacePath, resolveDataLayout, type DataLayout } from "../data/data-layout.js";

export interface StartupPathOptions {
  appRoot: string;
  argv?: readonly string[];
  env?: Record<string, string | undefined>;
}

export interface StartupPaths {
  appRoot: string;
  workspace: string;
  dataRoot: string;
  instanceId: string;
  layout: DataLayout;
}

export interface StartupPathsSnapshot {
  appRoot: string;
  workspace: string;
  dataRoot: string;
  instanceId: string;
  userRoot: string;
  workspaceRoot: string;
  instanceRoot: string;
  sessionsDir: string;
  cacheDir: string;
}

function readArg(argv: readonly string[], name: string): string | undefined {
  const prefix = `${name}=`;
  const inline = argv.find((arg) => arg.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);

  const index = argv.indexOf(name);
  const value = index >= 0 ? argv[index + 1] : undefined;
  return value && !value.startsWith("--") ? value : undefined;
}

function readValue(argv: readonly string[], env: Record<string, string | undefined>, argName: string, ...envNames: string[]): string | undefined {
  const fromArg = readArg(argv, argName);
  if (fromArg !== undefined) return fromArg;
  for (const envName of envNames) {
    if (env[envName] !== undefined) return env[envName];
  }
  return undefined;
}

function generateInstanceId(): string {
  return `instance-${randomUUID()}`;
}

export function resolveStartupPaths(options: StartupPathOptions): StartupPaths {
  const argv = options.argv || [];
  const env = options.env || {};
  const appRoot = resolve(options.appRoot);
  const workspaceInput = readValue(argv, env, "--workspace", "PI_WORKSPACE") || appRoot;
  const dataRootInput = readValue(argv, env, "--data-root", "PI_DATA_ROOT", "PI_DESKTOP_DATA") || join(appRoot, "data");
  const instanceId = readValue(argv, env, "--instance-id", "PI_INSTANCE_ID") || generateInstanceId();

  if (!isAbsolute(appRoot)) throw new Error("appRoot must be absolute");
  const workspace = canonicalWorkspacePath(workspaceInput);
  if (!isAbsolute(dataRootInput)) throw new Error("dataRoot must be absolute");
  const dataRoot = resolve(dataRootInput);
  const layout = resolveDataLayout({ dataRoot, workspace, instanceId });

  return { appRoot, workspace, dataRoot: layout.dataRoot, instanceId, layout };
}

export function startupPathsSnapshot(startup: StartupPaths): StartupPathsSnapshot {
  return {
    appRoot: startup.appRoot,
    workspace: startup.workspace,
    dataRoot: startup.dataRoot,
    instanceId: startup.instanceId,
    userRoot: startup.layout.userRoot,
    workspaceRoot: startup.layout.workspaceRoot,
    instanceRoot: startup.layout.instanceRoot,
    sessionsDir: startup.layout.sessionsDir,
    cacheDir: startup.layout.cacheDir,
  };
}
