import type { RouteHandler } from "../types.js";

export const cors = { "Access-Control-Allow-Origin": "*" };

export function publishDashboardChanged(ctx: Parameters<RouteHandler>[2]): void {
  try { ctx.appEvents.publish("dashboard.changed"); } catch {}
}
