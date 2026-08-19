#!/usr/bin/env node
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { toolRegistry } from "../src/agent/tools/index.ts";
import { ENGINE_EVENT_TYPES } from "../src/agent-engine/contracts.ts";
import { APP_EVENT_TYPES } from "../src/server/app-events.ts";
import { PERMISSION_MODES } from "../src/server/permission-mode.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUTPUT = resolve(ROOT, "docs/generated/capability-catalog.json");
const ROUTE_ROOT = resolve(ROOT, "src/server/routes");
const SCAN_ROOTS = [resolve(ROOT, "src"), resolve(ROOT, "scripts")];
const SPAWN_APIS = ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"];

const posix = (value) => value.replaceAll("\\", "/");
const repoPath = (value) => posix(relative(ROOT, value));
const compareText = (left, right) => left < right ? -1 : left > right ? 1 : 0;
const sortBy = (items, key) => [...items].sort((left, right) => compareText(key(left), key(right)));
const uniqueBy = (items, key) => [...new Map(items.map((item) => [key(item), item])).values()];

function stripCommentsPreservingLines(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (match) => match.replace(/[^\n]/g, " "))
    .replace(/\/\/.*$/gm, "");
}

async function walk(directory, extensions) {
  const entries = await readdir(directory, { withFileTypes: true });
  const output = [];
  for (const entry of entries.sort((left, right) => compareText(left.name, right.name))) {
    const fullPath = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      if (repoPath(fullPath) === "src/frontend/gen") continue;
      output.push(...await walk(fullPath, extensions));
    } else if (extensions.some((extension) => entry.name.endsWith(extension))) {
      output.push(fullPath);
    }
  }
  return output;
}

async function toolSources() {
  const source = await readFile(resolve(ROOT, "src/agent/tools/index.ts"), "utf8");
  const imports = new Map();
  for (const match of source.matchAll(/import\s+\{([^}]+)\}\s+from\s+["'](\.\/[^"']+)["']/g)) {
    const sourcePath = `src/agent/tools/${match[2].slice(2).replace(/\.js$/, ".ts")}`;
    for (const binding of match[1].split(",").map((item) => item.trim()).filter(Boolean)) {
      imports.set(binding.replace(/\s+as\s+.*/, ""), sourcePath);
    }
  }
  return [...source.matchAll(/toolRegistry\.register\((\w+)\)/g)]
    .map((match) => imports.get(match[1]) || "src/agent/tools/index.ts");
}

async function collectTools() {
  const sources = await toolSources();
  return sortBy(toolRegistry.getAll().map((tool, index) => ({
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
    capabilities: {
      readOnly: tool.isReadOnly,
      destructive: tool.isDestructive === true,
      riskLevel: tool.riskLevel || "medium",
      needsPermission: tool.needsPermission === true,
      workspaceBounded: tool.workspaceBounded !== false,
    },
    source: sources[index] || "src/agent/tools/index.ts",
  })), (tool) => tool.name);
}

function lineNumber(source, index) {
  return source.slice(0, index).split("\n").length;
}

function spawnCategory(file) {
  if (file === "src/agent/tools/command.ts") return "user-command";
  if (file.includes("/agent/mcp/")) return "mcp";
  if (file.includes("subagent")) return "subagent";
  if (file === "src/server/ts-server.ts") return "tsserver";
  if (file === "src/electron/server-binding.ts") return "internal-server";
  if (file.startsWith("src/electron/")) return "electron";
  if (file.startsWith("scripts/")) return "build-or-test";
  return "other";
}

function spawnOwner(category) {
  if (category === "user-command") return "agent-tools";
  if (category === "mcp") return "mcp-client";
  if (category === "subagent") return "subagent-host";
  if (category === "tsserver") return "server";
  if (category === "internal-server" || category === "electron") return "electron";
  if (category === "build-or-test") return "tooling";
  return "unassigned";
}

function childProcessBindings(source) {
  const bindings = new Map();
  const importPattern = /import\s*\{([^}]+)\}\s*from\s*["'](?:node:)?child_process["']/g;
  for (const match of source.matchAll(importPattern)) {
    for (const item of match[1].split(",")) {
      const binding = item.trim().match(/^(\w+)(?:\s+as\s+(\w+))?$/);
      if (!binding || !SPAWN_APIS.includes(binding[1])) continue;
      bindings.set(binding[2] || binding[1], binding[1]);
    }
  }
  return bindings;
}

