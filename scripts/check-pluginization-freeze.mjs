import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs"
import { execFileSync } from "node:child_process"
import { join, relative, resolve } from "node:path"
import { buildTestReport } from "./test-report.mjs"

const ROOT = resolve(import.meta.dirname, "..")
const BASELINE_PATH = resolve(ROOT, "docs/generated/pluginization-baseline.json")

function currentCommit() {
  try {
    return execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: ROOT, encoding: "utf8" }).trim() || "unknown"
  } catch {
    return "unknown"
  }
}

function workingTreeState() {
  try {
    return execFileSync("git", ["status", "--porcelain"], { cwd: ROOT, encoding: "utf8" }).trim() ? "dirty" : "clean"
  } catch {
    return "unknown"
  }
}

function sourceFiles(root, result = []) {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (entry.name === "gen" || entry.name === "node_modules" || entry.name === ".git") continue
    const path = join(root, entry.name)
    if (entry.isDirectory()) sourceFiles(path, result)
    else if (/\.(?:ts|tsx|js|mjs)$/u.test(entry.name)) result.push(path)
  }
  return result
}

function countLines(files) {
  return files.reduce((total, file) => total + readFileSync(file, "utf8").split(/\r?\n/u).length - 1, 0)
}

function countMatches(file, pattern) {
  const source = readFileSync(file, "utf8")
  return [...source.matchAll(pattern)].length
}

function collectMetrics() {
  const productionFiles = sourceFiles(resolve(ROOT, "src"))
  const componentManifestFile = resolve(ROOT, "src/agent/capability-components.ts")
  const packageFile = resolve(ROOT, "src/agent/component-package.ts")
  const toolIndexFile = resolve(ROOT, "src/agent/tools/index.ts")
  const paneFiles = sourceFiles(resolve(ROOT, "src/frontend/pane"))
  const capabilityCatalogPath = resolve(ROOT, "docs/generated/capability-catalog.json")
  const capabilityCatalog = existsSync(capabilityCatalogPath)
    ? JSON.parse(readFileSync(capabilityCatalogPath, "utf8"))
    : { routes: [] }
  const paneRegistrations = paneFiles.reduce((sum, file) => sum + countMatches(file, /\bregisterPane\s*\(/gu), 0)
  const testReport = buildTestReport()

  return {
    productionFiles: productionFiles.length,
    productionLines: countLines(productionFiles),
    testFiles: testReport.files,
    declaredTestBlocks: testReport.declaredTests,
    toolRegistrations: countMatches(toolIndexFile, /^toolRegistry\.register\(/gmu),
    requiredComponentManifests: countMatches(componentManifestFile, /^\s*\{ id: "[^"]+", version:/gmu),
    firstPartyComponentPackages: countMatches(packageFile, /^\s{2}[A-Z0-9_]+_COMPONENT_PACKAGE_MANIFEST,?$/gmu),
    uiPaneRegistrations: paneRegistrations,
    httpRouteEntries: Array.isArray(capabilityCatalog.routes) ? capabilityCatalog.routes.length : 0,
    componentCatalogEntrypoints: countMatches(resolve(ROOT, "src/frontend/pane/components/index.ts"), /registerPane\?\.\(\s*["']components/gu),
  }
}

function readBaseline() {
  if (!existsSync(BASELINE_PATH)) throw new Error(`Missing baseline: ${relative(ROOT, BASELINE_PATH)}`)
  return JSON.parse(readFileSync(BASELINE_PATH, "utf8"))
}

function check() {
  const baseline = readBaseline()
  const current = collectMetrics()
  const frozen = [
    "requiredComponentManifests",
    "firstPartyComponentPackages",
    "uiPaneRegistrations",
  ]
  const violations = frozen
    .filter((key) => current[key] > baseline.metrics[key])
    .map((key) => `${key} grew from ${baseline.metrics[key]} to ${current[key]}`)
  if (violations.length) {
    console.error("Pluginization freeze failed:")
    for (const violation of violations) console.error(`- ${violation}`)
    console.error("Record an intentional R0 baseline update before adding component entries.")
    process.exitCode = 1
    return
  }
  console.log(`[pluginization-freeze] pass; frozen=${frozen.map((key) => `${key}:${current[key]}/${baseline.metrics[key]}`).join(", ")}`)
  console.log(`[pluginization-freeze] current production=${current.productionFiles} files/${current.productionLines} lines; tests=${current.testFiles} files/${current.declaredTestBlocks} blocks`)
}

if (process.argv.includes("--write")) {
  const metrics = collectMetrics()
  writeFileSync(BASELINE_PATH, `${JSON.stringify({
    schemaVersion: 1,
    capturedAt: "2026-08-29",
    commit: currentCommit(),
    workingTree: workingTreeState(),
    source: "scripts/check-pluginization-freeze.mjs",
    scope: {
      production: "src/**/*.ts|tsx|js|mjs, excluding generated src/**/gen/**",
      tests: "scripts/test-report.mjs discovered test manifest",
      frozen: ["requiredComponentManifests", "firstPartyComponentPackages", "uiPaneRegistrations"],
      rule: "frozen metrics may decrease; increases require an intentional baseline update",
    },
    metrics,
  }, null, 2)}\n`, "utf8")
  console.log(`[pluginization-freeze] baseline written: ${relative(ROOT, BASELINE_PATH)}`)
} else if (process.argv.includes("--check") || process.argv.length <= 2) {
  check()
}
