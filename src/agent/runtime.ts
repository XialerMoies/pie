/**
 * AgentRuntime — AgentSession 的生命周期管理
 *
 * workspace 切换时重建整个 AgentSession（含内置工具），
 * 而不是 patch 私有字段。
 */
import { readdirSync, existsSync } from "fs"
import { resolve } from "path"
import type { AgentSession } from "@xiamol/pi-coding-agent"
import { createAgentSession, ModelRuntime, ModelRegistry, SessionManager, DefaultResourceLoader } from "@xiamol/pi-coding-agent"
import { resolveSystemPrompt } from "./prompts.js"
import { getCustomToolsAsync, disconnectMcp, reconnectMcp } from "./tools/index.js"
import type { SessionPermissionState, ToolContext } from "./types.js"
import { applySessionPermissionSuggestions, normalizePermissionPath, resetSessionPermissionState } from "./permissions.js"
import { wsDir } from "../server/routes/session-dir.js"
import { calculateContextUsageSnapshot, type ContextUsageSnapshot } from "./context-usage.js"

import { setCurrentRuntime as _setGlobalRuntime, getCurrentRuntime as _getGlobalRuntime } from "./globals.js";
// 重导出供 tools 使用，实际实现在 globals.ts（零依赖，防循环）
export const getCurrentRuntime = _getGlobalRuntime;
export const setCurrentRuntime = _setGlobalRuntime;

export interface RuntimeConfig {
  agentDir: string
  cwd: string
  sessionsDir: string
  sessionsDirForWorkspace?: (workspace: string) => string
  authFile: string
  modelsFile: string
  /** 权限模式：由宿主设置，传递给工具执行上下文 */
  permissionMode?: ToolContext["permissionMode"]
  getPermissionMode?: ToolContext["getPermissionMode"]
  /** 实际 shell 方言：由宿主设置，传递给命令安全解析 */
  shellDialect?: ToolContext["shellDialect"]
  /** 用户确认回调：返回 true=允许，false/undefined=拒绝 */
  confirmCommand?: ToolContext["confirmCommand"]
  sessionPermissionState?: SessionPermissionState
  authorizePath?: ToolContext["authorizePath"]
  authorizeTool?: ToolContext["authorizeTool"]
  applyPermissionSuggestions?: ToolContext["applyPermissionSuggestions"]
  desktopApiToken?: string
  validateSubagentModel?: ToolContext["validateSubagentModel"]
  getSubagentDefinitions?: ToolContext["getSubagentDefinitions"]
  getSubagentLimits?: ToolContext["getSubagentLimits"]
  delegateTasks?: ToolContext["delegateTasks"]
  syncModelProviders?: (runtime: ModelRuntime) => Promise<number>
}

type RuntimeToolExtraContext = Pick<
  ToolContext,
  | "permissionMode"
  | "getPermissionMode"
  | "confirmCommand"
  | "shellDialect"
  | "additionalWorkingDirectories"
  | "alwaysAllowRules"
  | "alwaysDenyRules"
  | "alwaysAskRules"
  | "applyPermissionSuggestions"
  | "authorizePath"
  | "authorizeTool"
  | "desktopApiToken"
  | "validateSubagentModel"
  | "getSubagentDefinitions"
  | "getSubagentLimits"
  | "delegateTasks"
>

export function buildToolContextExtra(config: RuntimeConfig): RuntimeToolExtraContext | undefined {
  const permissionState = config.sessionPermissionState
  if (!config.permissionMode && !config.getPermissionMode && !config.confirmCommand && !config.shellDialect && !permissionState && !config.authorizePath && !config.authorizeTool && !config.applyPermissionSuggestions && !config.desktopApiToken && !config.validateSubagentModel && !config.getSubagentDefinitions && !config.getSubagentLimits && !config.delegateTasks) return undefined
  return {
    permissionMode: config.permissionMode,
    getPermissionMode: config.getPermissionMode,
    confirmCommand: config.confirmCommand,
    shellDialect: config.shellDialect,
    additionalWorkingDirectories: permissionState?.additionalWorkingDirectories,
    alwaysAllowRules: permissionState?.alwaysAllowRules,
    alwaysDenyRules: permissionState?.alwaysDenyRules,
    alwaysAskRules: permissionState?.alwaysAskRules,
    applyPermissionSuggestions: config.applyPermissionSuggestions || (permissionState
      ? (suggestions, scope) => {
          if (scope === "session") applySessionPermissionSuggestions(permissionState, suggestions)
        }
      : undefined),
    authorizePath: config.authorizePath,
    authorizeTool: config.authorizeTool,
    desktopApiToken: config.desktopApiToken,
    validateSubagentModel: config.validateSubagentModel,
    getSubagentDefinitions: config.getSubagentDefinitions,
    getSubagentLimits: config.getSubagentLimits,
    delegateTasks: config.delegateTasks,
  }
}

