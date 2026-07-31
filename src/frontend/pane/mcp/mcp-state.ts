export type McpConnectionState = "connected" | "connecting" | "disconnected" | "error";

const MCP_STATE_LABELS: Record<McpConnectionState, string> = {
  connected: "已连接",
  connecting: "连接中",
  disconnected: "已断开",
  error: "错误",
};

export function normalizeMcpState(value: unknown): McpConnectionState {
  switch (value) {
    case "connected":
    case "connecting":
    case "disconnected":
    case "error":
      return value;
    default:
      return "error";
  }
}

export function mcpStateLabel(value: unknown): string {
  return MCP_STATE_LABELS[normalizeMcpState(value)];
}

if (typeof window !== "undefined") {
  const app = ((window as any).App ||= {});
  app.McpState = {
    normalize: normalizeMcpState,
    label: mcpStateLabel,
  };
}
