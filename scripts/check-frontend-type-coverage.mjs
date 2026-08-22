import { readFileSync, readdirSync } from "node:fs";
import { resolve, relative } from "node:path";
import ts from "typescript";

const ROOT = resolve(import.meta.dirname, "..");
const FRONTEND = resolve(ROOT, "src/frontend");
const CONFIG = resolve(FRONTEND, "tsconfig.frontend.json");

function sourceFiles(dir) {
  const result = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "gen" || entry.name === "node_modules") continue;
    const full = resolve(dir, entry.name);
    if (entry.isDirectory()) result.push(...sourceFiles(full));
    else if (entry.isFile() && entry.name.endsWith(".ts")) result.push(full);
  }
  return result;
}

const config = ts.readConfigFile(CONFIG, (file) => readFileSync(file, "utf8"));
if (config.error) throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, "\n"));
const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, FRONTEND);
const included = new Set(parsed.fileNames.map((file) => resolve(file)));
const sources = sourceFiles(FRONTEND);
const missing = sources.filter((file) => !included.has(resolve(file)));
const declaration = resolve(FRONTEND, "dashboard.d.ts");
if (!included.has(declaration)) missing.push(declaration);

if (missing.length > 0) {
  throw new Error(`[frontend-type-coverage] files outside typecheck: ${missing.map((file) => relative(ROOT, file)).join(", ")}`);
}
if (parsed.options.noCheck !== true || parsed.options.noUnusedLocals !== false || parsed.options.noUnusedParameters !== false) {
  throw new Error("[frontend-type-coverage] legacy global-script syntax-only exception must be explicit in tsconfig");
}

console.log(`[frontend-type-coverage] ${sources.length} source files + dashboard.d.ts covered; legacy global scripts syntax-only, strict modules use tsconfig.frontend.strict.json`);
