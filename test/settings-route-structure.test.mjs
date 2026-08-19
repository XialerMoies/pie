import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const ROUTES = resolve(ROOT, "src", "server", "routes");
const SETTINGS = resolve(ROUTES, "settings.ts");
const SETTINGS_DIR = resolve(ROUTES, "settings");

const expectedModules = [
  "common.ts",
  "auth.ts",
  "custom-providers.ts",
  "models.ts",
  "preferences.ts",
  "storage.ts",
  "subagents.ts",
  "thinking.ts",
  "layout.ts",
  "skills.ts",
];

const expectedHandlers = [
  "handleSkillSettings",
  "handleSubagentSettings",
  "handleStorageSettings",
  "handlePreferenceSettings",
  "handleCustomProviderSettings",
  "handleModelSettings",
  "handleAuthSettings",
  "handleThinkingSettings",
  "handleLayoutSettings",
];

describe("settings route module structure", () => {
  it("keeps settings.ts as a thin dispatcher over focused route modules", () => {
    const settingsSource = readFileSync(SETTINGS, "utf8");

    for (const file of expectedModules) {
      assert.ok(existsSync(resolve(SETTINGS_DIR, file)), `missing settings module: ${file}`);
    }

    for (const handler of expectedHandlers) {
      assert.match(settingsSource, new RegExp(`import\\s+\\{\\s*${handler}\\s*\\}`), `settings.ts should import ${handler}`);
    }

    const registeredHandlers = [...settingsSource.matchAll(/^\s+(handle\w+Settings),$/gm)].map((match) => match[1]);
    assert.deepEqual(registeredHandlers, expectedHandlers, "settings.ts should register settings handlers in a stable order");
    assert.match(settingsSource, /await handler\(req,\s*res,\s*ctx\)/, "settings.ts should delegate request handling through the registered handlers");
    assert.ok(settingsSource.length < 3000, `settings.ts should stay thin; got ${settingsSource.length} bytes`);
  });
});
