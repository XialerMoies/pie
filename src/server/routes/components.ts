import type { RouteHandler, ServerContext } from "./types.js"
import { capabilityComponentManager } from "../../agent/capability-components.js"
import { getServersStatus } from "../../agent/mcp/MCPClientService.js"
import { defaultTrustStorePath, hashServerCommand, TrustStore } from "../../agent/mcp/trust-store.js"
import { loadMcpConfigFromCandidates, defaultGlobalConfigPath, getCandidatePaths } from "../../agent/mcp/config.js"
import { canonicalWorkspacePath } from "../../data/data-layout.js"
import { normalizeServerName } from "../../agent/mcp/MCPToolAdapter.js"
import { dirname, join } from "node:path"

/** Read-only component catalog for the desktop host and diagnostics surfaces. */
export const handleComponents: RouteHandler = async (req, res, ctx) => {
  if (req.url === "/api/components" && req.method === "GET") {
    const runtime = ctx.groups.core.runtime as any
    const workspace = canonicalWorkspacePath(runtime.currentWorkspace || ctx.groups.storage.paths.APP_ROOT)
    const config = await loadMcpConfigFromCandidates(getCandidatePaths(workspace, defaultGlobalConfigPath()))
    const statuses = getServersStatus()
    const trustStore = new TrustStore({ filePath: defaultTrustStorePath() })
    const beforeGeneration = capabilityComponentManager.catalog().generation
    for (const server of config.servers) {
      const status = statuses.find((item) => item.name === server.name)
      const trusted = trustStore.isTrusted(workspace, hashServerCommand(server.config))
      const healthy = status?.state === "connected"
      capabilityComponentManager.sync(`mcp-server.${normalizeServerName(server.name)}`, {
        version: "1",
        kind: "optional",
        capability: "mcp.server",
        source: "mcp",
        trusted,
        enabled: server.config.enabled !== false,
        health: healthy ? "healthy" : status?.state === "error" ? "broken" : "unknown",
        description: status?.error,
      })
    }
    if (capabilityComponentManager.catalog().generation !== beforeGeneration) {
      try {
        await capabilityComponentManager.save(join(dirname(defaultTrustStorePath()), "component-state.json"))
      } catch {
        // A read-only catalog must remain available even when persistence is unavailable.
      }
    }
    res.writeHead(200, {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": "no-store",
    })
    res.end(JSON.stringify(capabilityComponentManager.catalog()))
    return true
  }
  return false
}
