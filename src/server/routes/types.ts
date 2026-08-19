/**
 * Shared types for route handlers
 */
import type { IncomingMessage, ServerResponse } from "http";
import type { TsserverManager } from "../ts-server.js";
import type { AgentRuntime } from "../../agent/index.js";
import type { AgentEngine } from "../../agent-engine/index.js";
import type { DesktopSecurityConfig } from "../security.js";
import type { ServerPermissionService } from "../permission-service.js";
import type { RootRegistry } from "../root-registry.js";
import type { PermissionModeController } from "../permission-mode.js";
import type { AppEventHub } from "../app-events.js";
import type { StartupPathsSnapshot } from "../startup-paths.js";
import type { WorkspaceLockCoordinator } from "../workspace-lock.js";
import type { CustomProviderService } from "../../model-provider/custom-provider-service.js";
import type { ProviderReferenceMutationLock } from "../../model-provider/provider-reference-lock.js";
import type { ServerObservability } from "../observability.js";
import type { ServerContextGroups } from "../server-context.js";
import type { SkillService } from "../../agent/skills/skill-service.js";

// ─── Trace Event 类型 ────────────────────────────────────

export type TraceEvent =
  | { type: "thinking"; status: "streaming" | "done"; text: string; turnId: string; id: string; seq?: number }
  | { type: "tool"; status: "running" | "success" | "error"; name: string; input?: unknown; output?: string; error?: string; metadata?: Record<string, unknown>; turnId: string; id: string; seq?: number }
  | { type: "step"; status: "info" | "success" | "error"; text: string; turnId: string; id: string; seq?: number };

export interface ChatStreamEventFrame {
  id: number;
  data: string;
}

// ─── Assistant Block 协议 ─────────────────────────────────

/** 在 assistant 气泡内线性排列的内容块，按 seq 排序 */
export type AssistantBlock =
  | { type: "thinking"; text: string; status: "streaming" | "done"; turnId: string; blockId: string; seq: number }
  | { type: "text"; text: string; turnId: string; blockId: string; seq: number }
  // B-5：tool 物理合并为一个 block（含 input/output/error，一个 seq）。
  // tool_use/tool_result 保留用于旧数据回放兼容。
  | { type: "tool"; toolCallId: string; name: string; input?: unknown; output?: string; error?: string; metadata?: Record<string, unknown>; status: "running" | "success" | "error"; turnId: string; blockId: string; seq: number }
  | { type: "tool_use"; toolCallId: string; name: string; input?: unknown; output?: string; metadata?: Record<string, unknown>; status: "running" | "success" | "error"; turnId: string; blockId: string; seq: number }
  | { type: "tool_result"; toolUseId: string; output?: string; isError?: boolean; turnId: string; blockId: string; seq: number }
  | { type: "step"; text: string; status: "info" | "success" | "error"; turnId: string; blockId: string; seq: number }
  | { type: "user_note"; noteId: string; mode: "steer" | "followUp"; text: string; status: "queued" | "delivered" | "failed"; turnId: string; blockId: string; seq: number };

// ─── Chat Stream 状态 ────────────────────────────────────

export interface ChatStreamState {
  textBuffer: string;
  thinkingBuffer: string;
  currentTextSnapshot?: string;
  currentThinkingSnapshot?: string;
  response: ServerResponse | null;
  currentWorkspace?: string;
  /** 当前 turn 的 ID，每次 POST /api/chat 生成 */
  turnId: string;
  /** 当前 turn 的 trace 顺序号 */
  traceSeq: number;
  /** 本轮已发出的 trace 事件（用于去重） */
  emittedTraces: Set<string>;
  /** 本轮 assistant_block 记录（按 seq 排序，用于持久化与回放） */
  blocks: AssistantBlock[];
  /** block 顺序号生成器（单调递增） */
  blockSeq: number;
  /** B-5：正文分段——每个 text 块的当前文本，索引即 content 中 text 块位置。
   *  流式时同一 text 块逐步追加；工具边界后 content 出现新 text 块时新增段。 */
  textSegments?: string[];
  /** B-5：当前 turn 内 assistant message 序号。每次 message_start（assistant）递增，
   *  用于 blockId 前缀避免工具前后不同 message 的 contentIndex 冲突。 */
  messageSeq?: number;
  /** SSE event sequence and bounded replay window for reconnecting clients. */
  eventSeq: number;
  eventHistory: ChatStreamEventFrame[];
}

export interface ServerContext {
  engine: AgentEngine;
  runtime: AgentRuntime;
  chatStream: ChatStreamState;
  recordUserNote?: (note: { noteId: string; message: string; mode: "steer" | "followUp" }) => void;
  appEvents: AppEventHub;
  tsServer?: TsserverManager;
  security?: DesktopSecurityConfig;
  permissionService?: ServerPermissionService;
  rootRegistry?: RootRegistry;
  permissionMode?: PermissionModeController;
  workspaceLock?: WorkspaceLockCoordinator;
  customProviderService?: CustomProviderService;
  providerReferenceLock?: ProviderReferenceMutationLock;
  observability?: ServerObservability;
  skillService?: SkillService;
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
  groups: ServerContextGroups;
}

export function resolveEngine(ctx: ServerContext): AgentEngine {
  const grouped = ctx.groups?.core?.engine;
  if (grouped) return grouped;
  if (ctx.engine) return ctx.engine;
  throw new Error("Server context is missing an explicit AgentEngine");
}

export type RouteHandler = (
  req: IncomingMessage,
  res: ServerResponse,
  ctx: ServerContext,
) => boolean | Promise<boolean>;
