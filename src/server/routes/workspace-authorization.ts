import type { ServerContext } from "./types.js";
import { guardPathWithinRoot, PathGuardError } from "./path-guard.js";
import { normalizePermissionPath } from "../../agent/permissions.js";

export interface WorkspaceAuthorizationOptions {
  required?: boolean;
}

export interface WorkspaceSwitchResult {
  workspace: string;
  previousWorkspace: string;
  switched: boolean;
}

export function runWithWorkspaceOwnership<T>(
  ctx: ServerContext,
  workspace: string,
  operation: () => T | Promise<T>,
): Promise<T> {
  if (ctx.workspaceLock) return ctx.workspaceLock.switchTo(workspace, operation);
  return Promise.resolve().then(operation);
}

interface WorkspaceSwitchState {
  tail: Promise<void>;
  activeByTarget: Map<string, Promise<WorkspaceSwitchResult>>;
}

const workspaceSwitchStates = new WeakMap<object, WorkspaceSwitchState>();

function publishWorkspaceChanged(ctx: ServerContext): void {
  try { ctx.appEvents.publish("dashboard.changed"); } catch {}
  try { ctx.appEvents.publish("usage.changed"); } catch {}
}

function workspacePathKey(workspace: string): string {
  return normalizePermissionPath(workspace);
}

function sameWorkspace(left: string | undefined, right: string): boolean {
  return !!left && workspacePathKey(left) === workspacePathKey(right);
}

function switchStateFor(ctx: ServerContext): WorkspaceSwitchState {
  const runtime = ctx.runtime as object;
  let state = workspaceSwitchStates.get(runtime);
  if (!state) {
    state = { tail: Promise.resolve(), activeByTarget: new Map() };
    workspaceSwitchStates.set(runtime, state);
  }
  return state;
}

export async function authorizeWorkspacePath(
  ctx: ServerContext,
  workspace: unknown,
  source: string,
  options: WorkspaceAuthorizationOptions = {},
): Promise<string> {
  const requestedWorkspace = typeof workspace === "string" ? workspace.trim() : "";
  if (!requestedWorkspace) {
    if (options.required) {
      throw new PathGuardError("Missing workspace", 400, "missing_workspace");
    }
    return "";
  }

  if (ctx.permissionService) {
    return ctx.permissionService.authorizeWorkspaceRoot(requestedWorkspace, source);
  }

  const currentWorkspace = ctx.runtime.currentWorkspace || ctx.paths.APP_ROOT;
  return guardPathWithinRoot(currentWorkspace, requestedWorkspace, "read").path;
}

export function switchAuthorizedWorkspace(
  ctx: ServerContext,
  workspace: unknown,
  source = "workspace.switch",
): Promise<WorkspaceSwitchResult> {
  const requestedWorkspace = typeof workspace === "string" ? workspace.trim() : "";
  if (!requestedWorkspace) {
    return Promise.reject(new PathGuardError("Missing workspace", 400, "missing_workspace"));
  }

  const state = switchStateFor(ctx);
  const targetKey = workspacePathKey(requestedWorkspace);
  const active = state.activeByTarget.get(targetKey);
  if (active) return active;

  const task = state.tail.catch(() => undefined).then(async () => {
    const currentWorkspace = ctx.runtime.currentWorkspace || ctx.paths.APP_ROOT;
    if (sameWorkspace(currentWorkspace, requestedWorkspace)) {
      return { workspace: currentWorkspace, previousWorkspace: currentWorkspace, switched: false };
    }

    const authorizedWorkspace = await authorizeWorkspacePath(ctx, requestedWorkspace, source, { required: true });
    const latestWorkspace = ctx.runtime.currentWorkspace || ctx.paths.APP_ROOT;
    if (sameWorkspace(latestWorkspace, authorizedWorkspace)) {
      return { workspace: latestWorkspace, previousWorkspace: latestWorkspace, switched: false };
    }

    await runWithWorkspaceOwnership(
      ctx,
      authorizedWorkspace,
      () => ctx.runtime.switchWorkspace(authorizedWorkspace),
    );
    publishWorkspaceChanged(ctx);
    console.log(`📂 Switched workspace: "${latestWorkspace}" → "${authorizedWorkspace}"`);
    return { workspace: authorizedWorkspace, previousWorkspace: latestWorkspace, switched: true };
  });

  state.activeByTarget.set(targetKey, task);
  state.tail = task.then(() => undefined, () => undefined);
  void task.finally(() => {
    if (state.activeByTarget.get(targetKey) === task) state.activeByTarget.delete(targetKey);
  }).catch(() => undefined);
  return task;
}
