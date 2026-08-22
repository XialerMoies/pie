/**
 * 前端构建脚本
 * 1. Vite build（产生 HTML + CSS + Monaco bundle + Workers，非 module script 已 strip）
 * 2. 复制 marked.umd.js
 * 3. esbuild 打包全部前端 .ts 为 IIFE bundle → dist/frontend/js/dashboard.js
 * 4. 更新 HTML：注入 marked.umd.js + dashboard.js
 */
import { execFileSync, execSync } from "child_process";
import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync, cpSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const SRC = resolve(ROOT, "src", "frontend");
const OUT = resolve(ROOT, "dist", "frontend");

// 1. Vite build
console.log("→ Vite build…");
console.log("-> Compile frontend TS...");
execSync("node scripts/compile-frontend-ts.mjs", { cwd: ROOT, stdio: "inherit" });
// Run the workspace-local Vite entry directly. Using npx adds an npm wrapper
// to the monitored process tree and inflates the build RSS gate unnecessarily.
// Dashboard and each worker are separate graphs. Monaco's main module is
// bundled with esbuild below; keeping it out of Rollup avoids a second large
// module graph and materially lowers the native RSS peak.
const viteBin = resolve(ROOT, "node_modules", "vite", "bin", "vite.js");
function runVite(target) {
  execFileSync(process.execPath, [viteBin, "build"], {
    cwd: ROOT,
    stdio: "inherit",
    env: { ...process.env, MY_CODE_AGENT_VITE_TARGET: target },
  });
}
runVite("dashboard");
for (const worker of ["editor", "typescript", "json", "css", "html"]) {
  runVite(`worker:${worker}`);
}
const esbuildBin = resolve(ROOT, "node_modules", "esbuild", "bin", "esbuild");
execFileSync(process.execPath, [
  esbuildBin,
  resolve(SRC, "editor", "monaco-setup.ts"),
  "--bundle",
  "--format=esm",
  "--platform=browser",
  `--outfile=${resolve(OUT, "js", "monaco-entry.js")}`,
  "--loader:.ts=ts",
  "--loader:.css=css",
  "--loader:.ttf=file",
  "--asset-names=assets/[name]-[hash]",
  "--minify",
], { cwd: ROOT, stdio: "inherit" });

// Explorer icons are referenced by stable /icons/*.svg URLs and therefore
// are not discovered by Vite's import graph.
cpSync(resolve(SRC, "icons"), resolve(OUT, "icons"), { recursive: true });

// 1.5 编译 preload.ts（Electron 需要 CommonJS 格式）
const { compilePreload } = await import("./compile-preload.mjs");
compilePreload();
console.log("-> preload.js compiled");

// 1.6 复制 marked.umd.js（常规 script 引用，Vite 不会自动处理）
const markedSrc = resolve(SRC, "marked.umd.js");
const markedDst = resolve(OUT, "marked.umd.js");
if (existsSync(markedSrc) && !existsSync(markedDst)) {
  copyFileSync(markedSrc, markedDst);
  console.log("→ 已复制 marked.umd.js");
}

// 2. 收集前端 TS 文件（排除 monaco-setup，它单独作为模块加载）
console.log("→ Bundle JS…");
// 用 esbuild 真 bundle（IIFE，不依赖全局变量顺序）
const generatedBundle = resolve(SRC, "gen", "dashboard.js");
const generatedStartup = resolve(SRC, "gen", "dashboard", "dashboard-startup.js");
if (!existsSync(generatedBundle) || !existsSync(generatedStartup)) {
  throw new Error("Frontend compiler did not emit the dashboard bundle and startup entry");
}
let bundleJs = `${readFileSync(generatedBundle, "utf-8")}\n${readFileSync(generatedStartup, "utf-8")}`;
bundleJs = bundleJs.replace(
  /import\(["']\.\.\/editor\/monaco-setup["']\)/g,
  'import("./monaco-entry.js")',
);
console.log(`  Bundle: ${(bundleJs.length / 1024).toFixed(0)} KB (ordered global scripts + startup)`);

mkdirSync(resolve(OUT, "js"), { recursive: true });
writeFileSync(resolve(OUT, "js", "dashboard.js"), bundleJs, "utf-8");

// 3. 更新 HTML — 注入非模块 script 标签（已被 Vite 构建时 stripped）
console.log("→ 更新 HTML…");
const htmlPath = resolve(OUT, "dashboard.html");
let html = readFileSync(htmlPath, "utf-8");

// 在 </body> 前插入 marked.umd.js + dashboard.js
html = html.replace(
  /<\/body>/,
  '<link rel="stylesheet" href="./js/monaco-entry.css">\n<script src="./marked.umd.js"></script>\n<script src="./js/dashboard.js"></script>\n</body>'
);

writeFileSync(htmlPath, html, "utf-8");
console.log("✓ 构建完成");
