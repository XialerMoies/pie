import { calculateContextTokens, estimateTokens } from "@xiamol/pi-coding-agent"

export type ContextUsageSource = "exact" | "mixed" | "estimated"

export interface ContextUsageSnapshot {
  tokens: number | null
  contextWindow: number
  percent: number | null
  source: ContextUsageSource
  exactTokens: number
  estimatedTokens: number
}

interface ContextUsageSession {
  model?: { contextWindow?: number } | null
  messages?: unknown[]
  getContextUsage?: () => { tokens?: number | null } | undefined
}

interface UsageInfo {
  index: number
  tokens: number
}

function findLastValidUsage(messages: unknown[]): UsageInfo | undefined {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index] as {
      role?: string
      stopReason?: string
      usage?: Parameters<typeof calculateContextTokens>[0]
    } | undefined
    if (message?.role !== "assistant") continue
    if (message.stopReason === "aborted" || message.stopReason === "error" || !message.usage) continue
    const tokens = calculateContextTokens(message.usage)
    if (tokens > 0) return { index, tokens }
  }
  return undefined
}

function estimateMessages(messages: unknown[], startIndex = 0): number {
  let tokens = 0
  for (let index = startIndex; index < messages.length; index++) {
    tokens += estimateTokens(messages[index] as Parameters<typeof estimateTokens>[0])
  }
  return tokens
}

function snapshot(
  tokens: number,
  contextWindow: number,
  source: ContextUsageSource,
  exactTokens: number,
  estimatedTokens: number,
): ContextUsageSnapshot {
  return {
    tokens,
    contextWindow,
    percent: tokens / contextWindow * 100,
    source,
    exactTokens,
    estimatedTokens,
  }
}

export function calculateContextUsageSnapshot(session: ContextUsageSession): ContextUsageSnapshot | undefined {
  const contextWindow = Number(session.model?.contextWindow ?? 0)
  if (!Number.isFinite(contextWindow) || contextWindow <= 0) return undefined

  const messages = Array.isArray(session.messages) ? session.messages : []
  const nativeUsage = session.getContextUsage?.()

  // PI returns null after compaction until a post-compaction response provides a new baseline.
  if (nativeUsage?.tokens === null) {
    const estimatedTokens = estimateMessages(messages)
    return snapshot(estimatedTokens, contextWindow, "estimated", 0, estimatedTokens)
  }

  const usage = findLastValidUsage(messages)
  if (!usage) {
    const estimatedTokens = estimateMessages(messages)
    return snapshot(estimatedTokens, contextWindow, "estimated", 0, estimatedTokens)
  }

  const estimatedTokens = estimateMessages(messages, usage.index + 1)
  const source: ContextUsageSource = usage.index < messages.length - 1 ? "mixed" : "exact"
  return snapshot(usage.tokens + estimatedTokens, contextWindow, source, usage.tokens, estimatedTokens)
}