export type SessionEventCallback = (event: any, sourceSession?: AgentSession) => void
export type WorkspaceChangeCallback = (workspace: string) => void

interface SessionEventSubscription {
  cb: SessionEventCallback
  currentUnsub?: () => void
  active: boolean
}

interface SessionToolTraceEmitter {
  emit: (event: any) => void
  bindSource: (sourceSession: AgentSession) => void
}

interface SessionRecoveryPoint {
  workspace: string
  sessionFile?: string
}

function sameRuntimePath(left: string | undefined, right: string): boolean {
  return !!left && normalizePermissionPath(left) === normalizePermissionPath(right)
}

export function recoverConversationLeaf(sessionManager: SessionManager): boolean {
  if (sessionManager.buildSessionContext().messages.length > 0) return false
  const lastMessage = [...sessionManager.getEntries()].reverse()
    .find((entry: any) => entry?.type === "message" && entry.id)
  if (!lastMessage) return false
  sessionManager.branch(lastMessage.id)
  return sessionManager.buildSessionContext().messages.length > 0
}

export class AgentRuntime {
  private _session?: AgentSession
  modelRuntime!: ModelRuntime
  modelRegistry!: ModelRegistry
  sessionManager!: SessionManager
  config!: RuntimeConfig
  currentWorkspace!: string
  private _eventSubscriptions: SessionEventSubscription[] = []
  private _workspaceChangeSubscriptions = new Set<WorkspaceChangeCallback>()
  private _transitionTail: Promise<void> = Promise.resolve()
  private _pendingOpens = new Map<string, Promise<void>>()
  private _modelProviderSync?: Promise<number>

  private constructor() {}

  /** 返回当前可用会话；恢复失败时明确阻止调用已释放对象。 */
  get session(): AgentSession {
    if (!this._session) throw new Error("[runtime] 当前没有可用的 Agent session")
    return this._session
  }

  /** 等待当前 session 切换完成，再返回可用 session；切换失败时保持 fail-closed。 */
  async waitForSessionReady(): Promise<AgentSession> {
    await (this._transitionTail ?? Promise.resolve())
    return this.session
  }

  /** Run an operation after pending transitions and prevent a new session transition until it settles. */
  runWithStableSession<T>(operation: () => Promise<T>): Promise<T> {
    return this._enqueueSessionTransition(operation)
  }

  getContextUsageSnapshot(): ContextUsageSnapshot | undefined {
    return calculateContextUsageSnapshot(this.session)
  }

  syncModelProviders(): Promise<number> {
    const sync = this.config.syncModelProviders
    if (!sync) return Promise.resolve(0)
    if (this._modelProviderSync) return this._modelProviderSync

    const operation = Promise.resolve().then(async () => {
      if (this._session?.isStreaming) await this._session.waitForIdle()
      const session = this._session
      const activeModel = session?.model
      const revision = await sync(this.modelRuntime)
      if (activeModel && session && this._session === session) {
        const refreshedModel = this.modelRegistry.find(activeModel.provider, activeModel.id)
        if (refreshedModel && refreshedModel !== activeModel) {
          await session.setModel(refreshedModel)
        }
      }
      return revision
    })
    let pending: Promise<number>
    pending = operation.finally(() => {
      if (this._modelProviderSync === pending) this._modelProviderSync = undefined
    })
    this._modelProviderSync = pending
    return pending
  }

  /** Sync shared provider state for an embedded subagent without waiting on or rebinding its parent session. */
  syncModelProvidersForSubagent(): Promise<number> {
    return this.config.syncModelProviders?.(this.modelRuntime) ?? Promise.resolve(0)
  }

  /** 仅在会话完整初始化后更新对外可见对象。 */
  set session(session: AgentSession) {
    this._session = session
  }

  private resetSessionPermissions(): void {
    const state = this.config?.sessionPermissionState
    if (state) resetSessionPermissionState(state)
  }

  /** 创建新的运行时 */
  static async create(config: RuntimeConfig): Promise<AgentRuntime> {
    const runtime = new AgentRuntime()
    runtime.config = config
    runtime.currentWorkspace = config.cwd
    _setGlobalRuntime(runtime) // _initSession 会调 resolveSystemPrompt → getCurrentRuntime，必须先设置
    await runtime._initSession(config.cwd)
    return runtime
  }

