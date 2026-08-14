import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

const moduleUrl = new URL("../src/electron/electron-e2e-renderer-probe.ts", import.meta.url);
const mainUrl = new URL("../src/electron/electron-main.ts", import.meta.url);

test("renderer E2E probes live outside electron-main", () => {
  assert.equal(existsSync(moduleUrl), true, "electron-e2e-renderer-probe.ts should exist");

  const mainSource = readFileSync(mainUrl, "utf8");
  const probeSource = readFileSync(moduleUrl, "utf8");
  for (const name of [
    "waitForRendererReady",
    "runRendererCookieIsolationProbe",
    "collectRendererE2EResult",
  ]) {
    assert.doesNotMatch(mainSource, new RegExp(`(?:async\\s+)?function\\s+${name}\\s*\\(`));
    assert.match(probeSource, new RegExp(`export\\s+async\\s+function\\s+${name}\\s*\\(`));
  }
  assert.match(mainSource, /from "\.\/electron-e2e-renderer-probe\.js"/);
});

test("waitForRendererReady returns after the dashboard and preload API are ready", async () => {
  const { waitForRendererReady } = await import(moduleUrl.href);
  let calls = 0;
  const win = {
    webContents: {
      executeJavaScript: async (_source, userGesture) => {
        calls += 1;
        assert.equal(userGesture, true);
        return { electronApiType: "object", appChildCount: 1 };
      },
    },
  };

  await waitForRendererReady(win);

  assert.equal(calls, 1);
});

test("cookie isolation probe bootstraps both windows before dashboard requests", async () => {
  const { runRendererCookieIsolationProbe } = await import(moduleUrl.href);
  const calls = [];
  const windowFor = (name, status) => ({
    webContents: {
      executeJavaScript: async (source, userGesture) => {
        assert.equal(userGesture, true);
        if (source.includes("bootstrapApi")) {
          calls.push(`${name}:bootstrap`);
          return undefined;
        }
        calls.push(`${name}:dashboard`);
        return status;
      },
    },
  });

  const result = await runRendererCookieIsolationProbe(
    windowFor("first", 200),
    windowFor("second", 403),
  );

  assert.deepEqual(result, { firstDashboardStatus: 200, secondDashboardStatus: 403 });
  assert.deepEqual(calls.slice(0, 2), ["first:bootstrap", "second:bootstrap"]);
  assert.deepEqual(new Set(calls.slice(2)), new Set(["first:dashboard", "second:dashboard"]));
});

test("renderer result probe serializes the outside path into isolated JavaScript", async () => {
  const { collectRendererE2EResult } = await import(moduleUrl.href);
  const outsidePath = "C:\\outside\\quote'\nfile.txt";
  let executedSource = "";
  const expected = { appRendered: true, apiStatus: 200 };
  const win = {
    webContents: {
      executeJavaScript: async (source, userGesture) => {
        executedSource = source;
        assert.equal(userGesture, true);
        return expected;
      },
    },
  };

  const result = await collectRendererE2EResult(win, outsidePath);

  assert.strictEqual(result, expected);
  assert.match(executedSource, new RegExp(JSON.stringify(outsidePath).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});
