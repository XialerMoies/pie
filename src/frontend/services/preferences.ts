/** Browser-local user preference facade. */

interface AppPreferences {
  get(key: string, fallback?: string): string;
  set(key: string, value: string): void;
  remove(key: string): void;
  getBoolean(key: string, fallback?: boolean): boolean;
  setBoolean(key: string, value: boolean): void;
  getNumber(key: string, fallback: number, min?: number, max?: number): number;
  getJson<T>(key: string, fallback: T): T;
  setJson<T>(key: string, value: T): void;
}

function preferenceGet(key: string, fallback = ''): string {
  try { return localStorage.getItem(key) ?? fallback; } catch { return fallback; }
}

function preferenceSet(key: string, value: string): void {
  try { localStorage.setItem(key, value); } catch { /* Storage may be unavailable. */ }
}

function preferenceRemove(key: string): void {
  try { localStorage.removeItem(key); } catch { /* Storage may be unavailable. */ }
}

const preferencesApi: AppPreferences = {
  get: preferenceGet,
  set: preferenceSet,
  remove: preferenceRemove,
  getBoolean(key: string, fallback = false): boolean {
    const value = preferenceGet(key, fallback ? '1' : '0');
    return value === '1' || value === 'true';
  },
  setBoolean(key: string, value: boolean): void { preferenceSet(key, value ? '1' : '0'); },
  getNumber(key: string, fallback: number, min?: number, max?: number): number {
    const raw = preferenceGet(key, '');
    if (!raw.trim()) return fallback;
    const parsed = Number(raw);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.max(min ?? -Infinity, Math.min(max ?? Infinity, parsed));
  },
  getJson<T>(key: string, fallback: T): T {
    const raw = preferenceGet(key, '');
    if (!raw) return fallback;
    try { return JSON.parse(raw) as T; } catch { return fallback; }
  },
  setJson<T>(key: string, value: T): void { preferenceSet(key, JSON.stringify(value)); },
};

const preferencesApp = (window as any).App || ((window as any).App = {});
preferencesApp.Preferences = preferencesApi;

export {};
