import type { ModelRuntime } from "@xiamol/pi-coding-agent";

import type { CustomProviderStore } from "./custom-provider-store.js";
import type { PiCustomProviderAdapter } from "./pi-custom-provider-adapter.js";

interface RuntimeSyncState {
  loadedRevision: number;
  generation: number;
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
    if (state.inFlight) return state.inFlight;

    const generation = ++state.generation;
    const load = this.#loadAndApply(runtime, state, generation);
    let pending: Promise<number>;
    pending = load.finally(() => {
      if (state.inFlight === pending) state.inFlight = undefined;
    });
    state.inFlight = pending;
    return pending;
  }

  #stateFor(runtime: ModelRuntime): RuntimeSyncState {
    let state = this.#states.get(runtime);
    if (state === undefined) {
      state = { loadedRevision: -1, generation: 0 };
      this.#states.set(runtime, state);
    }
    return state;
  }

  async #loadAndApply(
    runtime: ModelRuntime,
    state: RuntimeSyncState,
    generation: number,
  ): Promise<number> {
    const snapshot = await this.#store.readSnapshot();
    if (generation !== state.generation || snapshot.revision <= state.loadedRevision) {
      return state.loadedRevision;
    }

    const prepared = await Promise.all(snapshot.providers.map(async (provider) => (
      this.#adapter.prepare(provider, await this.#store.resolveSecrets(provider))
    )));
    if (generation !== state.generation || snapshot.revision <= state.loadedRevision) {
      return state.loadedRevision;
    }

    this.#adapter.replaceRuntimeProviders(runtime, prepared);
    state.loadedRevision = snapshot.revision;
    return state.loadedRevision;
  }
}
