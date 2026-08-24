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
import { normalizePermissionPath, resetSessionPermissionState } from "./permissions.js"
import { buildToolContextExtra, type RuntimeConfig } from "./runtime-config.js"
import { wsDir } from "../server/routes/session-dir.js"
import { calculateContextUsageSnapshot, type ContextUsageSnapshot } from "./context-usage.js"
import type { SkillFactSnapshot } from "./skills/skill-service.js"
import { formatSkillPrompt } from "./skills/skill-prompt.js"
import {
  agentProfileSelection,
  agentProfileRef,
  agentProfileRegistry,
  persistAgentProfileLifecycle,
  persistAgentProfileSelection,
  readAgentProfileLifecycle,
  readAgentProfileSelection,
  resolveAgentProfileRef,
  resolveAgentProfile,
  resolveAgentProfileSelection,
  type AgentProfile,
  type AgentProfileId,
  type AgentProfileLifecycleAction,
  type AgentProfileLifecycleFact,
  type AgentProfileRef,
  type AgentProfileSelection,
} from "./agent-profile.js"

import { setCurrentRuntime as _setGlobalRuntime, getCurrentRuntime as _getGlobalRuntime } from "./globals.js";
// 重导出供 tools 使用，实际实现在 globals.ts（零依赖，防循环）
export const getCurrentRuntime = _getGlobalRuntime;
export const setCurrentRuntime = _setGlobalRuntime;

export type { RuntimeConfig } from "./runtime-config.js"

export type SkillPromptStatus =
  | { status: "ready"; revision: string; workspaceKey?: string }
  | { status: "error"; code: string; message: string; attemptedAt: string; previousRevision?: string }

export type SystemPromptRefreshResult =
  | { ok: true; revision?: string; workspaceKey?: string }
  | { ok: false; code: string; message: string; attemptedAt: string; previousRevision?: string }

