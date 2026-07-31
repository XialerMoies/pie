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
  entry.source.removeEventListener('message', entry.listeners.message);
  entry.source.removeEventListener('error', entry.listeners.error);
  entry.source.removeEventListener('open', entry.listeners.open);
  entry.source.close();
}

const chatStreamApi: AppChatStream = {
  open(handlers: ChatStreamHandlers = {}): number {
    disposeChatStream(activeChatStream);
    activeChatStream = null;
    const currentGeneration = ++chatStreamGeneration;
    const source = new EventSource('/api/chat/stream');
    const entry = {
      source,
      generation: currentGeneration,
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
      entry.handlers.onOpen?.(event);
    };
    source.addEventListener('message', entry.listeners.message);
    source.addEventListener('error', entry.listeners.error);
    source.addEventListener('open', entry.listeners.open);
    return currentGeneration;
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
