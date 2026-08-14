import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

const moduleUrl = new URL("../src/electron/electron-packaged-e2e-probe.ts", import.meta.url);
const mainUrl = new URL("../src/electron/electron-main.ts", import.meta.url);

test("packaged E2E probe orchestration lives outside electron-main", () => {
  assert.equal(existsSync(moduleUrl), true, "electron-packaged-e2e-probe.ts should exist");

  const mainSource = readFileSync(mainUrl, "utf8");
  const probeSource = readFileSync(moduleUrl, "utf8");
  assert.match(mainSource, /from \"\.\/electron-packaged-e2e-probe\.js\"/);
  assert.match(probeSource, /export\s+function\s+createElectronPackagedE2EProbe\s*\(/);
  assert.doesNotMatch(mainSource, /async function runPackagedE2EProbe\s*\(/);
});
