import type { CommandConfirmationResult } from "../agent/types.js";

export type ConfirmationKind = "command" | "permission";

type PendingConfirmation = {
  kind: ConfirmationKind;
  responses: Set<unknown>;
  resolve: (decision: CommandConfirmationResult) => void;
  timeout: ReturnType<typeof setTimeout>;
};

export type PendingConfirmationResult = {
  id: string;
  result: Promise<CommandConfirmationResult>;
};

function normalizedDecision(decision: CommandConfirmationResult): CommandConfirmationResult {
  return decision.allow === true ? decision : { allow: false };
}

export class ConfirmationRegistry {
  private readonly pending = new Map<string, PendingConfirmation>();

  begin(
    kind: ConfirmationKind,
    responses: Iterable<unknown>,
    timeoutMs: number,
  ): PendingConfirmationResult {
    const id = this.createId(kind);
    let settle!: (decision: CommandConfirmationResult) => void;
    const result = new Promise<CommandConfirmationResult>((resolve) => {
      settle = (decision) => {
        const pending = this.pending.get(id);
        if (pending) {
          clearTimeout(pending.timeout);
          this.pending.delete(id);
        }
        resolve(normalizedDecision(decision));
      };
    });
    const timeout = setTimeout(() => settle({ allow: false }), timeoutMs);
    this.pending.set(id, {
      kind,
      responses: new Set(responses),
      resolve: settle,
      timeout,
    });
    return { id, result };
  }

  resolve(id: string, kind: ConfirmationKind, decision: CommandConfirmationResult): boolean {
    const pending = this.pending.get(id);
    if (!pending || pending.kind !== kind) return false;
    pending.resolve(decision);
    return true;
  }

  retainResponses(id: string, activeResponses: Iterable<unknown>): void {
    const pending = this.pending.get(id);
    if (!pending) return;
    const active = new Set(activeResponses);
    for (const response of pending.responses) {
      if (!active.has(response)) pending.responses.delete(response);
    }
    if (pending.responses.size === 0) pending.resolve({ allow: false });
  }

  removeResponse(response: unknown, kind?: ConfirmationKind): void {
    for (const pending of this.pending.values()) {
      if (kind && pending.kind !== kind) continue;
      if (!pending.responses.delete(response)) continue;
      if (pending.responses.size === 0) pending.resolve({ allow: false });
    }
  }

  private createId(kind: ConfirmationKind): string {
    const prefix = kind === "command" ? "cmd" : "perm";
    let id: string;
    do {
      id = prefix + "-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8);
    } while (this.pending.has(id));
    return id;
  }
}

export const serverConfirmationRegistry = new ConfirmationRegistry();