  /** 切换 workspace（重建整个 session）—— 不续写旧文件，新 workspace 独立 session */
  async switchWorkspace(workspace: string): Promise<void> {
    await this._enqueueSessionTransition(async () => {
      if (workspace === this.currentWorkspace && this._session) return
      this.resetSessionPermissions()

      console.log(`[runtime] Switching workspace: "${this.currentWorkspace}" → "${workspace}"`)

      // 不续写旧文件：workspace 切换意味着项目切换，新项目应有自己的 session 文件
      await this._replaceSessionWithRollback(workspace, false)
      console.log(`[runtime] ✅ Switched to "${workspace}"`)
    })
  }

  /**
   * 打开指定 session 文件作为活跃 session。
   * 与 switchWorkspace 不同：相同 workspace 下切换不同 session 文件。
   * 同 workspace 不断 MCP，保持缓存有效。
   */
  async openSession(sessionFile: string, workspace: string): Promise<void> {
    // 相同参数在本 runtime 内复用同一个排队任务，不影响其他 runtime 实例。
    const key = normalizePermissionPath(sessionFile) + "::" + normalizePermissionPath(workspace)
    const pendingOpens = this._pendingOpens ??= new Map<string, Promise<void>>()
    const inFlight = pendingOpens.get(key)
    if (inFlight) {
      console.log(`[runtime] ⏭ In-flight dedup openSession: "${sessionFile}"`)
      await inFlight
      return
    }

    const promise = this._enqueueSessionTransition(() => this._doOpenSession(sessionFile, workspace))
    pendingOpens.set(key, promise)
    try {
      await promise
    } finally {
      if (pendingOpens.get(key) === promise) pendingOpens.delete(key)
    }
  }

  /** 在串行队列中打开 session，执行时再判断最终 runtime 状态。 */
  private async _doOpenSession(sessionFile: string, workspace: string): Promise<void> {
    if (sameRuntimePath(this._session?.sessionFile, sessionFile)
      && sameRuntimePath(this.currentWorkspace, workspace)) {
      console.log(`[runtime] ⏭ Skipping duplicate openSession: "${sessionFile}"`)
      return
    }
    console.log(`[runtime] Opening session: "${sessionFile}"`)
    this.resetSessionPermissions()
    // 记录是否同 workspace（在更新 currentWorkspace 之前判断）
    const sameWs = sameRuntimePath(this.currentWorkspace, workspace)
    await this._replaceSessionWithRollback(workspace, sameWs, sessionFile)
    console.log(`[runtime] ✅ Session opened: "${sessionFile}"`)
  }

  /**
   * 强制创建新 session（不续写旧文件）。
   * 返回新 session ID。
   */
  async createNewSession(): Promise<string> {
    return this._enqueueSessionTransition(async () => {
      console.log(`[runtime] Creating new session`)
      this.resetSessionPermissions()

      await this._replaceSessionWithRollback(
        this.currentWorkspace,
        true,
        undefined,
        true /* forceNew */,
      )
      const id = this.session.sessionManager?.getSessionId?.() || ""
      console.log(`[runtime] ✅ New session created: ${id}`)
      return id
    })
  }

  /** 强制刷新 system prompt（从 sections 重新 resolve 并注入 session） */
  async refreshSystemPrompt(): Promise<void> {
    const { resolveSystemPrompt } = await import("./prompts.js")
    const newPrompt = resolveSystemPrompt()
    try {
      // 更新 resource loader 的 append prompt
      const loader = (this.session as any)._resourceLoader
      if (loader?.setAppendSystemPrompt) {
        loader.setAppendSystemPrompt([newPrompt])
      }
      // 触发 session 重建 system prompt
      ;(this.session as any).refreshSystemPrompt?.()
      console.log(`[runtime] ✅ System prompt refreshed`)
    } catch (e) {
      console.log(`[runtime] refreshSystemPrompt error: ${e}`)
    }
  }

  /** 获取当前活跃 session 基本信息 */
  getActiveSession(): { id: string; file: string } | null {
    try {
      return {
        id: this.session?.sessionManager?.getSessionId?.() || "",
        file: this.session?.sessionFile || "",
      }
    } catch {
      return null
    }
  }

