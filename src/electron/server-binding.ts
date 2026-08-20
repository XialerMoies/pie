import {
  execFileSync,
  spawn as spawnChild,
  type ChildProcess,
  type SpawnOptions,
} from "child_process";
import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";

import type { DataLayout } from "../data/data-layout.js";
import {
  createInternalServerEnv,
  getProviderSecretValues,
  sanitizeProcessOutput,
} from "../process/env-policy.js";

export type ServerBindingState = "starting" | "ready" | "stopping" | "failed" | "stopped";

export interface NoneServerBindingSnapshot {
  readonly kind: "none";
  readonly state: "stopped";
  readonly port: 0;
  readonly token: "";
  readonly origin: "";
  readonly hasProcess: false;
}

export interface ExternalServerBindingSnapshot {
  readonly kind: "external";
  readonly state: "ready";
  readonly port: number;
  readonly token: string;
  readonly origin: string;
  readonly hasProcess: false;
}

export interface OwnedServerBindingSnapshot {
  readonly kind: "owned";
  readonly state: ServerBindingState;
  readonly port: number;
  readonly token: string;
  readonly origin: string;
  readonly hasProcess: boolean;
}

export type ServerBindingSnapshot =
  | NoneServerBindingSnapshot
  | ExternalServerBindingSnapshot
  | OwnedServerBindingSnapshot;

export interface NoneServerBinding {
  readonly kind: "none";
  readonly state: "stopped";
  readonly port: 0;
  readonly token: "";
  readonly origin: "";
  readonly process: null;
  stop(): Promise<void>;
  snapshot(): NoneServerBindingSnapshot;
}

export interface ExternalServerBinding {
  readonly kind: "external";
  readonly state: "ready";
  readonly port: number;
  readonly token: string;
  readonly origin: string;
  readonly process: null;
  start(): Promise<number>;
  stop(): Promise<void>;
  snapshot(): ExternalServerBindingSnapshot;
}

export interface OwnedServerExit {
  code: number | null;
  signal: NodeJS.Signals | null;
  error?: Error;
}

export interface OwnedServerSpec {
  workspace: string;
  dataRoot: string;
  layout: DataLayout;
  instanceId: string;
  token: string;
  appRoot: string;
  runtimeRoot: string;
  isPackaged: boolean;
  env: NodeJS.ProcessEnv;
  onUnexpectedExit?: (event: OwnedServerExit) => void;
}

type TimerHandle = ReturnType<typeof setTimeout>;

