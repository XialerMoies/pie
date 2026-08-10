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
import { initAgent } from "../agent/index.js";
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

  const { session } = await initAgent({
    agentDir: CLI_PATHS.agentDir,
    cwd: CLI_PATHS.cwd,
    sessionsDir: CLI_PATHS.sessionsDir,
    sessionsDirForWorkspace: CLI_PATHS.sessionsDirForWorkspace,
    authFile: CLI_PATHS.authFile,
    modelsFile: CLI_PATHS.modelsFile,
    shellDialect: shellDialectFromEnv(),
  });

  console.log(`使用模型: ${session.model?.provider ?? "?"} / ${session.model?.id ?? "?"}`);
  console.log("输入消息（Ctrl+C 退出）");
  console.log();

  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: "> ",
  });

  rl.prompt();

  rl.on("line", (line) => {
    const text = line.trim();
    if (!text) { rl.prompt(); return; }

    // agent_end 后恢复 prompt。PI SDK AgentSession 类型未导出 once，通过 subscribe + 立即退订实现
    const unsub = session.subscribe((event: any) => {
      if (event.type === "agent_end") {
        unsub();
        rl.prompt();
      }
    });

    session.prompt(text);
  });

  rl.on("close", () => {
    console.log("\n再见！");
    process.exit(0);
  });
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
