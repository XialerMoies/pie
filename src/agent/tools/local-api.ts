import type { ToolContext } from "../types.js"

const DESKTOP_TOKEN_HEADER = "X-My-Code-Agent-Token"

export function getLocalApiBaseUrl(): string {
  const port = process.env.SERVER_PORT || process.env.PI_DEV_PORT || "3099"
  return `http://127.0.0.1:${port}`
}

export function localApiFetch(url: string, ctx: ToolContext, init?: RequestInit): Promise<Response> {
  const token = ctx.desktopApiToken
  if (!token) return fetch(url, init)
  return fetch(url, {
    ...init,
    headers: withDesktopApiToken(init?.headers, token),
  })
}

function withDesktopApiToken(headers: HeadersInit | undefined, token: string): HeadersInit {
  if (!headers) return { [DESKTOP_TOKEN_HEADER]: token }
  if (Array.isArray(headers)) return [...headers, [DESKTOP_TOKEN_HEADER, token]]
  if (typeof Headers !== "undefined" && headers instanceof Headers) {
    const next = new Headers(headers)
    next.set(DESKTOP_TOKEN_HEADER, token)
    return next
  }
  return {
    ...(headers as Record<string, string>),
    [DESKTOP_TOKEN_HEADER]: token,
  }
}
