import type { RequiredComponentLease } from "../agent/capability-component-replacement.js";
import { ModelRegistry, ModelRuntime } from "../agent-engine/pi-runtime.js";
import type {
  ProviderModel,
  ProviderModelRegistry,
  ProviderRefreshResult,
  ProviderRuntime,
} from "./runtime-types.js";
import { registerModelProtocolComponents } from "./protocol-components.js";

export interface ModelRouterSessionOptions {
  authFile: string;
  modelsFile: string;
  syncRuntime?: (runtime: ProviderRuntime) => Promise<number>;
}

/** Session-scoped model view pinned to one Required Component generation. */
export interface ModelRouterSession {
  readonly providerRuntime: ProviderRuntime;
  readonly modelRegistry: ProviderModelRegistry;
  syncProviders(): Promise<number>;
  listModels(): readonly ProviderModel[];
  findModel(provider: string, id: string): ProviderModel | undefined;
  providerAuthStatus(provider: string): { configured?: boolean; source?: string } | undefined;
  refreshProviders(providers: readonly string[]): Promise<ProviderRefreshResult>;
  dispose(): void;
}

export interface ModelRouterProvider {
  readonly kind: "model-router";
  createSession(options: ModelRouterSessionOptions): Promise<ModelRouterSession>;
}

export class ModelRouterContractError extends Error {
  readonly code = "invalid_model_router_provider";

  constructor(message: string) {
    super(message);
    this.name = "ModelRouterContractError";
  }
}

function assertModelRouterSession(value: unknown): asserts value is ModelRouterSession {
  const candidate = value as Partial<ModelRouterSession> | undefined;
  if (!candidate || typeof candidate !== "object"
    || !candidate.providerRuntime || !candidate.modelRegistry
    || typeof candidate.syncProviders !== "function"
    || typeof candidate.listModels !== "function"
    || typeof candidate.findModel !== "function"
    || typeof candidate.providerAuthStatus !== "function"
    || typeof candidate.refreshProviders !== "function"
    || typeof candidate.dispose !== "function") {
    throw new ModelRouterContractError("Model router returned an invalid session contract");
  }
}

export async function createModelRouterSession(
  lease: RequiredComponentLease,
  options: ModelRouterSessionOptions,
): Promise<ModelRouterSession> {
  let implementation: unknown;
  try {
    implementation = lease.resolveBinding("model-router").implementation;
  } catch (error) {
    throw new ModelRouterContractError(
      `Model router binding is unavailable: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const provider = implementation as Partial<ModelRouterProvider> | undefined;
  if (!provider || provider.kind !== "model-router" || typeof provider.createSession !== "function") {
    throw new ModelRouterContractError("Required model-router provider does not implement createSession");
  }
  const session = await provider.createSession(options);
  assertModelRouterSession(session);
  return session;
}

export const piModelRouterProvider: ModelRouterProvider = Object.freeze({
  kind: "model-router" as const,
  async createSession(options: ModelRouterSessionOptions): Promise<ModelRouterSession> {
    const providerRuntime = await ModelRuntime.create({
      authPath: options.authFile,
      modelsPath: options.modelsFile,
    }) as ProviderRuntime;
    await options.syncRuntime?.(providerRuntime);
    const modelRegistry = new ModelRegistry(providerRuntime as ModelRuntime) as ProviderModelRegistry;
    let disposed = false;
    const requireActive = (): void => {
      if (disposed) throw new ModelRouterContractError("Model router session has been disposed");
    };
    return Object.freeze({
      providerRuntime,
      modelRegistry,
      syncProviders: async () => {
        requireActive();
        return options.syncRuntime?.(providerRuntime) ?? 0;
      },
      listModels: () => {
        requireActive();
        return modelRegistry.getAvailable();
      },
      findModel: (provider: string, id: string) => {
        requireActive();
        return modelRegistry.find(provider, id);
      },
      providerAuthStatus: (provider: string) => {
        requireActive();
        return providerRuntime.getProviderAuthStatus(provider);
      },
      refreshProviders: async (providers: readonly string[]) => {
        requireActive();
        return providerRuntime.refresh({ providers, allowNetwork: false });
      },
      dispose: () => { disposed = true; },
    });
  },
});

// Keep protocol adapter components available whenever the model-router host is loaded.
registerModelProtocolComponents();
