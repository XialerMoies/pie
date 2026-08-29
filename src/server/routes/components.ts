import type { RouteHandler, ServerContext } from "./types.js"
import { CapabilityComponentError, capabilityComponentManager } from "../../agent/capability-components.js"
import {
  firstPartyComponentPackage,
  firstPartyComponentPackageCatalog,
  firstPartyComponentPackageForComponent,
  installFirstPartyComponentPackage,
  registerFirstPartyComponentPackages,
} from "../../agent/component-package.js"
import { reconcileMcpServerComponents } from "../../agent/mcp/MCPClientService.js"
import { defaultTrustStorePath } from "../../agent/mcp/trust-store.js"
import { loadMcpConfigFromCandidates, defaultGlobalConfigPath, getCandidatePaths } from "../../agent/mcp/config.js"
import { canonicalWorkspacePath } from "../../data/data-layout.js"
import { dirname, join } from "node:path"
import { extensionManifestFromPackage } from "../../agent/extension-manifest.js"

const cors = { "Access-Control-Allow-Origin": "*", "Cache-Control": "no-store" }

function componentStatePath(): string {
  return join(dirname(defaultTrustStorePath()), "component-state.json")
}

async function persistComponentState(): Promise<void> {
  await capabilityComponentManager.save(componentStatePath())
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

function isManagedFirstPartyOptional(componentId: string): boolean {
  const manifest = firstPartyComponentPackageForComponent(componentId)
  return manifest?.component.kind === "optional"
}

/** Read-only component catalog for the desktop host and diagnostics surfaces. */
export const handleComponents: RouteHandler = async (req, res, ctx) => {
  const parsedUrl = new URL(req.url || "/", `http://${req.headers?.host || "localhost"}`)

  // Product extension projection. This is deliberately separate from the
  // internal component catalog and carries no productClass/hostSurface fields.
  if (parsedUrl.pathname === "/api/extensions" && req.method === "GET") {
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
    res.writeHead(200, { "Content-Type": "application/json", ...cors })
    res.end(JSON.stringify({ schemaVersion: 1, generation: catalog.generation, extensions }))
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
      const state = action === "enable"
        ? capabilityComponentManager.enable(componentId)
        : capabilityComponentManager.disable(componentId)
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
      const state = capabilityComponentManager.uninstall(componentId)
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
      const component = installFirstPartyComponentPackage(capabilityComponentManager, packageId)
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
    const config = await loadMcpConfigFromCandidates(getCandidatePaths(workspace, defaultGlobalConfigPath()))
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

  if (req.url === "/api/components" && req.method === "GET") {
    // The catalog can be served by a lightweight route test/CLI path that did
    // not instantiate the Agent tool host. Seed declarations, never code.
    registerFirstPartyComponentPackages(capabilityComponentManager)
    const runtime = ctx.groups.core.runtime as any
    const workspace = canonicalWorkspacePath(runtime.currentWorkspace || ctx.groups.storage.paths.APP_ROOT)
    const config = await loadMcpConfigFromCandidates(getCandidatePaths(workspace, defaultGlobalConfigPath()))
    const beforeGeneration = capabilityComponentManager.catalog().generation
    await reconcileMcpServerComponents(workspace, config.servers)
    if (capabilityComponentManager.catalog().generation !== beforeGeneration) {
      try {
        await persistComponentState()
      } catch {
        // A read-only catalog must remain available even when persistence is unavailable.
      }
    }
    res.writeHead(200, {
      "Content-Type": "application/json",
      ...cors,
    })
    res.end(JSON.stringify({
      ...capabilityComponentManager.catalog(),
      availablePackages: firstPartyComponentPackageCatalog(),
    }))
    return true
  }
  return false
}
