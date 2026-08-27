import type { AgentRuntime } from "../agent/index.js";
import { randomUUID } from "node:crypto";
import type {
  SubagentDelegationModel,
  SubagentDelegationRequest,
  SubagentDelegateExecutor,
  SubagentModelValidator,
} from "../agent/types.js";
import {
  SubagentSupervisor,
  type SubagentSupervisorOptions,
} from "./subagent-supervisor.js";
import {
  createEmbeddedSubagentSessionFactory,
  type EmbeddedSubagentFactoryDependencies,
} from "./subagent-session.js";
import type { SubagentEvent } from "./subagent-events.js";

type DelegationRuntime = Pick<AgentRuntime, "currentWorkspace" | "findModel">;

type DelegationSupervisor = Pick<
  SubagentSupervisor,
  "startBatch" | "abortBatch" | "releaseBatch" | "dispose"
>;

export interface SubagentDelegationHost {
  validateSubagentModel: SubagentModelValidator;
  delegateTasks: SubagentDelegateExecutor;
  dispose(): Promise<void>;
}

export interface SubagentDelegationHostOptions {
  runtime: DelegationRuntime;
  supervisor: DelegationSupervisor;
  createSupervisor: (workspace: string) => DelegationSupervisor;
  createEventSink?: () => (event: SubagentEvent) => void;
}

type RuntimeSubagentHostRuntime = DelegationRuntime & EmbeddedSubagentFactoryDependencies["runtime"];

export interface RuntimeSubagentHostOptions {
  runtime: RuntimeSubagentHostRuntime;
  createSessionFactory?: (
    dependencies: EmbeddedSubagentFactoryDependencies,
    workspace: string,
  ) => SubagentSupervisorOptions["sessionFactory"];
  createSupervisor?: (
    options: SubagentSupervisorOptions,
    workspace: string,
  ) => DelegationSupervisor;
  createEventSink?: () => (event: SubagentEvent) => void;
}

export interface SubagentDelegationBridge {
  runtimeConfig: {
    validateSubagentModel: SubagentModelValidator;
    delegateTasks: SubagentDelegateExecutor;
  };
  bind(host: SubagentDelegationHost): void;
}

export function createSubagentDelegationBridge(): SubagentDelegationBridge {
  let host: SubagentDelegationHost | undefined;
  return {
    runtimeConfig: {
      validateSubagentModel: (model) => host?.validateSubagentModel(model) ?? false,
      delegateTasks: (request, signal, parentToolCallId) => {
        if (!host) return Promise.reject(new Error("Subagent delegation host is not ready"));
        return host.delegateTasks(request, signal, parentToolCallId);
      },
    },
    bind(nextHost) {
      if (host) throw new Error("Subagent delegation host is already bound");
      host = nextHost;
    },
  };
}

export function createRuntimeSubagentHost(
  options: RuntimeSubagentHostOptions,
): SubagentDelegationHost {
  const createSessionFactory = options.createSessionFactory
    ?? ((dependencies: EmbeddedSubagentFactoryDependencies) => createEmbeddedSubagentSessionFactory(dependencies));
  const createSupervisor = options.createSupervisor
    ?? ((supervisorOptions: SubagentSupervisorOptions) => new SubagentSupervisor(supervisorOptions));
  const buildSupervisor = (workspace: string): DelegationSupervisor => createSupervisor({
    sessionFactory: createSessionFactory({ runtime: options.runtime }, workspace),
  }, workspace);

  return createSubagentDelegationHost({
    runtime: options.runtime,
    supervisor: buildSupervisor(options.runtime.currentWorkspace),
    createSupervisor: buildSupervisor,
    createEventSink: options.createEventSink,
  });
}

