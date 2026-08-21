import type { EngineErrorInfo } from "../agent-engine/contracts.js";
import type { ToolFailureKind } from "../agent/types.js";

export type RetryAction = "retry" | "stop" | "block" | "cancel";
export type RetryCategory = ToolFailureKind | "provider" | "network" | "permission" | "validation" | "cancelled" | "internal" | "storage";

export interface RetryDecision {
  action: RetryAction;
  category: RetryCategory;
  attempt: number;
  requestKey: string;
  reason: string;
}

export interface RetryPolicyOptions {
  /** Category-specific budget; this is not a global tool-call circuit breaker. */
  transportAttempts?: number;
}

function categoryOf(error: EngineErrorInfo): RetryCategory {
  if (error.kind) return error.kind;
  if (error.category === "network") return "transport_error";
  if (error.category === "permission") return "permission_denied";
  if (error.category === "validation") return "validation_error";
  if (error.category === "cancelled") return "cancelled";
  return error.category;
}

/**
 * Classifies one failed request. State is keyed by request identity, so a
 * changed target/argument starts a distinct retry budget instead of sharing a
 * global counter across unrelated tools.
 */
export class RetryPolicy {
  readonly #transportAttempts: number;
  readonly #attempts = new Map<string, number>();
  readonly #decisions: RetryDecision[] = [];

  constructor(options: RetryPolicyOptions = {}) {
    this.#transportAttempts = Math.max(1, Math.min(3, Math.floor(options.transportAttempts ?? 2)));
  }

  decide(toolName: string, requestKey: string, error: EngineErrorInfo): RetryDecision {
    const category = categoryOf(error);
    const key = `${toolName}:${requestKey}`;
    const attempt = (this.#attempts.get(key) || 0) + 1;
    this.#attempts.set(key, attempt);
    let action: RetryAction;
    let reason: string;
    if (category === "cancelled") {
      action = "cancel";
      reason = "cancelled_by_user";
    } else if (category === "not_found") {
      action = "stop";
      reason = "target_not_found_is_not_retryable_without_a_new_target";
    } else if (category === "permission_denied") {
      action = "stop";
      reason = "permission_must_change_before_retry";
    } else if (category === "validation_error") {
      action = "stop";
      reason = "arguments_must_change_before_retry";
    } else if (category === "transport_error" || category === "network") {
      action = attempt < this.#transportAttempts ? "retry" : "block";
      reason = action === "retry"
        ? `transport_error_retry_${attempt}_of_${this.#transportAttempts - 1}`
        : "transport_error_retry_budget_exhausted";
    } else {
      action = "stop";
      reason = error.retryable ? "unclassified_failure_requires_explicit_change" : "failure_not_retryable";
    }
    const decision = { action, category, attempt, requestKey, reason };
    this.#decisions.push(decision);
    return decision;
  }

  decisions(): RetryDecision[] {
    return this.#decisions.map((decision) => ({ ...decision }));
  }
}
