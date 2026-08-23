/**
 * Owns the browser-side chat EventSource lifecycle.
 *
 * EventSource owns transport reconnects. This manager owns the active stream
 * generation so a replaced stream can never update the current chat.
 */

interface ChatStreamHandlers {
  onMessage?: (event: MessageEvent) => void;
  onError?: (event: Event) => void;
  onOpen?: (event: Event) => void;
}

interface ChatStreamEntry {
  source: EventSource;
  generation: number;
  opened: boolean;
  readySettled: boolean;
  ready: Promise<boolean>;
  resolveReady: (opened: boolean) => void;
  handlers: ChatStreamHandlers;
  listeners: {
    message: (event: MessageEvent) => void;
    error: (event: Event) => void;
    open: (event: Event) => void;
  };
}

let chatStreamGeneration = 0;
let activeChatStream: ChatStreamEntry | null = null;

function disposeChatStream(entry: ChatStreamEntry | null): void {
  if (!entry) return;
  if (!entry.readySettled) {
    entry.readySettled = true;
    entry.resolveReady(false);
  }
  entry.source.removeEventListener('message', entry.listeners.message);
  entry.source.removeEventListener('error', entry.listeners.error);
  entry.source.removeEventListener('open', entry.listeners.open);
  entry.source.close();
}

const chatStreamApi: AppChatStream = {
  open(handlers: ChatStreamHandlers = {}, options: { freshTurn?: boolean } = {}): number {
    disposeChatStream(activeChatStream);
    activeChatStream = null;
    const currentGeneration = ++chatStreamGeneration;
    const source = new EventSource(options.freshTurn ? '/api/chat/stream?freshTurn=1' : '/api/chat/stream');
    let resolveReady!: (opened: boolean) => void;
    const ready = new Promise<boolean>((resolve) => { resolveReady = resolve; });
    const entry = {
      source,
      generation: currentGeneration,
      opened: false,
      readySettled: false,
      ready,
      resolveReady,
      handlers,
      listeners: {} as ChatStreamEntry['listeners'],
    } as ChatStreamEntry;
    activeChatStream = entry;
    entry.listeners.message = (event: MessageEvent) => {
      if (activeChatStream !== entry) return;
      entry.handlers.onMessage?.(event);
    };
    entry.listeners.error = (event: Event) => {
      if (activeChatStream !== entry) return;
      entry.handlers.onError?.(event);
    };
    entry.listeners.open = (event: Event) => {
      if (activeChatStream !== entry) return;
      entry.opened = true;
      if (!entry.readySettled) {
        entry.readySettled = true;
        entry.resolveReady(true);
      }
      entry.handlers.onOpen?.(event);
    };
    source.addEventListener('message', entry.listeners.message);
    source.addEventListener('error', entry.listeners.error);
    source.addEventListener('open', entry.listeners.open);
    return currentGeneration;
  },
  async waitUntilOpen(candidate: number, timeoutMs = 5_000): Promise<boolean> {
    const entry = activeChatStream;
    if (!entry || entry.generation !== candidate) return false;
    if (entry.opened) return true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        entry.ready,
        new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), timeoutMs); }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  },
  setHandlers(candidate: number, handlers: ChatStreamHandlers): boolean {
    if (!activeChatStream || activeChatStream.generation !== candidate) return false;
    activeChatStream.handlers = handlers;
    return true;
  },
  close(): void {
    disposeChatStream(activeChatStream);
    activeChatStream = null;
    chatStreamGeneration++;
  },
  isCurrent(candidate: number): boolean {
    return activeChatStream?.generation === candidate;
  },
  isOpen(): boolean {
    return activeChatStream !== null;
  },
};

const chatStreamApp = (window as any).App || ((window as any).App = {});
chatStreamApp.ChatStream = chatStreamApi;

export {};
