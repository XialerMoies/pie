import type { ToolContext } from "../types.js"
import { getCurrentRuntime } from "../globals.js"

const DESKTOP_TOKEN_HEADER = "X-My-Code-Agent-Token"
const INTERNAL_TOOL_HEADER = "X-My-Code-Agent-Internal-Tool"
let _localApiToken: string | undefined

/** Bind the token owned by the current server process for in-process tools. */
export function setLocalApiToken(token: string | undefined): void {
  _localApiToken = token?.trim() || undefined
}

export function getLocalApiBaseUrl(): string {
  const port = process.env.SERVER_PORT
  if (!port || !/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535) {
    throw new Error("SERVER_PORT is unavailable for the active server instance")
  }
  return `http://127.0.0.1:${port}`
}

export function localApiFetch(url: string, ctx: ToolContext, init?: RequestInit): Promise<Response> {
  // Some PI callback paths create a reduced ToolContext. Keep local API calls
  // authenticated by falling back to the active runtime's host-owned token.
  const token = _localApiToken || ctx.desktopApiToken || getCurrentRuntime()?.config?.desktopApiToken
  const signal = combineSignals(ctx.signal, init?.signal)
  const requestInit = signal ? { ...init, signal } : init
  if (!token) return fetch(url, requestInit)
  return fetch(url, {
    ...requestInit,
    headers: withDesktopApiToken(requestInit?.headers, token),
  })
}

function combineSignals(hostSignal?: AbortSignal, requestSignal?: AbortSignal | null): AbortSignal | undefined {
  if (!hostSignal) return requestSignal ?? undefined
  if (!requestSignal || requestSignal === hostSignal) return hostSignal
  return AbortSignal.any([hostSignal, requestSignal])
}

function withDesktopApiToken(headers: HeadersInit | undefined, token: string): HeadersInit {
  if (!headers) return { [DESKTOP_TOKEN_HEADER]: token, [INTERNAL_TOOL_HEADER]: "1" }
  if (Array.isArray(headers)) return [...headers, [DESKTOP_TOKEN_HEADER, token], [INTERNAL_TOOL_HEADER, "1"]]
  if (typeof Headers !== "undefined" && headers instanceof Headers) {
    const next = new Headers(headers)
    next.set(DESKTOP_TOKEN_HEADER, token)
    next.set(INTERNAL_TOOL_HEADER, "1")
    return next
  }
  return {
    ...(headers as Record<string, string>),
    [DESKTOP_TOKEN_HEADER]: token,
    [INTERNAL_TOOL_HEADER]: "1",
  }
}
