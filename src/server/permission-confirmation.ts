import type { ServerResponse } from "http";
import type { CommandConfirmationResult } from "../agent/types.js";
import type { AppEventHub } from "./app-events.js";
import type { ServerPermissionConfirmationRequest } from "./permission-service.js";
import { serverConfirmationRegistry } from "./confirmation-registry.js";

const PERMISSION_CONFIRM_TIMEOUT_MS = 120_000;

export function createPermissionConfirmCallback(
  appEvents: AppEventHub,
  options: { timeoutMs?: number } = {},
) {
  const timeoutMs = options.timeoutMs ?? PERMISSION_CONFIRM_TIMEOUT_MS;
  return async (request: ServerPermissionConfirmationRequest): Promise<CommandConfirmationResult> => {
    const clients = appEvents.clientsSnapshot();
    if (clients.length === 0) return { allow: false };

    const pending = serverConfirmationRegistry.begin("permission", clients, timeoutMs);
    appEvents.sendTo(clients, "permission.confirm", {
      id: pending.id,
      ...request,
    });
    serverConfirmationRegistry.retainResponses(pending.id, appEvents.clientsSnapshot());
    return pending.result;
  };
}

export function resolvePermissionConfirmation(id: string, decision: CommandConfirmationResult): boolean {
  return serverConfirmationRegistry.resolve(id, "permission", decision);
}

export function cancelPermissionConfirmationsForResponse(response: ServerResponse): void {
  serverConfirmationRegistry.removeResponse(response, "permission");
}
