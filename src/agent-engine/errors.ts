import type { EngineErrorCategory, EngineErrorInfo } from "./contracts.js";

export interface NormalizeEngineErrorOptions {
  code?: string;
  category?: EngineErrorCategory;
  retryable?: boolean;
  message?: string;
}

export class AgentEngineError extends Error implements EngineErrorInfo {
  readonly code: string;
  readonly category: EngineErrorCategory;
  readonly retryable: boolean;
  declare readonly cause?: unknown;

  constructor(info: EngineErrorInfo, cause?: unknown) {
    super(info.message);
    this.name = "AgentEngineError";
    this.code = info.code;
    this.category = info.category;
    this.retryable = info.retryable;
    if (cause !== undefined) {
      Object.defineProperty(this, "cause", {
        configurable: true,
        enumerable: false,
        value: cause,
      });
    }
  }

  toJSON(): EngineErrorInfo {
    return {
      code: this.code,
      category: this.category,
      retryable: this.retryable,
      message: this.message,
    };
  }
}

export function normalizeEngineError(
  error: unknown,
  options: NormalizeEngineErrorOptions = {},
): AgentEngineError {
  if (error instanceof AgentEngineError) return error;
  return new AgentEngineError({
    code: options.code ?? "engine_error",
    category: options.category ?? "internal",
    retryable: options.retryable ?? false,
    message: options.message ?? "Agent 执行失败",
  }, error);
}