export { buildToolContextExtra } from "./runtime-config.js"

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
  profileId?: AgentProfileId
  profileRef?: AgentProfileRef
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
  /** True only while a public session transition is actually swapping the session
   *  (switch/open/create). Prompt turns queue behind the tail too, but they don't
   *  replace the session, so waitForSessionReady must not wait for a whole turn. */
  private _sessionSwitching = false
  private _pendingOpens = new Map<string, Promise<void>>()
  private _modelProviderSync?: Promise<number>
  private _modelProviderSyncGeneration = 0
  private _modelProviderSyncStarted = false
  private _modelProviderSyncWake?: Promise<number>
  /** 当前 in-flight provider sync 是否等待 streaming idle（read-only 查询不等待）。 */
  private _modelProviderSyncIdleWait?: boolean
  private _skillPromptStatus?: SkillPromptStatus
  private _skillPromptRefreshTail: Promise<void> = Promise.resolve()
  private _activeProfile: AgentProfile = resolveAgentProfile("standard")
  private _activeProfileRef: AgentProfileRef = agentProfileRef(this._activeProfile)
  private _activeProfileLifecycle?: AgentProfileLifecycleFact

  private constructor() {}

  /** 返回当前可用会话；恢复失败时明确阻止调用已释放对象。 */
  get session(): AgentSession {
    if (!this._session) throw new Error("[runtime] 当前没有可用的 Agent session")
    return this._session
  }

  /** 等待当前 session 切换完成，再返回可用 session；切换失败时保持 fail-closed。
   *
   *  注意：_transitionTail 同时被 engine.prompt 的 runWithStableSession 占用（整个
   *  turn）。等待完整 tail 会让 /api/dashboard 等 session 读取路由在长 tool 执行期间
   *  一直挂起，侧边栏/设置页因此卡在加载中。这里只在真正替换 session 的切换进行中时
   *  才等待；prompt 期间的 session 对象已可用，直接返回。 */
  async waitForSessionReady(): Promise<AgentSession> {
    if (!this._sessionSwitching) return this.session
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

  syncModelProviders(options?: { waitForIdle?: boolean }): Promise<number> {
    const sync = this.config.syncModelProviders
    if (!sync) return Promise.resolve(0)
    // 读模型列表等只读查询不应等待 streaming turn 结束，否则长 tool 执行期间
    // 设置页模型/子Agent 标签页、模型选择器会一直卡在加载中。切换模型等需要
    // 稳定 session 的调用保持默认 waitForIdle: true。
    const waitForIdle = options?.waitForIdle !== false
    this._modelProviderSyncGeneration = (this._modelProviderSyncGeneration ?? 0) + 1
    if (this._modelProviderSync && this._modelProviderSyncIdleWait === waitForIdle) {
      if (this._modelProviderSyncStarted) {
        try {
          this._modelProviderSyncWake = sync(this.modelRuntime)
        } catch (error) {
          this._modelProviderSyncWake = Promise.reject(error)
        }
      }
      return this._modelProviderSync
    }

    const operation = Promise.resolve().then(async () => {
      if (waitForIdle && this._session?.isStreaming) await this._session.waitForIdle()
      const session = this._session
      const activeModel = session?.model
      let revision = 0
      this._modelProviderSyncStarted = true
      try {
        while (true) {
          const generation = this._modelProviderSyncGeneration
          const wake = this._modelProviderSyncWake
          this._modelProviderSyncWake = undefined
          revision = await (wake ?? sync(this.modelRuntime))
          if (activeModel && session && this._session === session) {
            const refreshedModel = this.modelRegistry.find(activeModel.provider, activeModel.id)
            if (refreshedModel && refreshedModel !== session.model) {
              await session.setModel(refreshedModel)
            }
          }
          if (generation === this._modelProviderSyncGeneration && !this._modelProviderSyncWake) break
        }
      } finally {
        this._modelProviderSyncStarted = false
      }
      return revision
    })
    let pending: Promise<number>
    pending = operation.finally(() => {
      if (this._modelProviderSync === pending) {
        this._modelProviderSync = undefined
        this._modelProviderSyncStarted = false
        this._modelProviderSyncWake = undefined
        this._modelProviderSyncIdleWait = undefined
      }
    })
    this._modelProviderSync = pending
    this._modelProviderSyncIdleWait = waitForIdle
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
  async openSession(sessionFile: string, workspace: string, lifecycleAction: AgentProfileLifecycleAction = "resume"): Promise<void> {
    // 相同参数在本 runtime 内复用同一个排队任务，不影响其他 runtime 实例。
    const key = normalizePermissionPath(sessionFile) + "::" + normalizePermissionPath(workspace)
    const pendingOpens = this._pendingOpens ??= new Map<string, Promise<void>>()
    const inFlight = pendingOpens.get(key)
    if (inFlight) {
      console.log(`[runtime] ⏭ In-flight dedup openSession: "${sessionFile}"`)
      await inFlight
      return
    }

    const promise = this._enqueueSessionTransition(() => this._doOpenSession(sessionFile, workspace, lifecycleAction))
    pendingOpens.set(key, promise)
    try {
      await promise
    } finally {
      if (pendingOpens.get(key) === promise) pendingOpens.delete(key)
    }
  }

  /** 在串行队列中打开 session，执行时再判断最终 runtime 状态。 */
  private async _doOpenSession(sessionFile: string, workspace: string, lifecycleAction: AgentProfileLifecycleAction = "resume"): Promise<void> {
    if (sameRuntimePath(this._session?.sessionFile, sessionFile)
      && sameRuntimePath(this.currentWorkspace, workspace)) {
      console.log(`[runtime] ⏭ Skipping duplicate openSession: "${sessionFile}"`)
      return
    }
    console.log(`[runtime] Opening session: "${sessionFile}"`)
    this.resetSessionPermissions()
    // 记录是否同 workspace（在更新 currentWorkspace 之前判断）
    const sameWs = sameRuntimePath(this.currentWorkspace, workspace)
    await this._replaceSessionWithRollback(workspace, sameWs, sessionFile, undefined, undefined, undefined, lifecycleAction)
    console.log(`[runtime] ✅ Session opened: "${sessionFile}"`)
  }

  /**
   * 强制创建新 session（不续写旧文件）。
   * 返回新 session ID。
   */
  async createNewSession(profileId?: string): Promise<string> {
    const profile = resolveAgentProfile(profileId || this.config.profileId)
    return this._enqueueSessionTransition(async () => {
      console.log(`[runtime] Creating new session profile=${profile.id}@${profile.revision}`)
      this.resetSessionPermissions()

      await this._replaceSessionWithRollback(
        this.currentWorkspace,
        true,
        undefined,
        true /* forceNew */,
        profile.id,
      )
      const id = this.session.sessionManager?.getSessionId?.() || ""
      console.log(`[runtime] ✅ New session created: ${id}`)
      return id
    })
  }

  /** Last skill fact snapshot status used by the active system prompt. */
  getSkillPromptStatus(): SkillPromptStatus | undefined {
    return this._skillPromptStatus ? { ...this._skillPromptStatus } : undefined
  }

  /** Current session's immutable profile generation and last lifecycle fact. */
  get activeProfileLifecycle(): AgentProfileLifecycleFact | undefined {
    return this._activeProfileLifecycle ? structuredClone(this._activeProfileLifecycle) : undefined
  }

  /**
   * Switch only an empty session. The operation is a normal session transition,
   * so all tool assembly and rollback behavior remains serialized with open/new.
   */
  async switchProfile(profileId: string): Promise<AgentProfileSelection> {
    const requested = resolveAgentProfile(profileId)
    return this._enqueueSessionTransition(async () => {
      const messages = this._session?.messages
      if ((Array.isArray(messages) && messages.length > 0)
        || (this._session && this._session.sessionManager.buildSessionContext().messages.length > 0)) {
        throw new Error("Cannot switch agent profile in a non-empty session")
      }
      if (this._activeProfile.id === requested.id
        && this._activeProfile.revision === requested.revision
        && this._activeProfileRef.generation === agentProfileRef(requested).generation) {
        return agentProfileSelection(this._activeProfile)
      }
      await this._replaceSessionWithRollback(
        this.currentWorkspace,
        true,
        this._session?.sessionFile,
        false,
        requested.id,
        requested,
        "switch",
      )
      return agentProfileSelection(this._activeProfile)
    })
  }

  /** Immutable profile snapshot for the active session. */
  get activeProfile(): AgentProfileSelection {
    return agentProfileSelection(this._activeProfile ?? resolveAgentProfile("standard"))
  }

  /** 强制刷新 system prompt（串行化，失败显式返回而不是伪装成功） */
  async refreshSystemPrompt(): Promise<SystemPromptRefreshResult> {
    const operation = async (): Promise<SystemPromptRefreshResult> => {
      const attemptedAt = new Date().toISOString()
      const previousRevision = this._skillPromptStatus?.status === "ready" ? this._skillPromptStatus.revision : undefined
      let newPrompt: string
      try {
        newPrompt = await this._buildSystemPrompt(this.currentWorkspace, this._activeProfile ?? resolveAgentProfile("standard"))
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        const failure: SystemPromptRefreshResult = { ok: false, code: "skill_prompt_unavailable", message, attemptedAt, ...(previousRevision ? { previousRevision } : {}) }
        this._skillPromptStatus = { status: "error", ...failure }
        return failure
      }
      if (this._skillPromptStatus?.status === "error") {
        const message = this._skillPromptStatus.message
        return { ok: false, code: "skill_prompt_unavailable", message, attemptedAt, ...(previousRevision ? { previousRevision } : {}) }
      }
      try {
        const loader = (this.session as any)._resourceLoader
        if (loader?.setAppendSystemPrompt) loader.setAppendSystemPrompt([newPrompt])
        ;(this.session as any).refreshSystemPrompt?.()
        const status = this._skillPromptStatus
        const success: SystemPromptRefreshResult = {
          ok: true,
          ...(status?.status === "ready" ? { revision: status.revision, workspaceKey: status.workspaceKey } : {}),
        }
        console.log(`[runtime] ✅ System prompt refreshed${success.revision ? ` revision=${success.revision}` : ""}`)
        return success
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        const failure: SystemPromptRefreshResult = { ok: false, code: "system_prompt_refresh_failed", message, attemptedAt, ...(previousRevision ? { previousRevision } : {}) }
        this._skillPromptStatus = { status: "error", ...failure }
        console.log(`[runtime] refreshSystemPrompt error: ${message}`)
        return failure
      }
    }
    const pending = this._skillPromptRefreshTail.then(operation, operation)
    this._skillPromptRefreshTail = pending.then(() => undefined, () => undefined)
    return pending
  }

  private async _buildSystemPrompt(cwd: string, profile?: AgentProfile): Promise<string> {
    const effectiveProfile = profile ?? this._activeProfile ?? resolveAgentProfile("standard")
    const base = resolveSystemPrompt(effectiveProfile.promptSections)
    if (!effectiveProfile.includeSkills) {
      this._skillPromptStatus = undefined
      return base
    }
    const service = this.config.skillService
    if (!service) {
      this._skillPromptStatus = undefined
      return base
    }
    const workspaceSkillRoot = resolve(cwd, "agent", "skills")
    try {
      const snapshot: SkillFactSnapshot | undefined = typeof (service as any).snapshot === "function"
        ? await service.snapshot(workspaceSkillRoot)
        : undefined
      const input = snapshot
        ? await service.promptInput(workspaceSkillRoot, snapshot)
        : await service.promptInput(workspaceSkillRoot)
      const skillPrompt = formatSkillPrompt(input)
      this._skillPromptStatus = {
        status: "ready",
        revision: input.revision || snapshot?.revision || "legacy-prompt-input",
        ...(input.workspaceKey ? { workspaceKey: input.workspaceKey } : {}),
      }
      return [base, skillPrompt].filter(Boolean).join("\n\n")
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this._skillPromptStatus = {
        status: "error",
        code: "skill_snapshot_unavailable",
        message,
        attemptedAt: new Date().toISOString(),
        ...(this._skillPromptStatus?.status === "ready" ? { previousRevision: this._skillPromptStatus.revision } : {}),
      }
      console.warn(`[runtime] Skill prompt unavailable: ${message}`)
      return base
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
      profileId: this._activeProfile?.id,
      profileRef: this._activeProfileRef,
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
    profileId?: string,
    profileOverride?: AgentProfile,
    lifecycleAction?: AgentProfileLifecycleAction,
  ): Promise<void> {
    this._sessionSwitching = true
    try {
      const recoveryPoint = await this._saveAndDispose(keepMcp)
      this.currentWorkspace = workspace
      try {
        await this._initSession(workspace, sessionFile, forceNew, profileId, profileOverride, lifecycleAction)
      } catch (error) {
        await this._restoreSession(recoveryPoint)
        throw error
      }
      this._rebindEvents()
      if (recoveryPoint.workspace !== workspace) this._notifyWorkspaceChange(workspace)
    } finally {
      this._sessionSwitching = false
    }
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
      const restoredProfile = recoveryPoint.profileRef ? resolveAgentProfileRef(recoveryPoint.profileRef) : undefined
      await this._initSession(recoveryPoint.workspace, recoveryPoint.sessionFile, undefined, recoveryPoint.profileId, restoredProfile, "resume")
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

  private async _initSession(
    cwd: string,
    existingSessionFile?: string,
    forceNew?: boolean,
    requestedProfileId?: string,
    profileOverride?: AgentProfile,
    lifecycleAction?: AgentProfileLifecycleAction,
  ): Promise<void> {
    const { agentDir, sessionsDir, authFile, modelsFile } = this.config

    this.modelRuntime = await ModelRuntime.create({ authPath: authFile, modelsPath: modelsFile })
    await this.config.syncModelProviders?.(this.modelRuntime)
    this.modelRegistry = new ModelRegistry(this.modelRuntime)

    // 优先续写指定文件，否则查找 workspace 现有 session，否则创建新会话
    let created = false
    if (forceNew) {
      // 强制新 session：由 SessionManager.create 创建文件
      const wsSessionsDir = this.wsSessionDir(cwd)
      this.sessionManager = SessionManager.create(cwd, wsSessionsDir)
      created = true
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
        created = true
      }
    }

    const entries = this.sessionManager.getEntries()
    const persistedSelection = readAgentProfileSelection(entries)
    const persistedLifecycle = readAgentProfileLifecycle(entries)
    const profile = profileOverride
      ?? (persistedLifecycle?.status === "applied" && persistedLifecycle.effective
        ? resolveAgentProfileRef(persistedLifecycle.effective)
        : persistedSelection
          ? resolveAgentProfileSelection(persistedSelection)
          : created
            ? resolveAgentProfile(requestedProfileId || this.config.profileId)
            : resolveAgentProfile("standard"))
    this._activeProfile = profile
    this._activeProfileRef = profileOverride
      ? agentProfileRef(profileOverride)
      : persistedLifecycle?.status === "applied" && persistedLifecycle.effective
        ? persistedLifecycle.effective
        : agentProfileRef(profile)
    const action = lifecycleAction ?? (created ? "create" : "resume")
    const profileSnapshot = agentProfileRegistry.resolveRef(this._activeProfileRef)
    const lifecycle: AgentProfileLifecycleFact = {
      requested: profileOverride ? agentProfileRef(profileOverride) : this._activeProfileRef,
      effective: this._activeProfileRef,
      source: profileSnapshot.source,
      fingerprint: profileSnapshot.fingerprint,
      action,
      status: "applied",
      timestamp: new Date().toISOString(),
    }
    const systemPrompt = await this._buildSystemPrompt(cwd, profile)
    const loader = new DefaultResourceLoader({
      cwd,
      agentDir,
      appendSystemPrompt: systemPrompt ? [systemPrompt] : undefined,
    })
    await loader.reload()
    const toolTrace = this._createToolTraceEmitter()
    const customTools = await getCustomToolsAsync(
      cwd,
      toolTrace.emit,
      buildToolContextExtra(this.config),
      profile,
    )

    console.log(`[runtime] Profile: ${profile.id}@${profile.revision}; 自定义 Tool: ${customTools.map((t: { name: string }) => t.name).join(", ") || "（无）"}`)

    const { session } = await createAgentSession({
      agentDir,
      modelRuntime: this.modelRuntime,
      resourceLoader: loader,
      cwd,
      sessionManager: this.sessionManager,
      customTools,
      // Evidence and file access must go through the governed custom tools.
      // PI's built-in read/grep/find/ls do not emit our structured trace payloads.
      noTools: "builtin",
      // Keep the built-ins out of the registry too, so they cannot be re-enabled later.
      excludeTools: ["read", "bash", "edit", "write", "grep", "find", "ls"],
    })

    toolTrace.bindSource(session)
    this.session = session
    // Persist only after prompt, tools, and the PI session have all assembled.
    // A failed switch must not leave an applied lifecycle fact on disk.
    if (created) persistAgentProfileSelection(this.sessionManager, profile)
    persistAgentProfileLifecycle(this.sessionManager, lifecycle)
    this._activeProfileLifecycle = lifecycle
  }
}





