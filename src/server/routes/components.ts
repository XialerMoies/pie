import type { RouteHandler, ServerContext } from "./types.js"
import { CapabilityComponentError, capabilityComponentManager } from "../../agent/capability-components.js"
import {
  CapabilityComponentPackageError,
  componentPackageManifestFingerprint,
  firstPartyComponentPackage,
  firstPartyComponentPackageCatalog,
  firstPartyComponentPackageForComponent,
  normalizeCapabilityComponentPackageManifest,
  registerFirstPartyComponentPackages,
} from "../../agent/component-package.js"
import { reconcileMcpServerComponents } from "../../agent/mcp/MCPClientService.js"
import { loadMcpConfigFromCandidates, defaultGlobalConfigPath, getCandidatePaths } from "../../agent/mcp/config.js"
import { canonicalWorkspacePath, workspaceKey } from "../../data/data-layout.js"
import { existsSync, readdirSync } from "node:fs"
import { mkdir, readFile, stat, writeFile } from "node:fs/promises"
import { dirname, isAbsolute, join, resolve } from "node:path"
import { extensionManifestFromPackage } from "../../agent/extension-manifest.js"
import { extensionLifecycle } from "../../agent/extension-lifecycle.js"
import {
  defaultExtensionPackageStorePath,
  extensionPackageStore,
  extensionPackageUpdatePreview,
} from "../../agent/extension-package-store.js"
import { ExtensionSourceCatalog } from "../../agent/extension-source-catalog.js"
import {
  defaultExtensionSourceStorePath,
  ExtensionSourceError,
  extensionSourceStore,
} from "../../agent/extension-source-store.js"
import { parseBody } from "./parse-body.js"
import { readExtensionSettings, removeExtensionSettings, resolveExtensionSettings, updateExtensionSettings, type ExtensionSettingsScope } from "../../agent/extension-settings.js"

const cors = { "Access-Control-Allow-Origin": "*", "Cache-Control": "no-store" }

function componentStatePath(ctx: ServerContext): string {
  return join(ctx.groups.storage.paths.PI_CONFIG_DIR, "component-state.json")
}

async function persistComponentState(ctx: ServerContext): Promise<void> {
  await capabilityComponentManager.save(componentStatePath(ctx))
}

async function refreshAgentToolSession(ctx: ServerContext, componentIds: readonly string[]): Promise<void> {
  const affectsAgentTools = componentIds.some((componentId) => capabilityComponentManager.get(componentId)?.manifest.capability === "agent-tool")
  const runtime = ctx.groups.core.runtime as ServerContext["groups"]["core"]["runtime"] & { refreshTools?: () => Promise<void> }
  if (affectsAgentTools && typeof runtime.refreshTools === "function") await runtime.refreshTools()
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

let extensionSourceStoreLoadedPath = ""
async function ensureExtensionSourceStore(): Promise<void> {
  const filePath = defaultExtensionSourceStorePath()
  if (extensionSourceStoreLoadedPath === filePath) return
  await extensionSourceStore.restore(filePath)
  extensionSourceStoreLoadedPath = filePath
}

async function persistExtensionSourceState(): Promise<void> {
  await extensionSourceStore.save(defaultExtensionSourceStorePath())
}

const extensionPackageCompatibility = { hostVersion: "1.0.0", contractVersion: "1.0.0", engineVersion: "1.0.0" } as const
const extensionSourceCatalog = new ExtensionSourceCatalog(extensionPackageCompatibility)

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
  const status = error instanceof CapabilityComponentError || error instanceof CapabilityComponentPackageError || error instanceof ExtensionSourceError || error instanceof SyntaxError ? 400 : 500
  res.writeHead(status, { "Content-Type": "application/json", ...cors })
  res.end(JSON.stringify({
    ok: false,
    code: error instanceof CapabilityComponentError || error instanceof CapabilityComponentPackageError || error instanceof ExtensionSourceError ? error.code : "extension_operation_failed",
    error: error instanceof Error ? error.message : String(error),
  }))
}

