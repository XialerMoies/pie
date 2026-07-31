/**
 * Chat runtime state facade.
 *
 * The legacy window.__state fields remain as a compatibility projection while
 * chat and session modules migrate to App.ChatState.
 */

type ChatStateHost = {
  D?: DashboardData | null;
  M?: Message[];
  IL?: boolean;
};

const chatStateHost = ((window as any).__state || ((window as any).__state = {})) as ChatStateHost;
let chatStateMessages: Message[] = Array.isArray(chatStateHost.M) ? chatStateHost.M : [];
let chatStateBusy = chatStateHost.IL === true;
let chatStateDashboard: DashboardData | null = chatStateHost.D ?? null;

function defineChatStateProjection<K extends keyof ChatStateHost>(key: K, read: () => ChatStateHost[K], write: (value: ChatStateHost[K]) => void): void {
  const descriptor = Object.getOwnPropertyDescriptor(chatStateHost, key);
  if (descriptor && descriptor.configurable === false) return;
  Object.defineProperty(chatStateHost, key, {
    configurable: true,
    enumerable: true,
    get: read,
    set: write,
  });
}

defineChatStateProjection('M', () => chatStateMessages, (value) => {
  chatStateMessages = Array.isArray(value) ? value : [];
});
defineChatStateProjection('IL', () => chatStateBusy, (value) => {
  chatStateBusy = value === true;
});
defineChatStateProjection('D', () => chatStateDashboard, (value) => {
  chatStateDashboard = value ?? null;
});

const chatStateApi: AppChatState = {
  getMessages(): Message[] {
    return chatStateMessages;
  },
  replaceMessages(next: Message[]): void {
    chatStateMessages = Array.isArray(next) ? next : [];
  },
  appendMessage(message: Message): void {
    chatStateMessages.push(message);
  },
  clearMessages(): void {
    chatStateMessages = [];
  },
  isBusy(): boolean {
    return chatStateBusy;
  },
  setBusy(value: boolean): void {
    chatStateBusy = value === true;
  },
  getDashboard(): DashboardData | null {
    return chatStateDashboard;
  },
  setDashboard(value: DashboardData | null): void {
    chatStateDashboard = value ?? null;
  },
  reset(): void {
    chatStateMessages = [];
    chatStateBusy = false;
    chatStateDashboard = null;
  },
};

const chatStateApp = (window as any).App || ((window as any).App = {});
chatStateApp.ChatState = chatStateApi;

export {};
