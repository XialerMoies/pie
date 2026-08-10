import * as path from "node:path";

export interface DesktopLaunchRequest {
  workspace?: string;
  dataRoot?: string;
  instanceId?: string;
}

export const LEGACY_LAUNCH_HANDOFF_ERROR = "多窗口管理尚未就绪，请使用当前窗口。";

interface LaunchChild {
  once(event: string, listener: (...args: any[]) => void): LaunchChild;
}

interface LegacyLaunchWaiter {
  resolve: () => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export function readDesktopLaunchArgument(argv: readonly string[], name: string): string | undefined {
  const prefix = `${name}=`;
  const inline = argv.find((arg) => arg.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);

  const index = argv.indexOf(name);
  const value = index >= 0 ? argv[index + 1] : undefined;
  return value && !value.startsWith("--") ? value : undefined;
}

export function parseDesktopLaunchRequest(
  commandLine: readonly string[],
  workingDirectory: string,
): DesktopLaunchRequest {
  const workspace = readDesktopLaunchArgument(commandLine, "--workspace");
  const dataRoot = readDesktopLaunchArgument(commandLine, "--data-root");
  const instanceId = readDesktopLaunchArgument(commandLine, "--instance-id");
  return {
    ...(workspace ? { workspace: path.resolve(workingDirectory, workspace) } : {}),
    ...(dataRoot ? { dataRoot: path.resolve(workingDirectory, dataRoot) } : {}),
    ...(instanceId ? { instanceId } : {}),
  };
}

export function createLegacyLaunchWaiterRegistry(options: {
  timeoutMs?: number;
  setTimeoutFn?: typeof setTimeout;
  clearTimeoutFn?: typeof clearTimeout;
} = {}) {
  const timeoutMs = options.timeoutMs ?? 30_000;
  const setTimeoutFn = options.setTimeoutFn ?? setTimeout;
  const clearTimeoutFn = options.clearTimeoutFn ?? clearTimeout;
  const waiters = new Map<string, LegacyLaunchWaiter>();

  function settle(instanceId: string, callback: (waiter: LegacyLaunchWaiter) => void): boolean {
    const waiter = waiters.get(instanceId);
    if (!waiter) return false;
    waiters.delete(instanceId);
    clearTimeoutFn(waiter.timer);
    callback(waiter);
    return true;
  }

  function register(instanceId: string, child: LaunchChild): Promise<void> {
    const existing = waiters.get(instanceId);
    if (existing) {
      settle(instanceId, (waiter) => waiter.reject(new Error(`Duplicate launch waiter: ${instanceId}`)));
    }

    return new Promise<void>((resolve, reject) => {
      const timer = setTimeoutFn(() => {
        settle(instanceId, (waiter) => waiter.reject(new Error(`Window launch timed out: ${instanceId}`)));
      }, timeoutMs);
      waiters.set(instanceId, { resolve, reject, timer });
      child.once("error", (error: unknown) => {
        settle(instanceId, (waiter) => waiter.reject(error instanceof Error ? error : new Error(String(error))));
      });
      child.once("exit", (code: number | null, signal: string | null) => {
        settle(instanceId, (waiter) => waiter.reject(
          new Error(`Window launch exited before handoff (${code ?? "unknown"}, ${signal ?? "unknown"})`),
        ));
      });
    });
  }

  return {
    register,
    resolve: (instanceId: string) => settle(instanceId, (waiter) => waiter.resolve()),
    reject: (instanceId: string, error: Error) => settle(instanceId, (waiter) => waiter.reject(error)),
    size: () => waiters.size,
  };
}

export function drainSecondLaunchRequests(
  requests: readonly DesktopLaunchRequest[],
  options: {
    rejectWaiter: (instanceId: string) => boolean;
    focus: () => void;
    showErrorBox: () => void;
  },
): void {
  let hasExternalRequest = false;
  for (const request of requests) {
    if (request.instanceId && options.rejectWaiter(request.instanceId)) continue;
    hasExternalRequest = true;
  }
  if (!hasExternalRequest) return;
  options.focus();
  options.showErrorBox();
}
