import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Window } from "happy-dom";

describe("Preferences facade", () => {
  let win;
  let fetchCalls;
  let currentPreferences;

  beforeEach(() => {
    win = new Window();
    global.window = win;
    global.localStorage = win.localStorage;
    fetchCalls = [];
    global.fetch = async (...args) => {
      fetchCalls.push(args);
      return new Response(JSON.stringify({ preferences: {} }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    };
    win.App = {};
    global.App = win.App;
    currentPreferences = null;
  });

  afterEach(async () => {
    if (currentPreferences) {
      global.fetch = async () => response({});
      await currentPreferences.hydrate();
      await currentPreferences.flush();
    }
    currentPreferences = null;
  });

  async function loadPreferences() {
    await import(`../src/frontend/services/preferences.ts?${Date.now()}-${Math.random()}`);
    currentPreferences = win.App.Preferences;
    return currentPreferences;
  }

  function response(preferences, status = 200) {
    return new Response(JSON.stringify({ preferences }), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  }

  function deferred() {
    let resolve;
    let reject;
    const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
    return { promise, resolve, reject };
  }

  it("owns string, boolean, number, and JSON preference access", async () => {
    await loadPreferences();

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
    await loadPreferences();
    win.App.Preferences.set("bad-json", "{");
    win.App.Preferences.set("bad-number", "nope");

    assert.deepEqual(win.App.Preferences.getJson("bad-json", { ok: false }), { ok: false });
    assert.equal(win.App.Preferences.getNumber("bad-number", 7), 7);
    assert.equal(win.App.Preferences.getNumber("missing-number", 13), 13);
    win.App.Preferences.remove("bad-json");
    assert.equal(win.App.Preferences.get("bad-json", "fallback"), "fallback");
  });

  it("uses the supplied fallback for unknown boolean values", async () => {
    await loadPreferences();

    for (const value of ["corrupt", "maybe"]) {
      win.App.Preferences.set("unknown-boolean", value);
      assert.equal(win.App.Preferences.getBoolean("unknown-boolean", true), true);
      assert.equal(win.App.Preferences.getBoolean("unknown-boolean", false), false);
    }

    for (const [value, expected] of [["0", false], ["false", false], ["1", true], ["true", true]]) {
      win.App.Preferences.set("known-boolean", value);
      assert.equal(win.App.Preferences.getBoolean("known-boolean", !expected), expected);
    }
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

  it("declares the complete typed preferences facade", () => {
    const source = readFileSync(resolve(process.cwd(), "src/frontend/dashboard.d.ts"), "utf8");
    const declaration = source.slice(source.indexOf("interface AppPreferences"), source.indexOf("interface DashboardData"));
    for (const method of ["get", "set", "remove", "getBoolean", "setBoolean", "getNumber", "getJson", "setJson", "hydrate", "onHydrated", "isHydrated", "flush"]) {
      assert.match(declaration, new RegExp(`\\b${method}\\b`), `missing AppPreferences.${method}`);
    }
  });

  it("hydrates once and shares the in-flight promise", async () => {
    const preferences = await loadPreferences();
    const pending = deferred();
    global.fetch = async () => {
      fetchCalls.push([]);
      return pending.promise;
    };

    const first = preferences.hydrate();
    const second = preferences.hydrate();
    assert.strictEqual(first, second);
    assert.equal(preferences.isHydrated(), false);
    pending.resolve(response({ "editor-theme": "vs" }));
    await first;

    assert.equal(preferences.isHydrated(), true);
    assert.equal(preferences.get("editor-theme"), "vs");
    assert.equal(fetchCalls.length, 1);
  });

  it("lets a non-empty server map win over local values and cleans it as strings", async () => {
    const preferences = await loadPreferences();
    preferences.set("editor-theme", "local");
    preferences.set("auto-save", "1");
    global.fetch = async (...args) => {
      fetchCalls.push(args);
      return response({
        "editor-theme": "server",
        "auto-save": 1,
        ignored: null,
      });
    };

    await preferences.hydrate();

    assert.equal(preferences.get("editor-theme"), "server");
    assert.equal(preferences.get("auto-save", "missing"), "missing");
    assert.equal(preferences.get("ignored", "missing"), "missing");
    assert.equal(localStorage.getItem("editor-theme"), "server");
    assert.equal(localStorage.getItem("auto-save"), null);
    assert.equal(fetchCalls.length, 1);
    assert.equal(fetchCalls[0][0], "/api/preferences");
  });

  it("migrates only known local keys when the server map is empty", async () => {
    const preferences = await loadPreferences();
    preferences.set("editor-theme", "vs");
    preferences.set("providers_order", '["openai"]');
    preferences.set("unknown-local-key", "do-not-migrate");
    global.fetch = async (url, options) => {
      fetchCalls.push([url, options]);
      return fetchCalls.length === 1
        ? response({})
        : response({ "editor-theme": "vs", providers_order: '["openai"]' });
    };

    await preferences.hydrate();

    assert.equal(fetchCalls.length, 2);
    assert.equal(fetchCalls[1][0], "/api/preferences");
    assert.deepEqual(JSON.parse(fetchCalls[1][1].body), {
      values: { "editor-theme": "vs", providers_order: '["openai"]' },
      remove: [],
    });
    assert.equal(preferences.get("unknown-local-key"), "do-not-migrate");
  });

  it("batches set and remove mutations into one deterministic patch", async () => {
    const preferences = await loadPreferences();
    preferences.set("editor-theme", "vs");
    preferences.set("auto-save", "1");
    preferences.remove("providers_order");

    const ok = await preferences.flush();

    assert.equal(ok, true);
    assert.equal(fetchCalls.length, 1);
    assert.deepEqual(JSON.parse(fetchCalls[0][1].body), {
      values: { "auto-save": "1", "editor-theme": "vs" },
      remove: ["providers_order"],
    });
  });

  it("falls back to local state when GET fails", async () => {
    const preferences = await loadPreferences();
    preferences.set("editor-theme", "local");
    global.fetch = async () => { throw new Error("offline"); };

    await assert.doesNotReject(preferences.hydrate());

    assert.equal(preferences.isHydrated(), true);
    assert.equal(preferences.get("editor-theme"), "local");
  });

  it("allows hydration to retry after a failed GET", async () => {
    const preferences = await loadPreferences();
    let attempts = 0;
    global.fetch = async (...args) => {
      fetchCalls.push(args);
      attempts += 1;
      if (attempts === 1) throw new Error("offline");
      return response({ "editor-theme": "server" });
    };

    await preferences.hydrate();
    await preferences.hydrate();

    assert.equal(fetchCalls.length, 2);
    assert.equal(preferences.get("editor-theme"), "server");
  });

  it("bounds a pending hydration attempt so later preference writes can flush", async () => {
    const realSetTimeout = global.setTimeout;
    const realClearTimeout = global.clearTimeout;
    const timers = [];
    global.setTimeout = (callback, delay) => {
      const timer = { callback, delay, cleared: false };
      timers.push(timer);
      return timer;
    };
    global.clearTimeout = (timer) => { if (timer) timer.cleared = true; };
    const pending = deferred();

    try {
      const preferences = await loadPreferences();
      global.fetch = async (...args) => {
        fetchCalls.push(args);
        if (args[1]?.method === "PATCH") return response({});
        return pending.promise;
      };

      const hydration = preferences.hydrate();
      await Promise.resolve();
      const deadline = timers.find((timer) => timer.delay === 5000 && !timer.cleared);
      assert.ok(deadline, "hydration should install a five-second request deadline");
      deadline.callback();
      await hydration;

      preferences.set("editor-theme", "vs");
      assert.equal(await preferences.flush(), true);
      const patchCalls = fetchCalls.filter(([, options]) => options?.method === "PATCH");
      assert.equal(patchCalls.length, 1);
    } finally {
      pending.resolve(response({}));
      global.setTimeout = realSetTimeout;
      global.clearTimeout = realClearTimeout;
    }
  });

  it("automatically retries failed hydration and notifies hydrated consumers", async () => {
    const preferences = await loadPreferences();
    let attempts = 0;
    let notifications = 0;
    const unsubscribe = preferences.onHydrated(() => { notifications += 1; });
    global.fetch = async (...args) => {
      fetchCalls.push(args);
      attempts += 1;
      if (attempts === 1) throw new Error("offline");
      return response({ "editor-theme": "server" });
    };

    await preferences.hydrate();
    await new Promise((resolve) => setTimeout(resolve, 1100));
    unsubscribe();

    assert.equal(fetchCalls.length, 2);
    assert.equal(preferences.get("editor-theme"), "server");
    assert.equal(notifications, 1);
  });

  it("does not let a late GET overwrite a mutation made during hydration", async () => {
    const preferences = await loadPreferences();
    const pending = deferred();
    global.fetch = async () => pending.promise;
    const hydration = preferences.hydrate();

    preferences.set("editor-theme", "new-local");
    pending.resolve(response({ "editor-theme": "stale-server", "auto-save": "1" }));
    await hydration;

    assert.equal(preferences.get("editor-theme"), "new-local");
    assert.equal(preferences.get("auto-save"), "1");
  });

  it("keeps mutations made while a patch is in flight", async () => {
    const preferences = await loadPreferences();
    const pending = deferred();
    global.fetch = async (...args) => {
      fetchCalls.push(args);
      return pending.promise;
    };
    preferences.set("editor-theme", "first");
    const flushing = preferences.flush();
    preferences.set("editor-theme", "second");
    pending.resolve(response({}));
    assert.equal(await flushing, true);

    assert.equal(await preferences.flush(), true);
    assert.equal(fetchCalls.length, 2);
    assert.deepEqual(JSON.parse(fetchCalls[1][1].body), {
      values: { "editor-theme": "second" },
      remove: [],
    });
  });

  it("waits for the old patch and then flushes mutations added during it", async () => {
    const preferences = await loadPreferences();
    const firstPatch = deferred();
    global.fetch = async (...args) => {
      fetchCalls.push(args);
      return fetchCalls.length === 1 ? firstPatch.promise : response({});
    };

    preferences.set("editor-theme", "first");
    const firstFlush = preferences.flush();
    preferences.set("editor-theme", "second");
    const secondFlush = preferences.flush();
    firstPatch.resolve(response({}));

    assert.equal(await firstFlush, true);
    assert.equal(await secondFlush, true);
    assert.equal(fetchCalls.length, 2);
    assert.deepEqual(JSON.parse(fetchCalls[1][1].body), {
      values: { "editor-theme": "second" },
      remove: [],
    });
  });

  it("waits for an in-flight patch before starting hydration GET", async () => {
    const preferences = await loadPreferences();
    const patchPending = deferred();
    const getPending = deferred();
    global.fetch = async (...args) => {
      fetchCalls.push(args);
      return args[1]?.method === "PATCH" ? patchPending.promise : getPending.promise;
    };

    preferences.set("editor-theme", "local");
    const patch = preferences.flush();
    const hydration = preferences.hydrate();
    await Promise.resolve();
    const requestsBeforePatchCompletes = fetchCalls.length;

    patchPending.resolve(response({}));
    await Promise.resolve();
    getPending.resolve(response({ "editor-theme": "server" }));
    await patch;
    await hydration;
    assert.equal(requestsBeforePatchCompletes, 1);
    assert.equal(fetchCalls.length, 2);
    assert.equal(fetchCalls[0][1].method, "PATCH");
    assert.equal(fetchCalls[1][1]?.method, undefined);
    assert.ok(fetchCalls[1][1]?.signal);
    assert.equal(preferences.get("editor-theme"), "server");
  });

  it("preserves a mutation newer than the in-flight patch across hydration", async () => {
    const preferences = await loadPreferences();
    const patchPending = deferred();
    global.fetch = async (...args) => {
      fetchCalls.push(args);
      if (args[1]?.method === "PATCH") {
        return fetchCalls.length === 1 ? patchPending.promise : response({});
      }
      return response({ "editor-theme": "first" });
    };

    preferences.set("editor-theme", "first");
    const firstFlush = preferences.flush();
    preferences.set("editor-theme", "second");
    const hydration = preferences.hydrate();
    await Promise.resolve();
    assert.equal(fetchCalls.length, 1);

    patchPending.resolve(response({}));
    await hydration;

    assert.equal(preferences.get("editor-theme"), "second");
    await preferences.flush();
    await firstFlush;
    const patchCalls = fetchCalls.filter(([, options]) => options?.method === "PATCH");
    assert.equal(patchCalls.length, 2);
    assert.deepEqual(JSON.parse(patchCalls[1][1].body), {
      values: { "editor-theme": "second" },
      remove: [],
    });
  });

  it("retains a failed in-flight mutation against a stale hydration response", async () => {
    const preferences = await loadPreferences();
    const patchPending = deferred();
    global.fetch = async (...args) => {
      fetchCalls.push(args);
      if (args[1]?.method === "PATCH") {
        return fetchCalls.length === 1 ? patchPending.promise : response({});
      }
      return response({ "editor-theme": "old" });
    };

    preferences.set("editor-theme", "first");
    const firstFlush = preferences.flush();
    const hydration = preferences.hydrate();
    patchPending.resolve(response({}, 500));

    assert.equal(await firstFlush, false);
    await hydration;
    assert.equal(preferences.get("editor-theme"), "first");

    assert.equal(await preferences.flush(), true);
    const patchCalls = fetchCalls.filter(([, options]) => options?.method === "PATCH");
    assert.equal(patchCalls.length, 2);
    assert.deepEqual(JSON.parse(patchCalls[1][1].body), {
      values: { "editor-theme": "first" },
      remove: [],
    });
  });

  it("treats raw non-empty invalid preferences as server-wins without migration", async () => {
    const preferences = await loadPreferences();
    preferences.set("editor-theme", "local");
    global.fetch = async (...args) => {
      fetchCalls.push(args);
      return response({ "editor-theme": 42 });
    };

    await preferences.hydrate();

    assert.equal(fetchCalls.length, 1);
    assert.equal(preferences.get("editor-theme", "fallback"), "fallback");
    assert.equal(localStorage.getItem("editor-theme"), null);
  });

  it("retries a failed batch together with the next mutation", async () => {
    const preferences = await loadPreferences();
    let attempts = 0;
    global.fetch = async (...args) => {
      fetchCalls.push(args);
      attempts += 1;
      if (attempts === 1) return response({}, 500);
      return response({});
    };

    preferences.set("editor-theme", "first");
    assert.equal(await preferences.flush(), false);
    preferences.set("auto-save", "1");
    assert.equal(await preferences.flush(), true);

    assert.equal(fetchCalls.length, 2);
    assert.deepEqual(JSON.parse(fetchCalls[1][1].body), {
      values: { "auto-save": "1", "editor-theme": "first" },
      remove: [],
    });
  });

  it("automatically retries a failed batch without another mutation", async () => {
    const preferences = await loadPreferences();
    let attempts = 0;
    global.fetch = async (...args) => {
      fetchCalls.push(args);
      attempts += 1;
      if (attempts === 1) return response({}, 500);
      return response({});
    };

    preferences.set("editor-theme", "retry-me");
    assert.equal(await preferences.flush(), false);
    await new Promise((resolve) => setTimeout(resolve, 1100));

    assert.equal(fetchCalls.length, 2);
    assert.deepEqual(JSON.parse(fetchCalls[1][1].body), {
      values: { "editor-theme": "retry-me" },
      remove: [],
    });
  });
});
