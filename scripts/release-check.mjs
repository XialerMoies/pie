#!/usr/bin/env node
import { spawn } from "node:child_process";
import process from "node:process";

const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
const gates = [
  "typecheck",
  "test",
  "build",
  "test:build",
  "test:electron:e2e",
];
if (process.env.PROVIDER_MATRIX_FILE?.trim()) gates.push("test:provider:live");

function runGate(name) {
  return new Promise((resolve) => {
    const child = spawn(npmCommand, ["run", name], {
      cwd: process.cwd(),
      env: process.env,
      stdio: "inherit",
      shell: process.platform === "win32",
      windowsHide: true,
    });
    child.once("error", (error) => {
      console.error(`[release] ${name} failed to start: ${error.message}`);
      resolve(1);
    });
    child.once("close", (code, signal) => {
      if (signal) {
        console.error(`[release] ${name} stopped by ${signal}`);
        resolve(1);
        return;
      }
      console.log(`[release] ${name}: exit ${code ?? 1}`);
      resolve(code ?? 1);
    });
  });
}

for (const gate of gates) {
  console.log(`\n[release] running ${gate}`);
  const code = await runGate(gate);
  if (code !== 0) {
    console.error(`[release] blocked at ${gate}`);
    process.exit(code);
  }
}

console.log("\n[release] all release gates passed");
