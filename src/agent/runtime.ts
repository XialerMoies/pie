/**
 * AgentRuntime — AgentSession 的生命周期管理
 *
 * workspace 切换时重建整个 AgentSession（含内置工具），
 * 而不是 patch 私有字段。
 */
import { readdirSync, existsSync } from "fs"
import { resolve } from "path"
import type { AgentSession } from "@xiamol/pi-coding-agent"
import { createAgentSession, AuthStorage, ModelRegistry, SessionManager, DefaultResourceLoader } from "@xiamol/pi-coding-agent"
import { resolveSystemPrompt } from "./prompts"
import { getCustomToolsAsync } from "./tools"
import { disconnectAllSync } from "./mcp/MCPClientService"
import { wsDir } from "../server/routes/session-dir"

export interface RuntimeConfig {
  agentDir: string
  cwd: string
  sessionsDir: string
  authFile: string
  modelsFile: string
}

export type SessionEventCallback = (event: any) => void

export class AgentRuntime {
  session!: AgentSession
  modelRegistry!: ModelRegistry
  authStorage!: AuthStorage
  sessionManager!: SessionManager
  config!: RuntimeConfig
  currentWorkspace!: string
  private _eventCallbacks: SessionEventCallback[] = []

  private constructor() {}

  /** 创建新的运行时 */
  static async create(config: RuntimeConfig): Promise<AgentRuntime> {
    const runtime = new AgentRuntime()
    runtime.config = config
    runtime.currentWorkspace = config.cwd
    await runtime._initSession(config.cwd)
    return runtime
  }

  /** 切换 workspace（重建整个 session）—— 不续写旧文件，新 workspace 独立 session */
  async switchWorkspace(workspace: string): Promise<void> {
    if (workspace === this.currentWorkspace) return

    console.log(`[runtime] Switching workspace: "${this.currentWorkspace}" → "${workspace}"`)

    const callbacks = this._saveAndDispose()

    // 不续写旧文件：workspace 切换意味着项目切换，新项目应有自己的 session 文件
    await this._initSession(workspace)
    this.currentWorkspace = workspace

    this._rebindEvents(callbacks)
    console.log(`[runtime] ✅ Switched to "${workspace}"`)
  }

  /**
   * 打开指定 session 文件作为活跃 session。
   * 与 switchWorkspace 不同：相同 workspace 下切换不同 session 文件。
   */
  async openSession(sessionFile: string, workspace: string): Promise<void> {
    console.log(`[runtime] Opening session: "${sessionFile}"`)

    const callbacks = this._saveAndDispose()
    await this._initSession(workspace, sessionFile)
    this.currentWorkspace = workspace

    this._rebindEvents(callbacks)
    console.log(`[runtime] ✅ Session opened: "${sessionFile}"`)
  }

  /**
   * 强制创建新 session（不续写旧文件）。
   * 返回新 session ID。
   */
  async createNewSession(): Promise<string> {
    console.log(`[runtime] Creating new session`)

    const callbacks = this._saveAndDispose()
    await this._initSession(this.currentWorkspace, undefined, true /* forceNew */)

    this._rebindEvents(callbacks)
    const id = this.session.sessionManager?.getSessionId?.() || ""
    console.log(`[runtime] ✅ New session created: ${id}`)
    return id
  }

  /** 强制刷新 system prompt（从 sections 重新 resolve 并注入 session） */
  async refreshSystemPrompt(): Promise<void> {
    const { resolveSystemPrompt } = await import("./prompts")
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
    this._eventCallbacks.push(cb)
    const unsub = this.session.subscribe(cb)
    return () => {
      const idx = this._eventCallbacks.indexOf(cb)
      if (idx >= 0) this._eventCallbacks.splice(idx, 1)
      unsub()
    }
  }

  /** 清理 */
  dispose(): void {
    try { this.session.dispose() } catch {}
    disconnectAllSync()
    this._eventCallbacks = []
  }

  /** 自定义工具事件兜底：复用 PI 的事件订阅通道 */
  emitEvent(event: any): void {
    for (const cb of this._eventCallbacks) {
      try { cb(event) } catch {}
    }
  }

  // ─── 私有 ──────────────────────────────────────────

  /** 获取 workspace 对应的 session 目录（与 routes 共用 wsDir） */
  private wsSessionDir(workspace: string): string {
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

  /** 中止并清理旧 session + MCP 连接，返回事件回调列表 */
  private _saveAndDispose(): SessionEventCallback[] {
    try { this.session?.abort() } catch {}
    const callbacks = [...this._eventCallbacks]
    this._eventCallbacks = []
    try { this.session?.dispose() } catch {}
    disconnectAllSync()
    return callbacks
  }

  /** 重新绑定事件回调 */
  private _rebindEvents(callbacks: SessionEventCallback[]): void {
    for (const cb of callbacks) {
      this.session?.subscribe(cb)
      this._eventCallbacks.push(cb)
    }
  }

  private async _initSession(cwd: string, existingSessionFile?: string, forceNew?: boolean): Promise<void> {
    const { agentDir, sessionsDir, authFile, modelsFile } = this.config

    this.authStorage = AuthStorage.create(authFile)
    this.modelRegistry = ModelRegistry.create(this.authStorage, modelsFile)

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
    } else {
      const latestFile = this.findLatestSessionFile(cwd)
      if (latestFile) {
        this.sessionManager = SessionManager.open(latestFile, undefined, cwd)
      } else {
        // 新 session 直接创建在 workspace 目录下
        const wsSessionsDir = this.wsSessionDir(cwd)
        this.sessionManager = SessionManager.create(cwd, wsSessionsDir)
      }
    }
    const customTools = await getCustomToolsAsync(cwd, (event) => this.emitEvent(event))

    console.log(`[runtime] 自定义 Tool: ${customTools.map((t: { name: string }) => t.name).join(", ") || "（无）"}`)

    const { session } = await createAgentSession({
      agentDir,
      authStorage: this.authStorage,
      modelRegistry: this.modelRegistry,
      resourceLoader: loader,
      cwd,
      sessionManager: this.sessionManager,
      customTools,
    })

    this.session = session
  }
}
