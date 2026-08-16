import { existsSync, readFileSync, statSync } from "node:fs";
import { canonicalWorkspacePath } from "./data-layout.js";
import { updateLockedJson } from "./locked-json-store.js";

export const USER_PREFERENCE_KEYS = new Set([
  "auto-save",
  "chat-effort",
  "chat-jump-latest-enabled",
  "chat-jump-latest-smooth",
  "chat-jump-latest-threshold",
  "chat-mode",
  "chat-timeline-enabled",
  "chat-timeline-window-size",
  "editor-font-size",
  "editor-tab-size",
  "editor-theme",
  "editor-use-tabs",
  "explorer-filter",
  "explorer-state",
  "providers_order",
  "subagent-max-concurrent",
  "subagent-max-tasks",
]);

export interface UserSettingsDocument {
  defaultProvider?: string;
  defaultModel?: string;
  startup?: { lastWorkspace?: string; recentWorkspaces?: string[] };
  preferences?: Record<string, string>;
  [key: string]: unknown;
}

const MAX_RECENT_WORKSPACES = 10;
const MAX_PREFERENCE_VALUE_LENGTH = 4096;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validWorkspace(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const workspace = canonicalWorkspacePath(value);
    return existsSync(workspace) && statSync(workspace).isDirectory() ? workspace : null;
  } catch {
    return null;
  }
}

function sanitizeRecentWorkspaces(value: unknown): string[] {
  if (!Array.isArray(value)) return [];

  const recent: string[] = [];
  const seen = new Set<string>();
  for (const candidate of value) {
    const workspace = validWorkspace(candidate);
    if (!workspace || seen.has(workspace)) continue;
    seen.add(workspace);
    recent.push(workspace);
    if (recent.length === MAX_RECENT_WORKSPACES) break;
  }
  return recent;
}

function sanitizePreferences(value: unknown): Record<string, string> {
  if (!isRecord(value)) return {};

  const preferences: Record<string, string> = {};
  for (const [key, preference] of Object.entries(value)) {
    const isSubagentLimit = key === "subagent-max-tasks" || key === "subagent-max-concurrent";
    if (
      USER_PREFERENCE_KEYS.has(key)
      && typeof preference === "string"
      && preference.length <= MAX_PREFERENCE_VALUE_LENGTH
      && (!isSubagentLimit || (/^\d+$/.test(preference) && Number(preference) >= 1 && Number(preference) <= 30))
    ) {
      preferences[key] = preference;
    }
  }
  return preferences;
}

function sanitizeUserSettings(value: unknown): UserSettingsDocument {
  if (!isRecord(value)) return {};

  const settings: UserSettingsDocument = {};
  if (typeof value.defaultProvider === "string") settings.defaultProvider = value.defaultProvider;
  if (typeof value.defaultModel === "string") settings.defaultModel = value.defaultModel;

  if (isRecord(value.startup)) {
    const lastWorkspace = validWorkspace(value.startup.lastWorkspace);
    const recentWorkspaces = sanitizeRecentWorkspaces(value.startup.recentWorkspaces);
    if (lastWorkspace || recentWorkspaces.length > 0) {
      settings.startup = {};
      if (lastWorkspace) settings.startup.lastWorkspace = lastWorkspace;
      if (recentWorkspaces.length > 0) settings.startup.recentWorkspaces = recentWorkspaces;
    }
  }

  const preferences = sanitizePreferences(value.preferences);
  if (Object.keys(preferences).length > 0) settings.preferences = preferences;
  return settings;
}

export function readUserSettings(settingsFile: string): UserSettingsDocument {
  try {
    return sanitizeUserSettings(JSON.parse(readFileSync(settingsFile, "utf8")) as unknown);
  } catch (error: any) {
    if (error?.code === "ENOENT" || error instanceof SyntaxError) return {};
    throw error;
  }
}

export function readUserSettingsStrict(settingsFile: string): UserSettingsDocument {
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(settingsFile, "utf8")) as unknown;
  } catch (error: any) {
    if (error?.code === "ENOENT") return {};
    throw error;
  }
  if (!isRecord(value)) throw new Error("settings: must be a JSON object");
  if (value.defaultProvider !== undefined && typeof value.defaultProvider !== "string") {
    throw new Error("settings.defaultProvider: must be a string");
  }
  if (value.defaultModel !== undefined && typeof value.defaultModel !== "string") {
    throw new Error("settings.defaultModel: must be a string");
  }
  if ((value.defaultProvider === undefined) !== (value.defaultModel === undefined)) {
    throw new Error("settings defaultProvider and defaultModel must be configured together");
  }
  if (value.preferences !== undefined) {
    if (!isRecord(value.preferences)) throw new Error("settings.preferences: must be an object");
    const provider = value.preferences.defaultProvider;
    const model = value.preferences.defaultModel;
    if (provider !== undefined && typeof provider !== "string") {
      throw new Error("settings.preferences.defaultProvider: must be a string");
    }
    if (model !== undefined && typeof model !== "string") {
      throw new Error("settings.preferences.defaultModel: must be a string");
    }
    if ((provider === undefined) !== (model === undefined)) {
      throw new Error("settings preferences defaultProvider and defaultModel must be configured together");
    }
  }
  return value as UserSettingsDocument;
}

