import type { AssistantBlock, ChatStreamState } from "./routes/types.js";
import { writeChatEvent } from "./chat-stream.js";

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
    }
  | { type: "cancelled"; turnId: string; sessionId: string; reason?: string }
  | { type: "queue_update"; steering: unknown[]; followUp: unknown[] };

/** Single write boundary for canonical user-visible chat events. */
export function writePresentationEvent(state: ChatStreamState, event: PresentationEvent): number {
  return writeChatEvent(state, event);
}
