#!/usr/bin/env node
import { spawn } from "node:child_process";
import { resolve } from "node:path";

import { readArtifactJson, validateFailureArtifact } from "../test/helpers/failure-artifact.mjs";

const directoryArg = process.argv.slice(2).find((arg) => !arg.startsWith("--"));
if (!directoryArg) throw new Error("usage: npm run test:artifact:replay -- <artifact-dir> [--validate-only]");
const directory = resolve(directoryArg);
const manifest = validateFailureArtifact(directory);
const config = readArtifactJson(directory, "test-config.json");
if (process.argv.includes("--validate-only") || manifest.replay?.driver === "validate") {
  console.log(`[artifact-replay] validated ${directory}`);
  process.exit(0);
}
if (manifest.replay?.driver !== "packaged-electron") throw new Error(`unsupported artifact replay driver: ${manifest.replay?.driver}`);
const executable = process.execPath;
const child = spawn(executable, [resolve("test/packaged-electron.e2e.mjs")], {
  cwd: resolve(config.workspace || process.cwd()),
  env: {
    ...process.env,
    MY_CODE_AGENT_TEST_MEMORY_MB: String(config.memoryLimitMb || 2048),
    ...(config.failureMode === "artifact-probe" ? { MY_CODE_AGENT_E2E_EXPECT_FAILURE_ARTIFACT: "1" } : {}),
  },
  stdio: "inherit",
  windowsHide: true,
});
const exitCode = await new Promise((resolveExit, reject) => {
  child.once("error", reject);
  child.once("exit", (code, signal) => signal ? reject(new Error(`artifact replay stopped by ${signal}`)) : resolveExit(code ?? 1));
});
process.exitCode = exitCode;
