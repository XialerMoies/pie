import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";

export const FAILURE_ARTIFACT_VERSION = 1;
export const FAILURE_ARTIFACT_FILES = Object.freeze([
  "console-network.json",
  "dom-aria.json",
  "event-trace.json",
  "failure.json",
  "manifest.json",
  "process.json",
  "request-correlation.json",
  "screenshot.png",
  "session.jsonl",
  "test-config.json",
]);

const SENSITIVE_KEY = /(?:authorization|cookie|credential|password|secret|token|api.?key|private.?key|input|arguments?|params?|thought|thinking|content|text|output|command)/iu;
const SENSITIVE_TEXT = /(?:\b(?:api.?key|token|secret|password|authorization)\s*[:=]\s*(?:Bearer\s+)?\S+|\b(?:input|arguments?|params?|command|output|thought|thinking|content|text)\s*[:=]\s*[^\r\n]+|Bearer\s+\S+|\bsk-[A-Za-z0-9_-]{8,})/giu;

function sanitizeString(value) {
  return value
    .replace(SENSITIVE_TEXT, "[redacted]")
    .replace(/\bThought\b[^\r\n]*/giu, "[redacted-internal-event]")
    .replace(/[A-Za-z]:[\\/][^\r\n"'`,;)}\]]+/gu, "<absolute-path>")
    .replace(/(?<![:/\w>])\/(?!\/)[^\r\n"'`,;)}\]]+/gu, "<absolute-path>")
    .slice(0, 8_192);
}

export function sanitizeArtifactValue(value, key = "") {
  if (SENSITIVE_KEY.test(key)) return "[redacted]";
  if (Array.isArray(value)) return value.slice(0, 4_096).map((entry) => sanitizeArtifactValue(entry));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([childKey, entry]) => [childKey, sanitizeArtifactValue(entry, childKey)]));
  }
  return typeof value === "string" ? sanitizeString(value) : value;
}

function json(value) {
  return `${JSON.stringify(sanitizeArtifactValue(value), null, 2)}\n`;
}

function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

function normalizeSessionLines(lines) {
  const source = Array.isArray(lines) ? lines : [];
  return source.map((entry) => JSON.stringify(sanitizeArtifactValue(entry))).join("\n") + (source.length ? "\n" : "");
}

export function writeFailureArtifact(directory, evidence) {
  const target = resolve(directory);
  mkdirSync(target, { recursive: true });
  const screenshot = Buffer.isBuffer(evidence.screenshot) ? evidence.screenshot : Buffer.from(evidence.screenshot || "");
  const files = new Map([
    ["console-network.json", Buffer.from(json(evidence.consoleNetwork || {}))],
    ["dom-aria.json", Buffer.from(json(evidence.domAria || {}))],
    ["event-trace.json", Buffer.from(json(evidence.eventTrace || []))],
    ["failure.json", Buffer.from(json(evidence.failure || { code: "test_failure", message: "Cross-layer flow failed" }))],
    ["process.json", Buffer.from(json(evidence.process || {}))],
    ["request-correlation.json", Buffer.from(json(evidence.requestCorrelation || {}))],
    ["screenshot.png", screenshot],
    ["session.jsonl", Buffer.from(normalizeSessionLines(evidence.session || []))],
    ["test-config.json", Buffer.from(json(evidence.testConfig || {}))],
  ]);
  for (const [name, body] of files) writeFileSync(join(target, name), body);
  const manifest = {
    schemaVersion: FAILURE_ARTIFACT_VERSION,
    kind: "my-code-agent.failure-artifact",
    files: [...files].map(([name, body]) => ({ name, bytes: body.byteLength, sha256: sha256(body) })).sort((a, b) => a.name.localeCompare(b.name)),
    replay: sanitizeArtifactValue(evidence.replay || { driver: "validate" }),
  };
  writeFileSync(join(target, "manifest.json"), json(manifest));
  validateFailureArtifact(target);
  return target;
}

export function validateFailureArtifact(directory) {
  const target = resolve(directory);
  const actual = readdirSync(target).filter((name) => !name.startsWith(".")).sort();
  if (JSON.stringify(actual) !== JSON.stringify([...FAILURE_ARTIFACT_FILES])) {
    throw new Error(`failure artifact inventory drift: ${actual.join(", ")}`);
  }
  const manifest = JSON.parse(readFileSync(join(target, "manifest.json"), "utf8"));
  if (manifest.schemaVersion !== FAILURE_ARTIFACT_VERSION || manifest.kind !== "my-code-agent.failure-artifact") {
    throw new Error("unsupported failure artifact schema");
  }
  const declared = manifest.files.map((entry) => entry.name).sort();
  const expected = FAILURE_ARTIFACT_FILES.filter((name) => name !== "manifest.json");
  if (JSON.stringify(declared) !== JSON.stringify(expected)) throw new Error("failure artifact manifest inventory drift");
  for (const entry of manifest.files) {
    const body = readFileSync(join(target, entry.name));
    if (body.byteLength !== entry.bytes || sha256(body) !== entry.sha256) throw new Error(`failure artifact hash mismatch: ${entry.name}`);
  }
  const screenshot = readFileSync(join(target, "screenshot.png"));
  if (screenshot.byteLength < 8 || screenshot.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a") {
    throw new Error("failure artifact screenshot is not a PNG");
  }
  const inspect = (value, key = "") => {
    if (SENSITIVE_KEY.test(key) && value !== "[redacted]") throw new Error(`failure artifact contains forbidden sensitive field: ${key}`);
    if (Array.isArray(value)) return value.forEach((entry) => inspect(entry));
    if (value && typeof value === "object") return Object.entries(value).forEach(([childKey, entry]) => inspect(entry, childKey));
    if (typeof value === "string" && /(?:Bearer\s+(?!\[redacted\])\S+|\bsk-[A-Za-z0-9_-]{8,}|\bThought\b)/iu.test(value)) {
      throw new Error("failure artifact contains forbidden sensitive text");
    }
  };
  for (const name of actual.filter((entry) => entry.endsWith(".json"))) inspect(JSON.parse(readFileSync(join(target, name), "utf8")));
  const sessionText = readFileSync(join(target, "session.jsonl"), "utf8");
  for (const line of sessionText.split(/\r?\n/u).filter(Boolean)) inspect(JSON.parse(line));
  return manifest;
}

export function readArtifactJson(directory, name) {
  if (!FAILURE_ARTIFACT_FILES.includes(basename(name)) || !name.endsWith(".json")) throw new Error(`undeclared artifact JSON: ${name}`);
  return JSON.parse(readFileSync(join(resolve(directory), basename(name)), "utf8"));
}

export function artifactExists(directory) {
  return existsSync(join(resolve(directory), "manifest.json"));
}
