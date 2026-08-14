import type { DesktopLaunchRequest } from "./desktop-launch.js";

interface SecondInstanceCoordinatorOptions {
  maxPending?: number;
  electronPid: number;
  e2eEnabled: boolean;
  now?: () => number;
  validate(request: DesktopLaunchRequest): void;
  processRequest(request: DesktopLaunchRequest): Promise<void>;
  resolveWaiter(instanceId: string): void;
  rejectWaiter(instanceId: string, error: Error): void;
  showOverflowNotice(): void;
  showError(message: string): void;
  logError(message: string): void;
}

export interface SecondInstanceRecord {
  electronPid: number;
  request: DesktopLaunchRequest;
  handledAt: number;
}

export function createSecondInstanceCoordinator(options: SecondInstanceCoordinatorOptions) {
  const maxPending = options.maxPending ?? 32;
  const now = options.now || Date.now;
  const pending: DesktopLaunchRequest[] = [];
  const records: SecondInstanceRecord[] = [];
  let ready = false;
  let overflowNoticeShown = false;
  let draining: Promise<void> | null = null;

  function rejectWaiter(instanceId: string | undefined, error: Error): void {
    if (instanceId) options.rejectWaiter(instanceId, error);
  }

  async function processOne(request: DesktopLaunchRequest): Promise<void> {
    try {
      await options.processRequest(request);
      if (options.e2eEnabled) {
        records.push({
          electronPid: options.electronPid,
          request,
          handledAt: now(),
        });
      }
      if (request.instanceId) options.resolveWaiter(request.instanceId);
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error));
      rejectWaiter(request.instanceId, failure);
      options.logError(`Failed to process second launch: ${failure.message}`);
      options.showError(failure.message);
    }
  }

  function drain(): Promise<void> {
    if (draining) return draining;
    draining = (async () => {
      while (pending.length > 0) {
        const request = pending.shift();
        if (request) await processOne(request);
      }
      overflowNoticeShown = false;
    })().finally(() => {
      draining = null;
      if (pending.length > 0) void drain();
    });
    return draining;
  }

  function accept(request: DesktopLaunchRequest): void {
    try {
      options.validate(request);
      if (pending.length >= maxPending) {
        const error = new Error("The pending window request queue is full.");
        rejectWaiter(request.instanceId, error);
        options.logError(error.message);
        if (!overflowNoticeShown) {
          overflowNoticeShown = true;
          options.showOverflowNotice();
        }
        return;
      }
      pending.push(request);
      if (ready) void drain();
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error));
      rejectWaiter(request.instanceId, failure);
      options.logError(failure.message);
      options.showError(failure.message);
    }
  }

  async function markReady(): Promise<void> {
    ready = true;
    await drain();
  }

  return {
    accept,
    markReady,
    drain,
    records,
  };
}
