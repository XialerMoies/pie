/** PI-only construction helpers for embedded subagents. */
import {
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
} from "@xiamol/pi-coding-agent";
import type {
  EmbeddedSubagentResourceLoaderOptions,
  EmbeddedSubagentResourceLoader,
  EmbeddedSubagentSessionCreateOptions,
  EmbeddedSubagentSession,
} from "../server/subagent-session.js";

export function createPiSubagentResourceLoader(
  options: EmbeddedSubagentResourceLoaderOptions,
): EmbeddedSubagentResourceLoader {
  return new DefaultResourceLoader(options as never) as unknown as EmbeddedSubagentResourceLoader;
}

export async function createPiSubagentSession(
  options: EmbeddedSubagentSessionCreateOptions,
): Promise<EmbeddedSubagentSession> {
  const { session } = await createAgentSession({
    ...options,
    settingsManager: options.settingsManager ?? SettingsManager.inMemory(),
    sessionManager: options.sessionManager ?? SessionManager.inMemory(options.cwd),
  } as Parameters<typeof createAgentSession>[0]);
  return session as unknown as EmbeddedSubagentSession;
}

export function createPiSubagentSessionManager(workspace: string): unknown {
  return SessionManager.inMemory(workspace);
}

export function createPiSubagentSettingsManager(): unknown {
  return SettingsManager.inMemory();
}
