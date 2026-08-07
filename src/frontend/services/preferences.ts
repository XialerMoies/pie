/** Browser-local user preference facade with server hydration. */

interface AppPreferences {
  get(key: string, fallback?: string): string;
  set(key: string, value: string): void;
  remove(key: string): void;
  getBoolean(key: string, fallback?: boolean): boolean;
  setBoolean(key: string, value: boolean): void;
  getNumber(key: string, fallback: number, min?: number, max?: number): number;
  getJson<T>(key: string, fallback: T): T;
  setJson<T>(key: string, value: T): void;
  hydrate(): Promise<void>;
  onHydrated(listener: () => void): () => void;
  isHydrated(): boolean;
  flush(): Promise<boolean>;
}

type PendingMutation = { value: string | null; version: number };

const KNOWN_PREFERENCE_KEYS = [
  "auto-save",
  "chat-effort",
  "chat-jump-latest-enabled",
  "chat-jump-latest-smooth",
  "chat-jump-latest-threshold",
  "chat-mode",
  "chat-timeline-enabled",
  "chat-timeline-window-size",
  "editor-font-size",
  "editor-tab-size",
  "editor-theme",
  "editor-use-tabs",
  "explorer-filter",
  "explorer-state",
  "providers_order",
];

const values = new Map<string, string>();
const mutations = new Map<string, PendingMutation>();
const PREFERENCE_PATCH_RETRY_DELAY_MS = 1000;
const PREFERENCE_HYDRATION_RETRY_DELAY_MS = 1000;
const PREFERENCE_HYDRATION_REQUEST_TIMEOUT_MS = 5000;
const hydrationListeners = new Set<() => void>();
let nextMutationVersion = 0;
let hydrationPromise: Promise<void> | null = null;
let hydrationRetryTimer: ReturnType<typeof setTimeout> | null = null;
let hydrated = false;
let hydrationActive = false;
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let inFlightFlush: Promise<boolean> | null = null;
let inFlightBatch: Map<string, PendingMutation> | null = null;
let publicFlushPromise: Promise<boolean> | null = null;

function loadLocalValues(): void {
  try {
    for (let index = 0; index < localStorage.length; index += 1) {
      const key = localStorage.key(index);
      if (!key) continue;
      const value = localStorage.getItem(key);
      if (value !== null) values.set(key, value);
    }
  } catch { /* Storage may be unavailable. */ }
}

loadLocalValues();

function preferenceGet(key: string, fallback = ""): string {
  if (values.has(key)) return values.get(key) as string;
  try {
    const value = localStorage.getItem(key);
    if (value !== null) {
      values.set(key, value);
      return value;
    }
  } catch { /* Storage may be unavailable. */ }
  return fallback;
}

function writeLocalValue(key: string, value: string): void {
  values.set(key, value);
  try { localStorage.setItem(key, value); } catch { /* Storage may be unavailable. */ }
}

function removeLocalValue(key: string): void {
  values.delete(key);
  try { localStorage.removeItem(key); } catch { /* Storage may be unavailable. */ }
}

function scheduleFlush(delayMs = 150): void {
  if (flushTimer !== null) clearTimeout(flushTimer);
  flushTimer = setTimeout(() => {
    flushTimer = null;
    void flush();
  }, delayMs);
}

function recordMutation(key: string, value: string | null): void {
  if (!KNOWN_PREFERENCE_KEYS.includes(key)) return;
  nextMutationVersion += 1;
  mutations.set(key, { value, version: nextMutationVersion });
  scheduleFlush();
}

function preferenceSet(key: string, value: string): void {
  writeLocalValue(key, value);
  recordMutation(key, value);
}

function preferenceRemove(key: string): void {
  removeLocalValue(key);
  recordMutation(key, null);
}

function sanitizeStringMap(value: unknown): Record<string, string> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return {};
  const result: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item === "string") result[key] = item;
  }
  return result;
}

function patchBody(batch: Map<string, PendingMutation>): { values: Record<string, string>; remove: string[] } {
  const patch = { values: {} as Record<string, string>, remove: [] as string[] };
  for (const key of [...batch.keys()].sort()) {
    const mutation = batch.get(key) as PendingMutation;
    if (mutation.value === null) patch.remove.push(key);
    else patch.values[key] = mutation.value;
  }
  return patch;
}

async function sendBatch(): Promise<boolean> {
  if (inFlightFlush) return inFlightFlush;
  if (flushTimer !== null) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  if (mutations.size === 0) return true;

  const batch = new Map(mutations);
  const body = patchBody(batch);
  inFlightBatch = batch;
  let succeeded = false;
  const request = (async (): Promise<boolean> => {
    try {
      const response = await fetch("/api/preferences", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!response.ok) return false;
      for (const [key, mutation] of batch) {
        if (mutations.get(key)?.version === mutation.version) mutations.delete(key);
      }
      succeeded = true;
      return true;
    } catch {
      return false;
    } finally {
      inFlightFlush = null;
      inFlightBatch = null;
      if (!succeeded && mutations.size > 0) scheduleFlush(PREFERENCE_PATCH_RETRY_DELAY_MS);
    }
  })();
  inFlightFlush = request;
  return request;
}

async function drainMutations(waitForHydration = true): Promise<boolean> {
  while (mutations.size > 0) {
    if (waitForHydration && hydrationActive) {
      if (!hydrationPromise) return false;
      await hydrationPromise;
    }
    if (!await sendBatch()) return false;
  }
  return true;
}

function flush(): Promise<boolean> {
  if (publicFlushPromise) return publicFlushPromise;
  const drain = hydrationActive && hydrationPromise
    ? hydrationPromise.then(() => drainMutations())
    : drainMutations();
  publicFlushPromise = drain.finally(() => {
    publicFlushPromise = null;
  });
  return publicFlushPromise;
}

