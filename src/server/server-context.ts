import type { AgentEngine } from "../agent-engine/index.js";
import type { AgentRuntime } from "../agent/index.js";
import type { AppEventHub } from "./app-events.js";
import type { ChatStreamState } from "./routes/types.js";
import type { DesktopSecurityConfig } from "./security.js";
import type { ServerPermissionService } from "./permission-service.js";
import type { RootRegistry } from "./root-registry.js";
import type { PermissionModeController } from "./permission-mode.js";
import type { WorkspaceLockCoordinator } from "./workspace-lock.js";
import type { CustomProviderService } from "../model-provider/custom-provider-service.js";
import type { ProviderReferenceMutationLock } from "../model-provider/provider-reference-lock.js";
import type { TsserverManager } from "./ts-server.js";
import type { ServerObservability } from "./observability.js";
import type { StartupPathsSnapshot } from "./startup-paths.js";
import type { ModelRegistry, ModelRuntime } from "@xiamol/pi-coding-agent";

export interface ServerCoreContext {
  engine: AgentEngine;
  runtime: AgentRuntime;
  chatStream: ChatStreamState;
  appEvents: AppEventHub;
  recordUserNote?: (note: { noteId: string; message: string; mode: "steer" | "followUp" }) => void;
}

export interface ServerSecurityContext {
  config?: DesktopSecurityConfig;
  permissionService?: ServerPermissionService;
  rootRegistry?: RootRegistry;
  permissionMode?: PermissionModeController;
}

export interface ServerStorageContext {
  workspaceLock?: WorkspaceLockCoordinator;
  paths: {
    APP_ROOT: string;
    DATA_DIR: string;
    PI_CONFIG_DIR: string;
    SESSIONS_DIR: string;
    SETTINGS_FILE: string;
    SUBAGENTS_FILE?: string;
    DATA_ROOT_POINTER_FILE?: string;
    STARTUP?: StartupPathsSnapshot;
    FRONTEND_DIR: string;
    FRONTEND_SRC_DIR: string;
    HAS_BUILT_FRONTEND: boolean;
  };
}

export interface ServerProviderContext {
  customProviderService?: CustomProviderService;
  providerReferenceLock?: ProviderReferenceMutationLock;
  /** E0-b compatibility boundary for model/provider settings; not the AgentEngine contract. */
  model: ModelProviderContext;
}

export interface ModelProviderContext {
  readonly modelRuntime: ModelRuntime;
  readonly modelRegistry: ModelRegistry;
  syncModelProviders(): Promise<number>;
  runWithStableSession<T>(operation: () => Promise<T>): Promise<T>;
}

export interface ServerInfraContext {
  tsServer?: TsserverManager;
  observability?: ServerObservability;
}

export interface ServerContextGroups {
  core: ServerCoreContext;
  security: ServerSecurityContext;
  storage: ServerStorageContext;
  providers: ServerProviderContext;
  infra: ServerInfraContext;
}