async function collectSpawnPoints() {
  const files = (await Promise.all(SCAN_ROOTS.map((root) => walk(root, [".ts", ".js", ".mjs"])))).flat();
  const points = [];
  for (const filePath of files) {
    const file = repoPath(filePath);
    const source = stripCommentsPreservingLines(await readFile(filePath, "utf8"));
    const bindings = childProcessBindings(source);
    if (bindings.size > 0) {
      const callPattern = new RegExp(`(^|[^\\w$.])(${[...bindings.keys()].join("|")})\\s*\\(`, "gm");
      for (const match of source.matchAll(callPattern)) {
        const category = spawnCategory(file);
        const callIndex = match.index + match[1].length;
        points.push({ file, line: lineNumber(source, callIndex), api: bindings.get(match[2]), category, owner: spawnOwner(category) });
      }
    }
    if (file === "src/server/ts-server.ts") {
      for (const match of source.matchAll(/\bproc\.send\s*\(/g)) {
        points.push({ file, line: lineNumber(source, match.index), api: "child_process.send", category: "tsserver", owner: "server" });
      }
    }
  }
  return sortBy(uniqueBy(points, (point) => `${point.file}:${point.line}:${point.api}`), (point) => `${point.file}:${String(point.line).padStart(6, "0")}:${point.api}`);
}

function methodsOnLine(line) {
  const methods = [...line.matchAll(/method\s*===\s*["'](GET|HEAD|POST|PUT|PATCH|DELETE|OPTIONS)["']/g)].map((match) => match[1]);
  const allow = line.match(/allow:\s*\[([^\]]+)\]/);
  if (allow) methods.push(...[...allow[1].matchAll(/["'](GET|HEAD|POST|PUT|PATCH|DELETE|OPTIONS)["']/g)].map((match) => match[1]));
  return methods.length > 0 ? [...new Set(methods)].sort() : ["ANY"];
}

function routeCategory(value) {
  if (value === "/layout-config.json") return "layout";
  return value.replace(/\*$/, "").replace(/^\/api\//, "").split(/[/:]/)[0] || "root";
}

function routeMethods(file, path, line) {
  if (file === "src/server/routes/typescript.ts") {
    return path === "/api/ts/diagnostics*" ? ["GET"] : ["POST"];
  }
  return methodsOnLine(line);
}

async function collectRoutes() {
  const files = await walk(ROUTE_ROOT, [".ts"]);
  const routes = [];
  const routePattern = /(?:url|pathname)\s*===\s*["']([^"']+)["']|(?:url|pathname)\??\.startsWith\(\s*["']([^"']+)["']\s*\)/g;
  for (const filePath of files) {
    const file = repoPath(filePath);
    const raw = await readFile(filePath, "utf8");
    const source = stripCommentsPreservingLines(raw);
    const handler = raw.match(/export\s+const\s+(handle\w+)\s*:\s*RouteHandler/)?.[1]
      || raw.match(/export\s+(?:async\s+)?function\s+(handle\w+)/)?.[1]
      || "unknown";
    for (const line of source.split("\n")) {
      for (const match of line.matchAll(routePattern)) {
        const literal = match[1] || match[2];
        const path = literal.split("?")[0] + (match[2] ? "*" : "");
        if (!(path.startsWith("/api/") || path === "/layout-config.json")) continue;
        for (const method of routeMethods(file, path, line)) routes.push({ method, path, handler, source: file, category: routeCategory(path) });
      }
    }
    if (file === "src/server/routes/settings/custom-providers.ts" && /const\s+ITEM_ROUTE\s*=/.test(source)) {
      for (const method of ["DELETE", "PUT"]) {
        routes.push({ method, pathPattern: "/api/custom-providers/:providerId", handler, source: file, category: "custom-providers" });
      }
    }
  }
  return sortBy(uniqueBy(routes, (route) => `${route.method}:${route.path || route.pathPattern}:${route.source}`), (route) => `${route.path || route.pathPattern}:${route.method}:${route.source}`);
}

export async function buildCapabilityCatalog() {
  return {
    schemaVersion: 1,
    generatedAt: "deterministic",
    generator: "scripts/generate-capability-catalog.mjs",
    tools: await collectTools(),
    spawnPoints: await collectSpawnPoints(),
    events: {
      engine: [...ENGINE_EVENT_TYPES].sort(),
      application: [...APP_EVENT_TYPES].sort(),
    },
    routes: await collectRoutes(),
    permissionModes: [...PERMISSION_MODES],
    skills: [],
    sources: {
      tools: "src/agent/tools/index.ts",
      spawnPoints: "src/**/*.ts|js|mjs,scripts/**/*.js|mjs",
      engineEvents: "src/agent-engine/contracts.ts",
      applicationEvents: "src/server/app-events.ts",
      routes: "src/server/routes/**/*.ts",
      permissionModes: "src/server/permission-mode.ts",
      skills: "task-1-pending",
    },
  };
}

export function serializeCapabilityCatalog(catalog) {
  return `${JSON.stringify(catalog, null, 2)}\n`;
}

export async function checkCapabilityCatalog(output = OUTPUT) {
  if (!existsSync(output)) return { ok: false, reason: "missing" };
  const actual = await readFile(output, "utf8");
  const expected = serializeCapabilityCatalog(await buildCapabilityCatalog());
  return actual === expected ? { ok: true } : { ok: false, reason: "out-of-date" };
}

const isMain = process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (isMain) {
  const check = process.argv.includes("--check");
  if (check) {
    const result = await checkCapabilityCatalog(OUTPUT);
    if (!result.ok) {
      console.error("Capability catalog is out of date. Run: npm run capabilities:generate");
      process.exitCode = 1;
    }
  } else {
    await mkdir(dirname(OUTPUT), { recursive: true });
    await writeFile(OUTPUT, serializeCapabilityCatalog(await buildCapabilityCatalog()), "utf8");
    console.log(`Generated ${repoPath(OUTPUT)}`);
  }
}
