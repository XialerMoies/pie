/// <reference types="vite/client" />

interface ChatAPI {
  send(text: string): Promise<{ ok?: boolean; error?: string }>;
  onDelta(cb: (data: { text: string; thinking?: boolean }) => void): () => void;
  onStart(cb: () => void): () => void;
  onDone(cb: () => void): () => void;
}

interface DashboardAPI {
  getData(): Promise<{
    modelProvider: string;
    modelId: string;
    modelContextWindow: number | string;
    modelMaxTokens: number | string;
    thinkingLevel: string;
    runtime: number;
    messagesCount: number;
    isIdle: boolean;
  } | null>;
}

interface ToolsAPI {
  onStart(cb: (data: { name: string; args: any }) => void): () => void;
  onEnd(cb: (data: { name: string; isError: boolean }) => void): () => void;
}

interface AppAPI {
  getPaths(): Promise<{
    appRoot: string;
    dataDir: string;
    piConfigDir: string;
    sessionsDir: string;
  }>;
  newSession(): Promise<{ ok: boolean }>;
}

declare global {
  interface Window {
    pi: {
      chat: ChatAPI;
      dashboard: DashboardAPI;
      tools: ToolsAPI;
      app: AppAPI;
    };
    switchTab: (tab: "chat" | "dashboard") => void;
  }
}