function applyServerValues(serverValues: Record<string, string>, startVersions: Map<string, number>): void {
  const serverKeys = new Set(Object.keys(serverValues));
  for (const key of KNOWN_PREFERENCE_KEYS) {
    if ((mutations.get(key)?.version ?? 0) > (startVersions.get(key) ?? 0)) continue;
    if (serverKeys.has(key)) writeLocalValue(key, serverValues[key]);
    else removeLocalValue(key);
    mutations.delete(key);
  }

  for (const [key, value] of Object.entries(serverValues)) {
    if ((mutations.get(key)?.version ?? 0) > (startVersions.get(key) ?? 0)) continue;
    writeLocalValue(key, value);
    mutations.delete(key);
  }
}

function queueLocalMigration(startVersions: Map<string, number>): void {
  for (const key of KNOWN_PREFERENCE_KEYS) {
    if ((mutations.get(key)?.version ?? 0) > (startVersions.get(key) ?? 0)) continue;
    const value = preferenceGet(key, "");
    if (values.has(key)) recordMutation(key, value);
  }
}

async function fetchPreferencesWithDeadline(): Promise<Response> {
  const controller = new AbortController();
  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      fetch("/api/preferences", { signal: controller.signal }),
      new Promise<never>((_resolve, reject) => {
        timeoutId = setTimeout(() => {
          controller.abort();
          reject(new Error("Preference hydration timed out"));
        }, PREFERENCE_HYDRATION_REQUEST_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timeoutId !== null) clearTimeout(timeoutId);
  }
}

function notifyHydrated(): void {
  for (const listener of [...hydrationListeners]) {
    try { listener(); } catch { /* Preference consumers are isolated. */ }
  }
}

function scheduleHydrationRetry(): void {
  if (hydrationRetryTimer !== null) return;
  hydrationRetryTimer = setTimeout(() => {
    hydrationRetryTimer = null;
    void hydrate();
  }, PREFERENCE_HYDRATION_RETRY_DELAY_MS);
}

async function runHydrate(): Promise<boolean> {
  const startVersions = new Map<string, number>();
  for (const [key, mutation] of mutations) startVersions.set(key, mutation.version);
  const batchAtStart = inFlightBatch;
  if (batchAtStart) {
    for (const [key, mutation] of mutations) {
      const sent = batchAtStart.get(key);
      if (!sent || mutation.version > sent.version) startVersions.set(key, sent?.version ?? 0);
    }
  }
  hydrationActive = true;

  try {
    const initialFlushResult = inFlightFlush ? await inFlightFlush : null;
    if (initialFlushResult === false && batchAtStart) {
      for (const [key, sent] of batchAtStart) {
        const current = mutations.get(key);
        if (current && current.version >= sent.version) {
          startVersions.set(key, sent.version - 1);
        }
      }
    }
    const response = await fetchPreferencesWithDeadline();
    if (!response.ok) return false;
    const payload = await response.json() as { preferences?: unknown };
    const rawPreferences = payload?.preferences;
    const rawIsObject = rawPreferences !== null
      && typeof rawPreferences === "object"
      && !Array.isArray(rawPreferences);
    const serverNonEmpty = rawIsObject && Object.keys(rawPreferences).length > 0;
    const serverValues = sanitizeStringMap(rawPreferences);
    if (serverNonEmpty) applyServerValues(serverValues, startVersions);
    else {
      queueLocalMigration(startVersions);
      if (!await drainMutations(false)) return false;
    }
    return true;
  } catch {
    // Local state remains the fallback when the server cannot be reached.
    return false;
  } finally {
    hydrated = true;
    hydrationActive = false;
  }
}

function hydrate(): Promise<void> {
  if (!hydrationPromise) {
    const attempt = runHydrate();
    let sharedPromise: Promise<void>;
    sharedPromise = attempt.then((succeeded) => {
      if (succeeded) {
        if (hydrationRetryTimer !== null) {
          clearTimeout(hydrationRetryTimer);
          hydrationRetryTimer = null;
        }
        notifyHydrated();
      } else if (hydrationPromise === sharedPromise) {
        hydrationPromise = null;
        scheduleHydrationRetry();
      }
    });
    hydrationPromise = sharedPromise;
  }
  return hydrationPromise;
}

const preferencesApi: AppPreferences = {
  get: preferenceGet,
  set: preferenceSet,
  remove: preferenceRemove,
  getBoolean(key: string, fallback = false): boolean {
    const value = preferenceGet(key, fallback ? "1" : "0");
    if (value === "1" || value === "true") return true;
    if (value === "0" || value === "false") return false;
    return fallback;
  },
  setBoolean(key: string, value: boolean): void { preferenceSet(key, value ? "1" : "0"); },
  getNumber(key: string, fallback: number, min?: number, max?: number): number {
    const raw = preferenceGet(key, "");
    if (!raw.trim()) return fallback;
    const parsed = Number(raw);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.max(min ?? -Infinity, Math.min(max ?? Infinity, parsed));
  },
  getJson<T>(key: string, fallback: T): T {
    const raw = preferenceGet(key, "");
    if (!raw) return fallback;
    try { return JSON.parse(raw) as T; } catch { return fallback; }
  },
  setJson<T>(key: string, value: T): void { preferenceSet(key, JSON.stringify(value)); },
  hydrate,
  onHydrated(listener: () => void): () => void {
    hydrationListeners.add(listener);
    return () => hydrationListeners.delete(listener);
  },
  isHydrated: (): boolean => hydrated,
  flush,
};

const preferencesApp = (window as any).App || ((window as any).App = {});
preferencesApp.Preferences = preferencesApi;

export {};