const DIRECT_EXTENSION_MAX_BYTES = 1_048_576

async function readDirectExtensionManifest(location: string, kind: "file" | "https"): Promise<{ raw: string; manifest: Readonly<import("../../agent/component-package.js").CapabilityComponentPackageManifest> }> {
  const value = location.trim()
  if (!value) throw new CapabilityComponentPackageError("invalid_location", "安装位置不能为空")
  let raw: string
  if (kind === "file") {
    if (!isAbsolute(value)) throw new CapabilityComponentPackageError("invalid_location", "本地扩展路径必须是绝对路径")
    try {
      const path = resolve(value)
      const metadata = await stat(path)
      if (!metadata.isFile()) throw new CapabilityComponentPackageError("manifest_unreadable", "本地扩展位置必须是 manifest 文件")
      if (metadata.size > DIRECT_EXTENSION_MAX_BYTES) throw new CapabilityComponentPackageError("manifest_too_large", "扩展 manifest 超过 1 MiB")
      raw = await readFile(path, "utf8")
    } catch (error) {
      if (error instanceof CapabilityComponentPackageError) throw error
      throw new CapabilityComponentPackageError("manifest_unreadable", `无法读取扩展 manifest：${error instanceof Error ? error.message : String(error)}`)
    }
  } else {
    let url: URL
    try { url = new URL(value) } catch { throw new CapabilityComponentPackageError("invalid_location", "HTTPS 地址格式无效") }
    if (url.protocol !== "https:" || url.username || url.password || url.hash) throw new CapabilityComponentPackageError("invalid_location", "扩展地址必须是无凭据的 HTTPS manifest 地址")
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 10_000)
    try {
      const response = await fetch(url, { method: "GET", redirect: "error", credentials: "omit", signal: controller.signal })
      if (!response.ok) throw new CapabilityComponentPackageError("source_fetch_failed", `扩展地址返回 HTTP ${response.status}`)
      const contentLength = Number.parseInt(response.headers.get("content-length") || "0", 10)
      if (Number.isSafeInteger(contentLength) && contentLength > DIRECT_EXTENSION_MAX_BYTES) throw new CapabilityComponentPackageError("manifest_too_large", "扩展 manifest 超过 1 MiB")
      raw = await response.text()
    } catch (error) {
      if (error instanceof CapabilityComponentPackageError) throw error
      throw new CapabilityComponentPackageError(controller.signal.aborted ? "source_fetch_timeout" : "source_fetch_failed", controller.signal.aborted ? "扩展地址响应超时" : `无法获取扩展 manifest：${error instanceof Error ? error.message : String(error)}`)
    } finally { clearTimeout(timeout) }
  }
  if (Buffer.byteLength(raw, "utf8") > DIRECT_EXTENSION_MAX_BYTES) throw new CapabilityComponentPackageError("manifest_too_large", "扩展 manifest 超过 1 MiB")
  let input: unknown
  try { input = JSON.parse(raw) } catch (error) { throw new CapabilityComponentPackageError("invalid_manifest", `扩展 manifest 不是有效 JSON：${error instanceof Error ? error.message : String(error)}`) }
  const manifest = normalizeCapabilityComponentPackageManifest(input, extensionPackageCompatibility)
  return { raw, manifest }
}

async function stageDirectExtensionManifest(ctx: ServerContext, raw: string, manifest: Readonly<import("../../agent/component-package.js").CapabilityComponentPackageManifest>): Promise<string> {
  const directory = join(ctx.groups.storage.paths.PI_CONFIG_DIR, "extension-installs", manifest.packageId, manifest.packageVersion)
  await mkdir(directory, { recursive: true })
  const path = join(directory, "manifest.json")
  await writeFile(path, raw, { encoding: "utf8", flag: "wx" }).catch(async (error: NodeJS.ErrnoException) => {
    if (error.code !== "EEXIST") throw error
    const existing = await readFile(path, "utf8")
    if (componentPackageManifestFingerprint(normalizeCapabilityComponentPackageManifest(JSON.parse(existing), extensionPackageCompatibility)) !== componentPackageManifestFingerprint(manifest)) throw new CapabilityComponentPackageError("install_conflict", "受控安装目录中已存在不同的同版本 manifest")
  })
  return path
}

