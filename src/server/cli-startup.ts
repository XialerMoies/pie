import { resolveStartupPaths, type StartupPathOptions } from "./startup-paths.js";
import { workspaceDataPaths } from "./routes/session-dir.js";

export interface CliRuntimePaths {
  appRoot: string;
  cwd: string;
  dataRoot: string;
  agentDir: string;
  sessionsDir: string;
  sessionsDirForWorkspace: (workspace: string) => string;
  authFile: string;
  modelsFile: string;
}

export function resolveCliRuntimePaths(options: StartupPathOptions): CliRuntimePaths {
  const startup = resolveStartupPaths(options);
  return {
    appRoot: startup.appRoot,
    cwd: startup.workspace,
    dataRoot: startup.dataRoot,
    agentDir: startup.layout.userRoot,
    sessionsDir: startup.layout.sessionsDir,
    sessionsDirForWorkspace: (workspace) => workspaceDataPaths(startup.dataRoot, workspace).sessionsDir,
    authFile: startup.layout.authFile,
    modelsFile: startup.layout.modelsFile,
  };
}
