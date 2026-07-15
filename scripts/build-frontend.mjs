/**
 * 前端构建脚本
 * 1. Vite build（产生 HTML + CSS + Monaco bundle + Workers，非 module script 已 strip）
 * 2. 复制 marked.umd.js
 * 3. esbuild 打包全部前端 .ts 为 IIFE bundle → dist/frontend/js/dashboard.js
 * 4. 更新 HTML：注入 marked.umd.js + dashboard.js
 */
import { execSync } from "child_process";
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync, copyFileSync } from "fs";
import { resolve, dirname, relative } from "path";
import { fileURLToPath } from "url";
import * as esbuild from "esbuild";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const SRC = resolve(ROOT, "src", "frontend");
const OUT = resolve(ROOT, "dist", "frontend");

// 1. Vite build
console.log("→ Vite build…");
execSync("npx vite build", { cwd: ROOT, stdio: "inherit" });

// 1.5 复制 marked.umd.js（常规 script 引用，Vite 不会自动处理）
const markedSrc = resolve(SRC, "marked.umd.js");
const markedDst = resolve(OUT, "marked.umd.js");
if (existsSync(markedSrc) && !existsSync(markedDst)) {
  copyFileSync(markedSrc, markedDst);
  console.log("→ 已复制 marked.umd.js");
}

// 2. 收集前端 TS 文件（排除 monaco-setup，它单独作为模块加载）
console.log("→ Bundle JS…");
function findTs(dir) {
  const entries = readdirSync(dir, { withFileTypes: true });
  let files = [];
  for (const e of entries) {
    const full = resolve(dir, e.name);
    if (e.isDirectory()) files = files.concat(findTs(full));
    else if (e.name.endsWith(".ts") && !e.name.endsWith(".d.ts")) files.push(full);
  }
  return files;
}
const tsFiles = findTs(SRC).sort();
const bundleFiles = tsFiles.filter(f => !f.includes("monaco-setup") && !f.includes("marked.umd"));

// 用 esbuild 真 bundle（IIFE，不依赖全局变量顺序）
const entry = bundleFiles.map(f => `import "${f.replace(/\\/g, "/")}";`).join("\n");
const result = await esbuild.build({
  stdin: { contents: entry, resolveDir: SRC, sourcefile: "entry.ts" },
  bundle: true,
  minify: true,
  format: "iife",
  write: false,
  logLevel: "warning",
  external: ["monaco-editor"],
});
const bundleJs = result.outputFiles[0].text;
console.log(`  Bundle: ${(bundleJs.length / 1024).toFixed(0)} KB (${bundleFiles.length} files)`);

mkdirSync(resolve(OUT, "js"), { recursive: true });
writeFileSync(resolve(OUT, "js", "dashboard.js"), bundleJs, "utf-8");

// 3. 更新 HTML — 注入非模块 script 标签（已被 Vite 构建时 stripped）
console.log("→ 更新 HTML…");
const htmlPath = resolve(OUT, "dashboard.html");
let html = readFileSync(htmlPath, "utf-8");

// 在 </body> 前插入 marked.umd.js + dashboard.js
html = html.replace(
  /<\/body>/,
  '<script src="./marked.umd.js"></script>\n<script src="./js/dashboard.js"></script>\n</body>'
);

writeFileSync(htmlPath, html, "utf-8");
console.log("✓ 构建完成");
