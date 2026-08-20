import { dirname } from "node:path";

const REDACTED = "[redacted]";

const PROVIDER_SECRET_ENV_KEYS = new Set([
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "GITHUB_TOKEN",
  "BRAVE_API_KEY",
  "GOOGLE_API_KEY",
  "GEMINI_API_KEY",
  "DEEPSEEK_API_KEY",
  "MISTRAL_API_KEY",
  "XAI_API_KEY",
  "OPENROUTER_API_KEY",
  "AZURE_OPENAI_API_KEY",
  "COHERE_API_KEY",
  "GROQ_API_KEY",
]);

const INTERNAL_RUNTIME_ENV_KEYS = new Set([
  "MY_CODE_AGENT_DESKTOP_TOKEN",
  "ELECTRON_RUN_AS_NODE",
  "PI_DESKTOP_DATA",
  "PI_DESKTOP_CONFIG",
  "PI_DESKTOP_SESSIONS",
  "PI_DESKTOP_DATA_ROOT_POINTER",
  "PI_WORKSPACE",
  "PI_DATA_ROOT",
  "PI_INSTANCE_ID",
  "PI_USER_CONFIG",
  "PI_CONFIG_DIR",
  "PI_WORKSPACE_DATA",
  "PI_INSTANCE_DATA",
  "PI_ELECTRON_PARENTED",
  "PI_DEV_PORT",
  "PI_MODEL",
]);

const MCP_BASE_ENV_KEYS = process.platform === "win32"
  ? [
      "APPDATA",
      "HOMEDRIVE",
      "HOMEPATH",
      "LOCALAPPDATA",
      "PATH",
      "Path",
      "PROCESSOR_ARCHITECTURE",
      "SYSTEMDRIVE",
      "SYSTEMROOT",
      "TEMP",
      "TMP",
      "USERNAME",
      "USERPROFILE",
      "PROGRAMFILES",
      "ComSpec",
    ]
  : ["HOME", "LOGNAME", "PATH", "SHELL", "TERM", "USER", "TMPDIR"];

export interface InternalServerEnvValues {
  token: string;
  workspace: string;
  dataRoot: string;
  instanceId: string;
  userRoot: string;
  sessionsDir: string;
  workspaceData: string;
  instanceData: string;
}

function cloneEnv(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return { ...source };
}

function keyNames(keys: ReadonlySet<string>): Set<string> {
  return new Set([...keys].map((key) => key.toUpperCase()));
}

function removeKeys(env: NodeJS.ProcessEnv, keys: ReadonlySet<string>): void {
  const normalized = keyNames(keys);
  for (const key of Object.keys(env)) {
    if (normalized.has(key.toUpperCase())) delete env[key];
  }
}

function removeProviderAndInternalKeys(env: NodeJS.ProcessEnv): void {
  removeKeys(env, new Set([...PROVIDER_SECRET_ENV_KEYS, ...INTERNAL_RUNTIME_ENV_KEYS]));
}

function readHostKey(source: NodeJS.ProcessEnv, requested: string): [string, string] | undefined {
  const key = Object.keys(source).find((candidate) => candidate.toLowerCase() === requested.toLowerCase());
  const value = key ? source[key] : undefined;
  return key && value !== undefined ? [key, value] : undefined;
}

export function getProviderSecretValues(source: NodeJS.ProcessEnv): string[] {
  const values: string[] = [];
  for (const requestedKey of PROVIDER_SECRET_ENV_KEYS) {
    const value = readHostKey(source, requestedKey)?.[1];
    if (value) values.push(value);
  }
  return values;
}

function mergeStringValues(target: NodeJS.ProcessEnv, values: Record<string, string | undefined>): void {
  for (const [key, value] of Object.entries(values)) {
    if (typeof value === "string") target[key] = value;
  }
}

export function createUserCommandEnv(input: {
  hostEnv?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  bashExecutable?: string;
}): NodeJS.ProcessEnv {
  const hostEnv = input.hostEnv ?? process.env;
  const env = cloneEnv(hostEnv);
  removeKeys(env, INTERNAL_RUNTIME_ENV_KEYS);

  if (input.platform !== "win32" || !input.bashExecutable) return env;

  const pathKey = Object.keys(env).find((key) => key.toLowerCase() === "path") ?? "Path";
  const currentPath = env[pathKey] ?? "";
  const bashDir = dirname(input.bashExecutable);
  const pathParts = currentPath.split(";").filter(Boolean);
  if (!pathParts.some((part) => part.toLowerCase() === bashDir.toLowerCase())) {
    env[pathKey] = [bashDir, ...pathParts].join(";");
  }
  return env;
}

