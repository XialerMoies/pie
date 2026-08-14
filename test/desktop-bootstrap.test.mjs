import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import {
  resolveDesktopProcessPaths,
  validateSecondLaunchDataRoot,
} from "../src/electron/desktop-bootstrap.ts";

describe("desktop process bootstrap paths", () => {
  it("returns stable process-wide userData and cache paths", () => {
    const options = {
      osUserData: resolve("C:/Users/test/AppData/Roaming/my-code-agent"),
      runtimeRoot: resolve("E:/my-code-agent"),
    };

    const first = resolveDesktopProcessPaths(options);
    const second = resolveDesktopProcessPaths(options);

    assert.deepStrictEqual(second, first);
    assert.strictEqual(first.dataRoot, join(options.runtimeRoot, "data"));
    assert.strictEqual(first.electronUserData, join(first.dataRoot, "electron-user-data"));
    assert.strictEqual(first.electronCache, join(first.dataRoot, "cache", "electron"));
    assert.strictEqual(first.userRoot, join(first.dataRoot, "user"));
  });

  it("keeps the data root pointer in the OS userData directory", () => {
    const osUserData = resolve("C:/Users/test/AppData/Roaming/my-code-agent");
    const paths = resolveDesktopProcessPaths({
      osUserData,
      runtimeRoot: resolve("E:/my-code-agent"),
      configuredDataRoot: resolve("E:/agent-data"),
    });

    assert.strictEqual(paths.dataRootPointerFile, join(osUserData, "data-root.json"));
  });

  it("places shared Electron paths under a configured data root", () => {
    const configuredDataRoot = resolve("E:/agent-data");
    const paths = resolveDesktopProcessPaths({
      osUserData: resolve("C:/Users/test/AppData/Roaming/my-code-agent"),
      runtimeRoot: resolve("E:/my-code-agent"),
      configuredDataRoot,
    });

    assert.strictEqual(paths.dataRoot, configuredDataRoot);
    assert.strictEqual(paths.electronUserData, resolve("E:/agent-data/electron-user-data"));
    assert.strictEqual(paths.electronCache, resolve("E:/agent-data/cache/electron"));
  });

  it("requires absolute bootstrap roots", () => {
    assert.throws(
      () => resolveDesktopProcessPaths({ osUserData: "relative", runtimeRoot: resolve("E:/my-code-agent") }),
      /osUserData must be an absolute path/,
    );
    assert.throws(
      () => resolveDesktopProcessPaths({ osUserData: resolve("C:/os-user-data"), runtimeRoot: "relative" }),
      /runtimeRoot must be an absolute path/,
    );
    assert.throws(
      () => resolveDesktopProcessPaths({
        osUserData: resolve("C:/os-user-data"),
        runtimeRoot: resolve("E:/my-code-agent"),
        configuredDataRoot: "relative",
      }),
      /configuredDataRoot must be an absolute path/,
    );
  });
});

describe("second launch data root validation", () => {
  it("accepts the same canonical path", () => {
    const active = resolve("E:/agent-data");
    const equivalent = join(active, "nested", "..");

    assert.doesNotThrow(() => validateSecondLaunchDataRoot(active, equivalent));
    if (process.platform === "win32") {
      assert.doesNotThrow(() => validateSecondLaunchDataRoot(active.toUpperCase(), active.toLowerCase()));
    }
  });

  it("rejects a different process-wide data root with a clear error", () => {
    assert.throws(
      () => validateSecondLaunchDataRoot(resolve("E:/agent-data"), resolve("D:/other-data")),
      /second launch data root.*active Electron process data root/i,
    );
  });

  it("requires absolute active and requested data roots", () => {
    assert.throws(() => validateSecondLaunchDataRoot("relative"), /activeDataRoot must be an absolute path/);
    assert.throws(
      () => validateSecondLaunchDataRoot(resolve("E:/agent-data"), "relative"),
      /requestedDataRoot must be an absolute path/,
    );
  });
});

describe("second launch window-manager handling", () => {
  it("keeps queued requests bounded and drains them serially through WindowManager", () => {
    const electronSource = readFileSync(resolve("src/electron/electron-main.ts"), "utf8");
    const coordinatorSource = readFileSync(resolve("src/electron/electron-launch-coordinator.ts"), "utf8");

    assert.match(electronSource, /from "\.\/electron-launch-coordinator\.js"/);
    assert.match(coordinatorSource, /const maxPending = options\.maxPending \?\? 32/);
    assert.match(coordinatorSource, /function drain\(\): Promise<void>/);
    assert.match(coordinatorSource, /pending\.length >= maxPending/);
    assert.match(coordinatorSource, /const request = pending\.shift\(\)/);
    assert.match(coordinatorSource, /if \(request\) await processOne\(request\)/);
    assert.match(
      coordinatorSource,
      /rejectWaiter\(request\.instanceId, error\)/,
    );
    assert.doesNotMatch(coordinatorSource, /pending\.splice\(/);
  });
});
