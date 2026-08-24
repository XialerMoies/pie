import { readdirSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const TEST_ROOT = join(ROOT, "test");

// These are the only suite-specific ownership lists. Every discovered test
// file is classified below, so a new file cannot silently fall out of npm test.
export const ROUTE_FILES = [
  "routes.test.mjs",
  "path-guard.test.mjs",
  "server-security.test.mjs",
  "desktop-ipc.test.mjs",
  "multi-instance-security.test.mjs",
  "server-permission-service.test.mjs",
  "root-registry.test.mjs",
  "sessions.test.mjs",
  "workspace-session.test.mjs",
  "workspace-authorization.test.mjs",
  "server-startup-paths.test.mjs",
  "server-process-readiness.test.mjs",
  "session-data-layout.test.mjs",
  "typescript-route.test.mjs",
  "chat-sse.test.mjs",
  "chat-stream-replay.test.mjs",
  "chat-event-flow-contract.test.mjs",
  "deterministic-event-script-flow.test.mjs",
  "agent-fault-matrix-flow.test.mjs",
  "agent-terminal-guard-flow.test.mjs",
  "agent-event-persistence-flow.test.mjs",
  "agent-runtime-tool-boundary-flow.test.mjs",
  "agent-session-replay-first-flow.test.mjs",
  "agent-behavior-baseline-flow.test.mjs",
  "reliability-release-flow.test.mjs",
  "event-session-invariants-flow.test.mjs",
  "failure-artifact-flow.test.mjs",
  "attachments.test.mjs",
  "tool-trace.test.mjs",
  "tool-outcome-live-flow.test.mjs",
  "agent-fault-matrix.test.mjs",
  "execution-contract-flow.test.mjs",
  "agent-profile-flow.test.mjs",
];

export const SERIAL_ROUTE_FILES = ["multi-instance-e2e.mjs", "multi-instance-launch.test.mjs", "workspace-lock.test.mjs"];

export const FRONTEND_FILES = [
  "frontend-xss-sinks.test.mjs",
  "render-snapshot.test.mjs",
  "chat-sse-controller-flow.test.mjs",
  "chat-ui-state.test.mjs",
  "subagent-frontend-reducer.test.mjs",
  "chat-timeline.test.mjs",
  "chat-attachments-ui.test.mjs",
  "chat-mode.test.mjs",
  "mcp-state.test.mjs",
  "settings-ui.test.mjs",
  "session-restore.test.mjs",
  "session-activation.test.mjs",
  "session-ui.test.mjs",
  "workspace-ui.test.mjs",
  "app-tabs.test.mjs",
  "file-restore.test.mjs",
  "file-tab-render.test.mjs",
  "problems-bottom-bar.test.mjs",
  "search-pane.test.mjs",
  "git-pane.test.mjs",
  "dashboard-actions.test.mjs",
  "frontend-event-ownership.test.mjs",
  "frontend-auth-recovery.test.mjs",
  "app-events-frontend.test.mjs",
  "explorer-pane.test.mjs",
  "permissions-pane.test.mjs",
  "desktop-auth-bootstrap.test.mjs",
  "observer-owner.test.mjs",
  "frontend-component-tree.test.mjs",
  "chat-stream.test.mjs",
  "provider-settings-ui.test.mjs",
];

export const BUILD_FILES = ["dist-chat-event-flow.test.mjs", "dist-agent-event-flow.test.mjs"];
export const LIVE_FILES = ["provider-live-matrix.test.mjs"];
export const SERIAL_UNIT_FILES = ["custom-provider-multi-server.test.mjs", "custom-provider-store.test.mjs", "file-lock.test.mjs"];

function allTestFiles() {
  return readdirSync(TEST_ROOT, { withFileTypes: true })
    .filter((entry) => entry.isFile() && (entry.name.endsWith(".test.mjs") || SERIAL_ROUTE_FILES.includes(entry.name)))
    .map((entry) => entry.name)
    .sort();
}

function flowTag(name) {
  return /(?:flow|contract|replay|restore|recovery|concurrent|e2e|binding|session|route|permission|outcome|lifecycle)/iu.test(name);
}

function layerFor(name, suite) {
  if (suite === "frontend") return "integration";
  if (suite === "routes") return "integration";
  if (/^(?:dist-|electron-|packaged-electron-)/u.test(name)) return "system";
  if (flowTag(name)) return "integration";
  return "unit";
}

export function buildTestManifest() {
  const all = allTestFiles();
  const routeSet = new Set(ROUTE_FILES);
  const serialRouteSet = new Set(SERIAL_ROUTE_FILES);
  const frontendSet = new Set(FRONTEND_FILES);
  const buildSet = new Set(BUILD_FILES);
  const liveSet = new Set(LIVE_FILES);
  const entries = all.map((name) => {
    const suite = buildSet.has(name)
      ? "build"
      : liveSet.has(name)
        ? "live"
        : routeSet.has(name) || serialRouteSet.has(name)
          ? "routes"
          : frontendSet.has(name)
            ? "frontend"
            : "unit";
    return {
      file: `test/${name}`,
      name,
      suite,
      layer: layerFor(name, suite),
      flow: flowTag(name),
      default: suite !== "build" && suite !== "live",
    };
  });
  const known = new Set([...ROUTE_FILES, ...FRONTEND_FILES, ...BUILD_FILES, ...LIVE_FILES]);
  const unknownLists = [...known].filter((name) => !all.includes(name));
  if (unknownLists.length > 0) throw new Error(`test manifest references missing files: ${unknownLists.join(", ")}`);
  return {
    version: 1,
    generatedAt: new Date().toISOString(),
    entries,
    suites: {
      unit: entries.filter((entry) => entry.suite === "unit" && !SERIAL_UNIT_FILES.includes(entry.name)).map((entry) => entry.file),
      unitSerial: SERIAL_UNIT_FILES.map((name) => `test/${name}`),
      routes: ROUTE_FILES.map((name) => `test/${name}`),
      routesSerial: SERIAL_ROUTE_FILES.map((name) => `test/${name}`),
      frontend: entries.filter((entry) => entry.suite === "frontend").map((entry) => entry.file),
      build: entries.filter((entry) => entry.suite === "build").map((entry) => entry.file),
      live: entries.filter((entry) => entry.suite === "live").map((entry) => entry.file),
    },
  };
}

export function validateTestManifest(manifest = buildTestManifest()) {
  const errors = [];
  const seen = new Set();
  for (const entry of manifest.entries) {
    if (seen.has(entry.file)) errors.push(`duplicate entry: ${entry.file}`);
    seen.add(entry.file);
    if (!["unit", "integration", "system"].includes(entry.layer)) errors.push(`invalid layer: ${entry.file}`);
    if (typeof entry.flow !== "boolean") errors.push(`missing flow tag: ${entry.file}`);
    if (entry.suite === "unit" && !entry.default && !SERIAL_UNIT_FILES.includes(entry.name)) errors.push(`unit entry is not default: ${entry.file}`);
  }
  const defaultFiles = manifest.entries.filter((entry) => entry.default).map((entry) => entry.file);
  if (new Set(defaultFiles).size !== defaultFiles.length) errors.push("duplicate default test entry");
  const expectedDefault = manifest.entries.filter((entry) => entry.default).length;
  if (defaultFiles.length !== expectedDefault) errors.push("default suite count mismatch");
  return errors;
}

if (process.argv.includes("--check")) {
  const manifest = buildTestManifest();
  const errors = validateTestManifest(manifest);
  if (errors.length) {
    console.error(errors.join("\n"));
    process.exitCode = 1;
  } else {
    const counts = Object.fromEntries(Object.entries(manifest.suites).map(([key, files]) => [key, files.length]));
    const layers = Object.fromEntries(["unit", "integration", "system"].map((layer) => [layer, manifest.entries.filter((entry) => entry.layer === layer).length]));
    console.log(`[test-manifest] ${manifest.entries.length} test files classified; default=${manifest.entries.filter((entry) => entry.default).length}; layers=${JSON.stringify(layers)}; suites=${JSON.stringify(counts)}`);
  }
}

if (process.argv.includes("--json")) {
  console.log(JSON.stringify(buildTestManifest(), null, 2));
}
