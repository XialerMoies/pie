import { spawn } from "node:child_process";
import process from "node:process";
import { buildTestManifest, validateTestManifest } from "./test-manifest.mjs";

const suite = process.argv[2] || "unit";
const manifest = buildTestManifest();
const errors = validateTestManifest(manifest);
if (errors.length) throw new Error(errors.join("\n"));

const files = suite === "unit"
  ? manifest.suites.unit
  : suite === "frontend"
    ? manifest.suites.frontend
    : suite === "build"
      ? manifest.suites.build
      : manifest.suites.live;
if (!files?.length) throw new Error(`No files in test suite: ${suite}`);

function run(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["scripts/tsx-test.mjs", "--test", "--test-concurrency=1", ...args], {
      cwd: process.cwd(),
      stdio: "inherit",
      env: process.env,
      windowsHide: true,
    });
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (code === 0 && !signal) resolve();
      else reject(new Error(`${suite} test suite failed: exit=${code ?? "null"}${signal ? ` signal=${signal}` : ""}`));
    });
  });
}

console.log(`[test-suite] ${suite}: ${files.length} files from manifest`);
await run(files);
if (suite === "unit" && manifest.suites.unitSerial.length > 0) {
  console.log(`[test-suite] unit serial: ${manifest.suites.unitSerial.length} files from manifest`);
  await run(manifest.suites.unitSerial);
}
