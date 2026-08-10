import type { DataLayout } from "../data/data-layout.js";
import { canonicalWorkspacePath } from "../data/data-layout.js";
import type { TrustedDesktopRoots } from "./desktop-ipc.js";
import type {
  NoneServerBinding,
  OwnedServerBinding,
  OwnedServerExit,
  ServerBinding,
} from "./server-binding.js";

type RestartTimer = ReturnType<typeof setTimeout>;

interface ContextServerRecovery {
  health: "idle" | "starting" | "healthy" | "recovering" | "failed";
  restartCount: number;
  restartTimer: RestartTimer | null;
  restartPromises: Set<Promise<void>>;
  generation: number;
}

export interface ManagedWindow {
  readonly webContents: { readonly id: number };
  focus(): void;
  isDestroyed(): boolean;
  on(event: "close" | "closed", listener: () => void): unknown;
}

export type WorkspaceStatus =
  | { state: "idle" }
  | { state: "starting"; workspace: string }
  | { state: "failed"; workspace: string; message: string };

export interface WindowContext {
  id: string;
  instanceId: string;
  window: ManagedWindow;
  workspace: string | null;
  layout: DataLayout | null;
  token: string | null;
  trustedRoots: TrustedDesktopRoots;
  server: ServerBinding;
  serverRecovery: ContextServerRecovery;
  lifecycle: "active" | "closing" | "closed";
  disposePromise: Promise<void> | null;
}

export interface InitialWindowInput {
  id?: string;
  instanceId: string;
  workspace: string;
  layout: DataLayout;
  token: string;
  server: ServerBinding;
}

export type WorkspaceOpenAction =
  | "bound"
  | "unchanged"
  | "focused-existing"
  | "switched";

export interface OwnedWindowServerInput {
  workspace: string;
  dataRoot: string;
  layout: DataLayout;
  instanceId: string;
  token: string;
  context: WindowContext;
}

export interface WindowManagerAdapters {
  dataRoot: string;
  createWindow(instanceId: string): ManagedWindow;
  createInstanceId(): string;
  createToken(): string;
  createTrustedRoots(): TrustedDesktopRoots;
  createNoneServerBinding(): NoneServerBinding;
  resolveDataLayout(input: {
    dataRoot: string;
    workspace: string;
    instanceId: string;
  }): DataLayout;
  createOwnedServerBinding(input: OwnedWindowServerInput): OwnedServerBinding;
  switchExternalWorkspace(context: WindowContext, workspace: string): Promise<void>;
  showWindowStatus(context: WindowContext, status: WorkspaceStatus): void | Promise<void>;
  onServerReady?(context: WindowContext): void | Promise<void>;
  onError?(error: unknown, context: WindowContext): void;
  restartDelayMs?: number;
  maxRestartAttempts?: number;
  setTimeout?: (callback: () => void, delay: number) => RestartTimer;
  clearTimeout?: (timer: RestartTimer) => void;
}

export class WindowManager {
  private readonly contexts = new Set<WindowContext>();
  private readonly senderIndex = new Map<number, WindowContext>();
  private readonly contextSenderIds = new WeakMap<WindowContext, number>();
  private readonly workspaceOwners = new Map<string, WindowContext>();
  private readonly pendingOpens = new Map<WindowContext, {
    workspace: string;
    promise: Promise<WorkspaceOpenAction>;
  }>();
  private readonly retryWorkspaces = new Map<WindowContext, string>();

  constructor(private readonly adapters: WindowManagerAdapters) {}

  createEmptyWindow(): WindowContext {
    const instanceId = this.adapters.createInstanceId();
    const context = this.registerContext({
      id: instanceId,
      instanceId,
      window: this.adapters.createWindow(instanceId),
      workspace: null,
      layout: null,
      token: null,
      trustedRoots: this.adapters.createTrustedRoots(),
      server: this.adapters.createNoneServerBinding(),
      serverRecovery: this.createServerRecovery("idle"),
      lifecycle: "active",
      disposePromise: null,
    });
    this.showWindowStatus(context, { state: "idle" });
    return context;
  }

