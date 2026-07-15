/**
 * tsserver 进程管理器 — 使用 Node IPC 通信
 *
 * 通过 child_process.fork() + --useNodeIpc 启动 tsserver，
 * 利用 Node.js 内置的 IPC 信道（process.send / process.on('message')），
 * 无需 Content-Length 头解析、无需 stdin/stdout 协议处理。
 *
 * tsserver IPC 协议：
 *   发送：proc.send({ seq, type: "request", command, arguments })
 *   接收：proc.on('message', msg) → msg.type === "response" | "event"
 *
 * 参考 VSCode: IpcChildServerProcess  +  spawner.ts getTsServerArgs
 * 要求 TypeScript >= 4.6.0（当前版本 5.9.3 ✅）
 */
import { fork, type ChildProcess } from "node:child_process";
import { resolve } from "node:path";

// ─── 类型 ───────────────────────────────────────────────────────

interface TsserverRequest {
  seq: number;
  type: "request";
  command: string;
  arguments?: any;
}

interface TsserverResponse {
  type: "response";
  request_seq: number;
  success: boolean;
  message?: string;
  body?: any;
}

interface TsserverEvent {
  type: "event";
  event: string;
  body?: any;
}

type TsserverMessage = TsserverResponse | TsserverEvent;

// ─── TsserverManager ────────────────────────────────────────────

export class TsserverManager {
  private process: ChildProcess | null = null;
  private seq = 0;
  private pending = new Map<number, { resolve: (body: any) => void; reject: (err: Error) => void }>();
  private onEvent: ((event: TsserverEvent) => void) | null = null;
  private ready = false;

  /** 注册事件回调 */
  setEventHandler(handler: (event: TsserverEvent) => void): void {
    this.onEvent = handler;
  }

  /** 启动 tsserver（child_process.fork + IPC） */
  async start(projectRoot: string): Promise<void> {
    if (this.process) return;

    return new Promise((promResolve, reject) => {
      const tsLibDir = resolve(projectRoot, "node_modules", "typescript", "lib");
      const tsserverPath = resolve(tsLibDir, "tsserver.js");

      try {
        this.process = fork(tsserverPath, [
          "--useNodeIpc",
          "--noGetErrOnInitialProjectUpdate",
          "--disableAutomaticTypingAcquisition",
          "--useInferredProjectPerProjectRoot",
        ], {
          cwd: projectRoot,
          env: {
            ...process.env,
            TS_INTERNAL: tsLibDir,
          },
          stdio: ["pipe", "pipe", "pipe", "ipc"],
        });
      } catch (err) {
        reject(new Error(`Failed to fork tsserver: ${err}`));
        return;
      }

      const proc = this.process;

      // IPC 消息 — tsserver 通过 process.send() 发送响应和事件
      proc.on("message", (msg: any) => {
        if (msg && msg.type === "event" && msg.event === "projectLoadingStart") return; // 忽略启动事件
        console.log("[tsserver] ← msg:", msg?.type, msg?.command || msg?.event || "");
        this.handleMessage(msg);
      });
      console.log("[tsserver] spawned with pid", proc.pid, "IPC enabled:", !!proc.channel);

      // stderr 日志（stdout 在 IPC 模式下仅用于日志，不用于协议）
      proc.stderr?.on("data", (chunk: Buffer) => {
        console.error("[tsserver:err]", chunk.toString());
      });

      proc.on("exit", (code) => {
        console.log(`[tsserver] exited with code ${code}`);
        this.process = null;
        this.ready = false;
        for (const [, p] of this.pending) p.reject(new Error(`tsserver exited`));
        this.pending.clear();
      });

      proc.on("error", (err) => {
        console.error("[tsserver] error:", err);
        reject(err);
      });

      // 等待 tsserver 就绪
      setTimeout(() => { this.ready = true; promResolve(); }, 500);
      setTimeout(() => { if (!this.ready) promResolve(); }, 8000);
    });
  }

  /** 发送请求并等待响应（通过 IPC，无 Content-Length） */
  async sendRequest(command: string, args?: any): Promise<any> {
    const proc = this.process;
    if (!proc) throw new Error("tsserver not started");

    const seq = ++this.seq;
    const request: TsserverRequest = { seq, type: "request", command, arguments: args };

    return new Promise((resolve, reject) => {
      this.pending.set(seq, { resolve, reject });
      proc.send(request);
    });
  }

  /** 处理 IPC 消息 */
  private handleMessage(msg: TsserverMessage) {
    if (msg.type === "response") {
      const pending = this.pending.get(msg.request_seq);
      if (pending) {
        this.pending.delete(msg.request_seq);
        msg.success ? pending.resolve(msg.body) : pending.reject(new Error(msg.message || "tsserver error"));
      }
    } else if (msg.type === "event") {
      this.onEvent?.(msg);
    }
  }

  /** 关闭 tsserver */
  stop(): void {
    const proc = this.process;
    if (!proc) return;
    try { proc.send({ seq: ++this.seq, type: "request", command: "exit" }); } catch {}
    setTimeout(() => { try { proc.kill(); } catch {} this.process = null; }, 2000);
  }

  /** 初始化（configure + compilerOptionsForInferredProjects） */
  async init(projectRoot: string): Promise<void> {
    if (!this.ready) throw new Error("tsserver not ready");
    try {
      await this.sendRequest("configure", {
        hostInfo: "my-code-agent",
        preferences: { providePrefixAndSuffixTextForRename: true, allowRenameOfImportPath: true },
      });
      await this.sendRequest("compilerOptionsForInferredProjects", {
        options: {
          module: "ESNext" as any,
          moduleResolution: "bundler" as any,
          target: "ES2022" as any,
          strict: true,
          esModuleInterop: true,
          allowJs: true,
          allowSyntheticDefaultImports: true,
          allowNonTsExtensions: true,
          resolveJsonModule: true,
          skipLibCheck: true,
        },
      });
    } catch (e) {
      console.error("[tsserver] init failed:", e);
    }
  }

  isRunning(): boolean {
    return this.process !== null && this.ready;
  }
}