function isManagedFirstPartyOptional(componentId: string): boolean {
  const manifest = firstPartyComponentPackageForComponent(componentId)
  return manifest?.component.kind === "optional"
}

function installedFirstPartyAgentToolIds(): string[] {
  const removedPackages = new Set(capabilityComponentManager.catalog().uninstalledFirstPartyPackages)
  return firstPartyComponentPackageCatalog()
    .filter(({ packageId, component }) => component.kind === "optional"
      && component.source === "builtin"
      && component.capability === "agent-tool"
      && !removedPackages.has(packageId)
      && capabilityComponentManager.get(component.id))
    .map(({ component }) => component.id)
}

function managementComponentProjection(component: ReturnType<typeof capabilityComponentManager.require>) {
  const packageManifest = firstPartyComponentPackageForComponent(component.manifest.id)
  if (!packageManifest) return component
  return {
    ...component,
    manifest: {
      ...component.manifest,
      permissions: packageManifest.permissions,
    },
  }
}

function extensionSettingsPath(ctx: ServerContext, scope: ExtensionSettingsScope): string {
  if (scope === "user") return join(ctx.groups.storage.paths.PI_CONFIG_DIR, "extension-settings.json")
  const runtime = ctx.groups.core.runtime as { currentWorkspace?: string }
  const workspace = canonicalWorkspacePath(runtime.currentWorkspace || ctx.groups.storage.paths.APP_ROOT)
  return join(ctx.groups.storage.paths.DATA_DIR, "workspaces", workspaceKey(workspace), "extension-settings.json")
}

