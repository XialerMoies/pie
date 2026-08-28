/**
 * 宿主 UI contribution registry。
 *
 * 这是登记与生命周期边界，不是动态脚本加载器。贡献只能由宿主已加载的
 * 代码注册，并通过 componentId 绑定到能力组件状态；管理动作仍由宿主完成。
 */
type UiContributionKind = "pane" | "settings" | "language-service";

interface UiContributionContext {
  isComponentActive?: (componentId: string) => boolean;
}

interface UiContributionDefinition {
  id: string;
  componentId: string;
  kind: UiContributionKind;
  mount?: (container: HTMLElement) => void | (() => void);
  render?: (container: HTMLElement) => void;
  dispose?: () => void;
  activate?: () => void | (() => void);
}

interface UiContributionHandle {
  id: string;
  kind: UiContributionKind;
  componentId: string;
  mount(container: HTMLElement): () => void;
  activate(): () => void;
  dispose(): void;
}

export function createUiContributionRegistry(initialContext: UiContributionContext = {}) {
  let context = initialContext;
  const definitions = new Map<string, UiContributionDefinition>();
  const mounted = new Map<string, Set<() => void>>();
  const activated = new Map<string, Set<() => void>>();

  function register(definition: UiContributionDefinition): UiContributionHandle {
    if (!definition || !definition.id || !definition.componentId) throw new Error("UI contribution requires id and componentId");
    if (!/^(pane|settings|language-service)$/.test(definition.kind)) throw new Error(`Unsupported UI contribution kind: ${definition.kind}`);
    if (definitions.has(definition.id)) throw new Error(`Duplicate UI contribution: ${definition.id}`);
    if (!definition.mount && !definition.render && !definition.activate) throw new Error(`UI contribution requires mount, render, or activate: ${definition.id}`);
    definitions.set(definition.id, definition);
    return handleFor(definition);
  }

  function handleFor(definition: UiContributionDefinition): UiContributionHandle {
    return {
      id: definition.id,
      kind: definition.kind,
      componentId: definition.componentId,
      mount(container: HTMLElement): () => void {
        if (context.isComponentActive && !context.isComponentActive(definition.componentId)) {
          throw new Error(`UI contribution component is inactive: ${definition.componentId}`);
        }
        const cleanup = definition.mount?.(container) || (definition.render ? () => definition.render!(container) : undefined);
        const disposer = typeof cleanup === "function" ? cleanup : () => {};
        let active = true;
        const unmount = () => {
          if (!active) return;
          active = false;
          disposer();
          const set = mounted.get(definition.id);
          set?.delete(unmount);
          if (set?.size === 0) mounted.delete(definition.id);
        };
        let set = mounted.get(definition.id);
        if (!set) { set = new Set(); mounted.set(definition.id, set); }
        set.add(unmount);
        return unmount;
      },
      activate(): () => void {
        if (context.isComponentActive && !context.isComponentActive(definition.componentId)) {
          throw new Error(`UI contribution component is inactive: ${definition.componentId}`);
        }
        const cleanup = definition.activate?.();
        const disposer = typeof cleanup === 'function' ? cleanup : () => {};
        let active = true;
        const stop = () => {
          if (!active) return;
          active = false;
          disposer();
          const set = activated.get(definition.id);
          set?.delete(stop);
          if (set?.size === 0) activated.delete(definition.id);
        };
        let set = activated.get(definition.id);
        if (!set) { set = new Set(); activated.set(definition.id, set); }
        set.add(stop);
        return stop;
      },
      dispose(): void {
        for (const unmount of [...(mounted.get(definition.id) || [])]) unmount();
        for (const stop of [...(activated.get(definition.id) || [])]) stop();
        definition.dispose?.();
      },
    };
  }

  const api = {
    configure(nextContext: UiContributionContext): void { context = nextContext || {}; },
    register,
    get(id: string): UiContributionHandle | undefined {
      const definition = definitions.get(id);
      return definition ? handleFor(definition) : undefined;
    },
    list(): UiContributionDefinition[] { return [...definitions.values()]; },
    dispose(id: string): void {
      const definition = definitions.get(id);
      if (definition) handleFor(definition).dispose();
    },
    clear(): void {
      for (const definition of definitions.values()) handleFor(definition).dispose();
      definitions.clear(); mounted.clear(); activated.clear();
    },
  };
  return api;
}

const uiContributionApp = (globalThis as any).App || ((globalThis as any).App = {});
const uiContributionRegistry = uiContributionApp.UIContributions || createUiContributionRegistry();
uiContributionApp.UIContributions = uiContributionRegistry;
