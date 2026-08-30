#!/usr/bin/env node
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { capabilityComponentManager } from "../src/agent/capability-components.ts"
import { normalizeCapabilityComponentPackageManifest, registerFirstPartyComponentPackages } from "../src/agent/component-package.ts"
import { defaultTrustStorePath } from "../src/agent/mcp/trust-store.ts"
import { ExtensionLifecycle } from "../src/agent/extension-lifecycle.ts"
import { defaultExtensionPackageStorePath, extensionPackageStore, extensionPackageUpdatePreview } from "../src/agent/extension-package-store.ts"
import { extensionManifestFromPackage } from "../src/agent/extension-manifest.ts"
import { ExtensionSourceCatalog } from "../src/agent/extension-source-catalog.ts"
import { defaultExtensionSourceStorePath, extensionSourceStore } from "../src/agent/extension-source-store.ts"
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
  console.log("Usage: npm run extensions -- <list|validate|install|trust|untrust|enable|disable|uninstall|source-list|source-add|source-remove|source-view|source-install|source-update-preview|source-update> [id] [--manifest file]")
}

function validateManifestPath() {
  return valueAfter("--manifest") || (argv[1] && !argv[1].startsWith("--") ? argv[1] : undefined)
}

function extensionSummary(manifest) {
  const permissions = manifest.permissions.capabilities.length ? manifest.permissions.capabilities.join("、") : "无额外权限"
  const settings = manifest.settings?.length
    ? manifest.settings.map((setting) => `${setting.label} (${setting.type})`).join("、")
    : "无"
  const agent = manifest.agentConfig
    ? `超时 ${manifest.agentConfig.timeoutMs ?? "宿主默认"} ms；并发 ${manifest.agentConfig.maxConcurrent ?? "宿主默认"}`
    : "宿主默认"
  return [
    "扩展校验通过",
    `标识: ${manifest.id}`,
    `标题: ${manifest.displayName || manifest.id}`,
    `作者: ${manifest.publisher || "未提供"}`,
    `版本: ${manifest.version}`,
    `贡献点: ${manifest.contributions.join("、")}`,
    `权限: ${permissions}`,
    `Agent 限额: ${agent}`,
    `设置项: ${settings}`,
    `兼容性: 宿主 ${manifest.compatibility.host}；契约 ${manifest.compatibility.contract}`,
  ].join("\n")
}

function validateErrorDetails(error) {
  if (error instanceof SyntaxError) {
    return { code: "invalid_json", reason: "manifest 不是有效的 JSON", advice: "检查逗号、引号和 JSON 结构后重试。" }
  }
  if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
    return { code: "manifest_not_found", reason: "找不到 manifest 文件", advice: "检查 --manifest 路径是否存在且可读。" }
  }
  const code = error && typeof error === "object" && "code" in error && typeof error.code === "string"
    ? error.code
    : "invalid_manifest"
  const reason = error instanceof Error ? error.message : String(error || "未知校验错误")
  const advice = {
    invalid_compatibility: "使用受支持的 host、contract 和 engine 版本范围。",
    invalid_identity: "检查 packageId、component.id 和版本格式。",
    identity_mismatch: "使 package 与 component 的身份、版本和来源映射保持一致。",
    invalid_isolation: "使用不含绝对路径或 .. 的相对 entry 和隔离路径。",
    invalid_permissions: "仅声明宿主支持的文件、网络、子进程和密钥权限。",
    invalid_resources: "将资源上限调整到宿主允许的正整数范围内。",
    invalid_signature: "检查签名算法、摘要格式和 keyId。",
    missing_signature: "为非内置 package 声明签名。",
    invalid_source: "为非内置 package 提供来源 origin 与 SHA-256 digest。",
  }[code] || "根据原因修正对应 manifest 字段后重试。"
  return { code, reason, advice }
}

function printValidateError(manifestPath, error) {
  const details = validateErrorDetails(error)
  console.error([
    "扩展校验失败",
    `文件: ${manifestPath ? resolve(manifestPath) : "未提供"}`,
    `代码: ${details.code}`,
    `原因: ${details.reason}`,
    `修复建议: ${details.advice}`,
  ].join("\n"))
}

function printSourceError(error) {
  const details = validateErrorDetails(error)
  console.error([
    "扩展来源操作失败",
    `代码: ${details.code}`,
    `原因: ${details.reason}`,
    `修复建议: ${details.advice}`,
  ].join("\n"))
}

