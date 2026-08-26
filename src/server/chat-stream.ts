import type { ServerResponse } from "node:http";
import type { ChatStreamState } from "./routes/types.js";

const MAX_CHAT_EVENT_HISTORY = 512;

function normalizeState(state: ChatStreamState): void {
  if (!Number.isSafeInteger(state.eventSeq) || state.eventSeq < 0) state.eventSeq = 0;
  if (!Array.isArray(state.eventHistory)) state.eventHistory = [];
}

function frame(id: number, payload: unknown): string {
  return `id: ${id}\ndata: ${JSON.stringify(payload)}\n\n`;
}

export function writeChatEvent(state: ChatStreamState, payload: unknown): number {
  normalizeState(state);
  const id = ++state.eventSeq;
  const eventType = payload && typeof payload === "object" && "type" in payload ? String((payload as { type?: unknown }).type || "unknown") : "unknown";
  if (state.correlationLedger && state.correlation?.traceId) {
    state.correlationLedger.record({
      ...state.correlation,
      stage: "presentation.emitted",
      eventType,
      details: { sseEventId: id },
    });
  }
  const data = frame(id, payload);
  state.eventHistory.push({ id, data });
  if (state.eventHistory.length > MAX_CHAT_EVENT_HISTORY) {
    state.eventHistory.splice(0, state.eventHistory.length - MAX_CHAT_EVENT_HISTORY);
  }
  try {
    if (state.response && !state.response.writableEnded && !state.response.destroyed) {
      state.response.write(data);
    }
  } catch { /* The request may have disconnected between the checks. */ }
  return id;
}

export function writeChatStreamBaseline(state: ChatStreamState, response: ServerResponse): number {
  normalizeState(state);
  const baseline = state.evidenceContractState?.status === "active"
    ? { type: "stream_ready", evidenceState: state.evidenceContractState }
    : { type: "stream_ready" };
  try { response.write(frame(state.eventSeq, baseline)); } catch { /* Client disconnected during setup. */ }
  return state.eventSeq;
}

export function replayChatEvents(state: ChatStreamState, response: ServerResponse, lastEventId?: string | number): number {
  normalizeState(state);
  if (lastEventId === undefined || lastEventId === null || lastEventId === "") return 0;
  const parsed = Number(lastEventId || 0);
  const last = Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
  let replayed = 0;
  for (const event of state.eventHistory) {
    if (event.id <= last) continue;
    try {
      response.write(event.data);
      replayed++;
      if (state.correlationLedger && state.correlation?.traceId) {
        state.correlationLedger.record({
          ...state.correlation,
          stage: "sse.replay",
          replay: true,
          details: { sseEventId: event.id, afterEventId: last },
        });
      }
    } catch { break; }
  }
  return replayed;
}

export function resetChatEventHistory(state: ChatStreamState): void {
  normalizeState(state);
  state.eventHistory = [];
}