  createInitialWindow(input: InitialWindowInput): WindowContext {
    const workspace = canonicalWorkspacePath(input.workspace);
    if (this.workspaceOwners.has(workspace)) {
      throw new Error(`Workspace already has a window: ${workspace}`);
    }
    const context = this.registerContext({
      id: input.id || input.instanceId,
      instanceId: input.instanceId,
      window: this.adapters.createWindow(input.instanceId),
      workspace,
      layout: input.layout,
      token: input.token,
      trustedRoots: this.adapters.createTrustedRoots(),
      server: input.server,
      serverRecovery: this.createServerRecovery(
        input.server.kind === "owned" && input.server.state !== "ready" ? "starting" : "healthy",
      ),
      lifecycle: "active",
      disposePromise: null,
    });
    this.trustContextRoots(context);
    this.workspaceOwners.set(workspace, context);
    if (input.server.kind === "owned") {
      this.showWindowStatus(context, { state: "starting", workspace });
      this.attachOwnedBinding(context, input.server);
    }
    return context;
  }

  contextForSender(senderId: number): WindowContext {
    const context = this.senderIndex.get(senderId);
    if (!context || context.lifecycle === "closed") {
      throw new Error(`Sender ${senderId} is not a managed window`);
    }
    return context;
  }

  contextForWorkspace(workspace: string): WindowContext | null {
    return this.workspaceOwners.get(canonicalWorkspacePath(workspace)) || null;
  }

  openWorkspace(context: WindowContext, workspace: string): Promise<WorkspaceOpenAction> {
    this.assertActiveContext(context);
    const canonical = canonicalWorkspacePath(workspace);
    const pending = this.pendingOpens.get(context);
    if (pending) {
      if (pending.workspace === canonical) return pending.promise;
      return Promise.reject(new Error(`Window ${context.id} is already opening another workspace`));
    }

    const promise = this.openWorkspaceInternal(context, canonical)
      .finally(() => {
        if (this.pendingOpens.get(context)?.promise === promise) {
          this.pendingOpens.delete(context);
        }
      });
    this.pendingOpens.set(context, { workspace: canonical, promise });
    return promise;
  }

  async retryWorkspace(context: WindowContext): Promise<WorkspaceOpenAction> {
    this.assertActiveContext(context);
    const pending = this.pendingOpens.get(context);
    if (pending) await pending.promise.catch(() => undefined);
    this.assertActiveContext(context);
    const workspace = this.retryWorkspaces.get(context);
    if (!workspace) throw new Error(`Window ${context.id} has no failed workspace to retry`);

    if (context.workspace === workspace) {
      const recovery = this.cancelServerRecovery(context);
      try {
        await context.server.stop();
        await recovery;
      } catch (error) {
        this.showWindowStatus(context, this.failedStatus(workspace, error));
        this.adapters.onError?.(error, context);
        throw error;
      }
      this.releaseWorkspace(workspace, context);
      this.resetBinding(context);
    }
    return this.openWorkspace(context, workspace);
  }

  reportWorkspaceFailure(context: WindowContext, error: unknown): boolean {
    if (!this.contexts.has(context) || context.lifecycle !== "active") return false;
    if (!context.workspace) throw new Error(`Window ${context.id} has no workspace to report`);
    this.retryWorkspaces.set(context, context.workspace);
    this.showWindowStatus(context, this.failedStatus(context.workspace, error));
    return true;
  }

  dispose(context: WindowContext): Promise<void> {
    if (context.disposePromise) return context.disposePromise;
    if (context.lifecycle === "closed") return Promise.resolve();

    context.lifecycle = "closing";
    const senderId = this.contextSenderIds.get(context);
    if (senderId !== undefined) this.senderIndex.delete(senderId);
    let disposePromise!: Promise<void>;
    disposePromise = this.disposeContext(context).catch((error) => {
      if (context.disposePromise === disposePromise) context.disposePromise = null;
      throw error;
    });
    context.disposePromise = disposePromise;
    return disposePromise;
  }

