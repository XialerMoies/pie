import type { RouteHandler, ServerContext } from "./types.js"
import { CapabilityComponentError, capabilityComponentManager } from "../../agent/capability-components.js"
import {
  firstPartyComponentPackage,
  firstPartyComponentPackageCatalog,
  firstPartyComponentPackageForComponent,
  registerFirstPartyComponentPackages,
} from "../../agent/component-package.js"
import { reconcileMcpServerComponents } from "../../agent/mcp/MCPClientService.js"
import { defaultTrustStorePath } from "../../agent/mcp/trust-store.js"
import { loadMcpConfigFromCandidates, defaultGlobalConfigPath, getCandidatePaths } from "../../agent/mcp/config.js"
import { canonicalWorkspacePath } from "../../data/data-layout.js"
import { dirname, join } from "node:path"
import { extensionManifestFromPackage } from "../../agent/extension-manifest.js"
import { extensionLifecycle } from "../../agent/extension-lifecycle.js"
import { firstPartyExtensionHooks } from "../../agent/first-party-extension-contributions.js"
import {
  defaultExtensionPackageStorePath,
  extensionPackageStore,
} from "../../agent/extension-package-store.js"
import { parseBody } from "./parse-body.js"

const cors = { "Access-Control-Allow-Origin": "*", "Cache-Control": "no-store" }

function componentStatePath(): string {
  return join(dirname(defaultTrustStorePath()), "component-state.json")
}

async function persistComponentState(): Promise<void> {
  await capabilityComponentManager.save(componentStatePath())
}

let extensionPackageStoreLoadedPath = ""
async function ensureExtensionPackageStore(): Promise<void> {
  const filePath = defaultExtensionPackageStorePath()
  if (extensionPackageStoreLoadedPath === filePath) return
  await extensionPackageStore.restore(filePath)
  extensionPackageStoreLoadedPath = filePath
}

async function persistExtensionPackageState(): Promise<void> {
  await extensionPackageStore.save(defaultExtensionPackageStorePath())
}

function writeComponentError(res: Parameters<RouteHandler>[1], error: unknown): void {
  const known = error instanceof CapabilityComponentError
  res.writeHead(known ? 400 : 500, { "Content-Type": "application/json", ...cors })
  res.end(JSON.stringify({
    ok: false,
    code: known ? error.code : "component_operation_failed",
    error: error instanceof Error ? error.message : String(error),
    ...(known && error.componentId ? { componentId: error.componentId } : {}),
  }))
}

function writeExtensionError(res: Parameters<RouteHandler>[1], error: unknown): void {
  const status = error instanceof CapabilityComponentError || error instanceof SyntaxError ? 400 : 500
  res.writeHead(status, { "Content-Type": "application/json", ...cors })
  res.end(JSON.stringify({
    ok: false,
    code: error instanceof CapabilityComponentError ? error.code : "extension_operation_failed",
    error: error instanceof Error ? error.message : String(error),
  }))
}

function isManagedFirstPartyOptional(componentId: string): boolean {
  const manifest = firstPartyComponentPackageForComponent(componentId)
  return manifest?.component.kind === "optional"
}

