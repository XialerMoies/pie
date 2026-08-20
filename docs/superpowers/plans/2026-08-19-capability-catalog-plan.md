# Task 0 Capability Catalog Implementation Plan

> 状态：已完成（以下步骤保留为实施计划历史记录）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Generate a deterministic, code-derived capability catalog covering tools, spawn points, events, API routes, permission modes, and the static Task 1 skill contract seam, with a CI synchronization gate.

**Architecture:** Export three small runtime fact constants, then use one mixed generator script: runtime imports for structured tool/event/mode facts and constrained text scanning for route/spawn facts. The generated JSON is committed and checked byte-for-byte with `--check`; no AST framework, runtime plugin system, skill implementation, or environment governance is introduced.

**Tech Stack:** Node.js ESM, TypeScript/tsx imports, JSON, Node test runner, GitHub Actions on Windows.

---

### Task 1: Expose stable event and permission facts

**Files:**
- Modify: `src/agent-engine/contracts.ts`
- Modify: `src/server/app-events.ts`
- Modify: `src/server/permission-mode.ts`
- Test: `test/capability-catalog.test.mjs`

- [ ] **Step 1: Write the failing source-fact test**

Create `test/capability-catalog.test.mjs` with the initial contract:

```js
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { ENGINE_EVENT_TYPES } from "../src/agent-engine/contracts.ts";
import { APP_EVENT_TYPES } from "../src/server/app-events.ts";
import { PERMISSION_MODES, isPermissionMode } from "../src/server/permission-mode.ts";

describe("capability catalog source facts", () => {
  it("exports stable engine, application, and permission facts", () => {
    assert.deepStrictEqual([...ENGINE_EVENT_TYPES], [
      "engine.ready",
      "session.changed",
      "turn.started",
      "content.delta",
      "thinking.delta",
      "tool.started",
      "tool.updated",
      "tool.completed",
      "tool.failed",
      "usage.updated",
      "turn.completed",
      "turn.failed",
      "turn.cancelled",
      "compaction.started",
      "compaction.completed",
      "compaction.failed",
      "queue.updated",
      "diagnostic",
    ]);
    assert.deepStrictEqual([...APP_EVENT_TYPES], [
      "dashboard.changed",
      "usage.changed",
      "mcp.changed",
      "explorer.changed",
      "permission.confirm",
    ]);
    assert.deepStrictEqual([...PERMISSION_MODES], ["standard", "plan", "dontAsk", "yes"]);
    assert.ok(PERMISSION_MODES.every(isPermissionMode));
  });
});
```

- [ ] **Step 2: Run the test and verify the missing-export failure**

Run:

```powershell
node scripts/tsx-test.mjs --test test/capability-catalog.test.mjs
```

Expected: FAIL because `ENGINE_EVENT_TYPES`, `APP_EVENT_TYPES`, and `PERMISSION_MODES` are not exported.

- [ ] **Step 3: Export the minimal constants and reuse them**

In `src/agent-engine/contracts.ts`, replace the private event list with:

```ts
export const ENGINE_EVENT_TYPES = [
  "engine.ready",
  "session.changed",
  "turn.started",
  "content.delta",
  "thinking.delta",
  "tool.started",
  "tool.updated",
  "tool.completed",
  "tool.failed",
  "usage.updated",
  "turn.completed",
  "turn.failed",
  "turn.cancelled",
  "compaction.started",
  "compaction.completed",
  "compaction.failed",
  "queue.updated",
  "diagnostic",
] as const satisfies readonly EngineEvent["type"][];

const EVENT_TYPES = new Set<EngineEvent["type"]>(ENGINE_EVENT_TYPES);
```

In `src/server/app-events.ts`, replace the handwritten union with:

```ts
export const APP_EVENT_TYPES = [
  "dashboard.changed",
  "usage.changed",
  "mcp.changed",
  "explorer.changed",
  "permission.confirm",
] as const;

export type AppEventType = typeof APP_EVENT_TYPES[number];
```

In `src/server/permission-mode.ts`, add and reuse:

```ts
export const PERMISSION_MODES = ["standard", "plan", "dontAsk", "yes"] as const satisfies readonly PermissionMode[];

export function isPermissionMode(value: unknown): value is PermissionMode {
  return PERMISSION_MODES.includes(value as PermissionMode);
}
```

- [ ] **Step 4: Verify the source-fact test and typecheck**

Run:

```powershell
node scripts/tsx-test.mjs --test test/capability-catalog.test.mjs
npm run typecheck
```

Expected: the test passes and typecheck exits 0.

- [ ] **Step 5: Commit the source facts**

```powershell
git add src/agent-engine/contracts.ts src/server/app-events.ts src/server/permission-mode.ts test/capability-catalog.test.mjs
git commit -m "feat: expose capability catalog source facts"
```

