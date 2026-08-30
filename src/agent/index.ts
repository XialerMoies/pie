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
  assertCapabilityComponentPackageCompatible,
  componentPackageManifestFingerprint,
  FILE_READ_COMPONENT_PACKAGE_MANIFEST,
  EXPLORER_LIST_COMPONENT_PACKAGE_MANIFEST,
  SEARCH_COMPONENT_PACKAGE_MANIFEST,
  GIT_STATUS_COMPONENT_PACKAGE_MANIFEST,
  GIT_LOG_COMPONENT_PACKAGE_MANIFEST,
  FILE_OUTLINE_COMPONENT_PACKAGE_MANIFEST,
  WEB_SEARCH_COMPONENT_PACKAGE_MANIFEST,
  WEB_FETCH_COMPONENT_PACKAGE_MANIFEST,
  WRITE_AGENT_MD_COMPONENT_PACKAGE_MANIFEST,
  STR_REPLACE_EDITOR_COMPONENT_PACKAGE_MANIFEST,
  FILE_WRITE_COMPONENT_PACKAGE_MANIFEST,
  MEMORY_COMPONENT_PACKAGE_MANIFEST,
  PLAN_MODE_COMPONENT_PACKAGE_MANIFEST,
  SKILL_FACTS_COMPONENT_PACKAGE_MANIFEST,
  DELEGATE_TASKS_COMPONENT_PACKAGE_MANIFEST,
  COMMAND_COMPONENT_PACKAGE_MANIFEST,
  FIRST_PARTY_COMPONENT_PACKAGES,
  firstPartyComponentPackage,
  registerFirstPartyComponentPackages,
  capabilityComponentIdForTool,
  capabilityComponentPackageForTool,
} from "./component-package.js"
export type {
  CapabilityComponentDependency,
  CapabilityComponentAgentConfig,
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
export {
  ExtensionLifecycle,
  extensionLifecycle,
} from "./extension-lifecycle.js"
export {
  EXTENSION_PACKAGE_STORE_SCHEMA_VERSION,
  ExtensionPackageStore,
  extensionPackageStore,
  defaultExtensionPackageStorePath,
  extensionPackageUpdatePreview,
} from "./extension-package-store.js"
export type { InstalledExtensionPackageRecord, ExtensionPackageUpdatePreview } from "./extension-package-store.js"
export {
  EXTENSION_SOURCE_STORE_SCHEMA_VERSION,
  ExtensionSourceError,
  ExtensionSourceStore,
  extensionSourceStore,
  defaultExtensionSourceStorePath,
} from "./extension-source-store.js"
export {
  EXTENSION_SOURCE_INDEX_SCHEMA_VERSION,
  ExtensionSourceCatalog,
  extensionSourceIndexSigningPayload,
} from "./extension-source-catalog.js"
export type {
  ExtensionSourceRecord,
} from "./extension-source-store.js"
export type {
  ExtensionSourceIndex,
  ExtensionSourceIndexPackage,
  ExtensionSourceIndexVersion,
  ExtensionSourceCatalogPackageVersion,
  ExtensionSourceIndexSignature,
} from "./extension-source-catalog.js"
export type {
  ExtensionActivationContext,
  ExtensionInstallOptions,
  ExtensionPackageInstallOptions,
  ExtensionLifecycleHooks,
  ExtensionLifecyclePhase,
  ExtensionLifecycleSnapshot,
  ExtensionResource,
} from "./extension-lifecycle.js"
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
  DECLARATIVE_RESOURCE_SCHEMA_VERSION,
  buildDeclarativeResourceCatalog,
  declarativeSkillResource,
  declarativeSubagentResource,
  declarativeProfileResource,
} from "./declarative-resources.js"
export {
  EXTENSION_MANIFEST_SCHEMA_VERSION,
  normalizeExtensionManifest,
  validateExtensionManifest,
  isExtensionEligible,
  assertExtensionEligible,
  extensionManifestFromPackage,
} from "./extension-manifest.js"
export type {
  ExtensionManifest,
  ExtensionManifestCompatibility,
  ExtensionManifestPermissions,
  ExtensionAgentConfig,
  ExtensionContributionType,
  ExtensionPermission,
} from "./extension-manifest.js"
export { createExtensionApi } from "./extension-api.js"
export {
  EXTENSION_SETTINGS_SCHEMA_VERSION,
  normalizeExtensionSettingSchemas,
  resolveExtensionSettings,
  readExtensionSettings,
  updateExtensionSettings,
  removeExtensionSettings,
} from "./extension-settings.js"
export type {
  ExtensionSettingSchema,
  ExtensionSettingType as ExtensionManifestSettingType,
  ExtensionSettingValue,
  ExtensionSettingsScope,
} from "./extension-settings.js"
export { ExtensionToolRegistry, extensionToolRegistry } from "./extension-tool-registry.js"
export type { ExtensionToolRegistration, ExtensionToolRegistrationOptions, ExtensionToolSettingsResolver } from "./extension-tool-registry.js"
export type {
  ExtensionApi,
  ExtensionApiAdapters,
  ExtensionDisposable,
  ExtensionEventName,
  ExtensionSettingDefinition,
  ExtensionSettingType,
  ExtensionToolDefinition,
  ExtensionUiDefinition,
} from "./extension-api.js"
export {
  INTEGRATION_RECORD_SCHEMA_VERSION,
  mcpIntegrationRecord,
} from "./integrations.js"
export type {
  IntegrationRecord,
  IntegrationKind,
  IntegrationHealth,
  IntegrationLifecycle,
  McpIntegrationInput,
} from "./integrations.js"
export type {
  DeclarativeResourceKind,
  DeclarativeResourceSource,
  DeclarativeComponentResource,
  DeclarativeResourceCatalog,
  DeclarativeResourceCatalogInput,
} from "./declarative-resources.js"
export {
  HIGH_RISK_REPLACEMENT_GROUPS,
  CORE_REPLACEMENT_GROUPS,
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