export function readStartupWorkspace(settingsFile: string): string | null {
  return readUserSettings(settingsFile).startup?.lastWorkspace ?? null;
}

export function readUserPreferences(settingsFile: string): Record<string, string> {
  return readUserSettings(settingsFile).preferences ?? {};
}

export function readUserPreferencesStrict(settingsFile: string): Record<string, string> {
  const settings = readUserSettingsStrict(settingsFile);
  if (settings.preferences !== undefined && !isRecord(settings.preferences)) {
    throw new Error("settings.preferences: must be an object");
  }
  const preferences = sanitizePreferences(settings.preferences);
  if (settings.preferences?.defaultProvider !== undefined) {
    preferences.defaultProvider = settings.preferences.defaultProvider;
    preferences.defaultModel = settings.preferences.defaultModel;
  }
  return preferences;
}

function rawDocument(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

export async function recordOpenedWorkspace(
  settingsFile: string,
  workspace: string,
  options: { transientWorkspace?: string } = {},
): Promise<boolean> {
  const canonicalWorkspace = canonicalWorkspacePath(workspace);
  if (validWorkspace(canonicalWorkspace) === null) return false;
  if (
    options.transientWorkspace !== undefined
    && canonicalWorkspace === canonicalWorkspacePath(options.transientWorkspace)
  ) {
    return false;
  }

  let merged = false;
  await updateLockedJson<unknown>(settingsFile, () => ({}), (current) => {
    if (validWorkspace(canonicalWorkspace) === null) return current;
    merged = true;
    const document = rawDocument(current);
    const startup = isRecord(document.startup) ? document.startup : {};
    const recentWorkspaces = [
      canonicalWorkspace,
      ...sanitizeRecentWorkspaces(startup.recentWorkspaces).filter((item) => item !== canonicalWorkspace),
    ].slice(0, MAX_RECENT_WORKSPACES);

    return {
      ...document,
      startup: {
        ...startup,
        lastWorkspace: canonicalWorkspace,
        recentWorkspaces,
      },
    };
  }, { recoverInvalidJson: true });
  return merged;
}

function validatePreferenceKey(key: unknown): asserts key is string {
  if (typeof key !== "string" || !USER_PREFERENCE_KEYS.has(key)) {
    throw new Error(`Unknown preference key: ${String(key)}`);
  }
}

function validatePreferencePatch(
  patch: { values?: Record<string, string>; remove?: string[] },
): { values: Record<string, string>; remove: string[] } {
  if (!isRecord(patch)) throw new Error("Preference patch must be an object");

  const values = patch.values === undefined ? {} : patch.values;
  const remove = patch.remove === undefined ? [] : patch.remove;
  if (!isRecord(values)) throw new Error("Preference values must be an object");
  if (!Array.isArray(remove)) throw new Error("Preference remove must be an array");

  const validatedValues: Record<string, string> = {};
  for (const [key, value] of Object.entries(values)) {
    validatePreferenceKey(key);
    if (typeof value !== "string") throw new Error(`Preference value must be a string: ${key}`);
    if (value.length > MAX_PREFERENCE_VALUE_LENGTH) {
      throw new Error(`Preference value is too long: ${key}`);
    }
    if (
      (key === "subagent-max-tasks" || key === "subagent-max-concurrent")
      && (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 30)
    ) {
      throw new Error(`Preference value must be an integer between 1 and 30: ${key}`);
    }
    validatedValues[key] = value;
  }
  const validatedRemove: string[] = [];
  for (const key of remove) {
    validatePreferenceKey(key);
    if (Object.prototype.hasOwnProperty.call(validatedValues, key)) {
      throw new Error(`Preference key cannot be both set and removed: ${key}`);
    }
    validatedRemove.push(key);
  }

  return { values: validatedValues, remove: validatedRemove };
}

export async function patchUserPreferences(
  settingsFile: string,
  patch: { values?: Record<string, string>; remove?: string[] },
): Promise<Record<string, string>> {
  const validated = validatePreferencePatch(patch);
  const updated = await updateLockedJson<unknown>(settingsFile, () => ({}), (current) => {
    const document = rawDocument(current);
    const preferences = isRecord(document.preferences) ? { ...document.preferences } : {};
    Object.assign(preferences, validated.values);
    for (const key of validated.remove) delete preferences[key];
    return { ...document, preferences };
  }, { recoverInvalidJson: true });

  return sanitizePreferences(rawDocument(updated).preferences);
}