### Task 2: Build the deterministic mixed generator

**Files:**
- Create: `scripts/generate-capability-catalog.mjs`
- Modify: `test/capability-catalog.test.mjs`

- [ ] **Step 1: Add failing generator behavior tests**

Extend `test/capability-catalog.test.mjs`:

```js
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { tmpdir } from "node:os";

import {
  buildCapabilityCatalog,
  serializeCapabilityCatalog,
  checkCapabilityCatalog,
} from "../scripts/generate-capability-catalog.mjs";

describe("capability catalog generator", () => {
  it("builds deterministic code-derived facts without Task 1 or Task 2 behavior", async () => {
    const first = await buildCapabilityCatalog();
    const second = await buildCapabilityCatalog();
    assert.strictEqual(serializeCapabilityCatalog(first), serializeCapabilityCatalog(second));
    assert.strictEqual(first.schemaVersion, 1);
    assert.strictEqual(first.generatedAt, "deterministic");
    assert.equal(first.skills.schemaVersion, 1);
    assert.equal(first.skills.runtimeSource, "src/agent/skills/skill-service.ts");
    assert.deepStrictEqual(first.skills.roots, [
      "<PI_USER_CONFIG>/skills",
      "<workspace-root>/agent/skills",
    ]);
    assert.strictEqual(first.sources.skills, "src/agent/skills/skill-service.ts");
    assert.ok(first.tools.some((tool) => tool.name === "command" && tool.source === "src/agent/tools/command.ts"));
    assert.ok(first.events.engine.includes("turn.cancelled"));
    assert.ok(first.events.application.includes("permission.confirm"));
    assert.ok(first.routes.some((route) => route.path === "/api/chat" && route.method === "POST"));
    assert.ok(first.routes.some((route) => route.pathPattern === "/api/custom-providers/:providerId"));
    assert.ok(first.spawnPoints.some((point) => point.file === "src/agent/tools/command.ts" && point.category === "user-command"));
    assert.ok(first.spawnPoints.some((point) => point.file === "src/server/ts-server.ts" && point.category === "tsserver"));
    assert.deepStrictEqual(first.permissionModes, ["standard", "plan", "dontAsk", "yes"]);
  });

  it("checks a catalog byte-for-byte without modifying it", async () => {
    const root = mkdtempSync(resolve(tmpdir(), "capability-catalog-"));
    const output = resolve(root, "catalog.json");
    try {
      const expected = serializeCapabilityCatalog(await buildCapabilityCatalog());
      writeFileSync(output, expected);
      assert.deepStrictEqual(await checkCapabilityCatalog(output), { ok: true });
      writeFileSync(output, expected.replace('"schemaVersion": 1', '"schemaVersion": 2'));
      const before = readFileSync(output, "utf8");
      const mismatch = await checkCapabilityCatalog(output);
      assert.strictEqual(mismatch.ok, false);
      assert.strictEqual(readFileSync(output, "utf8"), before);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 2: Run the test and verify the missing-module failure**

```powershell
node scripts/tsx-test.mjs --test test/capability-catalog.test.mjs
```

Expected: FAIL because `scripts/generate-capability-catalog.mjs` does not exist.

- [ ] **Step 3: Implement one focused generator script**

Create `scripts/generate-capability-catalog.mjs` with only these responsibilities:

```js
#!/usr/bin/env node
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
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

const posix = (value) => value.replaceAll("\\", "/");
const repoPath = (value) => posix(relative(ROOT, value));
const sortBy = (items, key) => [...items].sort((left, right) => key(left).localeCompare(key(right)));
const uniqueBy = (items, key) => [...new Map(items.map((item) => [key(item), item])).values()];

function stripCommentsPreservingLines(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (match) => match.replace(/[^\n]/g, " "))
    .replace(/\/\/.*$/gm, "");
}

async function walk(directory, extensions) {
  const entries = await readdir(directory, { withFileTypes: true });
  const output = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const fullPath = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      if (repoPath(fullPath) === "src/frontend/gen") continue;
      output.push(...await walk(fullPath, extensions));
    }
    else if (extensions.some((extension) => entry.name.endsWith(extension))) output.push(fullPath);
  }
  return output;
}

async function toolSources() {
  const source = await readFile(resolve(ROOT, "src/agent/tools/index.ts"), "utf8");
  const imports = new Map();
  for (const match of source.matchAll(/import\s+\{([^}]+)\}\s+from\s+["'](\.\/[^"']+)["']/g)) {
    const sourcePath = `src/agent/tools/${match[2].slice(2).replace(/\.js$/, ".ts")}`;
    for (const binding of match[1].split(",").map((item) => item.trim()).filter(Boolean)) imports.set(binding, sourcePath);
  }
  const registered = [];
  for (const match of source.matchAll(/toolRegistry\.register\((\w+)\)/g)) {
    registered.push(imports.get(match[1]) || "src/agent/tools/index.ts");
  }
  return registered;
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
```

Append these exact local scanners and composers to the same file; do not extract a generic scanner framework:

```js
const SPAWN_APIS = ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"];

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

