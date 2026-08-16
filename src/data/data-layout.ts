import { createHash } from "node:crypto";
import { isAbsolute, join, normalize, resolve } from "node:path";

export interface DataLayoutOptions {
  dataRoot: string;
  workspace: string;
  instanceId: string;
}

export interface DataLayout {
  dataRoot: string;
  userRoot: string;
  workspaceRoot: string;
  instanceRoot: string;
  authFile: string;
  modelsFile: string;
  mcpConfigFile: string;
  mcpTrustFile: string;
  settingsFile: string;
  subagentsFile: string;
  customProvidersFile: string;
  customProviderSecretsFile: string;
  workspaceMetadataFile: string;
  workspaceLockFile: string;
  sessionsDir: string;
  usageIndexFile: string;
  permissionRulesFile: string;
  permissionAuditFile: string;
  uiStateFile: string;
  portFile: string;
  desktopTokenFile: string;
  cacheDir: string;
}

export function canonicalWorkspacePath(workspace: string): string {
  if (typeof workspace !== "string" || !workspace.trim() || !isAbsolute(workspace)) {
    throw new Error("workspace must be an absolute path");
  }

  const canonical = normalize(resolve(workspace));
  return process.platform === "win32" ? canonical.toLowerCase() : canonical;
}

export function workspaceKey(workspace: string): string {
  return createHash("sha256")
    .update(canonicalWorkspacePath(workspace))
    .digest("hex")
    .slice(0, 24);
}

function validateAbsoluteRoot(name: string, value: string): string {
  if (typeof value !== "string" || !isAbsolute(value)) {
    throw new Error(`${name} must be absolute`);
  }
  return normalize(resolve(value));
}

function validateInstanceId(instanceId: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(instanceId)) {
    throw new Error("instanceId is invalid");
  }
  return instanceId;
}

export function resolveDataLayout(options: DataLayoutOptions): DataLayout {
  const dataRoot = validateAbsoluteRoot("dataRoot", options.dataRoot);
  const workspace = canonicalWorkspacePath(options.workspace);
  const instanceId = validateInstanceId(options.instanceId);
  const userRoot = join(dataRoot, "user");
  const workspaceRoot = join(dataRoot, "workspaces", workspaceKey(workspace));
  const instanceRoot = join(dataRoot, "instances", instanceId);

  return {
    dataRoot,
    userRoot,
    workspaceRoot,
    instanceRoot,
    authFile: join(userRoot, "auth.json"),
    modelsFile: join(userRoot, "models.json"),
    mcpConfigFile: join(userRoot, "mcp.json"),
    mcpTrustFile: join(userRoot, "mcp-trust.json"),
    settingsFile: join(userRoot, "settings.json"),
    subagentsFile: join(userRoot, "subagents.json"),
    customProvidersFile: join(userRoot, "custom-providers.json"),
    customProviderSecretsFile: join(userRoot, "custom-provider-secrets.json"),
    workspaceMetadataFile: join(workspaceRoot, "metadata.json"),
    workspaceLockFile: join(workspaceRoot, "workspace.lock"),
    sessionsDir: join(workspaceRoot, "sessions"),
    usageIndexFile: join(workspaceRoot, "usage-index.json"),
    permissionRulesFile: join(workspaceRoot, "permission-rules.json"),
    permissionAuditFile: join(workspaceRoot, "permission-audit.json"),
    uiStateFile: join(workspaceRoot, "ui-state.json"),
    portFile: join(instanceRoot, "port.json"),
    desktopTokenFile: join(instanceRoot, "desktop-token"),
    cacheDir: join(instanceRoot, "cache"),
  };
}