  /** 绑定 session 事件 */
  onEvent(cb: SessionEventCallback): () => void {
    const subscription: SessionEventSubscription = { cb, active: true }
    this._eventSubscriptions.push(subscription)
    if (this._session) this._bindEventSubscription(subscription, this._session)
    return () => {
      if (!subscription.active) return
      subscription.active = false
      const idx = this._eventSubscriptions.indexOf(subscription)
      if (idx >= 0) this._eventSubscriptions.splice(idx, 1)
      const currentUnsub = subscription.currentUnsub
      subscription.currentUnsub = undefined
      try { currentUnsub?.() } catch {}
    }
  }

  /** Subscribe to successful workspace transitions. */
  onWorkspaceChange(cb: WorkspaceChangeCallback): () => void {
    const subscriptions = this._workspaceChangeSubscriptions ??= new Set()
    subscriptions.add(cb)
    return () => subscriptions.delete(cb)
  }

  /** 清理 */
  dispose(): void {
    for (const subscription of this._eventSubscriptions) {
      subscription.active = false
      try { subscription.currentUnsub?.() } catch {}
      subscription.currentUnsub = undefined
    }
    this._eventSubscriptions = []
    this._workspaceChangeSubscriptions?.clear()
    const session = this._session
    this._session = undefined
    try { session?.dispose() } catch {}
    disconnectMcp()
  }

  /** 自定义工具事件兜底：复用 PI 的事件订阅通道 */
  emitEvent(event: any, sourceSession?: AgentSession): void {
    const source = sourceSession ?? this.session
    for (const subscription of this._eventSubscriptions) {
      if (!subscription.active) continue
      try { subscription.cb(event, source) } catch {}
    }
  }

  private _createToolTraceEmitter(): SessionToolTraceEmitter {
    let sourceSession: AgentSession | undefined
    return {
      emit: (event) => {
        if (sourceSession) this.emitEvent(event, sourceSession)
      },
      bindSource: (session) => { sourceSession = session },
    }
  }

  // ─── 私有 ──────────────────────────────────────────

  /** 将 public session transition 按调用顺序串行化；前序失败不阻塞后续任务。 */
  private _enqueueSessionTransition<T>(transition: () => Promise<T>): Promise<T> {
    const previous = this._transitionTail ?? Promise.resolve()
    const result = previous.then(
      () => transition(),
      () => transition(),
    )
    this._transitionTail = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }

  /** 获取 workspace 对应的 session 目录（与 routes 共用 wsDir） */
  private wsSessionDir(workspace: string): string {
    if (this.config.sessionsDirForWorkspace) {
      return this.config.sessionsDirForWorkspace(workspace)
    }
    return wsDir(this.config.sessionsDir, workspace)
  }

  /** 在 workspace 的 session 目录中找最新的 .jsonl 文件 */
  private findLatestSessionFile(workspace: string): string | undefined {
    const dir = this.wsSessionDir(workspace)
    if (!existsSync(dir)) return undefined
    const files = readdirSync(dir).filter(f => f.endsWith(".jsonl"))
    if (files.length === 0) return undefined
    // 按文件名排序（文件名含时间戳），取最新的
    files.sort().reverse()
    return resolve(dir, files[0])
  }

  /** 中止并清理旧 session；dispose 前保留可用于重建的 workspace 和文件。 */
  private async _saveAndDispose(keepMcp: boolean): Promise<SessionRecoveryPoint> {
    const previousSession = this._session
    const recoveryPoint: SessionRecoveryPoint = {
      workspace: this.currentWorkspace,
      sessionFile: previousSession?.sessionFile,
    }
    this._session = undefined
    try { previousSession?.abort() } catch {}
    this._eventSubscriptions = this._eventSubscriptions.filter((subscription) => subscription.active)
    for (const subscription of this._eventSubscriptions) {
      const currentUnsub = subscription.currentUnsub
      subscription.currentUnsub = undefined
      try { currentUnsub?.() } catch {}
    }
    try {
      previousSession?.dispose()
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.error(`[runtime] 旧 session 释放失败，仍按不可用处理：${message}`)
    }
    if (!keepMcp) await disconnectMcp()
    return recoveryPoint
  }

  /** 所有 create/open/switch 共用目标初始化与旧会话回滚事务。 */
  private async _replaceSessionWithRollback(
    workspace: string,
    keepMcp: boolean,
    sessionFile?: string,
    forceNew?: boolean,
  ): Promise<void> {
    const recoveryPoint = await this._saveAndDispose(keepMcp)
    this.currentWorkspace = workspace
    try {
      await this._initSession(workspace, sessionFile, forceNew)
    } catch (error) {
      await this._restoreSession(recoveryPoint)
      throw error
    }
    this._rebindEvents()
    if (recoveryPoint.workspace !== workspace) this._notifyWorkspaceChange(workspace)
  }

