import type { AssistantBlock, ChatStreamState } from "./routes/types.js";
import { writeChatEvent } from "./chat-stream.js";
import type { EvidenceLedgerEntry } from "./evidence-ledger.js";
import type { TaskLifecycleSnapshot } from "./task-lifecycle.js";

/**
 * User-visible events emitted by the canonical engine bridge.
 * Raw traces and legacy delta/thinking frames are intentionally excluded.
 */
export type PresentationEvent =
  | { type: "block"; block: AssistantBlock }
  | {
      type: "done";
      text: string;
      thinking?: string;
      turnId: string;
      sessionId: string;
      status: "done" | "error";
      error?: string;
      usage?: unknown;
      blocks: AssistantBlock[];
      /** Only successful, complete ledger entries may be attached to a final answer. */
      evidence?: Array<Pick<EvidenceLedgerEntry, "evidenceId" | "toolCallId" | "canonicalTool" | "requestScope" | "payloadHash" | "createdAt">>;
      task?: TaskLifecycleSnapshot;
    }
  | { type: "cancelled"; turnId: string; sessionId: string; reason?: string }
  | { type: "queue_update"; steering: unknown[]; followUp: unknown[] };

/** Single write boundary for canonical user-visible chat events. */
export function writePresentationEvent(state: ChatStreamState, event: PresentationEvent): number {
  return writeChatEvent(state, event);
}
