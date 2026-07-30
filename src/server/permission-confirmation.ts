import type { ServerResponse } from "http";
import type { CommandConfirmationResult } from "../agent/types";
import type { ServerPermissionConfirmationRequest } from "./permission-service";

const PERMISSION_CONFIRM_TIMEOUT_MS = 120_000;

type PendingPermissionConfirmation = {
  responses: Set<ServerResponse>;
  resolve: (decision: CommandConfirmationResult) => void;
  timeout: ReturnType<typeof setTimeout>;
};

const pendingPermissionConfirmations = new Map<string, PendingPermissionConfirmation>();

function permissionConfirmationId(): string {
  return "perm-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8);
}

export function createPermissionConfirmCallback(
  sseClients: ServerResponse[],
  options: { timeoutMs?: number } = {},
) {
  const timeoutMs = options.timeoutMs ?? PERMISSION_CONFIRM_TIMEOUT_MS;
  return async (request: ServerPermissionConfirmationRequest): Promise<CommandConfirmationResult> => {
    const clients = sseClients.filter((client) => !client.destroyed && !client.writableEnded);
    if (clients.length === 0) return { allow: false };

    const id = permissionConfirmationId();
    return new Promise<CommandConfirmationResult>((resolve) => {
      const finish = (decision: CommandConfirmationResult) => {
        const pending = pendingPermissionConfirmations.get(id);
        if (pending) {
          clearTimeout(pending.timeout);
          pendingPermissionConfirmations.delete(id);
        }
        resolve(decision.allow === true ? decision : { allow: false });
      };

      const timeout = setTimeout(() => finish({ allow: false }), timeoutMs);
      pendingPermissionConfirmations.set(id, {
        responses: new Set(clients),
        resolve: finish,
        timeout,
      });

      const payload = `data: ${JSON.stringify({
        type: "permission_confirm",
        id,
        ...request,
      })}\n\n`;

      let sent = false;
      for (const client of clients) {
        try {
          client.write(payload);
          sent = true;
        } catch {
          const pending = pendingPermissionConfirmations.get(id);
          pending?.responses.delete(client);
        }
      }

      if (!sent) finish({ allow: false });
    });
  };
}

export function resolvePermissionConfirmation(id: string, decision: CommandConfirmationResult): boolean {
  const pending = pendingPermissionConfirmations.get(id);
  if (!pending) return false;
  pending.resolve(decision.allow === true ? decision : { allow: false });
  return true;
}

export function cancelPermissionConfirmationsForResponse(response: ServerResponse): void {
  for (const [id, pending] of pendingPermissionConfirmations) {
    if (!pending.responses.has(response)) continue;
    pending.responses.delete(response);
    if (pending.responses.size > 0) continue;
    clearTimeout(pending.timeout);
    pendingPermissionConfirmations.delete(id);
    pending.resolve({ allow: false });
  }
}