export function createMcpProcessEnv(
  hostEnv: NodeJS.ProcessEnv,
  configuredEnv?: Record<string, string>,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const requestedKey of MCP_BASE_ENV_KEYS) {
    const value = readHostKey(hostEnv, requestedKey);
    if (value) env[value[0]] = value[1];
  }
  if (configuredEnv) {
    const internalKeys = keyNames(INTERNAL_RUNTIME_ENV_KEYS);
    for (const [key, value] of Object.entries(configuredEnv)) {
      if (typeof value === "string" && !internalKeys.has(key.toUpperCase())) env[key] = value;
    }
  }
  return env;
}

export function createTsserverEnv(hostEnv: NodeJS.ProcessEnv, tsLibDir: string): NodeJS.ProcessEnv {
  const env = cloneEnv(hostEnv);
  removeProviderAndInternalKeys(env);
  env.TS_INTERNAL = tsLibDir;
  return env;
}

export function createInternalServerEnv(
  hostEnv: NodeJS.ProcessEnv,
  values: InternalServerEnvValues,
): NodeJS.ProcessEnv {
  const env = cloneEnv(hostEnv);
  mergeStringValues(env, {
    PI_DESKTOP_DATA: values.dataRoot,
    PI_DESKTOP_CONFIG: values.userRoot,
    PI_DESKTOP_SESSIONS: values.sessionsDir,
    PI_WORKSPACE: values.workspace,
    PI_DATA_ROOT: values.dataRoot,
    PI_INSTANCE_ID: values.instanceId,
    PI_USER_CONFIG: values.userRoot,
    PI_WORKSPACE_DATA: values.workspaceData,
    PI_INSTANCE_DATA: values.instanceData,
    MY_CODE_AGENT_DESKTOP_TOKEN: values.token,
    PI_ELECTRON_PARENTED: "1",
    ELECTRON_RUN_AS_NODE: "1",
  });
  return env;
}

export function createElectronHelperEnv(
  hostEnv: NodeJS.ProcessEnv,
  values: {
    electronRunAsNode?: boolean;
    workspace?: string;
    dataRoot?: string;
    extra?: Record<string, string | undefined>;
  },
): NodeJS.ProcessEnv {
  const env = cloneEnv(hostEnv);
  removeProviderAndInternalKeys(env);
  mergeStringValues(env, {
    ...(values.electronRunAsNode ? { ELECTRON_RUN_AS_NODE: "1" } : {}),
    ...(values.workspace ? { PI_WORKSPACE: values.workspace } : {}),
    ...(values.dataRoot ? { PI_DATA_ROOT: values.dataRoot } : {}),
  });
  if (values.extra) {
    const blocked = new Set([...PROVIDER_SECRET_ENV_KEYS, ...INTERNAL_RUNTIME_ENV_KEYS].map((key) => key.toUpperCase()));
    mergeStringValues(env, Object.fromEntries(
      Object.entries(values.extra).filter(([key]) => !blocked.has(key.toUpperCase())),
    ));
  }
  return env;
}

function redactSensitiveUrlQueries(value: string): string {
  return value.replace(
    /([?&](?:api[_-]?key|authorization|cookie|password|secret|token)[^=\s]*=)[^&#\s]*/gi,
    `$1${REDACTED}`,
  );
}

export function sanitizeProcessOutput(value: unknown, knownSecrets: readonly string[] = []): string {
  let output = value instanceof Error ? value.message : String(value ?? "");
  for (const secret of [...knownSecrets].filter(Boolean).sort((left, right) => right.length - left.length)) {
    output = output.split(secret).join(REDACTED);
  }
  output = output
    .replace(/\bBearer\s+[^\s"']+/gi, `Bearer ${REDACTED}`)
    .replace(/\b(?:sk|key|token)[-_][A-Za-z0-9._-]{8,}\b/gi, REDACTED)
    .replace(/\b(password|passwd|secret|api[_-]?key|authorization|cookie|token)\s*[:=]\s*[^\s,;]+/gi, `$1=${REDACTED}`);
  output = redactSensitiveUrlQueries(output);
  return output.length > 32_000 ? `${output.slice(0, 32_000)}\n...[truncated]` : output;
}
