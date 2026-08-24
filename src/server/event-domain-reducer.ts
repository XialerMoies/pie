import {
  defaultEngineEventVisibility,
  type EngineEvent,
  type EngineEventVisibility,
} from "../agent-engine/contracts.js";

/**
 * Domain-level classification between runtime events and the chat presentation
 * protocol. Runtime events are never written to SSE directly; the router acts
 * only on the reduced classification and emits PresentationEvent values.
 */
export type DomainEventKind =
  | "turn_started"
  | "content"
  | "thinking"
  | "tool_started"
  | "tool_updated"
  | "tool_completed"
  | "tool_failed"
  | "terminal"
  | "queue"
  | "plan"
  | "usage"
  | "compaction"
  | "internal"
  | "debug";

export interface ReducedEngineEvent {
  kind: DomainEventKind;
  event: EngineEvent;
  visibility: EngineEventVisibility;
  /** Only user-visible domain events may be converted to presentation events. */
  presentationEligible: boolean;
}

/**
 * Reduce a versioned runtime event to the small set of domain transitions the
 * server understands. This deliberately preserves the original event as data
 * while making visibility an explicit, testable boundary.
 */
export function reduceEngineEvent(event: EngineEvent): ReducedEngineEvent {
  const visibility = event.visibility ?? defaultEngineEventVisibility(event.type);
  let kind: DomainEventKind;
  switch (event.type) {
    case "turn.started": kind = "turn_started"; break;
    case "content.delta": kind = "content"; break;
    case "thinking.delta": kind = "thinking"; break;
    case "tool.started": kind = "tool_started"; break;
    case "tool.updated": kind = "tool_updated"; break;
    case "tool.completed": kind = "tool_completed"; break;
    case "tool.failed": kind = "tool_failed"; break;
    case "turn.completed":
    case "turn.failed":
    case "turn.cancelled": kind = "terminal"; break;
    case "queue.updated": kind = "queue"; break;
    case "plan.changed": kind = "plan"; break;
    case "usage.updated": kind = "usage"; break;
    case "compaction.started":
    case "compaction.completed":
    case "compaction.failed": kind = "compaction"; break;
    case "diagnostic": kind = "debug"; break;
    case "engine.ready":
    case "session.changed": kind = "internal"; break;
    default: kind = "internal";
  }
  return {
    kind,
    event,
    visibility,
    presentationEligible: visibility === "user" && kind !== "debug" && kind !== "internal",
  };
}
