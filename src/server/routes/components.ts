import type { RouteHandler, ServerContext } from "./types.js"
import { capabilityComponentManager } from "../../agent/capability-components.js"
import { reconcileMcpServerComponents } from "../../agent/mcp/MCPClientService.js"
import { defaultTrustStorePath } from "../../agent/mcp/trust-store.js"
import { loadMcpConfigFromCandidates, defaultGlobalConfigPath, getCandidatePaths } from "../../agent/mcp/config.js"
import { canonicalWorkspacePath } from "../../data/data-layout.js"
import { dirname, join } from "node:path"

/** Read-only component catalog for the desktop host and diagnostics surfaces. */
export const handleComponents: RouteHandler = async (req, res, ctx) => {
  if (req.url === "/api/components" && req.method === "GET") {
    const runtime = ctx.groups.core.runtime as any
    const workspace = canonicalWorkspacePath(runtime.currentWorkspace || ctx.groups.storage.paths.APP_ROOT)
    const config = await loadMcpConfigFromCandidates(getCandidatePaths(workspace, defaultGlobalConfigPath()))
    const beforeGeneration = capabilityComponentManager.catalog().generation
    await reconcileMcpServerComponents(workspace, config.servers)
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
