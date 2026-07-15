/**
 * CSS 变量扫描
 *
 * 检查 `.theme-light` 块是否覆盖了全部 `:root` 中定义的 `--var`，
 * 防止新增 UI 元素只在暗色主题下有变量定义。
 *
 * 运行：node test/css-vars.mjs
 */
import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const CSS_PATH = resolve(ROOT, "src", "frontend", "dashboard.css");

if (!existsSync(CSS_PATH)) {
  console.error(`❌ CSS 文件不存在: ${CSS_PATH}`);
  process.exit(1);
}

const css = readFileSync(CSS_PATH, "utf-8");

/**
 * 从 CSS 选择器块中提取所有 --var 名称
 */
function extractVars(css, selector) {
  // 查找 selector { ... }
  const regex = new RegExp(selector + "\\s*\\{([^}]+)\\}", "i");
  // 在末尾追加 } 让内部 regex 也能匹配最后一个属性
  const match = css.match(regex);
  if (!match) return new Map();

  const vars = new Map();
  const propRegex = /(--[\w-]+)\s*:\s*([^;}]+)(?:;|}|$)/g;
  let m;
  while ((m = propRegex.exec(match[1])) !== null) {
    vars.set(m[1], m[2].trim());
  }
  return vars;
}

const rootVars = extractVars(css, ":root");
const lightVars = extractVars(css, "\\.theme-light");

// 检查缺失
const missing = [];
const intentional = new Set([
  "--fd",  // font-family, 不依赖主题
  "--fb",  // font-family, 不依赖主题
  "--fm",  // font-family, 不依赖主题
  "--am",  // 品牌色（amber），双主题一致
  "--in",  // 品牌色（indigo），双主题一致
  "--em",  // 品牌色（emerald），双主题一致
  "--rs",  // 品牌色（rose），双主题一致
]);

for (const [name, val] of rootVars) {
  if (!lightVars.has(name)) {
    if (!intentional.has(name)) {
      missing.push(name);
    }
  }
}

// 检查值是否相同（如果 light 中用了和 dark 一样的值，可能也是遗漏）
const sameValue = [];
for (const [name, val] of rootVars) {
  if (lightVars.has(name) && lightVars.get(name) === val && !intentional.has(name)) {
    sameValue.push(name);
  }
}

// 输出
let exitCode = 0;

console.log(`\n🔍 CSS 变量扫描: ${CSS_PATH}\n`);
console.log(`  :root 定义变量: ${rootVars.size}`);
console.log(`  .theme-light 定义变量: ${lightVars.size}`);

if (missing.length > 0) {
  console.log(`\n  ❌ .theme-light 缺失以下变量（light 模式下会未定义）:`);
  for (const name of missing) {
    console.log(`     ${name} = ${rootVars.get(name)}`);
  }
  exitCode = 1;
} else {
  console.log(`\n  ✅ 所有 :root 变量在 .theme-light 中都有覆盖`);
}

if (sameValue.length > 0) {
  console.log(`\n  ⚠️  以下变量在 light 模式中与 dark 值相同，可能是遗漏:`);
  for (const name of sameValue) {
    console.log(`     ${name} = ${rootVars.get(name)}`);
  }
}

// 列出全部变量对比
console.log(`\n${"─".repeat(50)}`);
console.log("  完整对照表:");
console.log(`${"─".repeat(50)}`);
console.log(`  ${"变量名".padEnd(22)} ${":root".padEnd(22)} .theme-light`);
console.log(`${"─".repeat(50)}`);

for (const [name, val] of rootVars) {
  const lightVal = lightVars.get(name) || "—";
  const flag = !lightVars.has(name) ? " ⚠️" : (lightVal === val ? " =" : " ✓");
  console.log(`  ${name.padEnd(22)} ${val.padEnd(22)} ${lightVal.padEnd(22)}${flag}`);
}

console.log(`${"─".repeat(50)}\n`);
process.exit(exitCode);
