/** Host-owned activation hooks for shipped extension packages. */
import { capabilityComponentManager } from "./capability-components.js"
import { extensionLifecycle, type ExtensionLifecycleHooks } from "./extension-lifecycle.js"
import { extensionToolRegistry } from "./extension-tool-registry.js"
import { fileOutlineTool } from "./tools/file-outline.js"

const FILE_OUTLINE_COMPONENT_ID = "tool.file-outline"

const fileOutlineHooks: ExtensionLifecycleHooks = {
  activate: ({ registerResource }) => {
    const registration = extensionToolRegistry.registerFirstParty(FILE_OUTLINE_COMPONENT_ID, fileOutlineTool, {
      audiences: ["main", "coordinator", "subagent"],
    })
    registerResource({ id: "tool.file_outline", dispose: registration.dispose })
  },
}

export function firstPartyExtensionHooks(componentId: string): ExtensionLifecycleHooks {
  return componentId === FILE_OUTLINE_COMPONENT_ID ? fileOutlineHooks : {}
}

/** Reconcile a shipped contribution only after component state is available. */
export function ensureFirstPartyExtensionContributions(): void {
  const state = capabilityComponentManager.get(FILE_OUTLINE_COMPONENT_ID)
  if (!state || state.status !== "active" || extensionToolRegistry.has("file_outline")) return
  const registration = extensionToolRegistry.registerFirstParty(FILE_OUTLINE_COMPONENT_ID, fileOutlineTool, {
    audiences: ["main", "coordinator", "subagent"],
  })
  extensionLifecycle.adopt(FILE_OUTLINE_COMPONENT_ID, fileOutlineHooks, [
    { id: "tool.file_outline", dispose: registration.dispose },
  ])
}
