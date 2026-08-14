type AppEventSubscriptionType = AppEventType | "resync";

const appEventsNamespace = (window as any).App || ((window as any).App = {});
const subscriptions = new Map<AppEventSubscriptionType, Set<AppEventHandler>>();
const eventTypes = new Set<AppEventType>([
  "dashboard.changed",
  "usage.changed",
  "mcp.changed",
  "explorer.changed",
  "permission.confirm",
]);

let eventSource: EventSource | null = null;
let generation = 0;
let handshakeTimer: ReturnType<typeof setTimeout> | null = null;
let readiness: Promise<void> | null = null;
let resolveReadiness: (() => void) | null = null;
let rejectReadiness: ((reason?: unknown) => void) | null = null;
let readinessState: "idle" | "pending" | "ready" | "timed_out" = "idle";

function appEventsClearHandshakeTimer(): void {
  if (handshakeTimer === null) return;
  clearTimeout(handshakeTimer);
  handshakeTimer = null;
}

function appEventsNotify(type: AppEventSubscriptionType, event: AppEvent): void {
  for (const handler of [...(subscriptions.get(type) || [])]) {
    try {
      handler(event);
    } catch (error) {
      console.error(`[app-events] ${type} handler failed`, error);
    }
  }
}

function appEventsResync(): void {
  appEventsNotify("resync", { type: "resync", revision: 0 });
}

function appEventsStart(): Promise<void> {
  if (eventSource && readiness) return readiness;

  const sourceGeneration = ++generation;
  let source: EventSource;
  try {
    source = new EventSource("/api/events");
  } catch (error) {
    eventSource = null;
    readiness = null;
    readinessState = "idle";
    resolveReadiness = null;
    rejectReadiness = null;
    return Promise.reject(error);
  }

  eventSource = source;
  readinessState = "pending";

  readiness = new Promise<void>((resolve, reject) => {
    resolveReadiness = resolve;
    rejectReadiness = reject;
  });

  const isCurrent = (): boolean => eventSource === source && generation === sourceGeneration;

  source.onopen = () => {
    if (!isCurrent()) return;
    appEventsClearHandshakeTimer();
    if (readinessState === "pending") {
      readinessState = "ready";
      resolveReadiness?.();
      resolveReadiness = null;
      rejectReadiness = null;
    } else if (readinessState === "timed_out") {
      readinessState = "ready";
      readiness = Promise.resolve();
    }
    appEventsResync();
  };

  source.onmessage = (message) => {
    if (!isCurrent()) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(message.data);
    } catch {
      return;
    }
    if (!parsed || typeof parsed !== "object") return;
    const event = parsed as AppEvent;
    if (!eventTypes.has(event.type as AppEventType)) return;
    appEventsNotify(event.type, event);
  };

  source.onerror = () => {
    if (!isCurrent()) return;
    // EventSource owns reconnects. Initial readiness is reported by the timeout.
  };

  handshakeTimer = setTimeout(() => {
    if (!isCurrent() || readinessState !== "pending") return;
    readinessState = "timed_out";
    appEventsClearHandshakeTimer();
    console.error("[app-events] event channel handshake timed out");
    rejectReadiness?.(new Error("event channel handshake timed out"));
    resolveReadiness = null;
    rejectReadiness = null;
  }, 5000);

  return readiness;
}

function appEventsStop(): void {
  const source = eventSource;
  eventSource = null;
  generation += 1;
  appEventsClearHandshakeTimer();

  if (readinessState === "pending") {
    rejectReadiness?.(new Error("event channel stopped"));
  }
  readinessState = "idle";
  resolveReadiness = null;
  rejectReadiness = null;
  readiness = null;

  if (!source) return;
  source.onopen = null;
  source.onmessage = null;
  source.onerror = null;
  source.close();
}

function appEventsSubscribe(type: AppEventSubscriptionType, handler: AppEventHandler): () => void {
  let handlers = subscriptions.get(type);
  if (!handlers) {
    handlers = new Set();
    subscriptions.set(type, handlers);
  }
  handlers.add(handler);
  return () => {
    handlers?.delete(handler);
    if (handlers?.size === 0) subscriptions.delete(type);
  };
}

const appEvents: AppEvents = {
  start: appEventsStart,
  stop: appEventsStop,
  subscribe: appEventsSubscribe,
  resync: appEventsResync,
};
appEventsNamespace.Events = appEvents;
