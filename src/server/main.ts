#!/usr/bin/env node
/**
 * My Code Agent — CLI 入口
 *
 * 桌面端为主入口（npm start / npm run dev），本文件为 CLI 辅助模式。
 *
 * Usage:
 *   tsx src/main.ts              → 启动 CLI 模式
 *   tsx src/main.ts --cli        ↑ 同上
 *   node scripts/dev.mjs         → 启动桌面（Electron + Vite HMR）
 */
import { initEngine } from "../agent/index.js";
import { createInterface } from "readline";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { shellDialectFromEnv } from "../agent/tools/command/shell-parser.js";
import { resolveCliRuntimePaths } from "./cli-startup.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const APP_ROOT = resolve(__dirname, "..", "..");
const CLI_PATHS = resolveCliRuntimePaths({
  appRoot: APP_ROOT,
  argv: process.argv.slice(2),
  env: process.env,
});

async function main() {
  console.log("My Code Agent — CLI 模式");
  console.log("配置文件:", CLI_PATHS.agentDir);
  console.log();

  const engine = await initEngine({
    agentDir: CLI_PATHS.agentDir,
    cwd: CLI_PATHS.cwd,
    sessionsDir: CLI_PATHS.sessionsDir,
    sessionsDirForWorkspace: CLI_PATHS.sessionsDirForWorkspace,
    authFile: CLI_PATHS.authFile,
    modelsFile: CLI_PATHS.modelsFile,
    shellDialect: shellDialectFromEnv(),
  });

  console.log(`使用模型: ${engine.session.model?.provider ?? "?"} / ${engine.session.model?.id ?? "?"}`);
  console.log("输入消息（Ctrl+C 退出）");
  console.log();

  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: "> ",
  });

  rl.prompt();

  let promptInFlight = false;
  const unsubscribe = engine.subscribe((event) => {
    if (event.type === "turn.completed" || event.type === "turn.failed" || event.type === "turn.cancelled") {
      promptInFlight = false;
      rl.prompt();
    }
  });

  rl.on("line", (line) => {
    const text = line.trim();
    if (!text) { rl.prompt(); return; }
    if (promptInFlight) return;
    promptInFlight = true;
    void engine.prompt({ message: text }).catch((error) => {
      promptInFlight = false;
      console.error("Prompt failed:", error instanceof Error ? error.message : String(error));
      rl.prompt();
    });
  });

  rl.on("close", () => {
    unsubscribe();
    void engine.dispose();
    console.log("\n再见！");
  });
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
