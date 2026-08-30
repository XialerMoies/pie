/** Host-controlled contribution surface exposed to an activated extension. */

export type ExtensionEventName = "workspace.changed" | "session.changed" | "component.changed" | "app.shutdown"
export type ExtensionSettingType = "string" | "number" | "boolean" | "select"

export interface ExtensionDisposable { dispose(): void | Promise<void> }

export interface ExtensionToolDefinition {
  id: string
  description: string
  inputSchema: unknown
  /** The host wraps this callback in the normal permission/security/trace chain. */
  execute(input: unknown, signal: AbortSignal, settings: Readonly<Record<string, string | number | boolean>>): unknown | Promise<unknown>
}

export interface ExtensionSettingDefinition {
  id: string
  type: ExtensionSettingType
  label: string
  defaultValue?: string | number | boolean
  choices?: readonly string[]
  read(): string | number | boolean | undefined | Promise<string | number | boolean | undefined>
  write?(value: string | number | boolean): void | Promise<void>
}

export interface ExtensionUiDefinition {
  id: string
  kind: "pane" | "settings" | "language-service"
  mount(container: HTMLElement): void | (() => void)
  dispose?(): void
}

export interface ExtensionApiAdapters {
  registerTool(definition: ExtensionToolDefinition): ExtensionDisposable
  registerSetting(definition: ExtensionSettingDefinition): ExtensionDisposable
  registerUi(definition: ExtensionUiDefinition): ExtensionDisposable
  on(event: ExtensionEventName, listener: (payload: unknown) => void): ExtensionDisposable
}

export interface ExtensionApi {
  readonly componentId: string
  readonly tools: { register(definition: ExtensionToolDefinition): ExtensionDisposable }
  readonly settings: { register(definition: ExtensionSettingDefinition): ExtensionDisposable }
  readonly ui: { register(definition: ExtensionUiDefinition): ExtensionDisposable }
  readonly events: { on(event: ExtensionEventName, listener: (payload: unknown) => void): ExtensionDisposable }
}

const ID_PATTERN = /^[a-z0-9][a-z0-9._-]*$/u
const SECRET_NAME_PATTERN = /(?:secret|token|password|passwd|api[-_.]?key|private[-_.]?key)/iu

function assertId(id: string, label: string): void {
  if (!ID_PATTERN.test(id)) throw new Error(`${label} must be a stable identifier`)
}

function assertSetting(definition: ExtensionSettingDefinition): void {
  assertId(definition.id, "setting id")
  if (!definition.label.trim()) throw new Error(`setting label is required: ${definition.id}`)
  if (SECRET_NAME_PATTERN.test(definition.id)) throw new Error(`secret-bearing settings are host-owned: ${definition.id}`)
  if (definition.type === "select" && (!definition.choices || definition.choices.length === 0)) throw new Error(`select setting requires choices: ${definition.id}`)
}

/**
 * Create a namespaced API. Adapters are supplied by the host; this function
 * only validates declarations and never grants direct runtime access.
 */
export function createExtensionApi(componentId: string, adapters: ExtensionApiAdapters): ExtensionApi {
  assertId(componentId, "componentId")
  const registerTool = (definition: ExtensionToolDefinition): ExtensionDisposable => {
    assertId(definition.id, "tool id")
    if (!definition.description.trim() || typeof definition.execute !== "function") throw new Error(`invalid extension tool: ${definition.id}`)
    return adapters.registerTool({ ...definition, id: `${componentId}.${definition.id}` })
  }
  const registerSetting = (definition: ExtensionSettingDefinition): ExtensionDisposable => {
    assertSetting(definition)
    return adapters.registerSetting({ ...definition, id: `${componentId}.${definition.id}` })
  }
  const registerUi = (definition: ExtensionUiDefinition): ExtensionDisposable => {
    assertId(definition.id, "UI contribution id")
    if (typeof definition.mount !== "function") throw new Error(`UI contribution requires mount: ${definition.id}`)
    return adapters.registerUi({ ...definition, id: `${componentId}.${definition.id}` })
  }
  return Object.freeze({
    componentId,
    tools: Object.freeze({ register: registerTool }),
    settings: Object.freeze({ register: registerSetting }),
    ui: Object.freeze({ register: registerUi }),
    events: Object.freeze({ on: (event: ExtensionEventName, listener: (payload: unknown) => void) => {
      if (typeof listener !== "function") throw new Error("extension event listener must be a function")
      return adapters.on(event, listener)
    } }),
  })
}
