import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Window } from "happy-dom";

describe("Preferences facade", () => {
  let win;

  beforeEach(() => {
    win = new Window();
    global.window = win;
    global.localStorage = win.localStorage;
    win.App = {};
    global.App = win.App;
  });

  it("owns string, boolean, number, and JSON preference access", async () => {
    await import(`../src/frontend/services/preferences.ts?${Date.now()}-${Math.random()}`);

    win.App.Preferences.set("editor-theme", "vs");
    win.App.Preferences.setBoolean("auto-save", true);
    win.App.Preferences.setJson("providers_order", ["openai", "deepseek"]);
    win.App.Preferences.set("editor-font-size", "99");

    assert.equal(win.App.Preferences.get("editor-theme", "vs-dark"), "vs");
    assert.equal(win.App.Preferences.getBoolean("auto-save"), true);
    assert.deepEqual(win.App.Preferences.getJson("providers_order", []), ["openai", "deepseek"]);
    assert.equal(win.App.Preferences.getNumber("editor-font-size", 13, 10, 24), 24);
  });

  it("returns fallbacks for malformed or unavailable values", async () => {
    await import(`../src/frontend/services/preferences.ts?${Date.now()}-${Math.random()}`);
    win.App.Preferences.set("bad-json", "{");
    win.App.Preferences.set("bad-number", "nope");

    assert.deepEqual(win.App.Preferences.getJson("bad-json", { ok: false }), { ok: false });
    assert.equal(win.App.Preferences.getNumber("bad-number", 7), 7);
    assert.equal(win.App.Preferences.getNumber("missing-number", 13), 13);
    win.App.Preferences.remove("bad-json");
    assert.equal(win.App.Preferences.get("bad-json", "fallback"), "fallback");
  });

  it("loads the preference facade before modules that read it during startup", () => {
    const source = readFileSync(resolve(process.cwd(), "scripts/compile-frontend-ts.mjs"), "utf8");
    const preferenceIndex = source.indexOf('"gen/services/preferences.js"');
    const explorerIndex = source.indexOf('"gen/service/explorer-service.js"');
    const chatModeIndex = source.indexOf('"gen/chat/chat-mode.js"');

    assert.ok(preferenceIndex >= 0);
    assert.ok(preferenceIndex < explorerIndex, "preferences must load before ExplorerService");
    assert.ok(preferenceIndex < chatModeIndex, "preferences must load before chat mode initialization");
  });
});
