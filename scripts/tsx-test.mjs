import { fileURLToPath } from "node:url";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";

// The managed Windows sandbox reports ENOMEM from os.userInfo(), which tsx
// only uses to derive a per-user temporary directory name. NODE_OPTIONS keeps
// the shim active in the child process spawned by the tsx CLI.
if (process.platform === "win32") {
  const testTemp = resolve(process.cwd(), "node_modules", ".cache", "my-code-agent-tests");
  mkdirSync(testTemp, { recursive: true });
  process.env.TEMP = testTemp;
  process.env.TMP = testTemp;
  process.env.TMPDIR = testTemp;
  const preload = fileURLToPath(new URL("./tsx-windows-sandbox.cjs", import.meta.url));
  const requireOption = `--require=${preload}`;
  process.env.NODE_OPTIONS = [process.env.NODE_OPTIONS, requireOption].filter(Boolean).join(" ");
  await import("./tsx-windows-sandbox.cjs");
}

await import("tsx/cli");
