/**
 * Route registry — compose all domain route handlers
 */
import type { IncomingMessage, ServerResponse } from "http";
import type { RouteHandler, ServerContext } from "./types";
import { handleChat } from "./chat";
import { handleDashboard } from "./dashboard";
import { handleSessions } from "./sessions";
import { handleExplorer } from "./explorer";
import { handleSettings } from "./settings";
import { handleSearch } from "./search";
import { handleGit } from "./git";
import { handleTypeScript } from "./typescript";
import { handleUiState } from "./ui-state";

const handlers: RouteHandler[] = [
  handleChat,
  handleDashboard,
  handleSessions,
  handleExplorer,
  handleSettings,
  handleSearch,
  handleGit,
  handleTypeScript,
  handleUiState,
];

/**
 * Try each route handler in order. Returns true if one handled the request.
 */
export async function dispatchRoute(req: IncomingMessage, res: ServerResponse, ctx: ServerContext): Promise<boolean> {
  for (const handler of handlers) {
    const handled = await handler(req, res, ctx);
    if (handled) return true;
  }
  return false;
}
