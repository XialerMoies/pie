import type { RouteHandler } from "./types.js"
import { getMcpIntegrationRecords } from "../../agent/mcp/MCPClientService.js"
import { loadAuthorizedMcpConfig } from "./dashboard-mcp.js"

/** External instances have their own lifecycle; this route never returns config secrets. */
export const handleIntegrations: RouteHandler = async (req, res, ctx) => {
  if (req.url !== "/api/integrations" || req.method !== "GET") return false
  const runtime = ctx.groups.core.runtime as any
  const workspace = runtime.currentWorkspace || ctx.groups.storage.paths.APP_ROOT
  try {
    const config = await loadAuthorizedMcpConfig(ctx, workspace, "integrations.mcp.config")
    const records = await getMcpIntegrationRecords(workspace, config.servers)
    res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*", "Cache-Control": "no-store" })
    res.end(JSON.stringify({ schemaVersion: 1, integrations: records }))
  } catch (error) {
    res.writeHead(500, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" })
    res.end(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }))
  }
  return true
}
