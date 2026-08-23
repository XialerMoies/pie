#!/usr/bin/env node
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import process from "node:process";
import { fixturePaths, loadReplayCatalog, runReplayScenario } from "../test/fixtures/agent-session-replay.mjs";

const ROOT = resolve(import.meta.dirname, "..");
const BASELINE_PATH = resolve(ROOT, "test/fixtures/agent-behavior-baseline.json");
const FAULTS = new Set(["unrelated-read", "retry", "terminal", "leak", "missing-evidence", "memory", "instruction", "scope", "phase"]);

function readBaseline() {
  const baseline = JSON.parse(readFileSync(BASELINE_PATH, "utf8"));
  if (baseline.version !== 1 || !baseline.scenarios || typeof baseline.scenarios !== "object") throw new Error("invalid behavior baseline schema");
  return baseline;
}

function targetKey(call) {
  return `${call.name}:${JSON.stringify(call.input ?? {})}`;
}

function isRead(call) {
  return /^(?:file_read|read|explorer_list|search)$/u.test(call.name);
}

function hasLeak(value) {
  return typeof value === "string" && /(?:\bThought\b|\bIN\b|\bOUT\b|<internal>|tool parameters?)/iu.test(value);
}

function workspacePaths(value, paths = []) {
  if (typeof value === "string") {
    for (const match of value.matchAll(/<workspace>\/[^\s"'`,)\]}]+/gu)) paths.push(match[0].replace(/^<workspace>\//u, ""));
  } else if (Array.isArray(value)) {
    for (const entry of value) workspacePaths(entry, paths);
  } else if (value && typeof value === "object") {
    for (const entry of Object.values(value)) workspacePaths(entry, paths);
  }
  return paths;
}

function pathMatchesPrefix(path, prefix) {
  const normalizedPrefix = prefix.replace(/\/$/u, "");
  return path === normalizedPrefix || path.startsWith(`${normalizedPrefix}/`);
}

function engineeringMetrics(scenario) {
  const recording = scenario.recording;
  if (!recording) {
    return {
      taskClass: "baseline",
      contextMessageCount: null,
      normalizedContextChars: null,
      toolDiversity: new Set(scenario.toolCalls.map((call) => call.name)).size,
      instructionViolations: [],
      scopeViolations: [],
      latestInstructionHonored: true,
      phaseOrderValid: true,
    };
  }

  const { contract, context } = recording;
  const usedTools = new Set(scenario.toolCalls.map((call) => call.name));
  const allowedTools = new Set(contract.allowedToolNames || []);
  const forbiddenTools = new Set(contract.forbiddenToolNames || []);
  const instructionViolations = [];
  for (const name of contract.requiredToolNames || []) {
    if (!usedTools.has(name)) instructionViolations.push(`missing-required-tool:${name}`);
  }
  for (const call of scenario.toolCalls) {
    if (!allowedTools.has(call.name)) instructionViolations.push(`tool-not-allowed:${call.name}`);
    if (forbiddenTools.has(call.name)) instructionViolations.push(`forbidden-tool:${call.name}`);
    if (call.afterMessageIndex < context.latestUserMessageIndex) instructionViolations.push(`stale-instruction:${call.id}`);
  }

  const allowedPrefixes = contract.allowedPathPrefixes || [];
  const forbiddenPrefixes = contract.forbiddenPathPrefixes || [];
  const scopeViolations = [];
  for (const call of scenario.toolCalls) {
    for (const path of workspacePaths(call.input)) {
      if (forbiddenPrefixes.some((prefix) => pathMatchesPrefix(path, prefix))) scopeViolations.push(`${call.id}:forbidden:${path}`);
      else if (allowedPrefixes.length > 0 && !allowedPrefixes.some((prefix) => pathMatchesPrefix(path, prefix))) scopeViolations.push(`${call.id}:outside-allowed:${path}`);
    }
  }

  const phaseOrder = contract.phaseOrder || [];
  const phaseIndexes = scenario.toolCalls.map((call) => phaseOrder.indexOf(call.phase));
  const phaseOrderValid = phaseIndexes.every((index) => index >= 0)
    && phaseIndexes.every((index, position) => position === 0 || index >= phaseIndexes[position - 1])
    && phaseOrder.every((phase) => scenario.toolCalls.some((call) => call.phase === phase));
  return {
    taskClass: recording.taskClass,
    contextMessageCount: context.messageCount,
    normalizedContextChars: context.normalizedChars,
    toolDiversity: usedTools.size,
    instructionViolations,
    scopeViolations,
    latestInstructionHonored: instructionViolations.length === 0,
    phaseOrderValid,
  };
}

function collectMetrics(scenario, result, expected, fault = null) {
  const calls = scenario.toolCalls;
  const failedEvents = scenario.events.filter((event) => event.type === "tool.failed");
  const successfulEvents = scenario.events.filter((event) => event.type === "tool.completed");
  const successIds = new Set(successfulEvents.map((event) => event.toolCallId));
  const retryCount = failedEvents.filter((failure) => calls.some((call) => call.name === failure.name && successIds.has(call.id))).length;
  const allowedIds = new Set(expected.allowedToolIds || []);
  const unrelatedReads = scenario.recording ? 0 : calls.filter((call) => isRead(call) && !allowedIds.has(call.id)).length;
  const failureKinds = [...new Set(failedEvents.map((event) => event.error?.code || event.error?.category || "unknown"))];
  const terminalEvent = scenario.events.findLast((event) => event.type.startsWith("turn." ) && ["turn.completed", "turn.failed", "turn.cancelled"].includes(event.type));
  const presentationText = JSON.stringify(result.live.presentation) + JSON.stringify(result.replay.presentation) + JSON.stringify(result.refresh);
  const evidenceFields = [...new Set(scenario.events.flatMap((event) => Array.isArray(event.evidenceFields) ? event.evidenceFields : []))];
  const resourcePeakKb = Number(process.resourceUsage?.().maxRSS || 0);
  const peakRssMb = Math.round((resourcePeakKb || process.memoryUsage().rss / 1024) / 1024);
  const correct = result.live.text === scenario.expected.text
    && result.replay.text === scenario.expected.text
    && result.refresh.text === scenario.expected.text;
  const metrics = {
    id: scenario.id,
    correct,
    answerStatus: correct ? "correct" : "incorrect",
    toolCalls: calls.length,
    uniqueToolCalls: new Set(calls.map(targetKey)).size,
    unrelatedReads,
    retryCount,
    failureKinds,
    retryDecision: retryCount > 0 ? "retried" : (failedEvents.length ? "stopped" : "none"),
    terminalState: terminalEvent?.type === "turn.completed" ? "done" : terminalEvent?.type?.replace("turn.", "") || "unknown",
    evidenceFields,
    evidenceComplete: evidenceFields.length > 0 || successfulEvents.length === 0,
    userLeakPatterns: hasLeak(presentationText) ? ["internal-event-marker"] : [],
    eventCount: scenario.events.length,
    logicalDurationMs: Math.max(...scenario.events.map((event) => event.timestamp || 0)) - Math.min(...scenario.events.map((event) => event.timestamp || 0)),
    peakRssMb,
    tokenCount: null,
    tokenCountStatus: "unknown",
    ...engineeringMetrics(scenario),
  };
  if (fault === "unrelated-read") metrics.unrelatedReads += 1;
  if (fault === "retry") metrics.retryCount += 2;
  if (fault === "terminal") metrics.terminalState = "failed";
  if (fault === "leak") metrics.userLeakPatterns = ["internal-event-marker"];
  if (fault === "missing-evidence") metrics.evidenceComplete = false;
  if (fault === "memory") metrics.peakRssMb = Number.MAX_SAFE_INTEGER;
  if (fault === "instruction") {
    metrics.instructionViolations.push("forbidden-tool:injected");
    metrics.latestInstructionHonored = false;
  }
  if (fault === "scope") metrics.scopeViolations.push("injected:forbidden:src/server/injected.ts");
  if (fault === "phase") metrics.phaseOrderValid = false;
  return metrics;
}

function compare(metrics, expected) {
  const failures = [];
  if (metrics.correct !== expected.correct) failures.push(`correct=${metrics.correct} expected ${expected.correct}`);
  if (metrics.toolCalls > expected.maxToolCalls) failures.push(`toolCalls=${metrics.toolCalls} > ${expected.maxToolCalls}`);
  if (metrics.unrelatedReads > expected.maxUnrelatedReads) failures.push(`unrelatedReads=${metrics.unrelatedReads} > ${expected.maxUnrelatedReads}`);
  if (metrics.retryCount > expected.maxRetries) failures.push(`retryCount=${metrics.retryCount} > ${expected.maxRetries}`);
  if (metrics.terminalState !== expected.terminal) failures.push(`terminalState=${metrics.terminalState} expected ${expected.terminal}`);
  if (expected.requiredEvidence && !metrics.evidenceComplete) failures.push("evidenceComplete=false");
  if (metrics.userLeakPatterns.length) failures.push(`userLeakPatterns=${metrics.userLeakPatterns.join(",")}`);
  if (metrics.peakRssMb > expected.maxPeakRssMb) failures.push(`peakRssMb=${metrics.peakRssMb} > ${expected.maxPeakRssMb}`);
  if (expected.requiredInstructionCompliance && metrics.instructionViolations.length) failures.push(`instructionViolations=${metrics.instructionViolations.join(",")}`);
  if (expected.requiredScopeCompliance && metrics.scopeViolations.length) failures.push(`scopeViolations=${metrics.scopeViolations.join(",")}`);
  if (expected.requiredInstructionCompliance && !metrics.latestInstructionHonored) failures.push("latestInstructionHonored=false");
  if (expected.requiredPhaseOrder && !metrics.phaseOrderValid) failures.push("phaseOrderValid=false");
  if (metrics.toolDiversity < (expected.minToolDiversity || 0)) failures.push(`toolDiversity=${metrics.toolDiversity} < ${expected.minToolDiversity}`);
  if ((metrics.contextMessageCount ?? 0) < (expected.minContextMessages || 0)) failures.push(`contextMessageCount=${metrics.contextMessageCount ?? 0} < ${expected.minContextMessages}`);
  if ((metrics.normalizedContextChars ?? 0) < (expected.minContextChars || 0)) failures.push(`normalizedContextChars=${metrics.normalizedContextChars ?? 0} < ${expected.minContextChars}`);
  return failures;
}

export function evaluateBehavior({ scenarioId, fault = null } = {}) {
  if (fault && !FAULTS.has(fault)) throw new Error(`unsupported fault: ${fault}`);
  const catalog = loadReplayCatalog();
  const baseline = readBaseline();
  const scenarios = scenarioId ? catalog.scenarios.filter((scenario) => scenario.id === scenarioId) : catalog.scenarios;
  if (!scenarios.length) throw new Error(`unknown behavior scenario: ${scenarioId}`);
  const results = scenarios.map((scenario) => {
    const result = runReplayScenario(scenario, "replay");
    const expected = baseline.scenarios[scenario.id];
    if (!expected) return { id: scenario.id, status: "new_scenario", failures: [], correct: result.live.text === scenario.expected.text };
    const metrics = collectMetrics(scenario, result, expected, fault);
    const failures = compare(metrics, expected);
    const allowedChanges = new Set([
      ...(expected.allowExpectedChanges || []),
      ...String(process.env.MY_CODE_AGENT_EXPECTED_BEHAVIOR_CHANGES || "").split(",").map((value) => value.trim()).filter(Boolean),
    ]);
    const expectedOnly = failures.length > 0 && failures.every((failure) => allowedChanges.has(failure.split("=")[0]));
    return { ...metrics, status: failures.length === 0 ? "pass" : expectedOnly ? "expected_change" : "regression", failures };
  });
  return {
    version: 1,
    generatedAt: new Date().toISOString(),
    source: fixturePaths().map((path) => path.replaceAll("\\", "/").replace(ROOT.replaceAll("\\", "/"), "<workspace>")),
    baseline: BASELINE_PATH.replaceAll("\\", "/").replace(ROOT.replaceAll("\\", "/"), "<workspace>"),
    fault: fault || null,
    scenarios: results,
    passed: results.every((result) => result.status === "pass" || result.status === "expected_change"),
  };
}

export function reportMarkdown(report) {
  const lines = ["# Agent Behavior Baseline", "", `Generated: ${report.generatedAt}`, `Fault: ${report.fault || "none"}`, "", "| Scenario | Class | Status | Context | Tools/diversity | Instruction | Scope | Phase | Peak RSS |", "|---|---|---:|---:|---:|---|---|---|---:|"];
  for (const item of report.scenarios) {
    const context = item.contextMessageCount === null ? "n/a" : `${item.contextMessageCount}/${item.normalizedContextChars} chars`;
    lines.push(`| ${item.id} | ${item.taskClass} | ${item.status} | ${context} | ${item.toolCalls}/${item.toolDiversity} | ${item.latestInstructionHonored && !item.instructionViolations.length ? "pass" : "fail"} | ${item.scopeViolations.length ? "fail" : "pass"} | ${item.phaseOrderValid ? "pass" : "fail"} | ${item.peakRssMb}MB |`);
  }
  const failures = report.scenarios.flatMap((item) => item.failures.map((failure) => `${item.id}: ${failure}`));
  if (failures.length) lines.push("", "Failures:", ...failures.map((failure) => `- ${failure}`));
  return `${lines.join("\n")}\n`;
}

const args = process.argv.slice(2);
if (args.some((arg) => ["--check", "--json", "--markdown", "--write"].includes(arg))) {
  const scenarioIndex = args.indexOf("--scenario");
  const faultIndex = args.indexOf("--fault");
  const report = evaluateBehavior({ scenarioId: scenarioIndex >= 0 ? args[scenarioIndex + 1] : undefined, fault: faultIndex >= 0 ? args[faultIndex + 1] : null });
  if (args.includes("--write")) {
    const dir = resolve(ROOT, "docs/generated");
    mkdirSync(dir, { recursive: true });
    writeFileSync(resolve(dir, "agent-behavior-report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
    writeFileSync(resolve(dir, "agent-behavior-report.md"), reportMarkdown(report), "utf8");
  }
  if (args.includes("--json")) console.log(JSON.stringify(report, null, 2));
  else if (args.includes("--markdown") || args.includes("--write")) console.log(reportMarkdown(report));
  else console.log(`[agent-eval] ${report.scenarios.length} scenarios ${report.passed ? "passed" : "failed"}`);
  if (!report.passed) process.exitCode = 1;
}