  private _notifyWorkspaceChange(workspace: string): void {
    for (const callback of [...(this._workspaceChangeSubscriptions ?? [])]) {
      try { callback(workspace) } catch {}
    }
  }

  /** 重新绑定事件回调 */
  private _rebindEvents(): void {
    const sourceSession = this._session
    if (!sourceSession) return
    for (const subscription of this._eventSubscriptions) {
      if (!subscription.active || subscription.currentUnsub) continue
      this._bindEventSubscription(subscription, sourceSession)
    }
  }

  /** 按旧 workspace/file 创建全新会话；任何已执行 dispose 的对象都不复用。 */
  private async _restoreSession(recoveryPoint?: SessionRecoveryPoint): Promise<void> {
    if (!recoveryPoint) {
      this._session = undefined
      return
    }

    this.currentWorkspace = recoveryPoint.workspace
    this._session = undefined

    try {
      await this._initSession(recoveryPoint.workspace, recoveryPoint.sessionFile)
      this._rebindEvents()
    } catch (rollbackError) {
      this._session = undefined
      const message = rollbackError instanceof Error ? rollbackError.message : String(rollbackError)
      console.error(`[runtime] 回滚旧 session 失败：${message}`)
    }
  }

  private _bindEventSubscription(subscription: SessionEventSubscription, sourceSession: AgentSession): void {
    const currentUnsub = subscription.currentUnsub
    subscription.currentUnsub = undefined
    try { currentUnsub?.() } catch {}
    if (!subscription.active) return
    const nextUnsub = sourceSession.subscribe((event) => {
      if (subscription.active) subscription.cb(event, sourceSession)
    })
    if (!subscription.active) {
      try { nextUnsub() } catch {}
      return
    }
    subscription.currentUnsub = nextUnsub
  }

  private async _initSession(cwd: string, existingSessionFile?: string, forceNew?: boolean): Promise<void> {
    const { agentDir, sessionsDir, authFile, modelsFile } = this.config

    this.modelRuntime = await ModelRuntime.create({ authPath: authFile, modelsPath: modelsFile })
    await this.config.syncModelProviders?.(this.modelRuntime)
    this.modelRegistry = new ModelRegistry(this.modelRuntime)

    const systemPrompt = resolveSystemPrompt()
    const loader = new DefaultResourceLoader({
      cwd,
      agentDir,
      appendSystemPrompt: systemPrompt ? [systemPrompt] : undefined,
    })
    await loader.reload()

    // 优先续写指定文件，否则查找 workspace 现有 session，否则创建新会话
    if (forceNew) {
      // 强制新 session：由 SessionManager.create 创建文件
      const wsSessionsDir = this.wsSessionDir(cwd)
      this.sessionManager = SessionManager.create(cwd, wsSessionsDir)
    } else if (existingSessionFile) {
      // SessionManager.open(文件路径, sessionDir, cwd覆盖)
      // sessionDir 传 undefined 让 SessionManager 从文件路径推导，避免混到根目录
      this.sessionManager = SessionManager.open(existingSessionFile, undefined, cwd)
      recoverConversationLeaf(this.sessionManager)
    } else {
      const latestFile = this.findLatestSessionFile(cwd)
      if (latestFile) {
        this.sessionManager = SessionManager.open(latestFile, undefined, cwd)
        recoverConversationLeaf(this.sessionManager)
      } else {
        // 新 session 直接创建在 workspace 目录下
        const wsSessionsDir = this.wsSessionDir(cwd)
        this.sessionManager = SessionManager.create(cwd, wsSessionsDir)
      }
    }
    const toolTrace = this._createToolTraceEmitter()
    const customTools = await getCustomToolsAsync(
      cwd,
      toolTrace.emit,
      buildToolContextExtra(this.config),
    )

    console.log(`[runtime] 自定义 Tool: ${customTools.map((t: { name: string }) => t.name).join(", ") || "（无）"}`)

    const { session } = await createAgentSession({
      agentDir,
      modelRuntime: this.modelRuntime,
      resourceLoader: loader,
      cwd,
      sessionManager: this.sessionManager,
      customTools,
      excludeTools: ["bash", "edit", "write"],
    })

    toolTrace.bindSource(session)
    this.session = session
  }
}





