import { spawn } from "node:child_process";
import process from "node:process";

const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
const startedAt = Date.now();
const children = new Set();

const groups = [
  { name: "unit", command: npmCommand, args: ["run", "test:unit"], shell: process.platform === "win32" },
  { name: "routes", command: npmCommand, args: ["run", "test:routes"], shell: process.platform === "win32" },
  { name: "frontend", command: npmCommand, args: ["run", "test:frontend"], shell: process.platform === "win32" },
];

function seconds(ms) {
  return (ms / 1000).toFixed(1);
}

function writePrefixed(stream, prefix, chunk) {
  const text = String(chunk);
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line === "" && i === lines.length - 1) continue;
    stream.write(`${prefix}${line}\n`);
  }
}

function runTask(task) {
  const taskStartedAt = Date.now();
  const prefix = `[${task.name}] `;
  console.log(`${prefix}starting: ${task.command} ${task.args.join(" ")}`);

  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(task.command, task.args, {
        cwd: process.cwd(),
        env: process.env,
        shell: task.shell ?? false,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch (error) {
      const durationMs = Date.now() - taskStartedAt;
      const message = error instanceof Error ? error.message : String(error);
      console.error(`${prefix}failed to spawn after ${seconds(durationMs)}s: ${message}`);
      resolve({ ...task, code: 1, signal: undefined, durationMs });
      return;
    }
    children.add(child);

    child.stdout.on("data", (chunk) => writePrefixed(process.stdout, prefix, chunk));
    child.stderr.on("data", (chunk) => writePrefixed(process.stderr, prefix, chunk));

    child.on("error", (error) => {
      children.delete(child);
      const durationMs = Date.now() - taskStartedAt;
      console.error(`${prefix}failed to start after ${seconds(durationMs)}s: ${error.message}`);
      resolve({ ...task, code: 1, signal: undefined, durationMs });
    });

    child.on("close", (code, signal) => {
      children.delete(child);
      const durationMs = Date.now() - taskStartedAt;
      const status = signal ? `signal ${signal}` : `exit ${code}`;
      console.log(`${prefix}completed with ${status} in ${seconds(durationMs)}s`);
      resolve({ ...task, code: code ?? 1, signal, durationMs });
    });
  });
}

function stopChildren(signal) {
  for (const child of children) {
    try {
      child.kill(signal);
    } catch {
      // Ignore cleanup failures; the process is already exiting.
    }
  }
}

process.on("SIGINT", () => {
  stopChildren("SIGINT");
  process.exit(130);
});

process.on("SIGTERM", () => {
  stopChildren("SIGTERM");
  process.exit(143);
});

const results = await Promise.all(groups.map(runTask));
const failed = results.filter((result) => result.code !== 0 || result.signal);

if (failed.length > 0) {
  console.error("\nParallel test groups failed:");
  for (const result of failed) {
    const status = result.signal ? `signal ${result.signal}` : `exit ${result.code}`;
    console.error(`- ${result.name}: ${status} in ${seconds(result.durationMs)}s`);
  }
  process.exit(1);
}

const cssResult = await runTask({
  name: "css-vars",
  command: process.execPath,
  args: ["test/css-vars.mjs"],
});

if (cssResult.code !== 0 || cssResult.signal) {
  process.exit(cssResult.code || 1);
}

console.log(`\nAll parallel tests passed in ${seconds(Date.now() - startedAt)}s`);
