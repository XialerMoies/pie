/**
 * Agent layer — 在 PI 框架之上叠自定义层
 *
 * 封装 createAgentSession() 为 AgentRuntime，支持：
 * - 自定义 Tool 注入
 * - 自定义 system prompt
 * - workspace 切换时重建 session
 *
 * 原则：只封装，不 fork。PI 的 agent-loop 不改。
 */
import { AgentRuntime, type RuntimeConfig } from "./runtime.js"
import { type AgentEngine } from "../agent-engine/index.js"
import { capabilityComponentManager } from "./capability-components.js"
import type { AgentEngineProvider } from "./capability-contracts.js"

export {
  CAPABILITY_COMPONENT_SCHEMA_VERSION,
  CAPABILITY_COMPONENT_SESSION_CUSTOM_TYPE,
  CapabilityComponentError,
  CapabilityComponentManager,
  REQUIRED_COMPONENT_MANIFESTS,
  capabilityComponentManager,
  componentManifestFingerprint,
  validateCapabilityComponentManifest,
  persistCapabilityComponentGeneration,
  readCapabilityComponentGeneration,
} from "./capability-components.js"
export {
  CAPABILITY_COMPONENT_PACKAGE_SCHEMA,
  CAPABILITY_COMPONENT_PACKAGE_SCHEMA_VERSION,
  CAPABILITY_COMPONENT_PACKAGE_RESOURCE_LIMITS,
  CapabilityComponentPackageError,
  normalizeCapabilityComponentPackageManifest,
  parseCapabilityComponentPackageManifest,
  validateCapabilityComponentPackageManifest,
  assertCapabilityComponentPackageCompatible,
  componentPackageManifestFingerprint,
  FILE_READ_COMPONENT_PACKAGE_MANIFEST,
  FIRST_PARTY_COMPONENT_PACKAGES,
  firstPartyComponentPackage,
  registerFirstPartyComponentPackages,
  installFirstPartyComponentPackage,
  capabilityComponentIdForTool,
  capabilityComponentPackageForTool,
} from "./component-package.js"
export type {
  CapabilityComponentDependency,
  CapabilityComponentHealth,
  CapabilityComponentKind,
  CapabilityComponentLifecycleAction,
  CapabilityComponentLifecycleEvent,
  CapabilityComponentLifecycleResult,
  CapabilityComponentManifest,
  CapabilityComponentSource,
  CapabilityComponentState,
  CapabilityComponentStatus,
  RegisterComponentOptions,
  RequiredComponentContract,
  SyncComponentOptions,
  RequiredProviderHealthResult,
  RequiredProviderLifecycle,
} from "./capability-components.js"
export type {
  CapabilityComponentPackageManifest,
  CapabilityComponentPackageSource,
  CapabilityComponentPackageSourceKind,
  CapabilityComponentPackageSignature,
  CapabilityComponentPackageCompatibility,
  CapabilityComponentPackageCompatibilityContext,
  CapabilityComponentPackagePermissions,
  CapabilityComponentPackageResources,
  CapabilityComponentPackageIsolation,
  CapabilityComponentPackageIsolationMode,
  CapabilityComponentPackagePermission,
} from "./component-package.js"
export {
  HIGH_RISK_REPLACEMENT_GROUPS,
  failedReplacementChecks,
} from "./capability-component-replacement.js"
export type {
  RequiredComponentGenerationRef,
  RequiredComponentLease,
  RequiredComponentProviderBinding,
  RequiredReplacementCheck,
  RequiredReplacementContext,
  RequiredReplacementOptions,
  RequiredReplacementPreflightReport,
  RequiredReplacementResult,
} from "./capability-component-replacement.js"
export type {
  RequiredCapability,
  SessionStoreEntry,
  SessionStoreSession,
  SessionStoreCreateOptions,
  SessionStoreProvider,
  PermissionEvaluator,
  PermissionEvaluatorDelegate,
  SecurityParserProvider,
  McpHostIntegration,
  AgentEngineProvider,
} from "./capability-contracts.js"
export { HOST_EXECUTION_CHAIN } from "./types.js"
export type { HostExecutionStage, ToolExecutionBoundary } from "./types.js"
export {
  assertRequiredProviderContract,
  createPermissionEvaluatorProvider,
} from "./capability-contracts.js"

export type { AgentRuntime, RuntimeConfig, AgentEngine }

export interface AgentHost {
  engine: AgentEngine
  runtime: AgentRuntime
}

/** Single construction path for every PI-backed host boundary. */
async function createAgentHost(config: RuntimeConfig): Promise<AgentHost> {
  const runtime = await AgentRuntime.create(config)
  const componentId = runtime.activeComponentGeneration?.providers["agent-engine"]
  const provider = capabilityComponentManager
    .getRequiredProviderBinding<AgentEngineProvider>("agent-engine", componentId)
    .implementation
  return { engine: provider.create(runtime), runtime }
}

/** Initialize the stable host-facing engine while PI remains behind the adapter. */
export async function initEngine(config: RuntimeConfig): Promise<AgentEngine> {
  return (await createAgentHost(config)).engine
}

/** Internal PI host for services that still manage providers and subagents. */
export async function initAgentHost(config: RuntimeConfig): Promise<AgentHost> {
  return createAgentHost(config)
}