function lineNumber(source, index) {
  return source.slice(0, index).split("\n").length;
}

async function collectSpawnPoints() {
  const files = (await Promise.all(SCAN_ROOTS.map((root) => walk(root, [".ts", ".js", ".mjs"])))).flat();
  const points = [];
  const callPattern = new RegExp(`\\b(${SPAWN_APIS.join("|")})\\s*\\(`, "g");
  for (const filePath of files) {
    const file = repoPath(filePath);
    const source = stripCommentsPreservingLines(await readFile(filePath, "utf8"));
    for (const match of source.matchAll(callPattern)) {
      const category = spawnCategory(file);
      points.push({ file, line: lineNumber(source, match.index), api: match[1], category, owner: spawnOwner(category) });
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
  return value.replace(/^\/api\//, "").split(/[/:]/)[0] || "root";
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
        const path = literal.endsWith("?") ? literal.slice(0, -1) : literal.split("?")[0];
        if (!(path.startsWith("/api/") || path === "/layout-config.json")) continue;
        for (const method of methodsOnLine(line)) routes.push({ method, path, handler, source: file, category: routeCategory(path) });
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
    skills: {
      schemaVersion: 1,
      runtimeSource: "src/agent/skills/skill-service.ts",
      roots: ["<PI_USER_CONFIG>/skills", "<workspace-root>/agent/skills"],
      summaryFields: ["id", "name", "description", "source", "path", "trust", "enabled", "parse", "declaredTools"],
    },
    sources: {
      tools: "src/agent/tools/index.ts",
      spawnPoints: "src/**/*.ts|js|mjs,scripts/**/*.js|mjs",
      engineEvents: "src/agent-engine/contracts.ts",
      applicationEvents: "src/server/app-events.ts",
      routes: "src/server/routes/**/*.ts",
      permissionModes: "src/server/permission-mode.ts",
      skills: "src/agent/skills/skill-service.ts",
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
```

The CLI footer must be:

```js
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
```

- [ ] **Step 4: Run focused tests and inspect the generated in-memory document**

```powershell
node scripts/tsx-test.mjs --test test/capability-catalog.test.mjs
node --import tsx -e "import('./scripts/generate-capability-catalog.mjs').then(async m => console.log(JSON.stringify(await m.buildCapabilityCatalog(), null, 2)))"
```

Expected: focused tests pass; output contains no machine-absolute paths, timestamps, environment values, skill bodies, or env policies.

- [ ] **Step 5: Commit the generator**

```powershell
git add scripts/generate-capability-catalog.mjs test/capability-catalog.test.mjs
git commit -m "feat: generate deterministic capability catalog"
```

### Task 3: Commit the catalog and synchronization commands

**Files:**
- Create: `docs/generated/capability-catalog.json`
- Modify: `package.json`
- Modify: `test/capability-catalog.test.mjs`

- [ ] **Step 1: Add the failing package-script and committed-output assertions**

Extend the focused test:

```js
const packageJson = JSON.parse(readFileSync(resolve("package.json"), "utf8"));

it("publishes generate/check commands and keeps the committed catalog synchronized", async () => {
  assert.strictEqual(packageJson.scripts["capabilities:generate"], "node --import tsx scripts/generate-capability-catalog.mjs");
  assert.strictEqual(packageJson.scripts["capabilities:check"], "node --import tsx scripts/generate-capability-catalog.mjs --check");
  const committed = readFileSync(resolve("docs/generated/capability-catalog.json"), "utf8");
  assert.strictEqual(committed, serializeCapabilityCatalog(await buildCapabilityCatalog()));
});
```

- [ ] **Step 2: Run the test and verify missing scripts/output**

```powershell
node scripts/tsx-test.mjs --test test/capability-catalog.test.mjs
```

Expected: FAIL because package scripts and generated JSON are absent.

- [ ] **Step 3: Add the two package scripts**

Add beside the existing build/test scripts:

```json
"capabilities:generate": "node --import tsx scripts/generate-capability-catalog.mjs",
"capabilities:check": "node --import tsx scripts/generate-capability-catalog.mjs --check",
```

- [ ] **Step 4: Generate and force-add the ignored documentation output**

```powershell
npm run capabilities:generate
npm run capabilities:check
git add package.json test/capability-catalog.test.mjs
git add -f docs/generated/capability-catalog.json
```

Inspect:

```powershell
git diff --cached -- docs/generated/capability-catalog.json package.json
```

Expected: deterministic JSON only; `skills` contains the static Task 1 schema and `sources.skills` is `src/agent/skills/skill-service.ts`.

- [ ] **Step 5: Verify mismatch detection without modifying the committed file**

```powershell
Copy-Item docs/generated/capability-catalog.json $env:TEMP\capability-catalog.backup.json
Add-Content docs/generated/capability-catalog.json " "
npm run capabilities:check
Copy-Item $env:TEMP\capability-catalog.backup.json docs/generated/capability-catalog.json -Force
npm run capabilities:check
```

Expected: first check exits non-zero; restored check exits 0.

- [ ] **Step 6: Commit commands and output**

```powershell
git add package.json test/capability-catalog.test.mjs
git add -f docs/generated/capability-catalog.json
git commit -m "feat: publish generated capability catalog"
```

### Task 4: Add the CI gate and close Task 0 documentation

**Files:**
- Modify: `.github/workflows/windows-governance.yml`
- Modify: `docs/任务清单.md`
- Modify: `package.json`
- Test: `test/capability-catalog.test.mjs`

- [ ] **Step 1: Add failing CI and test-suite wiring assertions**

Extend `test/capability-catalog.test.mjs`:

```js
it("runs capability synchronization in CI and the unit suite", () => {
  const workflow = readFileSync(resolve(".github/workflows/windows-governance.yml"), "utf8");
  assert.match(workflow, /npm run capabilities:check/);
  assert.match(packageJson.scripts["test:unit"], /test\/capability-catalog\.test\.mjs/);
});
```

- [ ] **Step 2: Run the focused test and verify the wiring failure**

```powershell
node scripts/tsx-test.mjs --test test/capability-catalog.test.mjs
```

Expected: FAIL because CI and `test:unit` do not run the check/test yet.

- [ ] **Step 3: Wire the focused test and CI check**

Add `test/capability-catalog.test.mjs` to `test:unit` in `package.json`.

In `.github/workflows/windows-governance.yml`, insert after typecheck:

```yaml
      - run: npm run capabilities:check
```

- [ ] **Step 4: Mark Task 0 complete without adding volatile counts**

In `docs/任务清单.md`, replace the Task 0 heading and completion block with a concise completed record:

```markdown
### Task 0：生成式能力目录（已完成）

代码事实通过 `scripts/generate-capability-catalog.mjs` 生成到 `docs/generated/capability-catalog.json`；`npm run capabilities:check` 和 Windows CI 检查同步。目录覆盖工具、spawn 点、事件、API 路由、权限模式，并为 Task 1 保留静态技能 schema、目录根和运行时来源接缝。
```

Keep the existing goal, scope exclusions, and rationale; do not add test counts or catalog item counts.

- [ ] **Step 5: Run focused, type, unit, and synchronization gates**

```powershell
node scripts/tsx-test.mjs --test test/capability-catalog.test.mjs
npm run capabilities:check
npm run typecheck
npm run test:unit
git diff --check
```

Expected: all commands exit 0.

- [ ] **Step 6: Run complete release verification**

```powershell
npm test
npm run build
npm run test:build
npm run test:electron:e2e
```

Expected: all commands exit 0. No catalog generation step should contact a Provider, start Electron, start the server, or connect MCP.

- [ ] **Step 7: Commit Task 0 completion**

```powershell
git add .github/workflows/windows-governance.yml package.json test/capability-catalog.test.mjs
git add -f docs/任务清单.md docs/generated/capability-catalog.json
git commit -m "test: gate generated capability catalog"
```

### Task 5: Final scope and determinism review

**Files:**
- Review only: `scripts/generate-capability-catalog.mjs`
- Review only: `docs/generated/capability-catalog.json`
- Review only: Task 0 changed files

- [ ] **Step 1: Verify no prohibited scope was introduced**

```powershell
rg -n "typescript\.createSourceFile|ts-morph|SKILL\.md|installSkill|enableSkill|process\.env.*filter|<html|express" scripts/generate-capability-catalog.mjs package.json
```

Expected: no AST platform, skill runtime, env governance, HTML, or server framework in the Task 0 generator.

- [ ] **Step 2: Verify deterministic regeneration**

```powershell
$before = (Get-FileHash docs/generated/capability-catalog.json -Algorithm SHA256).Hash
npm run capabilities:generate
$after = (Get-FileHash docs/generated/capability-catalog.json -Algorithm SHA256).Hash
if ($before -ne $after) { throw "Capability catalog generation is not deterministic" }
npm run capabilities:check
```

Expected: hashes match and check exits 0.

- [ ] **Step 3: Review final repository state**

```powershell
git diff master...HEAD --stat
git status --short
git log --oneline master..HEAD
```

Expected: only Task 0 spec, plan, generator, source constants, tests, generated JSON, package/CI wiring, and task-list status changes.
