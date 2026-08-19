import type { ServerContext } from "./routes/types.js";
import type { ServerContextGroups } from "./server-context.js";

/** Assemble the immutable ownership groups once during server startup. */
export function createServerContext(
  flat: Omit<ServerContext, "groups">,
): ServerContext {
  const groups: ServerContextGroups = {
    core: {
      engine: flat.engine,
      runtime: flat.runtime,
      chatStream: flat.chatStream,
      appEvents: flat.appEvents,
      recordUserNote: flat.recordUserNote,
      skillService: flat.skillService,
    },
    security: {
      config: flat.security,
      permissionService: flat.permissionService,
      rootRegistry: flat.rootRegistry,
      permissionMode: flat.permissionMode,
    },
    storage: {
      paths: flat.paths,
      workspaceLock: flat.workspaceLock,
    },
    providers: {
      customProviderService: flat.customProviderService,
      providerReferenceLock: flat.providerReferenceLock,
      model: {
        get modelRuntime() { return flat.runtime.modelRuntime; },
        get modelRegistry() { return flat.runtime.modelRegistry; },
        syncModelProviders: () => flat.runtime.syncModelProviders(),
        runWithStableSession: (operation) => flat.runtime.runWithStableSession(operation),
      },
    },
    infra: {
      tsServer: flat.tsServer,
      observability: flat.observability,
    },
  };
  const context = { groups } as ServerContext;
  Object.defineProperties(context, {
    engine: { enumerable: true, get: () => groups.core.engine },
    runtime: { enumerable: true, get: () => groups.core.runtime },
    chatStream: { enumerable: true, get: () => groups.core.chatStream },
    appEvents: { enumerable: true, get: () => groups.core.appEvents },
    recordUserNote: { enumerable: true, get: () => groups.core.recordUserNote },
    skillService: { enumerable: true, get: () => groups.core.skillService },
    security: { enumerable: true, get: () => groups.security.config },
    permissionService: { enumerable: true, get: () => groups.security.permissionService },
    rootRegistry: { enumerable: true, get: () => groups.security.rootRegistry },
    permissionMode: { enumerable: true, get: () => groups.security.permissionMode },
    workspaceLock: { enumerable: true, get: () => groups.storage.workspaceLock },
    paths: { enumerable: true, get: () => groups.storage.paths },
    customProviderService: { enumerable: true, get: () => groups.providers.customProviderService },
    providerReferenceLock: { enumerable: true, get: () => groups.providers.providerReferenceLock },
    tsServer: { enumerable: true, get: () => groups.infra.tsServer },
    observability: { enumerable: true, get: () => groups.infra.observability },
  });
  return context;
}
