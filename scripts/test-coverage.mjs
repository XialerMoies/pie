#!/usr/bin/env node
import { spawn } from "node:child_process";
import process from "node:process";

const command = process.env.MY_CODE_AGENT_COVERAGE_COMMAND?.trim();
if (!command) {
  console.log("[test-coverage] skipped: set MY_CODE_AGENT_COVERAGE_COMMAND to enable the coverage collector");
  process.exit(0);
}

const child = spawn(command, { cwd: process.cwd(), env: process.env, shell: true, stdio: "inherit", windowsHide: true });
child.once("error", (error) => {
  console.error(`[test-coverage] failed to start: ${error.message}`);
  process.exitCode = 1;
});
child.once("close", (code, signal) => {
  if (signal) {
    console.error(`[test-coverage] stopped by ${signal}`);
    process.exitCode = 1;
  } else process.exitCode = code ?? 1;
});
