/**
 * Build 冒烟测试 — 验证构建产物 + 脚本加载链完整性
 *
 * 检查项：
 *   1. dist/frontend/ 构建产物完整
 *   2. 脚本加载链：HTML script 标签 → .js 文件存在 → 语法正确
 *
 * 运行：
 *   npm run test:build
 */
import { existsSync, statSync, readFileSync, readdirSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const DIST = resolve(ROOT, "dist", "frontend");
const SRC = resolve(ROOT, "src", "frontend");

let passed = 0;
let failed = 0;

function check(condition, msg) {
  if (condition) { console.log(`  ✅ ${msg}`); passed++; }
  else { console.log(`  ❌ ${msg}`); failed++; }
}

console.log("\n📦 Build Smoke Test\n");

// ════════════════════════════════════════════════════════════════
//  生产构建检查
// ════════════════════════════════════════════════════════════════

if (!existsSync(DIST)) {
  console.error("\n❌ 构建产物不存在: dist/frontend/");
  console.error("   请先运行 npm run build:vite\n");
  process.exit(1);
}

// 0. marked.umd.js（构建脚本负责复制，这里只读检查）
console.log("📎 生产附件检查");
check(existsSync(resolve(DIST, "marked.umd.js")), "marked.umd.js 在 dist/frontend/ 中");

// 1. dashboard.html
console.log("\n📄 生产 HTML 检查");
const htmlDistPath = resolve(DIST, "dashboard.html");
check(existsSync(htmlDistPath), "dashboard.html 存在");
if (existsSync(htmlDistPath)) {
  const html = readFileSync(htmlDistPath, "utf-8");
  check(html.includes("dashboard"), "HTML 包含 dashboard 相关内容");
  check(html.includes("</html>"), "HTML 标签闭合完整");
  check(html.includes("marked.umd.js"), "marked.umd.js 引用存在");
}

// 2. JS 产物
console.log("\n📜 JS 产物检查");
const assetsDir = resolve(DIST, "assets");
if (existsSync(assetsDir)) {
  const jsFiles = readdirSync(assetsDir).filter(n => n.endsWith(".js") && !n.includes("worker"));
  check(jsFiles.length > 0, `assets/ 下存在应用 JS (${jsFiles.length} 个)`);
  for (const f of jsFiles) {
    const p = resolve(assetsDir, f);
    const sizeKB = (statSync(p).size / 1024).toFixed(0);
    if (parseInt(sizeKB) > 100) console.log(`     → ${f}: ${sizeKB} KB`);
  }
} else {
  check(false, "assets/ 目录存在");
}
const workerFiles = readdirSyncSafe(assetsDir).filter(n => n.includes("worker"));
check(workerFiles.length >= 3, `Monaco Worker 文件存在 (${workerFiles.length} 个)`);

// 3. CSS 产物
console.log("\n🎨 CSS 产物检查");
const cssFiles = readdirSyncSafe(assetsDir).filter(n => n.endsWith(".css"));
check(cssFiles.length > 0, `CSS 产物存在 (${cssFiles.length} 个)`);

// 4. 前端源文件完整性
console.log("\n📁 前端源文件检查");
const requiredSrc = [
  "dashboard.html", "dashboard.css",
  "dashboard/dashboard-helpers.ts", "dashboard/dashboard-layout.ts", "dashboard/layout-tabs.ts", "dashboard/layout-panel.ts", "dashboard/layout-shortcuts.ts", "dashboard/dashboard-chat.ts",
  "dashboard/dashboard-sessions.ts", "dashboard/dashboard-settings.ts", "dashboard/dashboard-menus.ts",
  "chat/chat-render.ts", "chat/chat-mode.ts", "chat/chat-token.ts", "chat/chat-attachments.ts",
  "ui/tree.ts", "ui/tree-render.ts", "ui/tree-events.ts", "service/explorer-service.ts",
  "editor/monaco-setup.ts", "editor/monaco-tsserver.ts", "editor/monaco-theme.ts", "marked.umd.js",
];
for (const f of requiredSrc) {
  check(existsSync(resolve(SRC, f)), `src/frontend/${f}`);
}

// 5. Pane 文件
console.log("\n🧩 Pane 文件检查");
for (const dir of ["explorer", "chat", "search", "git"]) {
  check(existsSync(resolve(SRC, "pane", dir, "index.ts")), `pane/${dir}/index.ts`);
}

// 6. 后端路由文件
console.log("\n🛣️  后端路由文件检查");
for (const f of ["index.ts","types.ts","chat.ts","dashboard.ts","sessions.ts","explorer.ts","settings.ts","search.ts","search-core.ts","git.ts","git-core.ts","typescript.ts", "attach.ts", "parse-body.ts"]) {
  check(existsSync(resolve(ROOT, "src", "server", "routes", f)), `routes/${f}`);
}
// session-workspace.ts 在 server/ 根目录
check(existsSync(resolve(ROOT, "src", "server", "session-workspace.ts")), "server/session-workspace.ts");

// ════════════════════════════════════════════════════════════════
//  脚本加载链检查（开发模式）
//  读取 src/frontend/dashboard.html，验证所有非 module script：
//    1. 每个引用的 .js 文件存在于 src/frontend/
//    2. 按顺序拼接后语法正确（无 const 重复声明等）
// ════════════════════════════════════════════════════════════════

console.log("\n🔗 脚本加载链检查（开发模式）");
const srcHtml = readFileSync(resolve(SRC, "dashboard.html"), "utf-8");
const scriptTags = extractScripts(srcHtml);
check(scriptTags.length > 0, `HTML 包含 ${scriptTags.length} 个 script 标签`);

// 提取所有非 module 脚本的 src
const nonModuleScripts = scriptTags.filter(t => !t.isModule);
console.log(`  非 module script: ${nonModuleScripts.length} 个`);

// 验证每个文件存在 + 读取内容
const jsContents = [];
let allExist = true;
for (const s of nonModuleScripts) {
  const jsPath = resolve(SRC, s.src);
  const exists = existsSync(jsPath);
  if (!exists) console.log(`  ❌ 文件缺失: ${s.src}（未找到 ${jsPath}）`);
  allExist = allExist && exists;
  if (exists) {
    try {
      jsContents.push(readFileSync(jsPath, "utf-8"));
    } catch (e) {
      console.log(`  ❌ 读取失败: ${s.src}: ${e.message}`);
      allExist = false;
    }
  }
}
check(allExist, "所有引用的 .js 文件存在");

// 拼接并检查语法
if (jsContents.length > 0) {
  const combined = jsContents.join("\n");
  try {
    // new Function() 只编译不执行，能捕获 SyntaxError
    // 不会触发 ReferenceError（代码中的 window/document 引用不执行）
    new Function(combined);
    check(true, `拼接 ${jsContents.length} 个文件，语法检查通过`);
  } catch (e) {
    if (e instanceof SyntaxError) {
      check(false, `拼接 JS 语法错误: ${e.message}`);
    } else {
      // 非语法错误（如 ReferenceError）不影响检查通过
      check(true, `拼接 ${jsContents.length} 个文件，语法检查通过（警告: ${e.message}）`);
    }
  }

  // 额外提醒：输出拼接总大小
  console.log(`  📊 拼接 JS 总大小: ${(combined.length / 1024).toFixed(0)} KB`);
}

// ════════════════════════════════════════════════════════════════
//  前端 API 契约检查
//  验证 App.Chat.xxx 的注册方和消费方匹配（防跨模块引用断裂）
// ════════════════════════════════════════════════════════════════

console.log("\n📋 前端 API 契约检查");

const providers = new Map();
const consumers = new Map();
const apiFiles = ["chat/chat-render.ts", "chat/chat-mode.ts", "chat/chat-token.ts", "chat/chat-attachments.ts", "dashboard/dashboard-chat.ts"];

for (const f of apiFiles) {
  const src = readFileSafe(resolve(SRC, f));
  if (!src) continue;

  // 注册方: AppChat.NAME = / App.Chat.NAME =
  const provRe = /App(?:Chat|\.Chat)\.(\w+)\s*=/g;
  let m;
  while ((m = provRe.exec(src)) !== null) {
    if (!providers.has(m[1])) providers.set(m[1], []);
    providers.get(m[1]).push(f);
  }

  // 消费方: App.Chat?.NAME
  const consRe = /App\.Chat\?\.(\w+)/g;
  while ((m = consRe.exec(src)) !== null) {
    if (!consumers.has(m[1])) consumers.set(m[1], []);
    consumers.get(m[1]).push(f);
  }
}

let contractOk = true;
for (const [name, consFiles] of consumers) {
  if (!providers.has(name)) {
    console.log(`  ❌ App.Chat?.${name} 在 ${consFiles.join(", ")} 中被消费，但无文件注册`);
    contractOk = false;
  }
}
for (const [name, provFiles] of providers) {
  if (!consumers.has(name)) {
    console.log(`  ℹ️  App.Chat.${name} 在 ${provFiles.join(", ")} 中注册，未被消费`);
  }
}
check(contractOk, `App.Chat API 契约一致（${providers.size} 注册, ${consumers.size} 消费）`);

// 汇总
console.log(`\n${"=".repeat(40)}`);
console.log(`结果: ${passed} 通过, ${failed} 失败`);
console.log(`${"=".repeat(40)}\n`);

// 输出构建产物大小摘要
console.log("📊 构建产物大小摘要:");
if (existsSync(assetsDir)) {
  const allFiles = readdirSync(assetsDir).filter(f => f.endsWith(".js") || f.endsWith(".css") || f.endsWith(".ttf"));
  for (const f of allFiles) {
    const kb = (statSync(resolve(assetsDir, f)).size / 1024).toFixed(0);
    console.log(`  ${f.padEnd(50)} ${kb.padStart(6)} KB`);
  }
}

process.exit(failed > 0 ? 1 : 0);

// ════════════════════════════════════════════════════════════════
//  Helpers
// ════════════════════════════════════════════════════════════════

function readdirSyncSafe(dir) {
  try { return readdirSync(dir); } catch { return []; }
}

/** 安全读取文件，失败返回 null */
function readFileSafe(p) {
  try { return readFileSync(p, "utf-8"); } catch { return null; }
}

/** 从 HTML 中提取所有 <script> 标签信息 */
function extractScripts(html) {
  const results = [];
  const re = /<script\s+([^>]*)>\s*<\/script>/gi;
  let match;
  while ((match = re.exec(html)) !== null) {
    const attrs = match[1];
    const srcMatch = attrs.match(/src=["']([^"']+)["']/);
    const isModule = /\btype\s*=\s*["']module["']/.test(attrs);
    if (srcMatch) {
      results.push({ src: srcMatch[1], isModule });
    }
  }
  return results;
}
