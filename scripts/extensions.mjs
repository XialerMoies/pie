#!/usr/bin/env node
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { capabilityComponentManager } from "../src/agent/capability-components.ts"
import { registerFirstPartyComponentPackages } from "../src/agent/component-package.ts"
import { defaultTrustStorePath } from "../src/agent/mcp/trust-store.ts"
import { ExtensionLifecycle } from "../src/agent/extension-lifecycle.ts"
import { defaultExtensionPackageStorePath, extensionPackageStore } from "../src/agent/extension-package-store.ts"
import { dirname, join } from "node:path"

const argv = process.argv.slice(2)
const action = argv[0] || "list"

function valueAfter(name) {
  const inline = argv.find((arg) => arg.startsWith(`${name}=`))
  if (inline) return inline.slice(name.length + 1)
  const index = argv.indexOf(name)
  const value = index >= 0 ? argv[index + 1] : undefined
  return value && !value.startsWith("--") ? value : undefined
}

function usage() {
  console.log("Usage: npm run extensions -- <list|install|trust|untrust|enable|disable|uninstall> [id] [--manifest file]")
}

const stateFile = resolve(valueAfter("--component-state-file") || join(dirname(defaultTrustStorePath()), "component-state.json"))
const packageFile = resolve(valueAfter("--package-state-file") || defaultExtensionPackageStorePath())
const id = valueAfter("--id") || (argv[1] && !argv[1].startsWith("--") ? argv[1] : undefined)

registerFirstPartyComponentPackages(capabilityComponentManager)
await capabilityComponentManager.restore(stateFile)
await extensionPackageStore.restore(packageFile)
const lifecycle = new ExtensionLifecycle(capabilityComponentManager, extensionPackageStore)

if (action === "list" || action === "view") {
  console.log(JSON.stringify({ packages: extensionPackageStore.list(), components: capabilityComponentManager.catalog().components.filter((state) => extensionPackageStore.get(state.manifest.id)) }, null, 2))
} else if (action === "install") {
  const manifestPath = valueAfter("--manifest")
  if (!manifestPath) throw new Error("extensions install requires --manifest <file>")
  const manifest = JSON.parse(readFileSync(resolve(manifestPath), "utf8"))
  const lifecycleState = await lifecycle.installPackage(manifest, {}, {
    compatibility: { hostVersion: "1.0.0", contractVersion: "1.0.0", engineVersion: "1.0.0" },
    trusted: false,
  })
  await capabilityComponentManager.save(stateFile)
  await extensionPackageStore.save(packageFile)
  console.log(JSON.stringify({ lifecycle: lifecycleState, package: extensionPackageStore.get(lifecycleState.componentId) }, null, 2))
} else {
  if (!id) throw new Error(`extensions ${action} requires <id>`)
  if (!extensionPackageStore.get(id)) throw new Error(`Unknown installed extension: ${id}`)
  lifecycle.adopt(id)
  let result
  if (action === "trust") result = await lifecycle.trust(id, true)
  else if (action === "untrust") result = await lifecycle.trust(id, false)
  else if (action === "enable") {
    await lifecycle.validate(id)
    await lifecycle.enable(id)
    result = await lifecycle.activate(id)
  } else if (action === "disable") result = await lifecycle.dispose(id)
  else if (action === "uninstall") result = await lifecycle.uninstall(id)
  else {
    usage()
    process.exitCode = 2
  }
  if (result) {
    await capabilityComponentManager.save(stateFile)
    await extensionPackageStore.save(packageFile)
    console.log(JSON.stringify({ lifecycle: result, package: extensionPackageStore.get(id) || null }, null, 2))
  }
}
