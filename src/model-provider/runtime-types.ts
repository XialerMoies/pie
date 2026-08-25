/** Project-owned provider runtime boundary. PI-backed implementations stay in adapters. */
export interface ProviderModel {
  provider: string;
  id: string;
  name?: string;
  contextWindow?: number;
  maxTokens?: number;
  reasoning?: boolean;
  input?: readonly string[];
}

export interface ProviderRefreshResult {
  aborted?: boolean;
  errors: ReadonlyMap<string, Error>;
}

export interface ProviderRuntime {
  refresh(options?: { providers?: readonly string[]; allowNetwork?: boolean }): Promise<ProviderRefreshResult>;
  getProviders(): ReadonlyArray<{ id: string; name: string }>;
  getProvider(providerId: string): unknown;
  getRegisteredNativeProvider(providerId: string): unknown;
  getProviderAuthStatus(provider: string): { configured?: boolean; source?: string } | undefined;
  getAvailableModels?(): readonly ProviderModel[];
  findModel?(provider: string, id: string): ProviderModel | undefined;
  registerProvider(providerId: string, config: unknown): void;
  registerNativeProvider(provider: unknown): void;
  unregisterProvider(providerId: string): void;
}

export interface ProviderModelRegistry {
  getAvailable(): readonly ProviderModel[];
  find(provider: string, id: string): ProviderModel | undefined;
}
