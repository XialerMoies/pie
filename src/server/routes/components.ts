import type { RouteHandler } from "./types.js"
import { capabilityComponentManager } from "../../agent/capability-components.js"

/** Read-only component catalog for the desktop host and diagnostics surfaces. */
export const handleComponents: RouteHandler = async (req, res) => {
  if (req.url === "/api/components" && req.method === "GET") {
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
