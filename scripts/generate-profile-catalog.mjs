#!/usr/bin/env node
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { buildAllProfileCatalogs } from "../src/agent/profile-catalog.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUTPUT = resolve(ROOT, "docs/generated/profile-catalog.json");

export function serializeProfileCatalog(catalogs) {
  return `${JSON.stringify({ schemaVersion: 1, generatedAt: "deterministic", profiles: catalogs }, null, 2)}\n`;
}

export function buildProfileCatalogDocument() {
  return { schemaVersion: 1, generatedAt: "deterministic", profiles: buildAllProfileCatalogs() };
}

export async function checkProfileCatalog(output = OUTPUT) {
  if (!existsSync(output)) return { ok: false, reason: "missing" };
  const actual = await readFile(output, "utf8");
  const expected = serializeProfileCatalog(buildProfileCatalogDocument().profiles);
  return actual === expected ? { ok: true } : { ok: false, reason: "out-of-date" };
}

const isMain = process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (isMain) {
  if (process.argv.includes("--check")) {
    const result = await checkProfileCatalog();
    if (!result.ok) {
      console.error("Profile catalog is out of date. Run: npm run profiles:generate");
      process.exitCode = 1;
    }
  } else {
    const document = buildProfileCatalogDocument();
    await mkdir(dirname(OUTPUT), { recursive: true });
    await writeFile(OUTPUT, serializeProfileCatalog(document.profiles), "utf8");
    console.log(`Generated ${relative(ROOT, OUTPUT).replaceAll("\\", "/")}`);
  }
}
