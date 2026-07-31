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
}

type ChatStreamHost = {
  CS?: EventSource | null;
};

let chatStreamGeneration = 0;
let activeChatStream: ChatStreamEntry | null = null;
const chatStreamHost = ((window as any).__state || ((window as any).__state = {})) as ChatStreamHost;

function disposeChatStream(entry: ChatStreamEntry | null): void {
  if (!entry) return;
  entry.source.onmessage = null;
  entry.source.onerror = null;
  entry.source.onopen = null;
  entry.source.close();
  if (chatStreamHost.CS === entry.source) chatStreamHost.CS = null;
}

// Adopt a stream created by the legacy path so workspace/session changes can
// still close it during the migration window.
if (chatStreamHost.CS) {
  activeChatStream = { source: chatStreamHost.CS, generation: ++chatStreamGeneration, handlers: {} };
}

const chatStreamApi: AppChatStream = {
  open(handlers: ChatStreamHandlers = {}): number {
    disposeChatStream(activeChatStream);
    activeChatStream = null;
    const currentGeneration = ++chatStreamGeneration;
    const source = new EventSource('/api/chat/stream');
    const entry: ChatStreamEntry = { source, generation: currentGeneration, handlers };
    activeChatStream = entry;
    chatStreamHost.CS = source;
    source.onmessage = (event: MessageEvent) => {
      if (activeChatStream !== entry) return;
      entry.handlers.onMessage?.(event);
    };
    source.onerror = (event: Event) => {
      if (activeChatStream !== entry) return;
      entry.handlers.onError?.(event);
    };
    source.onopen = (event: Event) => {
      if (activeChatStream !== entry) return;
      entry.handlers.onOpen?.(event);
    };
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