  disposeAll(): Promise<void> {
    return Promise.all([...this.contexts].map((context) => this.dispose(context))).then(() => undefined);
  }

  private registerContext(context: WindowContext): WindowContext {
    const senderId = context.window.webContents.id;
    if (this.senderIndex.has(senderId)) {
      throw new Error(`Window sender ${senderId} is already managed`);
    }
    this.contexts.add(context);
    this.senderIndex.set(senderId, context);
    this.contextSenderIds.set(context, senderId);
    const disposeWindowContext = () => {
      void this.dispose(context).catch((error) => this.adapters.onError?.(error, context));
    };
    context.window.on("close", disposeWindowContext);
    context.window.on("closed", disposeWindowContext);
    return context;
  }

  private async openWorkspaceInternal(
    context: WindowContext,
    workspace: string,
  ): Promise<WorkspaceOpenAction> {
    if (context.workspace === workspace) return "unchanged";

    const owner = this.workspaceOwners.get(workspace);
    if (owner && owner !== context) {
      if (owner.lifecycle === "closing") {
        const disposal = owner.disposePromise;
        if (!disposal) {
          throw new Error(`Workspace owner termination not confirmed: ${workspace}`);
        }
        await disposal;
        this.assertActiveContext(context);
        return this.openWorkspaceInternal(context, workspace);
      }
      if (owner.lifecycle === "active") {
        const transition = this.pendingOpens.get(owner);
        if (transition && transition.workspace !== workspace) {
          await transition.promise.catch(() => undefined);
          this.assertActiveContext(context);
          return this.openWorkspaceInternal(context, workspace);
        }
        if (!owner.window.isDestroyed()) owner.window.focus();
        return "focused-existing";
      }
    }

    const switching = context.workspace !== null;
    const previousWorkspace = context.workspace;
    const previousServer = context.server;

    if (switching && previousWorkspace && previousServer.kind === "external") {
      const layout = this.adapters.resolveDataLayout({
        dataRoot: this.adapters.dataRoot,
        workspace,
        instanceId: context.instanceId,
      });
      try {
        await this.adapters.switchExternalWorkspace(context, workspace);
      } catch (error) {
        this.adapters.onError?.(error, context);
        throw error;
      }
      if (context.lifecycle !== "active") {
        throw new Error(`Window ${context.id} is closing`);
      }
      this.releaseWorkspace(previousWorkspace, context);
      this.workspaceOwners.set(workspace, context);
      context.workspace = workspace;
      context.layout = layout;
      context.trustedRoots = this.adapters.createTrustedRoots();
      this.trustContextRoots(context);
      this.retryWorkspaces.delete(context);
      await this.adapters.onServerReady?.(context);
      return "switched";
    }

    this.workspaceOwners.set(workspace, context);
    this.retryWorkspaces.delete(context);
    this.showWindowStatus(context, { state: "starting", workspace });

    if (switching && previousWorkspace) {
      const recovery = this.cancelServerRecovery(context);
      try {
        await previousServer.stop();
        await recovery;
      } catch (error) {
        this.releaseWorkspace(workspace, context);
        this.retryWorkspaces.set(context, workspace);
        this.showWindowStatus(context, this.failedStatus(workspace, error));
        this.adapters.onError?.(error, context);
        throw error;
      }
      this.releaseWorkspace(previousWorkspace, context);
      this.resetBinding(context);
      if (context.lifecycle !== "active") {
        this.releaseWorkspace(workspace, context);
        throw new Error(`Window ${context.id} is closing`);
      }
    }

    let candidate: OwnedServerBinding | null = null;
    try {
      const layout = this.adapters.resolveDataLayout({
        dataRoot: this.adapters.dataRoot,
        workspace,
        instanceId: context.instanceId,
      });
      const token = this.adapters.createToken();
      candidate = this.adapters.createOwnedServerBinding({
        workspace,
        dataRoot: this.adapters.dataRoot,
        layout,
        instanceId: context.instanceId,
        token,
        context,
      });
      context.layout = layout;
      context.token = token;
      context.server = candidate;
      this.attachOwnedBinding(context, candidate);
      await candidate.start();
      if (context.lifecycle !== "active") {
        throw new Error(`Window ${context.id} closed while its server was starting`);
      }
      context.workspace = workspace;
      this.trustContextRoots(context);
      await this.adapters.onServerReady?.(context);
      context.serverRecovery.health = "healthy";
      context.serverRecovery.restartCount = 0;
      this.retryWorkspaces.delete(context);
      return switching ? "switched" : "bound";
    } catch (error) {
      this.retryWorkspaces.set(context, workspace);
      this.showWindowStatus(context, this.failedStatus(workspace, error));
      if (candidate) {
        try {
          await candidate.stop();
        } catch (cleanupError) {
          context.workspace = workspace;
          context.lifecycle = "closing";
          this.senderIndex.delete(context.window.webContents.id);
          const cleanupMessage = cleanupError instanceof Error
            ? cleanupError.message
            : String(cleanupError);
          const failure = new AggregateError(
            [error, cleanupError],
            `Candidate cleanup failed: ${cleanupMessage}`,
          );
          this.adapters.onError?.(failure, context);
          throw failure;
        }
      }
      this.releaseWorkspace(workspace, context);
      if (context.lifecycle === "active") this.resetBinding(context);
      this.adapters.onError?.(error, context);
      throw error;
    }
  }

