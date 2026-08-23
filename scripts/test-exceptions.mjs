#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const EXCEPTIONS_FILE = resolve(ROOT, "test/test-exceptions.json");

export function loadTestExceptions() {
  return JSON.parse(readFileSync(EXCEPTIONS_FILE, "utf8"));
}

export function validateTestExceptions(entries = loadTestExceptions()) {
  const errors = [];
  if (!entries || entries.version !== 1 || !Array.isArray(entries.exceptions)) return ["test exception registry must have version=1 and exceptions[]"];
  const seen = new Set();
  const today = new Date().toISOString().slice(0, 10);
  for (const entry of entries.exceptions) {
    const key = `${entry.file}:${entry.kind}`;
    if (seen.has(key)) errors.push(`duplicate test exception: ${key}`);
    seen.add(key);
    for (const field of ["file", "kind", "reason", "owner", "expires"]) if (typeof entry[field] !== "string" || !entry[field].trim()) errors.push(`${key}: missing ${field}`);
    if (!/^\d{4}-\d{2}-\d{2}$/u.test(entry.expires ?? "")) errors.push(`${key}: expires must be YYYY-MM-DD`);
    else if (entry.expires < today) errors.push(`${key}: exception expired on ${entry.expires}`);
    if (!["skip", "platform_exclusion", "live_opt_in"].includes(entry.kind)) errors.push(`${key}: unsupported kind ${entry.kind}`);
    const sourcePath = resolve(ROOT, entry.file);
    if (!existsSync(sourcePath)) errors.push(`${key}: source file does not exist`);
    else {
      const source = readFileSync(sourcePath, "utf8");
      const marker = entry.kind === "live_opt_in" ? /t\.skip|PROVIDER_MATRIX_FILE/u
        : entry.kind === "platform_exclusion" ? /process\.platform/u
          : entry.kind === "skip" ? /\.skip\b|skip:/u
            : null;
      if (marker && !marker.test(source)) errors.push(`${key}: source has no ${entry.kind} marker`);
    }
  }
  return errors;
}

if (process.argv.includes("--check")) {
  const errors = validateTestExceptions();
  if (errors.length) { console.error(errors.join("\n")); process.exitCode = 1; }
  else console.log(`[test-exceptions] ${loadTestExceptions().exceptions.length} governed exceptions valid`);
}
