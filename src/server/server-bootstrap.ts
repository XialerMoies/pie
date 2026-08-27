import type { ServerContext } from "./routes/types.js";
import type { ServerContextDependencies, ServerContextGroups } from "./server-context.js";

/** Assemble the immutable ownership groups once during server startup. */
export function createServerContext(
  dependencies: ServerContextDependencies,
): ServerContext {
  const groups: ServerContextGroups = {
    core: {
      engine: dependencies.engine,
      runtime: dependencies.runtime,
      chatStream: dependencies.chatStream,
      appEvents: dependencies.appEvents,
      recordUserNote: dependencies.recordUserNote,
      skillService: dependencies.skillService,
    },
    security: {
      config: dependencies.security,
      permissionService: dependencies.permissionService,
      rootRegistry: dependencies.rootRegistry,
      permissionMode: dependencies.permissionMode,
    },
    storage: {
      paths: dependencies.paths,
      workspaceLock: dependencies.workspaceLock,
    },
    providers: {
      customProviderService: dependencies.customProviderService,
      providerReferenceLock: dependencies.providerReferenceLock,
      model: {
        get router() { return dependencies.runtime.modelRouter; },
        get providerRuntime() { return dependencies.runtime.modelRouter.providerRuntime; },
        listModels: () => dependencies.runtime.listModels(),
        findModel: (provider, id) => dependencies.runtime.findModel(provider, id),
        providerAuthStatus: (provider) => dependencies.runtime.providerAuthStatus(provider),
        refreshProviders: (providers) => dependencies.runtime.refreshModelProviders(providers),
        syncModelProviders: (options) => dependencies.runtime.syncModelProviders(options),
        runWithStableSession: (operation) => dependencies.runtime.runWithStableSession(operation),
      },
    },
    infra: {
      tsServer: dependencies.tsServer,
      observability: dependencies.observability,
    },
  };
  return { groups };
}
