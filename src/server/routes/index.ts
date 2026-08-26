/**
 * Route registry — compose all domain route handlers
 */
import type { IncomingMessage, ServerResponse } from "http";
import type { RouteHandler, ServerContext } from "./types.js";
import { handleChat } from "./chat.js";
import { handleDashboard } from "./dashboard.js";
import { handleSessions } from "./sessions.js";
import { handleExplorer } from "./explorer.js";
import { handleSettings } from "./settings.js";
import { handleSearch } from "./search.js";
import { handleGit } from "./git.js";
import { handleTypeScript } from "./typescript.js";
import { handleUiState } from "./ui-state.js";
import { handlePermissions } from "./permissions.js";
import { handleDiagnostics } from "./diagnostics.js";
import { handleComponents } from "./components.js";

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
  handlePermissions,
  handleDiagnostics,
  handleComponents,
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