if (action === "validate") {
  const manifestPath = validateManifestPath()
  if (!manifestPath) {
    printValidateError(undefined, new Error("extensions validate requires --manifest <file>"))
    process.exitCode = 2
  } else {
    try {
      const packageManifest = normalizeCapabilityComponentPackageManifest(JSON.parse(readFileSync(resolve(manifestPath), "utf8")), {
        hostVersion: "1.0.0", contractVersion: "1.0.0", engineVersion: "1.0.0",
      })
      const manifest = extensionManifestFromPackage({
        packageId: packageManifest.packageId,
        packageVersion: packageManifest.packageVersion,
        entry: packageManifest.entry,
        source: packageManifest.source.kind === "registry" ? "registry" : packageManifest.source.kind === "mcp" ? "user" : packageManifest.source.kind,
        component: packageManifest.component,
        permissions: packageManifest.permissions,
        compatibility: packageManifest.compatibility,
      })
      console.log(extensionSummary(manifest))
    } catch (error) {
      printValidateError(manifestPath, error)
      process.exitCode = 1
    }
  }
} else if (action.startsWith("source-")) {
  const sourceFile = resolve(valueAfter("--source-state-file") || defaultExtensionSourceStorePath())
  const compatibility = { hostVersion: "1.0.0", contractVersion: "1.0.0", engineVersion: "1.0.0" }
  try {
    await extensionSourceStore.restore(sourceFile)
    const sourceId = valueAfter("--id") || (argv[1] && !argv[1].startsWith("--") ? argv[1] : undefined)
    if (action === "source-list") {
      console.log(JSON.stringify({ sources: extensionSourceStore.list() }, null, 2))
    } else if (action === "source-add") {
      const kind = valueAfter("--kind") || "file"
      const indexPath = valueAfter("--path")
      const indexUrl = valueAfter("--url")
      const keyFile = valueAfter("--public-key-file")
      const publicKey = keyFile ? readFileSync(resolve(keyFile), "utf8") : valueAfter("--public-key")
      if (!sourceId || (kind === "file" && !indexPath) || (kind === "https" && (!indexUrl || !publicKey || !valueAfter("--key-id")))) {
        throw new Error("source-add requires <id> and --path <index.json>, or --kind https --url <https-url> --key-id <id> --public-key-file <pem>")
      }
      const source = extensionSourceStore.add({ id: sourceId, displayName: valueAfter("--name") || sourceId, kind, indexPath, indexUrl, publicKey, keyId: valueAfter("--key-id") })
      try {
        await new ExtensionSourceCatalog(compatibility).list(source)
      } catch (error) {
        extensionSourceStore.remove(source.id)
        throw error
      }
      await extensionSourceStore.save(sourceFile)
      console.log(JSON.stringify({ source }, null, 2))
    } else if (action === "source-remove") {
      if (!sourceId) throw new Error("source-remove requires <id>")
      if (!extensionSourceStore.remove(sourceId)) throw new Error(`Unknown extension source: ${sourceId}`)
      await extensionSourceStore.save(sourceFile)
      console.log(JSON.stringify({ removed: sourceId }, null, 2))
    } else if (action === "source-view" || action === "source-refresh") {
      if (!sourceId) throw new Error(`${action} requires <id>`)
      const source = extensionSourceStore.get(sourceId)
      if (!source) throw new Error(`Unknown extension source: ${sourceId}`)
      const packages = await new ExtensionSourceCatalog(compatibility).list(source)
      console.log(JSON.stringify({ source, packages }, null, 2))
    } else if (action === "source-install" || action === "source-update-preview" || action === "source-update") {
      const packageId = argv[2] && !argv[2].startsWith("--") ? argv[2] : undefined
      const version = valueAfter("--version")
      if (!sourceId || !packageId || !version) throw new Error(`${action} requires <source-id> <package-id> --version <version>`)
      const source = extensionSourceStore.get(sourceId)
      if (!source) throw new Error(`Unknown extension source: ${sourceId}`)
      const selected = await new ExtensionSourceCatalog(compatibility).find(source, packageId, version)
      const stateFile = resolve(valueAfter("--component-state-file") || join(dirname(defaultTrustStorePath()), "component-state.json"))
      const packageFile = resolve(valueAfter("--package-state-file") || defaultExtensionPackageStorePath())
      registerFirstPartyComponentPackages(capabilityComponentManager)
      await capabilityComponentManager.restore(stateFile)
      await extensionPackageStore.restore(packageFile)
      const lifecycle = new ExtensionLifecycle(capabilityComponentManager, extensionPackageStore)
      const current = extensionPackageStore.get(selected.manifest.component.id)
      if (action === "source-update-preview") {
        if (!current) throw new Error(`No installed package can be updated: ${selected.manifest.component.id}`)
        console.log(JSON.stringify({ source, update: extensionPackageUpdatePreview(current, selected.manifest) }, null, 2))
      } else {
        if (action === "source-update" && valueAfter("--confirm") !== "true") {
          throw new Error("source-update requires --confirm=true after reviewing source-update-preview")
        }
        if (action === "source-install" && current) throw new Error(`Extension is already installed; use source-update-preview and source-update: ${current.componentId}`)
        if (action === "source-update" && !current) throw new Error(`No installed package can be updated: ${selected.manifest.component.id}`)
        if (current) lifecycle.adopt(current.componentId)
        const lifecycleState = current
          ? await lifecycle.replacePackage(current.componentId, selected.manifest, {}, { compatibility, trusted: current.trusted })
          : await lifecycle.installPackage(selected.manifest, {}, { compatibility, trusted: false })
        await capabilityComponentManager.save(stateFile)
        await extensionPackageStore.save(packageFile)
        console.log(JSON.stringify({ source, selected: { packageId, version }, lifecycle: lifecycleState, package: extensionPackageStore.get(lifecycleState.componentId) }, null, 2))
      }
    } else {
      usage()
      process.exitCode = 2
    }
  } catch (error) {
    printSourceError(error)
    process.exitCode = 1
  }
} else {
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
}