async function clearExtensionSettings(ctx: ServerContext, componentId: string): Promise<void> {
  const userPath = extensionSettingsPath(ctx, "user")
  const workspaceRoot = join(ctx.groups.storage.paths.DATA_DIR, "workspaces")
  const paths = [userPath]
  if (existsSync(workspaceRoot)) {
    for (const entry of readdirSync(workspaceRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const path = join(workspaceRoot, entry.name, "extension-settings.json")
      if (existsSync(path)) paths.push(path)
    }
  }
  await Promise.all([...new Set(paths)].filter((path) => existsSync(path)).map((path) => removeExtensionSettings(path, componentId)))
}

async function extensionSettingsProjection(ctx: ServerContext, componentId: string) {
  const state = capabilityComponentManager.get(componentId)
  if (!state || state.manifest.kind !== "optional") throw new CapabilityComponentError("unknown_extension", `Unknown optional extension: ${componentId}`, componentId)
  const settings = state.manifest.settings || []
  const [user, workspace] = await Promise.all([
    readExtensionSettings(extensionSettingsPath(ctx, "user"), componentId, settings),
    readExtensionSettings(extensionSettingsPath(ctx, "workspace"), componentId, settings),
  ])
  return { settings, values: { user, workspace, effective: resolveExtensionSettings(settings, user, workspace) } }
}

/** Read-only component catalog for the desktop host and diagnostics surfaces. */
export const handleComponents: RouteHandler = async (req, res, ctx) => {
  const parsedUrl = new URL(req.url || "/", `http://${req.headers?.host || "localhost"}`)

  const extensionSettingsMatch = parsedUrl.pathname.match(/^\/api\/extensions\/([a-z0-9][a-z0-9._-]*)\/settings$/u)
  if (extensionSettingsMatch && (req.method === "GET" || req.method === "PATCH")) {
    const [, componentId] = extensionSettingsMatch
    try {
      registerFirstPartyComponentPackages(capabilityComponentManager)
      if (req.method === "PATCH") {
        const body = await parseBody(req)
        const scope = body?.scope
        if (scope !== "user" && scope !== "workspace") throw new Error("settings scope must be user or workspace")
        const state = capabilityComponentManager.get(componentId)
        if (!state || state.manifest.kind !== "optional") throw new CapabilityComponentError("unknown_extension", `Unknown optional extension: ${componentId}`, componentId)
        await updateExtensionSettings(extensionSettingsPath(ctx, scope), componentId, state.manifest.settings || [], body?.values)
      }
      const projection = await extensionSettingsProjection(ctx, componentId)
      res.writeHead(200, { "Content-Type": "application/json", ...cors })
      res.end(JSON.stringify({ ok: true, componentId, ...projection }))
    } catch (error) {
      res.writeHead(400, { "Content-Type": "application/json", ...cors })
      res.end(JSON.stringify({
        ok: false,
        code: error instanceof CapabilityComponentError ? error.code : "invalid_extension_settings",
        error: error instanceof Error ? error.message : String(error),
      }))
    }
  return true
}

  const sourceItemMatch = parsedUrl.pathname.match(/^\/api\/extension-sources\/([a-z0-9][a-z0-9._-]*)\/(refresh|install|update-preview|update|remove)$/u)
  if (sourceItemMatch && req.method === "POST") {
    const [, sourceId, action] = sourceItemMatch
    try {
      await ensureExtensionSourceStore()
      const source = extensionSourceStore.get(sourceId)
      if (!source) {
        res.writeHead(404, { "Content-Type": "application/json", ...cors })
        res.end(JSON.stringify({ ok: false, code: "extension_source_not_found", error: `Unknown extension source: ${sourceId}` }))
        return true
      }
      if (action === "remove") {
        extensionSourceStore.remove(sourceId)
        await persistExtensionSourceState()
        res.writeHead(200, { "Content-Type": "application/json", ...cors })
        res.end(JSON.stringify({ ok: true, removed: sourceId }))
        return true
      }
      const packages = await extensionSourceCatalog.list(source)
      if (action === "refresh") {
        res.writeHead(200, { "Content-Type": "application/json", ...cors })
        res.end(JSON.stringify({ ok: true, source, packages }))
        return true
      }
      const body = await parseBody(req)
      const packageId = typeof body?.packageId === "string" ? body.packageId : ""
      const version = typeof body?.version === "string" ? body.version : ""
      const selected = packages.find((entry) => entry.packageId === packageId && entry.version === version)
      if (!selected) throw new ExtensionSourceError("source_package_not_found", `Package version not found in source ${sourceId}: ${packageId}@${version}`)
      await ensureExtensionPackageStore()
      const current = extensionPackageStore.get(selected.manifest.component.id)
      if (action === "update-preview") {
        if (!current) throw new ExtensionSourceError("update_not_installed", `No installed package can be updated: ${selected.manifest.component.id}`)
        res.writeHead(200, { "Content-Type": "application/json", ...cors })
        res.end(JSON.stringify({ ok: true, source, update: extensionPackageUpdatePreview(current, selected.manifest) }))
        return true
      }
      if (action === "install" && current) throw new ExtensionSourceError("extension_already_installed", `Extension is already installed: ${current.componentId}`)
      if (action === "update" && !current) throw new ExtensionSourceError("update_not_installed", `No installed package can be updated: ${selected.manifest.component.id}`)
      if (action === "update" && body?.confirm !== true) throw new ExtensionSourceError("update_confirmation_required", "Review update-preview and confirm this package update explicitly")
      if (current) extensionLifecycle.adopt(current.componentId)
      const snapshot = current
        ? await extensionLifecycle.replacePackage(current.componentId, selected.manifest, {}, { compatibility: extensionPackageCompatibility, trusted: current.trusted })
        : await extensionLifecycle.installPackage(selected.manifest, {}, { compatibility: extensionPackageCompatibility, trusted: false })
      await persistComponentState(ctx)
      await persistExtensionPackageState()
      await refreshAgentToolSession(ctx, [snapshot.componentId])
      res.writeHead(action === "update" ? 200 : 201, { "Content-Type": "application/json", ...cors })
      res.end(JSON.stringify({ ok: true, source, selected: { packageId, version }, extension: extensionPackageStore.get(snapshot.componentId), lifecycle: snapshot }))
    } catch (error) {
      writeExtensionError(res, error)
    }
    return true
  }

  if (parsedUrl.pathname === "/api/extension-sources" && (req.method === "GET" || req.method === "POST")) {
    try {
      await ensureExtensionSourceStore()
      if (req.method === "POST") {
        const body = await parseBody(req)
        const source = extensionSourceStore.add({
          id: typeof body?.id === "string" ? body.id : "",
          displayName: typeof body?.displayName === "string" ? body.displayName : typeof body?.name === "string" ? body.name : "",
          kind: body?.kind === undefined ? "file" : body.kind,
          indexPath: typeof body?.indexPath === "string" ? body.indexPath : typeof body?.path === "string" ? body.path : "",
          indexUrl: typeof body?.indexUrl === "string" ? body.indexUrl : typeof body?.url === "string" ? body.url : "",
          publicKey: typeof body?.publicKey === "string" ? body.publicKey : undefined,
          keyId: typeof body?.keyId === "string" ? body.keyId : undefined,
        })
        // Refuse malformed indexes before they can become a persistent source.
        try {
          await extensionSourceCatalog.list(source)
        } catch (error) {
          extensionSourceStore.remove(source.id)
          throw error
        }
        await persistExtensionSourceState()
        res.writeHead(201, { "Content-Type": "application/json", ...cors })
        res.end(JSON.stringify({ ok: true, source }))
      } else {
        res.writeHead(200, { "Content-Type": "application/json", ...cors })
        res.end(JSON.stringify({ ok: true, sources: extensionSourceStore.list() }))
      }
    } catch (error) {
      writeExtensionError(res, error)
    }
    return true
  }

  const sourceViewMatch = parsedUrl.pathname.match(/^\/api\/extension-sources\/([a-z0-9][a-z0-9._-]*)$/u)
  if (sourceViewMatch && req.method === "GET") {
    try {
      await ensureExtensionSourceStore()
      const source = extensionSourceStore.get(sourceViewMatch[1])
      if (!source) {
        res.writeHead(404, { "Content-Type": "application/json", ...cors })
        res.end(JSON.stringify({ ok: false, code: "extension_source_not_found", error: `Unknown extension source: ${sourceViewMatch[1]}` }))
      } else {
        res.writeHead(200, { "Content-Type": "application/json", ...cors })
        res.end(JSON.stringify({ ok: true, source, packages: await extensionSourceCatalog.list(source) }))
      }
    } catch (error) {
      writeExtensionError(res, error)
    }
    return true
  }

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

  // Third-party installation records a declaration only; no endpoint imports
  // or executes an entry path.
  if (parsedUrl.pathname === "/api/extensions/install-from-location" && req.method === "POST") {
    try {
      await ensureExtensionPackageStore()
      const body = await parseBody(req)
      const kind = body?.kind === "https" ? "https" : body?.kind === "file" ? "file" : ""
      if (!kind) throw new CapabilityComponentPackageError("invalid_location", "安装来源必须是本地文件或 HTTPS 地址")
      const location = typeof body?.location === "string" ? body.location : ""
      const { raw, manifest } = await readDirectExtensionManifest(location, kind)
      if (extensionPackageStore.get(manifest.component.id)) throw new CapabilityComponentError("duplicate_component", `Extension already installed: ${manifest.component.id}`, manifest.component.id)
      await stageDirectExtensionManifest(ctx, raw, manifest)
      const snapshot = await extensionLifecycle.installPackage(manifest, {}, {
        compatibility: extensionPackageCompatibility,
        trusted: false,
      })
      await persistComponentState(ctx)
      await persistExtensionPackageState()
      await refreshAgentToolSession(ctx, [snapshot.componentId])
      res.writeHead(201, { "Content-Type": "application/json", ...cors })
      res.end(JSON.stringify({ ok: true, extension: extensionPackageStore.get(snapshot.componentId), lifecycle: snapshot }))
    } catch (error) {
      writeExtensionError(res, error)
    }
    return true
  }

  if (parsedUrl.pathname === "/api/extensions/install" && req.method === "POST") {
    try {
      await ensureExtensionPackageStore()
      const body = await parseBody(req)
      const packageManifest = body && typeof body === "object" && "manifest" in body ? body.manifest : body
      const snapshot = await extensionLifecycle.installPackage(packageManifest, {}, {
        compatibility: extensionPackageCompatibility,
        trusted: false,
      })
      await persistComponentState(ctx)
      await persistExtensionPackageState()
      await refreshAgentToolSession(ctx, [snapshot.componentId])
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
      extensionLifecycle.adopt(componentId)
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
        await clearExtensionSettings(ctx, componentId)
      }
      await persistComponentState(ctx)
      await persistExtensionPackageState()
      await refreshAgentToolSession(ctx, [componentId])
      res.writeHead(200, { "Content-Type": "application/json", ...cors })
      res.end(JSON.stringify({ ok: true, lifecycle, extension: extensionPackageStore.get(componentId) || null }))
    } catch (error) {
      writeExtensionError(res, error)
    }
    return true
  }

  const agentToolCollectionMatch = parsedUrl.pathname.match(/^\/api\/components\/agent-tools\/(enable|disable)$/u)
  if (agentToolCollectionMatch && req.method === "POST") {
    const [, action] = agentToolCollectionMatch
    try {
      registerFirstPartyComponentPackages(capabilityComponentManager)
      const componentIds = installedFirstPartyAgentToolIds()
      for (const componentId of componentIds) {
        extensionLifecycle.adopt(componentId)
        if (action === "enable") {
          await extensionLifecycle.validate(componentId)
          await extensionLifecycle.enable(componentId)
          await extensionLifecycle.activate(componentId)
        } else {
          await extensionLifecycle.dispose(componentId)
        }
      }
      await persistComponentState(ctx)
      await refreshAgentToolSession(ctx, componentIds)
      const components = componentIds.map((componentId) => managementComponentProjection(capabilityComponentManager.require(componentId)))
      res.writeHead(200, { "Content-Type": "application/json", ...cors })
      res.end(JSON.stringify({ ok: true, components, catalog: capabilityComponentManager.catalog() }))
    } catch (error) {
      writeComponentError(res, error)
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
      extensionLifecycle.adopt(componentId)
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
      await persistComponentState(ctx)
      await refreshAgentToolSession(ctx, [componentId])
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
      extensionLifecycle.adopt(componentId)
      const state = capabilityComponentManager.require(componentId)
      await extensionLifecycle.uninstall(componentId)
      await clearExtensionSettings(ctx, componentId)
      await persistComponentState(ctx)
      await refreshAgentToolSession(ctx, [componentId])
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
      await extensionLifecycle.install(componentManifest.component, {}, { trusted: true })
      const component = capabilityComponentManager.require(componentManifest.component.id)
      await persistComponentState(ctx)
      await refreshAgentToolSession(ctx, [componentManifest.component.id])
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
    const extensions = catalog.components
      .filter((component) => component.manifest.kind === "optional" && !isIntegration(component))
      .map(managementComponentProjection)
    const integrations = catalog.components
      .filter((component) => component.manifest.kind === "optional" && isIntegration(component))
      .map(managementComponentProjection)
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
