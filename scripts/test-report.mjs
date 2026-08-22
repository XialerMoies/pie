import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { buildTestManifest, validateTestManifest } from "./test-manifest.mjs";

const ROOT = resolve(import.meta.dirname, "..");

function countDeclaredTests(file) {
  const source = readFileSync(resolve(ROOT, file), "utf8");
  return source.match(/\b(?:it|test|describe)\s*\(/gu)?.length ?? 0;
}

export function buildTestReport() {
  const manifest = buildTestManifest();
  const errors = validateTestManifest(manifest);
  if (errors.length) throw new Error(errors.join("\n"));
  const entries = manifest.entries.map((entry) => ({ ...entry, declaredTests: countDeclaredTests(entry.file) }));
  const countBy = (items, key) => Object.fromEntries([...new Set(items.map((item) => item[key]))].sort().map((value) => [value, items.filter((item) => item[key] === value).length]));
  const testsBy = (key) => Object.fromEntries([...new Set(entries.map((entry) => entry[key]))].sort().map((value) => [value, entries.filter((entry) => entry[key] === value).reduce((sum, entry) => sum + entry.declaredTests, 0)]));
  return {
    version: 1,
    generatedAt: new Date().toISOString(),
    source: "scripts/test-manifest.mjs",
    files: entries.length,
    declaredTests: entries.reduce((sum, entry) => sum + entry.declaredTests, 0),
    defaultFiles: entries.filter((entry) => entry.default).length,
    flowFiles: entries.filter((entry) => entry.flow).length,
    filesBySuite: countBy(entries, "suite"),
    filesByLayer: countBy(entries, "layer"),
    testsBySuite: testsBy("suite"),
    testsByLayer: testsBy("layer"),
    entries,
  };
}

export function reportMarkdown(report) {
  return [
    "# Test Statistics",
    "",
    `Generated: ${report.generatedAt}`,
    `Source: \`${report.source}\` (discovered manifest; do not edit counts manually)`,
    "",
    `- Test files: **${report.files}** (default **${report.defaultFiles}**, flow **${report.flowFiles}**)`,
    `- Declared test/describe blocks: **${report.declaredTests}**`,
    `- Files by suite: ${Object.entries(report.filesBySuite).map(([key, value]) => `\`${key}\` ${value}`).join(", ")}`,
    `- Files by layer: ${Object.entries(report.filesByLayer).map(([key, value]) => `\`${key}\` ${value}`).join(", ")}`,
    `- Declared blocks by suite: ${Object.entries(report.testsBySuite).map(([key, value]) => `\`${key}\` ${value}`).join(", ")}`,
    `- Declared blocks by layer: ${Object.entries(report.testsByLayer).map(([key, value]) => `\`${key}\` ${value}`).join(", ")}`,
    "",
    "Runtime pass/fail/skip counts must come from the test runner output for the run; this report never substitutes discovered files for executed tests.",
    "",
  ].join("\n");
}

if (["--check", "--json", "--markdown", "--write"].some((arg) => process.argv.includes(arg))) {
  const report = buildTestReport();
  if (process.argv.includes("--write")) {
    const outputDir = resolve(ROOT, "docs/generated");
    mkdirSync(outputDir, { recursive: true });
    writeFileSync(resolve(outputDir, "test-stats.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
    writeFileSync(resolve(outputDir, "test-stats.md"), reportMarkdown(report), "utf8");
  }
  if (process.argv.includes("--json")) console.log(JSON.stringify(report, null, 2));
  else if (process.argv.includes("--markdown") || process.argv.includes("--write")) console.log(reportMarkdown(report));
  else console.log(`[test-report] ${report.files} files; ${report.declaredTests} declared blocks; default=${report.defaultFiles}; flow=${report.flowFiles}; layers=${JSON.stringify(report.filesByLayer)}`);
}
