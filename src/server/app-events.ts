import type { ServerResponse } from "http";

export const APP_EVENT_TYPES = [
  "dashboard.changed",
  "usage.changed",
  "mcp.changed",
  "explorer.changed",
  "permission.confirm",
] as const;

export type AppEventType = typeof APP_EVENT_TYPES[number];

export interface AppEvent<T = unknown> {
  type: AppEventType;
  revision: number;
  payload?: T;
}

export class AppEventHub {
  private readonly clients = new Set<ServerResponse>();
  private readonly clientRemovedHandlers = new Set<(response: ServerResponse) => void>();
  private currentRevision = 0;
  private closed = false;

  addClient(response: ServerResponse): void {
    if (!this.closed && this.isWritable(response)) this.clients.add(response);
  }

  removeClient(response: ServerResponse): void {
    if (!this.clients.delete(response)) return;
    for (const handler of [...this.clientRemovedHandlers]) {
      try {
        handler(response);
      } catch {
        // Client cleanup must continue even if one observer fails.
      }
    }
  }

  subscribeClientRemoved(handler: (response: ServerResponse) => void): () => void {
    this.clientRemovedHandlers.add(handler);
    return () => this.clientRemovedHandlers.delete(handler);
  }

  clientsSnapshot(): ServerResponse[] {
    this.removeInvalidClients();
    return [...this.clients];
  }

  publish<T = unknown>(type: AppEventType, payload?: T): void {
    const frame = this.createFrame(type, payload);
    this.writeFrame(this.clients, frame);
  }

  sendTo<T = unknown>(
    clients: Iterable<ServerResponse>,
    type: AppEventType,
    payload?: T,
  ): void {
    const frame = this.createFrame(type, payload);
    this.removeInvalidClients();
    this.writeFrame(
      [...new Set(clients)].filter((client) => this.clients.has(client)),
      frame,
    );
  }

  revision(): number {
    return this.currentRevision;
  }

  closeAll(): void {
    if (this.closed) return;
    this.closed = true;
    for (const client of [...this.clients]) {
      this.removeClient(client);
      try { client.end(); } catch {}
    }
  }

  private createFrame<T>(type: AppEventType, payload?: T): string {
    const event: AppEvent<T> = {
      type,
      revision: ++this.currentRevision,
      ...(payload === undefined ? {} : { payload }),
    };
    return `data: ${JSON.stringify(event)}\n\n`;
  }

  private writeFrame(clients: Iterable<ServerResponse>, frame: string): void {
    for (const client of clients) {
      if (!this.isWritable(client)) {
        this.removeClient(client);
        continue;
      }
      try {
        client.write(frame);
      } catch {
        this.removeClient(client);
      }
    }
  }

  private removeInvalidClients(): void {
    for (const client of this.clients) {
      if (!this.isWritable(client)) this.removeClient(client);
    }
  }

  private isWritable(response: ServerResponse): boolean {
    return !response.destroyed && !response.writableEnded;
  }
}