/** Read-only component catalog for the desktop host and diagnostics surfaces. */
export const handleComponents: RouteHandler = async (req, res, ctx) => {
  const parsedUrl = new URL(req.url || "/", `http://${req.headers?.host || "localhost"}`)

  // Product extension projection. This is deliberately separate from the
  // internal component catalog and carries no productClass/hostSurface fields.
  if ((parsedUrl.pathname === "/api/extensions" || /^\/api\/extensions\/[a-z0-9][a-z0-9._-]*$/u.test(parsedUrl.pathname)) && req.method === "GET") {
    await ensureExtensionPackageStore()
    registerFirstPartyComponentPackages(capabilityComponentManager)
    const catalog = capabilityComponentManager.catalog()
    const stateById = new Map(catalog.components.map((item) => [item.manifest.id, item]))
    const extensions = firstPartyComponentPackageCatalog().map((entry) => {
      const packageManifest = firstPartyComponentPackage(entry.packageId)
      if (!packageManifest) throw new Error(`Missing first-party package ${entry.packageId}`)
      const manifest = extensionManifestFromPackage({
        packageId: packageManifest.packageId,
        packageVersion: packageManifest.packageVersion,
        entry: packageManifest.entry,
        source: packageManifest.source.kind === "registry" ? "registry" : packageManifest.source.kind === "user" ? "user" : packageManifest.source.kind === "workspace" ? "workspace" : "builtin",
        component: packageManifest.component,
        permissions: packageManifest.permissions,
        compatibility: packageManifest.compatibility,
      })
      const state = stateById.get(entry.component.id)
      return {
        manifest,
        installed: Boolean(state && !catalog.uninstalledFirstPartyPackages.includes(entry.packageId)),
        enabled: state?.enabled === true,
        trusted: state?.trusted === true,
        health: state?.health || "unavailable",
        status: state?.status || "disabled",
      }
    })
    const thirdParty = extensionPackageStore.list().map((record) => {
      const state = stateById.get(record.componentId)
      const manifest = extensionManifestFromPackage({
        packageId: record.manifest.packageId,
        packageVersion: record.manifest.packageVersion,
        entry: record.manifest.entry,
        source: record.manifest.source.kind === "registry"
          ? "registry"
          : record.manifest.source.kind === "mcp"
            ? "user"
            : record.manifest.source.kind,
        component: record.manifest.component,
        permissions: record.manifest.permissions,
        compatibility: record.manifest.compatibility,
      })
      return {
        manifest,
        packageId: record.packageId,
        packageVersion: record.packageVersion,
        fingerprint: record.fingerprint,
        source: record.source,
        installed: Boolean(state),
        enabled: state?.enabled === true,
        trusted: record.trusted && state?.trusted === true,
        health: state?.health || "unavailable",
        status: state?.status || "disabled",
      }
    })
    const allExtensions = [...extensions, ...thirdParty]
    if (parsedUrl.pathname !== "/api/extensions") {
      const id = parsedUrl.pathname.slice("/api/extensions/".length)
      const entry = allExtensions.find((candidate) => candidate.manifest.id === id || ("packageId" in candidate && candidate.packageId === id))
      if (!entry) {
        res.writeHead(404, { "Content-Type": "application/json", ...cors })
        res.end(JSON.stringify({ ok: false, code: "extension_not_found", error: `Unknown extension: ${id}` }))
        return true
      }
      res.writeHead(200, { "Content-Type": "application/json", ...cors })
      res.end(JSON.stringify({ schemaVersion: 1, generation: catalog.generation, extension: entry }))
      return true
    }
    res.writeHead(200, { "Content-Type": "application/json", ...cors })
    res.end(JSON.stringify({ schemaVersion: 1, generation: catalog.generation, extensions: allExtensions }))
    return true
  }

  // Third-party management deliberately accepts only a package declaration;
  // no endpoint imports or executes its entry path.
  if (parsedUrl.pathname === "/api/extensions/install" && req.method === "POST") {
    try {
      await ensureExtensionPackageStore()
      const body = await parseBody(req)
      const packageManifest = body && typeof body === "object" && "manifest" in body ? body.manifest : body
      const snapshot = await extensionLifecycle.installPackage(packageManifest, {}, {
        compatibility: { hostVersion: "1.0.0", contractVersion: "1.0.0", engineVersion: "1.0.0" },
        trusted: false,
      })
      await persistComponentState()
      await persistExtensionPackageState()
      res.writeHead(201, { "Content-Type": "application/json", ...cors })
      res.end(JSON.stringify({ ok: true, extension: extensionPackageStore.get(snapshot.componentId), lifecycle: snapshot }))
    } catch (error) {
      writeExtensionError(res, error)
    }
    return true
  }

  const extensionActionMatch = parsedUrl.pathname.match(/^\/api\/extensions\/([a-z0-9][a-z0-9._-]*)\/(trust|enable|disable|uninstall)$/u)
  if (extensionActionMatch && req.method === "POST") {
    const [, componentId, action] = extensionActionMatch
    try {
      await ensureExtensionPackageStore()
      if (!extensionPackageStore.get(componentId)) {
        res.writeHead(404, { "Content-Type": "application/json", ...cors })
        res.end(JSON.stringify({ ok: false, code: "extension_not_managed", error: "Only installed third-party extensions use this endpoint" }))
        return true
      }
      extensionLifecycle.adopt(componentId, firstPartyExtensionHooks(componentId))
      let lifecycle
      if (action === "trust") {
        const body = await parseBody(req)
        lifecycle = await extensionLifecycle.trust(componentId, body?.trusted !== false)
      } else if (action === "enable") {
        await extensionLifecycle.validate(componentId)
        await extensionLifecycle.enable(componentId)
        lifecycle = await extensionLifecycle.activate(componentId)
      } else if (action === "disable") {
        lifecycle = await extensionLifecycle.dispose(componentId)
      } else {
        lifecycle = await extensionLifecycle.uninstall(componentId)
      }
      await persistComponentState()
      await persistExtensionPackageState()
      res.writeHead(200, { "Content-Type": "application/json", ...cors })
      res.end(JSON.stringify({ ok: true, lifecycle, extension: extensionPackageStore.get(componentId) || null }))
    } catch (error) {
      writeExtensionError(res, error)
    }
    return true
  }

  const actionMatch = parsedUrl.pathname.match(/^\/api\/components\/([a-z0-9][a-z0-9._-]*)\/(enable|disable)$/u)
  if (actionMatch && req.method === "POST") {
    const [, componentId, action] = actionMatch
    try {
      registerFirstPartyComponentPackages(capabilityComponentManager)
      // The generic component surface only governs packages shipped in this
      // app. MCP servers keep their configuration and lifecycle in /api/mcp.
      if (!isManagedFirstPartyOptional(componentId)) {
        res.writeHead(404, { "Content-Type": "application/json", ...cors })
        res.end(JSON.stringify({ ok: false, code: "component_not_managed", error: "This component is not managed by the desktop component pane" }))
        return true
      }
      extensionLifecycle.adopt(componentId, firstPartyExtensionHooks(componentId))
      let state
      if (action === "enable") {
        await extensionLifecycle.validate(componentId)
        await extensionLifecycle.enable(componentId)
        await extensionLifecycle.activate(componentId)
        state = capabilityComponentManager.require(componentId)
      } else {
        await extensionLifecycle.dispose(componentId)
        state = capabilityComponentManager.require(componentId)
      }
      await persistComponentState()
      res.writeHead(200, { "Content-Type": "application/json", ...cors })
      res.end(JSON.stringify({ ok: true, component: state, catalog: capabilityComponentManager.catalog() }))
    } catch (error) {
      writeComponentError(res, error)
    }
    return true
  }

  const uninstallMatch = parsedUrl.pathname.match(/^\/api\/components\/([a-z0-9][a-z0-9._-]*)\/uninstall$/u)
  if (uninstallMatch && req.method === "POST") {
    const [, componentId] = uninstallMatch
    try {
      registerFirstPartyComponentPackages(capabilityComponentManager)
      if (!isManagedFirstPartyOptional(componentId)) {
        res.writeHead(404, { "Content-Type": "application/json", ...cors })
        res.end(JSON.stringify({ ok: false, code: "component_not_managed", error: "This component is not managed by the desktop component pane" }))
        return true
      }
      extensionLifecycle.adopt(componentId, firstPartyExtensionHooks(componentId))
      const state = capabilityComponentManager.require(componentId)
      await extensionLifecycle.uninstall(componentId)
      await persistComponentState()
      res.writeHead(200, { "Content-Type": "application/json", ...cors })
      res.end(JSON.stringify({ ok: true, component: state, catalog: capabilityComponentManager.catalog() }))
    } catch (error) {
      writeComponentError(res, error)
    }
    return true
  }

  const installMatch = parsedUrl.pathname.match(/^\/api\/components\/packages\/([a-z0-9][a-z0-9._-]*)\/install$/u)
  if (installMatch && req.method === "POST") {
    const [, packageId] = installMatch
    try {
      const manifest = firstPartyComponentPackage(packageId)
      if (!manifest || manifest.component.kind !== "optional") {
        res.writeHead(404, { "Content-Type": "application/json", ...cors })
        res.end(JSON.stringify({ ok: false, code: "package_not_installable", error: "This package cannot be restored from the desktop component pane" }))
        return true
      }
      const componentManifest = firstPartyComponentPackage(packageId)
      if (!componentManifest) throw new CapabilityComponentError("unknown_first_party_package", `Unknown first-party package: ${packageId}`)
      await extensionLifecycle.install(componentManifest.component, firstPartyExtensionHooks(componentManifest.component.id), { trusted: true })
      const component = capabilityComponentManager.require(componentManifest.component.id)
      await persistComponentState()
      res.writeHead(200, { "Content-Type": "application/json", ...cors })
      res.end(JSON.stringify({ ok: true, component, catalog: capabilityComponentManager.catalog() }))
    } catch (error) {
      writeComponentError(res, error)
    }
    return true
  }

  // The desktop management surface receives a product projection rather than
  // the kernel catalog. Core services stay available to host reconciliation
  // through /api/components but never become user-facing list entries.
  if (parsedUrl.pathname === "/api/components" && parsedUrl.searchParams.get("view") === "management" && req.method === "GET") {
    registerFirstPartyComponentPackages(capabilityComponentManager)
    const runtime = ctx.groups.core.runtime as any
    const workspace = canonicalWorkspacePath(runtime.currentWorkspace || ctx.groups.storage.paths.APP_ROOT)
    const config = await loadMcpConfigFromCandidates(getCandidatePaths(workspace, dirname(defaultGlobalConfigPath())))
    await reconcileMcpServerComponents(workspace, config.servers)
    const catalog = capabilityComponentManager.catalog()
    const isIntegration = (component: { manifest: { source?: string; hostSurface?: string } }): boolean => component.manifest.source === "mcp" || component.manifest.hostSurface === "mcp-service"
    const removed = new Set(catalog.uninstalledFirstPartyPackages)
    const extensions = catalog.components.filter((component) => component.manifest.kind === "optional" && !isIntegration(component))
    const integrations = catalog.components.filter((component) => component.manifest.kind === "optional" && isIntegration(component))
    const availableExtensions = firstPartyComponentPackageCatalog().filter((entry) => removed.has(entry.packageId) && entry.component.kind === "optional" && !isIntegration({ manifest: entry.component }))
    res.writeHead(200, { "Content-Type": "application/json", ...cors })
    res.end(JSON.stringify({
      schemaVersion: catalog.schemaVersion,
      generation: catalog.generation,
      extensions,
      integrations,
      availableExtensions,
    }))
    return true
  }

  return false
}
