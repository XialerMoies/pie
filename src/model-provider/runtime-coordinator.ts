import type { ModelRuntime } from "@xiamol/pi-coding-agent";

import type { CustomProviderStore } from "./custom-provider-store.js";
import { IncompleteCustomProviderRollbackError } from "./pi-custom-provider-adapter.js";
import type { PiCustomProviderAdapter } from "./pi-custom-provider-adapter.js";

interface RuntimeSyncState {
  loadedRevision: number;
  requestedGeneration: number;
  inFlight?: Promise<number>;
}

export interface CustomProviderRuntimeCoordinatorOptions {
  store: Pick<CustomProviderStore, "readSnapshot" | "resolveSecrets">;
  adapter: Pick<PiCustomProviderAdapter, "prepare" | "replaceRuntimeProviders">;
}

export class CustomProviderRuntimeCoordinator {
  readonly #store: CustomProviderRuntimeCoordinatorOptions["store"];
  readonly #adapter: CustomProviderRuntimeCoordinatorOptions["adapter"];
  readonly #states = new WeakMap<ModelRuntime, RuntimeSyncState>();

  constructor(options: CustomProviderRuntimeCoordinatorOptions) {
    this.#store = options.store;
    this.#adapter = options.adapter;
  }

  loadedRevision(runtime: ModelRuntime): number {
    return this.#stateFor(runtime).loadedRevision;
  }

  sync(runtime: ModelRuntime): Promise<number> {
    const state = this.#stateFor(runtime);
    state.requestedGeneration += 1;
    if (state.inFlight) return state.inFlight;

    const pending = Promise.resolve().then(() => this.#drain(runtime, state));
    state.inFlight = pending;
    return pending;
  }

  #stateFor(runtime: ModelRuntime): RuntimeSyncState {
    let state = this.#states.get(runtime);
    if (state === undefined) {
      state = { loadedRevision: -1, requestedGeneration: 0 };
      this.#states.set(runtime, state);
    }
    return state;
  }

  async #drain(runtime: ModelRuntime, state: RuntimeSyncState): Promise<number> {
    try {
      while (true) {
        const generation = state.requestedGeneration;
        await this.#loadAndApply(runtime, state, generation);
        if (generation === state.requestedGeneration) {
          state.inFlight = undefined;
          return state.loadedRevision;
        }
      }
    } catch (error) {
      state.inFlight = undefined;
      throw error;
    }
  }

  async #loadAndApply(
    runtime: ModelRuntime,
    state: RuntimeSyncState,
    generation: number,
  ): Promise<number> {
    const snapshot = await this.#store.readSnapshot();
    if (generation !== state.requestedGeneration || snapshot.revision <= state.loadedRevision) {
      return state.loadedRevision;
    }

    const prepared = await Promise.all(snapshot.providers.map(async (provider) => (
      this.#adapter.prepare(provider, await this.#store.resolveSecrets(provider))
    )));
    if (generation !== state.requestedGeneration || snapshot.revision <= state.loadedRevision) {
      return state.loadedRevision;
    }

    try {
      await this.#adapter.replaceRuntimeProviders(runtime, prepared);
    } catch (error) {
      if (error instanceof IncompleteCustomProviderRollbackError) {
        state.loadedRevision = -1;
      }
      throw error;
    }
    state.loadedRevision = snapshot.revision;
    return state.loadedRevision;
  }
}
