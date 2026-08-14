/**
 * Chat runtime state facade.
 *
 * The chat state facade is the sole owner; consumers must not keep browser-global
 * compatibility mirrors.
 */

let chatStateMessages: Message[] = [];
let chatStateBusy = false;
let chatStateDashboard: DashboardData | null = null;

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
