/**
 * Shared types for route handlers
 */
import type { IncomingMessage, ServerResponse } from "http";
import type { TsserverManager } from "../ts-server";
import type { AgentRuntime } from "../../agent/index";

// ─── Trace Event 类型 ────────────────────────────────────

export type TraceEvent =
  | { type: "thinking"; status: "streaming" | "done"; text: string; turnId: string; id: string; seq?: number }
  | { type: "tool"; status: "running" | "success" | "error"; name: string; input?: unknown; output?: string; error?: string; turnId: string; id: string; seq?: number }
  | { type: "step"; status: "info" | "success" | "error"; text: string; turnId: string; id: string; seq?: number };

// ─── Assistant Block 协议 ─────────────────────────────────

/** 在 assistant 气泡内线性排列的内容块，按 seq 排序 */
export type AssistantBlock =
  | { type: "thinking"; text: string; status: "streaming" | "done"; turnId: string; blockId: string; seq: number }
  | { type: "text"; text: string; turnId: string; blockId: string; seq: number }
  | { type: "tool_use"; toolCallId: string; name: string; input?: unknown; status: "running" | "success" | "error"; turnId: string; blockId: string; seq: number }
  | { type: "tool_result"; toolUseId: string; output?: string; isError?: boolean; turnId: string; blockId: string; seq: number }
  | { type: "step"; text: string; status: "info" | "success" | "error"; turnId: string; blockId: string; seq: number };

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
}

export interface ServerContext {
  runtime: AgentRuntime;
  chatStream: ChatStreamState;
  sseClients: ServerResponse[];
  tsServer?: TsserverManager;
  paths: {
    APP_ROOT: string;
    DATA_DIR: string;
    PI_CONFIG_DIR: string;
    SESSIONS_DIR: string;
    SETTINGS_FILE: string;
    FRONTEND_DIR: string;
    FRONTEND_SRC_DIR: string;
    HAS_BUILT_FRONTEND: boolean;
  };
}

export type RouteHandler = (
  req: IncomingMessage,
  res: ServerResponse,
  ctx: ServerContext,
) => boolean | Promise<boolean>;
