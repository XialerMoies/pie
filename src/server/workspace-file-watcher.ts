import { watch as watchFs, type FSWatcher } from "node:fs";
import { resolve } from "node:path";

type WatchListener = (eventType: string, filename: string | Buffer | null) => void;
type WatchHandle = Pick<FSWatcher, "close">;

export type WorkspaceWatchFactory = (
  root: string,
  options: { recursive: boolean; encoding: BufferEncoding },
  listener: WatchListener,
) => WatchHandle;

export interface WorkspaceFileWatcherOptions {
  appRoot?: string;
  onChange: (file: string) => void;
  onError?: (error: Error) => void;
  onWatching?: (root: string) => void;
  debounceMs?: number;
  watch?: WorkspaceWatchFactory;
}

const COMMON_IGNORED_PREFIXES = [
  "node_modules/",
  ".git/",
  ".claude/",
];

const APP_IGNORED_PREFIXES = [
  "data/",
  "dist/",
  "example/",
  "src/frontend/gen/",
];

function pathKey(path: string): string {
  const normalized = resolve(path).replace(/\\/g, "/");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

export class WorkspaceFileWatcher {
  private readonly onChange: (file: string) => void;
  private readonly onError?: (error: Error) => void;
  private readonly onWatching?: (root: string) => void;
  private readonly appRootKey?: string;
  private readonly debounceMs: number;
  private readonly watchFactory: WorkspaceWatchFactory;
  private watcher: WatchHandle | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private workspace = "";
  private generation = 0;

  constructor(options: WorkspaceFileWatcherOptions) {
    this.onChange = options.onChange;
    this.onError = options.onError;
    this.onWatching = options.onWatching;
    this.appRootKey = options.appRoot ? pathKey(options.appRoot) : undefined;
    this.debounceMs = options.debounceMs ?? 500;
    this.watchFactory = options.watch ?? ((root, watchOptions, listener) => (
      watchFs(root, watchOptions, listener)
    ));
  }

  watchWorkspace(workspace: string): void {
    if (workspace === this.workspace && this.watcher) return;
    this.stopCurrentWatcher();
    if (!workspace) return;

    const generation = this.generation;
    const useAppIgnores = this.appRootKey === pathKey(workspace);
    try {
      this.watcher = this.watchFactory(
        workspace,
        { recursive: true, encoding: "utf8" },
        (_eventType, filename) => this.handleChange(generation, filename, useAppIgnores),
      );
      this.workspace = workspace;
      this.onWatching?.(workspace);
    } catch (error) {
      this.workspace = "";
      this.watcher = null;
      this.onError?.(error instanceof Error ? error : new Error(String(error)));
    }
  }

  close(): void {
    this.stopCurrentWatcher();
  }

  private handleChange(
    generation: number,
    filename: string | Buffer | null,
    useAppIgnores: boolean,
  ): void {
    if (generation !== this.generation || !filename) return;
    const file = filename.toString();
    const normalized = file.replace(/\\/g, "/");
    if (COMMON_IGNORED_PREFIXES.some((prefix) => normalized.startsWith(prefix))) return;
    if (useAppIgnores && APP_IGNORED_PREFIXES.some((prefix) => normalized.startsWith(prefix))) return;

    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      if (generation === this.generation) this.onChange(file);
    }, this.debounceMs);
  }

  private stopCurrentWatcher(): void {
    this.generation += 1;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    try { this.watcher?.close(); } catch {}
    this.watcher = null;
    this.workspace = "";
  }
}
