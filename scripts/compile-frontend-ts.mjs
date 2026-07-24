/**
 * 开发模式编译 .ts → .js（递归遍历子目录）
 *
 * 规则：
 *   - 在 HTML 中以 <script type="module"> 加载的文件 → 保留 export（ESM 需要）
 *   - 这些文件 import 的依赖 → 也保留 export
 *   - 以 <script>（非 module）加载的文件 → 移除 export（全局 script 不需要）
 */
import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync } from "fs";
import { resolve, dirname, relative, join, sep } from "path";
import { fileURLToPath } from "url";
import * as esbuild from "esbuild";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const SRC = resolve(ROOT, "src", "frontend");
const HTML_PATH = resolve(SRC, "dashboard.html");

// 从 HTML 提取 <script type="module" src="..."> 中的 src 路径
const moduleEntryPoints = new Set();
if (existsSync(HTML_PATH)) {
  const html = readFileSync(HTML_PATH, "utf-8");
  const re = /<script\s+type\s*=\s*["']module["'][^>]*\s+src\s*=\s*["']([^"']+)["']/gi;
  let m;
  while ((m = re.exec(html)) !== null) moduleEntryPoints.add(m[1]);
}
// 动态 import() 加载的模块也需要保留 export（如 Monaco）
moduleEntryPoints.add("gen/editor/monaco-setup.js");
moduleEntryPoints.add("gen/editor/monaco-theme.js");

// 依赖追踪：从 module entry 出发，找出所有被 import 的文件
// 这些文件都应保留 export
function findModuleDeps(entryRelJsPath, allSources) {
  const deps = new Set();
  function walk(relJsPath) {
    const key = relJsPath.replace(/\\/g, "/").replace(/^\.\//, "");
    if (deps.has(key)) return;
    deps.add(key);
    // 找到对应的 .ts 源文件
    const srcKey = key.replace(/\.js$/, ".ts");
    const src = allSources[srcKey];
    if (!src) return;
    // 解析 import 语句（只处理相对路径 import）
    const importRe = /from\s+["'](\.[^"']+)["']/g;
    let m;
    while ((m = importRe.exec(src)) !== null) {
      // 相对路径是相对于当前文件所在目录
      const dir = srcKey.replace(/\/[^/]*$/, "");
      const resolved = join(dir, m[1]).replace(/\\/g, "/") + ".js";
      walk(resolved);
    }
  }
  walk(entryRelJsPath);
  return deps;
}

// 读取所有 .ts 源文件到内存
const allSources = {};
const allFiles = [];
function findTs(dir) {
  const entries = readdirSync(dir, { withFileTypes: true });
  for (const e of entries) {
    const full = resolve(dir, e.name);
    if (e.isDirectory()) findTs(full);
    else if (e.name.endsWith(".ts") && !e.name.endsWith(".d.ts")) {
      const rel = relative(SRC, full).replace(/\\/g, "/");
      allFiles.push(full);
      allSources[rel] = readFileSync(full, "utf-8");
    }
  }
}
findTs(SRC);

// 计算所有需要保留 export 的文件（module entry + 它们的依赖）
const preserveExport = new Set();
for (const entryPath of moduleEntryPoints) {
  // HTML 中路径可能带 gen/ 前缀（输出目录），去掉它才能匹配源文件
  const cleanPath = entryPath.replace(/^\.\//, "").replace(/^gen\//, "");
  const deps = findModuleDeps(cleanPath, allSources);
  for (const d of deps) preserveExport.add(d);
}

// 1. 逐文件编译（保留向后兼容）
for (const fullPath of allFiles) {
  const rel = relative(SRC, fullPath).replace(/\\/g, "/");
  const relJs = rel.replace(/\.ts$/, ".js");
  const src = allSources[rel];
  const result = await esbuild.transform(src, { loader: "ts", minify: false });

  const isModule = preserveExport.has(relJs);
  const code = isModule
    ? result.code  // 模块文件：保留 export
    : result.code.replace(/^export\s+/gm, '');  // 普通 script：移除 export

  const outDir = resolve(SRC, "gen", rel.replace(/\/[^/]*$/, ""));
  mkdirSync(outDir, { recursive: true });
  const outPath = resolve(SRC, "gen", rel.replace(".ts", ".js"));
  const previous = existsSync(outPath) ? readFileSync(outPath, "utf-8") : null;
  if (previous !== code) {
    writeFileSync(outPath, code, "utf-8");
    console.log(`  ${rel} → gen/${rel.replace(".ts", ".js")}${isModule ? ' (module)' : ''}`);
  }
}

// 2. 额外生成单文件 bundle（替代 25 个独立 script 标签）
//    IIFE 会隔离顶层声明导致全局不可访问，改为按顺序拼接已编译的 gen 文件
const bundleOut = resolve(SRC, "gen", "dashboard.js");
const bundlePrev = existsSync(bundleOut) ? readFileSync(bundleOut, "utf-8") : null;

// 与 dashboard.html 原 script 顺序一致（已移除 problems/index 和 pane/problems）
const bundleOrder = [
  "gen/dashboard/dashboard-helpers.js",
  "gen/service/explorer-service.js",
  "gen/chat/chat-render.js",
  "gen/chat/chat-mode.js",
  "gen/chat/chat-token.js",
  "gen/chat/chat-attachments.js",
  "gen/services/ui-state-store.js",
  "gen/services/tab-store.js",
  "gen/services/problems-store.js",
  "gen/dashboard/dashboard-chat.js",
  "gen/dashboard/dashboard-layout.js",
  "gen/dashboard/layout-tabs.js",
  "gen/dashboard/layout-panel.js",
  "gen/dashboard/layout-shortcuts.js",
  "gen/ui/tree.js",
  "gen/ui/tree-render.js",
  "gen/ui/tree-events.js",
  "gen/dashboard/dashboard-sessions.js",
  "gen/pane/explorer/index.js",
  "gen/pane/chat/index.js",
  "gen/pane/search/index.js",
  "gen/pane/git/index.js",
  "gen/pane/mcp/index.js",
  "gen/dashboard/dashboard-menus.js",
  "gen/dashboard/dashboard-settings.js",
].filter(f => existsSync(resolve(SRC, f)));

if (bundleOrder.length > 0) {
  const parts = bundleOrder.map(f => {
    const fullPath = resolve(SRC, f);
    return readFileSync(fullPath, "utf-8");
  });
  const code = parts.join("\n");
  if (code !== bundlePrev) {
    writeFileSync(bundleOut, code, "utf-8");
    console.log(`  [bundle] gen/dashboard.js (${bundleOrder.length} files, ${(code.length / 1024).toFixed(0)} KB)`);
  }
}
