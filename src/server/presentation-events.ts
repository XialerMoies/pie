import type { AssistantBlock, ChatStreamState, EvidenceContractState } from "./routes/types.js";
import { writeChatEvent } from "./chat-stream.js";
import type { EvidenceLedgerEntry } from "./evidence-ledger.js";
import type { TaskLifecycleSnapshot } from "./task-lifecycle.js";
import type { CorrelationIds } from "./correlation.js";
import type { PlanStateSnapshot } from "../agent/plan-state.js";

/**
 * User-visible events emitted by the canonical engine bridge.
 * Raw traces and legacy delta/thinking frames are intentionally excluded.
 */
export type PresentationEvent =
  | { type: "block"; block: AssistantBlock; correlation?: CorrelationIds }
  | {
      type: "done";
      text: string;
      turnId: string;
      sessionId: string;
      status: "done" | "error";
      error?: string;
      usage?: unknown;
      blocks: AssistantBlock[];
      /** Only successful, complete ledger entries may be attached to a final answer. */
      evidence?: Array<Pick<EvidenceLedgerEntry, "evidenceId" | "toolCallId" | "canonicalTool" | "requestScope" | "payloadHash" | "createdAt">>;
      task?: TaskLifecycleSnapshot;
      correlation?: CorrelationIds;
    }
  | { type: "cancelled"; turnId: string; sessionId: string; reason?: string; correlation?: CorrelationIds }
  | { type: "queue_update"; steering: unknown[]; followUp: unknown[]; correlation?: CorrelationIds }
  | { type: "plan_state"; state: PlanStateSnapshot; correlation?: CorrelationIds }
  | { type: "evidence_state"; state: EvidenceContractState; correlation?: CorrelationIds };

function sanitizePresentationEvent(event: PresentationEvent): PresentationEvent {
  if (event.type !== "done") return event;
  // Runtime/provider compatibility objects may still carry internal fields at
  // runtime even when TypeScript excludes them.  Strip them at the transport
  // boundary so SSE history and reconnect replay cannot preserve a leak.
  const {
    thinking: _thinking,
    trace: _trace,
    event: _rawEvent,
    ...safe
  } = event as PresentationEvent & { thinking?: unknown; trace?: unknown; event?: unknown };
  return safe as PresentationEvent;
}

/** Single write boundary for canonical user-visible chat events. */
export function writePresentationEvent(state: ChatStreamState, event: PresentationEvent): number {
  const safeEvent = sanitizePresentationEvent(event);
  return writeChatEvent(state, state.correlation && !safeEvent.correlation
    ? { ...safeEvent, correlation: state.correlation }
    : safeEvent);
}
