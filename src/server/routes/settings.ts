/**
 * Settings routes - thin dispatcher for focused settings modules.
 */
import type { RouteHandler } from "./types.js";
import { handleAuthSettings } from "./settings/auth.js";
import { handleCustomProviderSettings } from "./settings/custom-providers.js";
import { handleLayoutSettings } from "./settings/layout.js";
import { handleModelSettings } from "./settings/models.js";
import { handlePreferenceSettings } from "./settings/preferences.js";
import { handleStorageSettings } from "./settings/storage.js";
import { handleSubagentSettings } from "./settings/subagents.js";
import { handleThinkingSettings } from "./settings/thinking.js";

const handlers: RouteHandler[] = [
  handleSubagentSettings,
  handleStorageSettings,
  handlePreferenceSettings,
  handleCustomProviderSettings,
  handleModelSettings,
  handleAuthSettings,
  handleThinkingSettings,
  handleLayoutSettings,
];

export const handleSettings: RouteHandler = async (req, res, ctx) => {
  for (const handler of handlers) {
    if (await handler(req, res, ctx)) return true;
  }
  return false;
};
