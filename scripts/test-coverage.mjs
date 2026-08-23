#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import process from "node:process";

const ROOT = resolve(import.meta.dirname, "..");
const POLICY_FILE = resolve(ROOT, "test", "coverage-policy.json");
const RAW_DIRECTORY = resolve(ROOT, ".coverage", "raw");
const REPORT_DIRECTORY = resolve(ROOT, ".coverage", "report");
const SUMMARY_FILE = resolve(REPORT_DIRECTORY, "coverage-summary.json");
const METRICS = ["lines", "statements", "functions", "branches"];

export function loadCoveragePolicy() {
  return JSON.parse(readFileSync(POLICY_FILE, "utf8"));
}

export function validateCoveragePolicy(policy) {
  const errors = [];
  if (!policy || policy.version !== 1) return ["coverage policy must have version=1"];
  if (policy.collector !== "c8") errors.push("coverage collector must be c8");
  if (!Array.isArray(policy.include) || policy.include.length === 0) errors.push("coverage include[] must not be empty");
  if (!Array.isArray(policy.exclude)) errors.push("coverage exclude[] must be an array");
  if (!Number.isSafeInteger(policy.minimumRawFiles) || policy.minimumRawFiles < 1) errors.push("coverage minimumRawFiles must be a positive integer");
  if (typeof policy.maximumRawMb !== "number" || !Number.isFinite(policy.maximumRawMb) || policy.maximumRawMb < 1) errors.push("coverage maximumRawMb must be positive");
  if (!Array.isArray(policy.requiredProducers) || policy.requiredProducers.length === 0) errors.push("coverage requiredProducers[] must not be empty");
  if (typeof policy.maximumRegressionPoints !== "number" || policy.maximumRegressionPoints < 0 || policy.maximumRegressionPoints > 5) {
    errors.push("coverage maximumRegressionPoints must be between 0 and 5");
  }
  for (const metric of METRICS) {
    const value = policy.thresholds?.[metric];
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0 || value > 100) {
      errors.push(`coverage threshold ${metric} must be greater than 0 and at most 100`);
    }
    const baseline = policy.baseline?.[metric];
    if (typeof baseline !== "number" || !Number.isFinite(baseline) || baseline < value || baseline > 100) {
      errors.push(`coverage baseline ${metric} must be at least its threshold and at most 100`);
    }
  }
  return errors;
}

export function inspectCoverageSummary(summary, policy) {
  const errors = [];
  if (!summary?.total) return { ok: false, errors: ["coverage summary has no total"] };
  for (const metric of METRICS) {
    const pct = summary.total[metric]?.pct;
    const threshold = policy.thresholds[metric];
    const regressionFloor = policy.baseline[metric] - policy.maximumRegressionPoints;
    if (typeof pct !== "number" || !Number.isFinite(pct)) errors.push(`coverage summary ${metric} is missing`);
    else if (pct < threshold) errors.push(`${metric} coverage ${pct}% is below ${threshold}%`);
    else if (pct < regressionFloor) errors.push(`${metric} coverage ${pct}% regressed below ${regressionFloor.toFixed(2)}%`);
  }
  const files = Object.keys(summary).filter((key) => key !== "total");
  if (files.length === 0) errors.push("coverage summary contains no source files");
  return { ok: errors.length === 0, errors, files: files.length };
}

function c8Arguments(policy) {
  const args = [
    resolve(ROOT, "node_modules", "c8", "bin", "c8.js"),
    "report",
    "--temp-directory", RAW_DIRECTORY,
    "--reports-dir", REPORT_DIRECTORY,
    "--reporter", "text-summary",
    "--reporter", "json-summary",
    "--all",
    "--src", "src",
    "--exclude-after-remap",
    "--merge-async",
    "--check-coverage",
  ];
  for (const pattern of policy.include) args.push("--include", pattern);
  for (const pattern of policy.exclude) args.push("--exclude", pattern);
  for (const metric of METRICS) args.push(`--${metric}`, String(policy.thresholds[metric]));
  return args;
}

async function runCollector(policy) {
  rmSync(REPORT_DIRECTORY, { recursive: true, force: true });
  const child = spawn(process.execPath, c8Arguments(policy), {
    cwd: ROOT,
    env: { ...process.env, NODE_V8_COVERAGE: "" },
    stdio: "inherit",
    windowsHide: true,
  });
  return new Promise((resolveRun, rejectRun) => {
    child.once("error", rejectRun);
    child.once("close", (code, signal) => {
      if (code === 0 && !signal) resolveRun();
      else rejectRun(new Error(`c8 report failed: exit=${code ?? "null"}${signal ? ` signal=${signal}` : ""}`));
    });
  });
}

export async function runCoverageGate() {
  const policy = loadCoveragePolicy();
  try {
    const policyErrors = validateCoveragePolicy(policy);
    if (policyErrors.length) throw new Error(policyErrors.join("\n"));
    if (!existsSync(RAW_DIRECTORY)) throw new Error("coverage raw directory is missing; unit/routes/frontend producers did not run");
    const missingProducers = policy.requiredProducers.filter((producer) => !existsSync(resolve(RAW_DIRECTORY, `${producer}.complete`)));
    if (missingProducers.length) throw new Error(`coverage producers incomplete: ${missingProducers.join(", ")}`);
    const rawFiles = readdirSync(RAW_DIRECTORY).filter((name) => name.endsWith(".json"));
    if (rawFiles.length < policy.minimumRawFiles) {
      throw new Error(`coverage raw data incomplete: ${rawFiles.length} files, expected at least ${policy.minimumRawFiles}`);
    }
    const rawBytes = rawFiles.reduce((total, name) => total + statSync(resolve(RAW_DIRECTORY, name)).size, 0);
    const rawMb = rawBytes / (1024 * 1024);
    if (rawMb > policy.maximumRawMb) throw new Error(`coverage raw data ${rawMb.toFixed(1)}MB exceeds ${policy.maximumRawMb}MB`);
    await runCollector(policy);
    if (!existsSync(SUMMARY_FILE)) throw new Error("c8 did not produce coverage-summary.json");
    const summary = JSON.parse(readFileSync(SUMMARY_FILE, "utf8"));
    const inspection = inspectCoverageSummary(summary, policy);
    if (!inspection.ok) throw new Error(inspection.errors.join("\n"));
    const totals = METRICS.map((metric) => `${metric}=${summary.total[metric].pct}%`).join(" ");
    console.log(`[test-coverage] ${inspection.files} source files; raw=${rawFiles.length}/${rawMb.toFixed(1)}MB; ${totals}`);
  } finally {
    rmSync(RAW_DIRECTORY, { recursive: true, force: true });
  }
}

if (pathToFileURL(process.argv[1] || "").href === import.meta.url) {
  runCoverageGate().catch((error) => {
    console.error(`[test-coverage] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