  private async disposeContext(context: WindowContext): Promise<void> {
    const recovery = this.cancelServerRecovery(context);
    await context.server.stop();
    await recovery;

    for (const [workspace, owner] of this.workspaceOwners) {
      if (owner === context) this.workspaceOwners.delete(workspace);
    }
    this.contexts.delete(context);
    this.retryWorkspaces.delete(context);
    context.lifecycle = "closed";
  }

  private resetBinding(context: WindowContext): void {
    context.workspace = null;
    context.layout = null;
    context.token = null;
    context.trustedRoots = this.adapters.createTrustedRoots();
    context.server = this.adapters.createNoneServerBinding();
    context.serverRecovery = this.createServerRecovery("idle");
  }

  private createServerRecovery(health: ContextServerRecovery["health"]): ContextServerRecovery {
    return {
      health,
      restartCount: 0,
      restartTimer: null,
      restartPromises: new Set(),
      generation: 0,
    };
  }

  private attachOwnedBinding(context: WindowContext, binding: OwnedServerBinding): void {
    binding.setUnexpectedExitHandler((event) => {
      this.handleUnexpectedServerExit(context, binding, event);
    });
  }

  private handleUnexpectedServerExit(
    context: WindowContext,
    binding: OwnedServerBinding,
    event: OwnedServerExit,
  ): void {
    if (!this.isCurrentOwnedBinding(context, binding)) return;
    const recovery = context.serverRecovery;
    this.clearRestartTimer(recovery);
    recovery.health = "recovering";
    recovery.generation++;
    this.retryWorkspaces.delete(context);
    this.showWindowStatus(context, { state: "starting", workspace: context.workspace! });
    this.scheduleServerRestart(context, binding, this.exitError(event), recovery.generation);
  }

