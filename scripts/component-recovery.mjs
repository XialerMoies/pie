#!/usr/bin/env node
import { dirname, join, resolve } from "node:path";
import { defaultTrustStorePath } from "../src/agent/mcp/trust-store.ts";
import { capabilityComponentManager } from "../src/agent/capability-components.ts";
import {
  firstPartyComponentPackage,
  installFirstPartyComponentPackage,
  registerFirstPartyComponentPackages,
} from "../src/agent/component-package.ts";

function valueAfter(argv, name) {
  const inline = argv.find((arg) => arg.startsWith(`${name}=`));
  if (inline) return inline.slice(name.length + 1);
  const index = argv.indexOf(name);
  const value = index >= 0 ? argv[index + 1] : undefined;
  return value && !value.startsWith("--") ? value : undefined;
}

export function parseComponentRecoveryArgs(argv = process.argv.slice(2)) {
  const marker = argv.find((arg) => arg === "--components" || arg.startsWith("--components="));
  const actions = new Set(["list", "health", "disable", "install", "uninstall", "rollback"]);
  let action;
  let positionalTarget;
  if (marker) {
    const markerIndex = argv.indexOf(marker);
    action = marker.includes("=") ? marker.slice(marker.indexOf("=") + 1) : argv[markerIndex + 1];
  } else if (actions.has(argv[0])) {
    // npm consumes unknown --options passed after `npm run ... --`; positional
    // actions keep the recovery command usable through the package script.
    action = argv[0];
    positionalTarget = argv[1] && !argv[1].startsWith("--") ? argv[1] : undefined;
  } else {
    return undefined;
  }
  const stateFile = valueAfter(argv, "--component-state-file")
    || join(dirname(defaultTrustStorePath()), "component-state.json");
  const target = valueAfter(argv, "--package-id") || valueAfter(argv, "--component-id") || valueAfter(argv, "--group") || positionalTarget;
  return { action: action || "list", stateFile: resolve(stateFile), target };
}

export async function runComponentRecovery({ argv, manager = capabilityComponentManager, stateFile } = {}) {
  const parsed = parseComponentRecoveryArgs(argv);
  if (!parsed) return false;
  const filePath = stateFile ? resolve(stateFile) : parsed.stateFile;
  registerFirstPartyComponentPackages(manager);
  await manager.restore(filePath);
  let result;
  if (parsed.action === "list") {
    result = manager.catalog();
  } else if (parsed.action === "health") {
    const required = manager.list().filter((state) => state.manifest.kind === "required");
    for (const state of required) await manager.healthCheckRequired(state.manifest.id);
    result = manager.catalog();
    await manager.save(filePath);
  } else if (parsed.action === "disable") {
    if (!parsed.target) throw new Error("--components disable requires --component-id <id>");
    result = manager.disableTree(parsed.target);
    await manager.save(filePath);
  } else if (parsed.action === "install") {
    if (!parsed.target) throw new Error("--components install requires --package-id <id>");
    const manifest = installFirstPartyComponentPackage(manager, parsed.target);
    result = { packageId: manifest.packageId, component: manager.require(manifest.component.id) };
    await manager.save(filePath);
  } else if (parsed.action === "uninstall") {
    if (!parsed.target) throw new Error("--components uninstall requires --component-id <id> or --package-id <id>");
    const componentId = firstPartyComponentPackage(parsed.target)?.component.id || parsed.target;
    result = manager.uninstall(componentId);
    await manager.save(filePath);
  } else if (parsed.action === "rollback") {
    if (!parsed.target) throw new Error("--components rollback requires --group <replacement-group>");
    result = manager.rollbackRequired(parsed.target);
    await manager.save(filePath);
  } else {
    throw new Error(`Unknown component recovery action: ${parsed.action}`);
  }
  console.log(JSON.stringify(result, null, 2));
  return true;
}

if (process.argv[1]?.replaceAll("\\", "/").endsWith("/scripts/component-recovery.mjs")) {
  runComponentRecovery().catch((error) => {
    console.error(`[components] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
