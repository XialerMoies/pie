/** Real-entry fault scenarios consumed by the cross-layer fault flow test. */
export const AGENT_FAULT_MATRIX_SCRIPT = [
  { id: "http-404", category: "not_found", transport: "http", status: 404, path: "missing.txt" },
  { id: "http-403", category: "permission_denied", transport: "http", status: 403, path: "forbidden.txt" },
  { id: "transport", category: "transport_error", transport: "socket", path: "transport.txt" },
  { id: "cancelled", category: "cancelled", transport: "pending", path: "pending.txt" },
  { id: "invalid-path", category: "validation_error", transport: "none", path: "" },
  { id: "command-timeout", category: "transport_error", transport: "command", command: 'node -e "setTimeout(() => {}, 500)"' },
  { id: "permission-approved", category: "success", transport: "command", command: "node --version" },
];