  private scheduleServerRestart(
    context: WindowContext,
    binding: OwnedServerBinding,
    lastError: Error,
    generation: number,
  ): void {
    if (!this.isCurrentRecovery(context, binding, generation)) return;
    const recovery = context.serverRecovery;
    const maxAttempts = this.adapters.maxRestartAttempts ?? 3;
    if (recovery.restartCount >= maxAttempts) {
      recovery.health = "failed";
      this.retryWorkspaces.set(context, context.workspace!);
      this.showWindowStatus(context, this.failedStatus(context.workspace!, lastError));
      return;
    }

    const schedule = this.adapters.setTimeout || setTimeout;
    recovery.restartTimer = schedule(() => {
      recovery.restartTimer = null;
      if (!this.isCurrentRecovery(context, binding, generation)) return;
      recovery.restartCount++;
      const restart = this.restartServer(context, binding, generation);
      const handledRestart = restart.catch((error) => {
        if (!this.isCurrentRecovery(context, binding, generation)) return;
        const failure = error instanceof Error ? error : new Error(String(error));
        try {
          this.adapters.onError?.(failure, context);
        } catch {}
        this.scheduleServerRestart(context, binding, failure, generation);
      });
      recovery.restartPromises.add(handledRestart);
      void handledRestart.then(() => {
        recovery.restartPromises.delete(handledRestart);
      });
    }, this.adapters.restartDelayMs ?? 1_000);
  }

  private async restartServer(
    context: WindowContext,
    binding: OwnedServerBinding,
    generation: number,
  ): Promise<void> {
    await binding.start();
    if (!this.isCurrentRecovery(context, binding, generation)) return;
    await this.adapters.onServerReady?.(context);
    if (!this.isCurrentRecovery(context, binding, generation)) return;
    context.serverRecovery.health = "healthy";
    context.serverRecovery.restartCount = 0;
    this.retryWorkspaces.delete(context);
  }

  private cancelServerRecovery(context: WindowContext): Promise<void> {
    const recovery = context.serverRecovery;
    recovery.generation++;
    this.clearRestartTimer(recovery);
    const pending = Promise.allSettled([...recovery.restartPromises]).then(() => undefined);
    recovery.health = "idle";
    recovery.restartCount = 0;
    return pending;
  }

  private clearRestartTimer(recovery: ContextServerRecovery): void {
    if (recovery.restartTimer === null) return;
    const cancel = this.adapters.clearTimeout || clearTimeout;
    cancel(recovery.restartTimer);
    recovery.restartTimer = null;
  }

  private isCurrentOwnedBinding(context: WindowContext, binding: OwnedServerBinding): boolean {
    return this.contexts.has(context)
      && context.lifecycle === "active"
      && context.server === binding
      && context.workspace !== null;
  }

  private isCurrentRecovery(
    context: WindowContext,
    binding: OwnedServerBinding,
    generation: number,
  ): boolean {
    return this.isCurrentOwnedBinding(context, binding)
      && context.serverRecovery.generation === generation
      && context.serverRecovery.health === "recovering";
  }

  private exitError(event: OwnedServerExit): Error {
    return event.error || new Error(
      `Pi server exited unexpectedly (code ${event.code ?? "unknown"}, signal ${event.signal ?? "none"})`,
    );
  }

  private releaseWorkspace(workspace: string, context: WindowContext): void {
    if (this.workspaceOwners.get(workspace) === context) {
      this.workspaceOwners.delete(workspace);
    }
  }

  private trustContextRoots(context: WindowContext): void {
    if (context.workspace) context.trustedRoots.addRoot(context.workspace);
    if (context.layout) {
      context.trustedRoots.addRoot(context.layout.workspaceRoot);
      context.trustedRoots.addRoot(context.layout.instanceRoot);
    }
  }

  private showWindowStatus(context: WindowContext, status: WorkspaceStatus): void {
    try {
      void Promise.resolve(this.adapters.showWindowStatus(context, status)).catch((error) => {
        this.adapters.onError?.(error, context);
      });
    } catch (error) {
      this.adapters.onError?.(error, context);
    }
  }

  private failedStatus(workspace: string, error: unknown): WorkspaceStatus {
    return {
      state: "failed",
      workspace,
      message: error instanceof Error ? error.message : String(error),
    };
  }

  private assertActiveContext(context: WindowContext): void {
    if (!this.contexts.has(context) || context.lifecycle !== "active") {
      throw new Error(`Window ${context.id} is not active`);
    }
  }
}