export interface OwnedServerBindingDeps {
  executable?: string;
  spawn?: (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess;
  forceKill?: (child: ChildProcess) => boolean | void | Promise<boolean | void>;
  setTimeout?: (callback: () => void, delay: number) => TimerHandle;
  clearTimeout?: (timer: TimerHandle) => void;
  startupTimeoutMs?: number;
  stopTimeoutMs?: number;
  forceKillGraceTimeoutMs?: number;
  writeStdout?: (text: string) => void;
  writeStderr?: (text: string) => void;
}

export interface OwnedServerBinding {
  readonly kind: "owned";
  readonly state: ServerBindingState;
  readonly port: number;
  readonly token: string;
  readonly origin: string;
  readonly process: ChildProcess | null;
  start(): Promise<number>;
  stop(): Promise<void>;
  setUnexpectedExitHandler(handler: ((event: OwnedServerExit) => void) | null): void;
  snapshot(): OwnedServerBindingSnapshot;
}

export type ServerBinding = NoneServerBinding | ExternalServerBinding | OwnedServerBinding;

export function createNoneServerBinding(): NoneServerBinding {
  const binding: NoneServerBinding = {
    kind: "none",
    state: "stopped",
    port: 0,
    token: "",
    origin: "",
    process: null,
    stop: () => Promise.resolve(),
    snapshot: () => ({
      kind: "none",
      state: "stopped",
      port: 0,
      token: "",
      origin: "",
      hasProcess: false,
    }),
  };
  return binding;
}

export function createExternalServerBinding(options: {
  port: number;
  token: string;
  origin?: string;
}): ExternalServerBinding {
  const origin = options.origin || `http://127.0.0.1:${options.port}`;
  const binding: ExternalServerBinding = {
    kind: "external",
    state: "ready",
    port: options.port,
    token: options.token,
    origin,
    process: null,
    start: () => Promise.resolve(options.port),
    stop: () => Promise.resolve(),
    snapshot: () => ({
      kind: "external",
      state: "ready",
      port: options.port,
      token: options.token,
      origin,
      hasProcess: false,
    }),
  };
  return binding;
}

function defaultForceKill(child: ChildProcess): void {
  if (process.platform === "win32" && child.pid) {
    execFileSync("taskkill", ["/F", "/T", "/PID", String(child.pid)], { stdio: "ignore" });
    return;
  }
  if (!child.kill("SIGKILL")) throw new Error("Pi server force kill failed");
}

function prepareLayout(spec: OwnedServerSpec): void {
  for (const directory of [
    spec.dataRoot,
    spec.layout.userRoot,
    spec.layout.sessionsDir,
    spec.layout.workspaceRoot,
    spec.layout.instanceRoot,
    spec.layout.cacheDir,
  ]) {
    mkdirSync(directory, { recursive: true });
  }
  try {
    writeFileSync(spec.layout.authFile, JSON.stringify({}, null, 2), { encoding: "utf8", flag: "wx" });
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException)?.code !== "EEXIST") throw error;
  }
}