export function createSubagentDelegationHost(
  options: SubagentDelegationHostOptions,
): SubagentDelegationHost {
  let activeWorkspace = options.runtime.currentWorkspace;
  let activeSupervisor = options.supervisor;
  let disposed = false;
  let disposePromise: Promise<void> | undefined;
  let rotationTail: Promise<void> = Promise.resolve();
  let pendingWorkspace: string | undefined;
  let pendingSupervisor: Promise<DelegationSupervisor> | undefined;
  const disposedSupervisors = new WeakSet<object>();

  const disposeSupervisor = (supervisor: DelegationSupervisor): Promise<void> => {
    if (disposedSupervisors.has(supervisor)) return Promise.resolve();
    disposedSupervisors.add(supervisor);
    return Promise.resolve(supervisor.dispose()).then(() => undefined);
  };

  const supervisorForWorkspace = (workspace: string): Promise<DelegationSupervisor> => {
    if (disposed) return Promise.reject(new Error("Subagent delegation host has been disposed"));
    if (pendingWorkspace === workspace && pendingSupervisor) return pendingSupervisor;
    if (!pendingSupervisor && workspace === activeWorkspace) return Promise.resolve(activeSupervisor);

    // Create synchronously while runtime.currentWorkspace still matches this request's snapshot.
    const candidate = options.createSupervisor(workspace);
    const operation = rotationTail.then(async () => {
      if (disposed) {
        await disposeSupervisor(candidate);
        throw new Error("Subagent delegation host has been disposed");
      }
      if (workspace === activeWorkspace) {
        await disposeSupervisor(candidate);
        return activeSupervisor;
      }
      try {
        await disposeSupervisor(activeSupervisor);
      } catch (error) {
        try { await disposeSupervisor(candidate); } catch {}
        throw error;
      }
      if (disposed) {
        await disposeSupervisor(candidate);
        throw new Error("Subagent delegation host has been disposed");
      }
      activeWorkspace = workspace;
      activeSupervisor = candidate;
      return activeSupervisor;
    });

    rotationTail = operation.then(() => undefined, () => undefined);
    pendingWorkspace = workspace;
    pendingSupervisor = operation;
    void operation.finally(() => {
      if (pendingSupervisor !== operation) return;
      pendingWorkspace = undefined;
      pendingSupervisor = undefined;
    }).catch(() => undefined);
    return operation;
  };

  const delegateTasks: SubagentDelegateExecutor = async (request, signal, parentToolCallId) => {
    const resolvedParentToolCallId = parentToolCallId || `delegate-${randomUUID()}`;
    const workspace = options.runtime.currentWorkspace;
    const supervisor = await supervisorForWorkspace(workspace);
    if (disposed) throw new Error("Subagent delegation host has been disposed");
    const onEvent = options.createEventSink?.();
    const batch = supervisor.startBatch({
      ...adaptRequest(request, workspace),
      parentToolCallId: resolvedParentToolCallId,
      ...(onEvent ? { onEvent } : {}),
    });
    let abortPromise: Promise<unknown> | undefined;
    const abortBatch = (): Promise<unknown> => {
      abortPromise ??= Promise.resolve(supervisor.abortBatch(batch.batchId));
      return abortPromise;
    };
    const onAbort = (): void => {
      void abortBatch().catch(() => undefined);
    };

    if (signal) signal.addEventListener("abort", onAbort, { once: true });
    try {
      if (signal?.aborted) await abortBatch();
      return await batch.result;
    } finally {
      if (signal) signal.removeEventListener("abort", onAbort);
      if (abortPromise) await abortPromise.catch(() => undefined);
      supervisor.releaseBatch(batch.batchId);
    }
  };

  const host: SubagentDelegationHost = {
    validateSubagentModel(model: SubagentDelegationModel): boolean {
      if (disposed) return false;
      return Boolean(options.runtime.findModel(model.provider, model.id));
    },
    delegateTasks,
    dispose(): Promise<void> {
      if (disposePromise) return disposePromise;
      disposed = true;
      disposePromise = (async () => {
        await rotationTail;
        await disposeSupervisor(activeSupervisor);
      })();
      return disposePromise;
    },
  };
  return host;
}

function adaptRequest(
  request: SubagentDelegationRequest,
  workspace: string,
): Parameters<DelegationSupervisor["startBatch"]>[0] {
  return {
    workspace,
    tasks: request.tasks,
    maxConcurrent: request.maxConcurrent,
    timeoutSeconds: request.timeoutSeconds,
    maxTurns: request.maxTurns,
    maxToolCalls: request.maxToolCalls,
  };
}
