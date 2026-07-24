/**
 * 编译 preload.ts → CJS（Electron 需要 CommonJS 格式）
 * 被 dev.mjs / build-frontend.mjs / package.json 共享
 */
import * as esbuild from "esbuild";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

export function compilePreload() {
  esbuild.buildSync({
    entryPoints: [resolve(ROOT, "src", "electron", "preload.ts")],
    bundle: true,
    format: "cjs",
    platform: "node",
    outfile: resolve(ROOT, "dist-electron", "electron", "preload.js"),
    external: ["electron"],
  });
}

// 直接运行时
if (process.argv[1] && process.argv[1].includes("compile-preload")) {
  compilePreload();
  console.log("✅ preload.js compiled");
}