export function createOwnedServerBinding(
  spec: OwnedServerSpec,
  dependencies: OwnedServerBindingDeps = {},
): OwnedServerBinding {
  const executable = dependencies.executable || process.execPath;
  const spawn = dependencies.spawn || ((command, args, options) => spawnChild(command, [...args], options));
  const forceKill = dependencies.forceKill || defaultForceKill;
  const scheduleTimeout = dependencies.setTimeout || setTimeout;
  const cancelTimeout = dependencies.clearTimeout || clearTimeout;
  const startupTimeoutMs = dependencies.startupTimeoutMs ?? 30_000;
  const stopTimeoutMs = dependencies.stopTimeoutMs ?? 2_000;
  const forceKillGraceTimeoutMs = dependencies.forceKillGraceTimeoutMs ?? 2_000;
  const writeStdout = dependencies.writeStdout || ((text: string) => process.stdout.write(`[pi-server] ${text}`));
  const writeStderr = dependencies.writeStderr || ((text: string) => process.stderr.write(`[pi-server:err] ${text}`));
  const knownSecrets = [spec.token, ...getProviderSecretValues(spec.env)];

  interface ActiveRun {
    child: ChildProcess;
    stdout: string;
    stderr: string;
    ready: boolean;
    startSettled: boolean;
    terminationRequested: boolean;
    pendingStartupFailure: Error | null;
    startupTimer: TimerHandle | null;
    resolveStart: (port: number) => void;
    rejectStart: (error: Error) => void;
    onStdout: (chunk: Buffer | string) => void;
    onStderr: (chunk: Buffer | string) => void;
    onExit: (code: number | null, signal: NodeJS.Signals | null) => void;
    onError: (error: Error) => void;
  }

  interface StopAttempt {
    child: ChildProcess;
    promise: Promise<void>;
    resolve: () => void;
    reject: (error: Error) => void;
    forceTimer: TimerHandle | null;
    graceTimer: TimerHandle | null;
    settled: boolean;
  }

  let state: ServerBindingState = "stopped";
  let port = 0;
  let child: ChildProcess | null = null;
  let activeRun: ActiveRun | null = null;
  let readinessPromise: Promise<number> | null = null;
  let disposalPromise: Promise<void> | null = null;
  let stopAttempt: StopAttempt | null = null;
  let unexpectedExitHandler: ((event: OwnedServerExit) => void) | null = null;
  let pendingUnexpectedExit: OwnedServerExit | null = null;

  const binding: OwnedServerBinding = {
    kind: "owned",
    get state() { return state; },
    get port() { return port; },
    get token() { return spec.token; },
    get origin() { return port ? `http://127.0.0.1:${port}` : ""; },
    get process() { return child; },
    start,
    stop,
    setUnexpectedExitHandler,
    snapshot: () => ({
      kind: "owned",
      state,
      port,
      token: spec.token,
      origin: port ? `http://127.0.0.1:${port}` : "",
      hasProcess: child !== null,
    }),
  };

  function errorText(error: unknown): string {
    return sanitizeProcessOutput(error, knownSecrets);
  }

  function safeError(error: unknown): Error {
    return new Error(errorText(error));
  }

  function notifyUnexpectedExit(event: OwnedServerExit): void {
    spec.onUnexpectedExit?.(event);
    if (unexpectedExitHandler) {
      unexpectedExitHandler(event);
      return;
    }
    pendingUnexpectedExit = event;
  }

  function setUnexpectedExitHandler(handler: ((event: OwnedServerExit) => void) | null): void {
    unexpectedExitHandler = handler;
    if (!handler || !pendingUnexpectedExit) return;
    const event = pendingUnexpectedExit;
    pendingUnexpectedExit = null;
    handler(event);
  }

  function clearRunTimer(run: ActiveRun): void {
    if (run.startupTimer === null) return;
    cancelTimeout(run.startupTimer);
    run.startupTimer = null;
  }

  function removeStreamListeners(run: ActiveRun): void {
    run.child.stdout?.off("data", run.onStdout);
    run.child.stderr?.off("data", run.onStderr);
  }

  function removeRunListeners(run: ActiveRun): void {
    removeStreamListeners(run);
    run.child.off("exit", run.onExit);
    run.child.off("error", run.onError);
  }

  function cleanupRun(run: ActiveRun): void {
    clearRunTimer(run);
    removeRunListeners(run);
    if (activeRun === run) activeRun = null;
    if (child === run.child) child = null;
  }

  function settleStartFailure(run: ActiveRun, error: Error): void {
    if (run.startSettled) return;
    run.startSettled = true;
    clearRunTimer(run);
    removeStreamListeners(run);
    port = 0;
    if (state !== "stopping") state = "failed";
    run.rejectStart(error);
  }

  function finishStopSuccess(attempt: StopAttempt): void {
    if (attempt.settled) return;
    attempt.settled = true;
    if (attempt.forceTimer !== null) cancelTimeout(attempt.forceTimer);
    if (attempt.graceTimer !== null) cancelTimeout(attempt.graceTimer);
    attempt.forceTimer = null;
    attempt.graceTimer = null;
    if (stopAttempt === attempt) stopAttempt = null;
    disposalPromise = null;
    state = "stopped";
    attempt.resolve();
  }

  function finishStopFailure(attempt: StopAttempt, error: Error): void {
    if (attempt.settled) return;
    attempt.settled = true;
    if (attempt.forceTimer !== null) cancelTimeout(attempt.forceTimer);
    if (attempt.graceTimer !== null) cancelTimeout(attempt.graceTimer);
    attempt.forceTimer = null;
    attempt.graceTimer = null;
    if (stopAttempt === attempt) stopAttempt = null;
    disposalPromise = null;
    state = "failed";
    attempt.reject(error);
  }

  function handleRunExit(
    run: ActiveRun,
    code: number | null,
    signal: NodeJS.Signals | null,
  ): void {
    if (activeRun !== run) return;
    const wasReady = run.ready;
    const wasTerminationRequested = run.terminationRequested;
    const pendingStartupFailure = run.pendingStartupFailure;
    cleanupRun(run);

    if (!run.startSettled) {
      const exitDescription = signal === null ? String(code) : `${code}, ${signal}`;
      const failure = pendingStartupFailure
        || new Error(`Pi server exited before ready (${exitDescription})\n${run.stdout}${run.stderr}`);
      settleStartFailure(run, failure);
    }

    const stopping = stopAttempt?.child === run.child ? stopAttempt : null;
    if (stopping) {
      finishStopSuccess(stopping);
      return;
    }

    port = 0;
    if (!wasReady || wasTerminationRequested) {
      state = "failed";
      return;
    }
    state = "failed";
    notifyUnexpectedExit({ code, signal });
  }

  function handleRunError(run: ActiveRun, error: Error): void {
    if (activeRun !== run) return;
    const wasReady = run.ready;
    cleanupRun(run);
    const diagnosticError = new Error(`${errorText(error)}\n${run.stdout}${run.stderr}`);

    if (!run.startSettled) settleStartFailure(run, diagnosticError);

    const stopping = stopAttempt?.child === run.child ? stopAttempt : null;
    if (stopping) {
      finishStopFailure(stopping, new Error(`Pi server error while stopping: ${errorText(error)}`));
      return;
    }

    port = 0;
    state = "failed";
    if (wasReady && !run.terminationRequested) {
      notifyUnexpectedExit({ code: null, signal: null, error: safeError(error) });
    }
  }

  async function requestForceKill(target: ChildProcess): Promise<void> {
    const result = await forceKill(target);
    if (result === false) throw new Error("Pi server force kill reported failure");
  }

  function spawnOptions(): { script: string; args: string[]; options: SpawnOptions } {
    const script = spec.isPackaged
      ? join(spec.appRoot, "dist", "server", "server.js")
      : join(spec.appRoot, "src", "server", "server.ts");
    const args = spec.isPackaged ? [script] : ["--import", "tsx", script];
    const env = createInternalServerEnv(spec.env, {
      token: spec.token,
      workspace: spec.workspace,
      dataRoot: spec.dataRoot,
      instanceId: spec.instanceId,
      userRoot: spec.layout.userRoot,
      sessionsDir: spec.layout.sessionsDir,
      workspaceData: spec.layout.workspaceRoot,
      instanceData: spec.layout.instanceRoot,
    });
    return {
      script,
      args,
      options: {
        env,
        stdio: ["pipe", "pipe", "pipe"],
        cwd: spec.isPackaged ? spec.runtimeRoot : spec.appRoot,
        shell: false,
      },
    };
  }

  function start(): Promise<number> {
    if (state === "ready" && port > 0) return Promise.resolve(port);
    if (readinessPromise) return readinessPromise;
    if (child) {
      return Promise.reject(new Error("Pi server has an existing child process; stop it before retrying start"));
    }
    if (state === "stopping") {
      return Promise.reject(new Error("Pi server cannot start while stopping"));
    }

    state = "starting";
    port = 0;
    const attempt = startAttempt();
    readinessPromise = attempt;
    void attempt.then(
      () => { if (readinessPromise === attempt) readinessPromise = null; },
      () => { if (readinessPromise === attempt) readinessPromise = null; },
    );
    return attempt;
  }

  function startAttempt(): Promise<number> {
    try {
      prepareLayout(spec);
    } catch (error) {
      state = "failed";
      return Promise.reject(error);
    }

    let spawned: ChildProcess;
    try {
      const command = spawnOptions();
      spawned = spawn(executable, command.args, command.options);
    } catch (error) {
      state = "failed";
      return Promise.reject(error);
    }

    child = spawned;
    return new Promise<number>((resolveStart, rejectStart) => {
      const run: ActiveRun = {
        child: spawned,
        stdout: "",
        stderr: "",
        ready: false,
        startSettled: false,
        terminationRequested: false,
        pendingStartupFailure: null,
        startupTimer: null,
        resolveStart,
        rejectStart,
        onStdout: () => {},
        onStderr: () => {},
        onExit: () => {},
        onError: () => {},
      };

      run.onStdout = (chunk) => {
        const text = chunk.toString();
        writeStdout(sanitizeProcessOutput(text, knownSecrets));
        if (run.startSettled) return;
        run.stdout += sanitizeProcessOutput(text, knownSecrets);
        const portMatch = run.stdout.match(/SERVER_PORT:(\d+)/);
        if (!portMatch) return;
        run.ready = true;
        run.startSettled = true;
        clearRunTimer(run);
        port = Number(portMatch[1]);
        state = "ready";
        resolveStart(port);
      };
      run.onStderr = (chunk) => {
        const text = chunk.toString();
        writeStderr(sanitizeProcessOutput(text, knownSecrets));
        if (!run.startSettled) run.stderr += sanitizeProcessOutput(text, knownSecrets);
      };
      run.onExit = (code, signal) => handleRunExit(run, code, signal);
      run.onError = (error) => handleRunError(run, error);

      activeRun = run;
      spawned.stdout?.on("data", run.onStdout);
      spawned.stderr?.on("data", run.onStderr);
      spawned.on("exit", run.onExit);
      spawned.on("error", run.onError);
      run.startupTimer = scheduleTimeout(() => {
        run.startupTimer = null;
        if (run.startSettled) return;
        const timeoutError = new Error(`Pi server startup timeout\n${run.stdout}${run.stderr}`);
        run.pendingStartupFailure = timeoutError;
        run.terminationRequested = true;
        void requestForceKill(spawned).then(
          () => settleStartFailure(run, timeoutError),
          (killError) => {
            const failure = new Error(
              `${timeoutError.message}\nPi server force kill failed: ${errorText(killError)}`,
            );
            run.pendingStartupFailure = failure;
            settleStartFailure(run, failure);
          },
        );
      }, startupTimeoutMs);
    });
  }

  function stop(): Promise<void> {
    if (disposalPromise) return disposalPromise;
    const stoppingChild = child;
    const run = activeRun;
    if (!stoppingChild || !run) {
      port = 0;
      state = "stopped";
      return Promise.resolve();
    }

    state = "stopping";
    port = 0;
    run.terminationRequested = true;
    if (!run.startSettled) {
      settleStartFailure(run, new Error(`Pi server stopped before ready\n${run.stdout}${run.stderr}`));
    }

    let resolveStop!: () => void;
    let rejectStop!: (error: Error) => void;
    const promise = new Promise<void>((resolve, reject) => {
      resolveStop = resolve;
      rejectStop = reject;
    });
    const attempt: StopAttempt = {
      child: stoppingChild,
      promise,
      resolve: resolveStop,
      reject: rejectStop,
      forceTimer: null,
      graceTimer: null,
      settled: false,
    };
    stopAttempt = attempt;
    disposalPromise = promise;

    try { stoppingChild.stdin?.write("PI_SERVER_SHUTDOWN\n"); } catch {}
    try { stoppingChild.stdin?.end(); } catch {}

    attempt.forceTimer = scheduleTimeout(() => {
      attempt.forceTimer = null;
      if (attempt.settled || activeRun !== run) return;
      void requestForceKill(stoppingChild).then(
        () => {
          if (attempt.settled || activeRun !== run) return;
          attempt.graceTimer = scheduleTimeout(() => {
            attempt.graceTimer = null;
            if (attempt.settled || activeRun !== run) return;
            finishStopFailure(
              attempt,
              new Error("Pi server did not exit within the grace period after force kill"),
            );
          }, forceKillGraceTimeoutMs);
        },
        (killError) => {
          finishStopFailure(
            attempt,
            new Error(`Pi server force kill failed: ${errorText(killError)}`),
          );
        },
      );
    }, stopTimeoutMs);
    return promise;
  }

  return binding;
}
