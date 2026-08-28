/** PI adapters for Required Component contracts. Keep PI types in this file. */
import { SessionManager } from "./pi-runtime.js"
import { PiAgentEngine } from "./pi-adapter.js"
import { capabilityComponentManager } from "../agent/capability-components.js"
import type {
  AgentEngineProvider,
  SessionStoreCreateOptions,
  SessionStoreEntry,
  SessionStoreProvider,
  SessionStoreSession,
} from "../agent/capability-contracts.js"

/** PI owns the engine plus its PI-specific subagent/provider adapters. */
export const piAgentEngineProvider: AgentEngineProvider = Object.freeze({
  kind: "agent-engine" as const,
  ownership: Object.freeze({
    engine: "pi-agent-engine",
    subagentAdapter: "pi-subagent-adapter",
    providerAdapter: "pi-provider-adapter",
  }),
  create: (runtime: unknown) => new PiAgentEngine(runtime as never),
  health: () => ({ status: "healthy" as const }),
  dispose: () => {},
})

if (!capabilityComponentManager.hasRequiredProviderBinding("agent-engine")) {
  capabilityComponentManager.bindRequiredProvider("agent-engine", piAgentEngineProvider)
}

function asSessionStoreSession(manager: any): SessionStoreSession {
  let disposed = false
  const ensureActive = (): void => {
    if (disposed) throw new Error("Session store session has been disposed")
  }
  return Object.freeze({
    sessionId: String(manager.getSessionId?.() || ""),
    sessionFile: typeof manager.getSessionFile === "function" ? manager.getSessionFile() : undefined,
    getEntries: () => {
      ensureActive()
      return manager.getEntries() as SessionStoreEntry[]
    },
    buildSessionContext: () => {
      ensureActive()
      return manager.buildSessionContext() as { messages: readonly unknown[] }
    },
    appendCustomEntry: (customType: string, data?: unknown) => {
      ensureActive()
      return manager.appendCustomEntry(customType, data)
    },
    appendMessage: (message: unknown) => {
      ensureActive()
      return String(manager.appendMessage(message))
    },
    branch: (entryId: string) => {
      ensureActive()
      return manager.branch(entryId)
    },
    dispose: () => { disposed = true },
  })
}

/** Existing PI JSONL SessionManager exposed through the project's narrow contract. */
export const piSessionStoreProvider: SessionStoreProvider = Object.freeze({
  kind: "session-store" as const,
  async createSession(options: SessionStoreCreateOptions): Promise<SessionStoreSession> {
    return asSessionStoreSession(createPiSessionManager(options))
  },
  health: () => ({ status: "healthy" as const }),
  dispose: () => {},
})

/** Internal PI host handle for AgentSession construction; callers do not expose it as a plugin API. */
export function createPiSessionManager(options: SessionStoreCreateOptions): ReturnType<typeof SessionManager.create> {
  return options.forceNew
    ? SessionManager.create(options.cwd, options.sessionsDir)
    : options.existingSessionFile
      ? SessionManager.open(options.existingSessionFile, undefined, options.cwd)
      : SessionManager.create(options.cwd, options.sessionsDir)
}
