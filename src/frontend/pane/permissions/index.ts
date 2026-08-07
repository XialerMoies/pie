/// <reference path="../../dashboard.d.ts" />

type PermissionDecision = "allow" | "ask" | "deny";
type PermissionOperation = "read" | "write" | "create" | "remove" | "tool";
type PermissionRuleList = "allow" | "deny" | "ask";
type PermissionRuleScope = "session" | "workspace";
type PermissionMode = "plan" | "standard" | "dontAsk" | "yes";

interface PermissionAuditEntry {
  id: number;
  timestamp: string;
  source: string;
  operation: PermissionOperation;
  root: string;
  path?: string;
  relativePath?: string;
  decision: PermissionDecision;
  reason?: string;
  code?: string;
  toolName?: string;
  toolOperations?: string[];
  riskLevel?: string;
  workspaceBounded?: boolean;
  permissionRequired?: boolean;
}

interface PermissionRuleView {
  toolName: string;
  ruleContent: string;
  match?: "exact" | "prefix" | "wildcard";
  scope: PermissionRuleScope;
  index: number;
}

interface PermissionRulesSnapshot {
  additionalWorkingDirectories: Array<{ path: string; source: string }>;
  alwaysAllowRules: PermissionRuleView[];
  alwaysDenyRules: PermissionRuleView[];
  alwaysAskRules: PermissionRuleView[];
}

const PERMISSION_PANEL_ID = "permissions-panel-root";
let _permissionsTab: "audit" | "rules" = "audit";
let _permissionsAudit: PermissionAuditEntry[] = [];
let _permissionsRules: PermissionRulesSnapshot | null = null;
let _permissionMode: PermissionMode = "standard";
let mountedContainer: HTMLElement | null = null;
let mountedRoot: HTMLElement | null = null;
let mountedGeneration = 0;
let refreshGeneration = 0;
let modeMutationGeneration = 0;
let modeMutationQueue: Array<{
  mode: PermissionMode;
  generation: number;
  mountedGeneration: number;
  root: HTMLElement | null;
  allowUnmounted: boolean;
}> = [];
let modeMutationProcessing = false;
let modeMutationQueueEpoch = 0;
let activeRiskOverlay: HTMLElement | null = null;
let resolveRiskConfirmation: ((allowed: boolean) => void) | null = null;

function mountPermissionsPanel(container: HTMLElement): void {
  dismissRiskOverlay();
  if (mountedContainer === container && mountedRoot?.parentElement === container && mountedRoot.isConnected) return;

  invalidateModeMutationQueue();
  mountedRoot?.remove();
  mountedGeneration += 1;
  const root = document.createElement("div");
  root.id = PERMISSION_PANEL_ID;
  root.innerHTML = renderPermissionsPanel();
  container.replaceChildren(root);
  mountedContainer = container;
  mountedRoot = root;
  bindPermissionsPanel(root);
  void refreshPermissionsPanel();
}

function unmountPermissionsPanel(): void {
  dismissRiskOverlay();
  invalidateModeMutationQueue();
  mountedRoot?.remove();
  mountedContainer = null;
  mountedRoot = null;
  mountedGeneration += 1;
  refreshGeneration += 1;
}

function renderPermissionsPanel(): string {
  return `
    <div class="perm-panel">
      <div class="perm-head">
        <div class="perm-title">${S("ishield", 16)}<span>权限</span></div>
        <select class="perm-mode-select" id="perm-mode" title="权限模式">
          ${permissionModeOptions()}
        </select>
        <span class="perm-yes-badge${_permissionMode === "yes" ? " on" : ""}" id="perm-yes-badge">${_permissionMode === "yes" ? "YES" : ""}</span>
        <button class="perm-icon-btn" id="perm-refresh" title="刷新" type="button">${S("irefresh", 14)}</button>
      </div>
      <div class="perm-tabs" role="tablist">
        <button class="perm-tab${_permissionsTab === "audit" ? " active" : ""}" data-perm-tab="audit" type="button">最近确认</button>
        <button class="perm-tab${_permissionsTab === "rules" ? " active" : ""}" data-perm-tab="rules" type="button">规则</button>
      </div>
      <div class="perm-content" id="permissions-content">${renderPermissionsContent()}</div>
    </div>
  `;
}

function renderPermissionsContent(): string {
  if (_permissionsTab === "rules") return renderPermissionRules();
  return renderPermissionAudit();
}

function bindPermissionsPanel(container: HTMLElement): void {
  container.querySelector<HTMLSelectElement>("#perm-mode")?.addEventListener("change", (event) => {
    const mode = (event.target as HTMLSelectElement).value as PermissionMode;
    void requestPermissionMode(mode);
  });
  container.querySelector("#perm-refresh")?.addEventListener("click", () => {
    void refreshPermissionsPanel(true);
  });
  container.querySelectorAll("[data-perm-tab]").forEach((button) => {
    button.addEventListener("click", () => {
      _permissionsTab = (button as HTMLElement).dataset.permTab === "rules" ? "rules" : "audit";
      syncPermissionsPanel();
      void refreshPermissionsPanel();
    });
  });
}

async function refreshPermissionsPanel(forceToast = false): Promise<void> {
  const requestGeneration = ++refreshGeneration;
  const requestMountedGeneration = mountedGeneration;
  const requestRoot = mountedRoot;
  const requestModeMutationGeneration = modeMutationGeneration;
  const requestModeMutationPending = modeMutationProcessing;
  try {
    const [auditRes, rulesRes] = await Promise.all([
      fetch("/api/permissions/audit?limit=50"),
      fetch("/api/permissions/rules"),
    ]);
    if (!auditRes.ok) throw new Error(`audit HTTP ${auditRes.status}`);
    if (!rulesRes.ok) throw new Error(`rules HTTP ${rulesRes.status}`);
    const auditBody = await auditRes.json();
    const rulesBody = await rulesRes.json();
    let nextPermissionMode = _permissionMode;
    try {
      const modeRes = await fetch("/api/permissions/mode");
      if (modeRes.ok) {
        const modeBody = await modeRes.json();
        if (isPermissionMode(modeBody.mode)) nextPermissionMode = modeBody.mode;
      }
    } catch {
      // Mode is informational; audit and rules can still refresh independently.
    }
    if (!isCurrentPermissionsRefresh(requestGeneration, requestMountedGeneration, requestRoot)) return;
    _permissionsAudit = Array.isArray(auditBody.audit) ? auditBody.audit : [];
    _permissionsRules = rulesBody;
    if (!requestModeMutationPending && requestModeMutationGeneration === modeMutationGeneration) {
      _permissionMode = nextPermissionMode;
    }
    updatePermissionModeBadge();
    syncPermissionsPanel();
    if (forceToast) toast("权限信息已刷新", "success");
  } catch (err) {
    if (!isCurrentPermissionsRefresh(requestGeneration, requestMountedGeneration, requestRoot)) return;
    const content = mountedRoot?.querySelector<HTMLElement>("#permissions-content");
    if (content) {
      content.innerHTML = `<div class="perm-empty perm-error">加载失败: ${E((err as Error).message)}</div>`;
    }
  }
}

function isCurrentPermissionsRefresh(requestGeneration: number, requestMountedGeneration: number, requestRoot: HTMLElement | null): boolean {
  return requestGeneration === refreshGeneration
    && requestMountedGeneration === mountedGeneration
    && requestRoot === mountedRoot
    && Boolean(requestRoot && requestRoot.parentElement === mountedContainer && requestRoot.isConnected);
}

function isPermissionMode(value: unknown): value is PermissionMode {
  return value === "plan" || value === "standard" || value === "dontAsk" || value === "yes";
}

async function refreshPermissionMode(): Promise<PermissionMode> {
  const requestModeMutationGeneration = modeMutationGeneration;
  try {
    const response = await fetch("/api/permissions/mode");
    if (response.ok) {
      const body = await response.json();
      if (isPermissionMode(body.mode)) {
        // 请求期间用户发起过 setMode：丢弃迟到的服务端快照，避免覆盖刚应用的模式
        if (modeMutationGeneration !== requestModeMutationGeneration) return _permissionMode;
        _permissionMode = body.mode;
        updatePermissionModeBadge();
      }
    }
  } catch {
    // Keep the last known mode when the server is temporarily unavailable.
  }
  return _permissionMode;
}

function permissionModeOptions(): string {
  return ([
    ["plan", "计划模式"],
    ["standard", "标准模式"],
    ["dontAsk", "不询问模式"],
    ["yes", "Yes 模式"],
  ] as const).map(([value, label]) => `<option value="${value}"${_permissionMode === value ? " selected" : ""}>${label}</option>`).join("");
}

function requestPermissionMode(mode: PermissionMode, allowUnmounted = false): void {
  const requestModeMutationGeneration = ++modeMutationGeneration;
  const requestMountedGeneration = mountedGeneration;
  const requestRoot = mountedRoot;
  if (mode !== "yes") dismissRiskOverlay();
  modeMutationQueue.push({
    mode,
    generation: requestModeMutationGeneration,
    mountedGeneration: requestMountedGeneration,
    root: requestRoot,
    allowUnmounted,
  });
  if (!modeMutationProcessing) {
    modeMutationProcessing = true;
    void drainModeMutations();
  }
}

function invalidateModeMutationQueue(): void {
  modeMutationQueue = [];
  modeMutationQueueEpoch += 1;
  modeMutationProcessing = false;
}

async function drainModeMutations(): Promise<void> {
  const queueEpoch = modeMutationQueueEpoch;
  try {
    while (queueEpoch === modeMutationQueueEpoch && modeMutationQueue.length > 0) {
      const mutation = modeMutationQueue.shift()!;
      await performPermissionMode(mutation.mode, mutation.generation, mutation.mountedGeneration, mutation.root, mutation.allowUnmounted);
    }
  } finally {
    if (queueEpoch === modeMutationQueueEpoch) modeMutationProcessing = false;
  }
}

async function performPermissionMode(
  mode: PermissionMode,
  requestModeMutationGeneration: number,
  requestMountedGeneration: number,
  requestRoot: HTMLElement | null,
  allowUnmounted: boolean,
): Promise<void> {
  if (!isCurrentModeMutation(requestModeMutationGeneration, requestMountedGeneration, requestRoot, allowUnmounted)) return;
  if (mode === "yes" && !(await confirmYesMode())) {
    if (!isCurrentModeMutation(requestModeMutationGeneration, requestMountedGeneration, requestRoot, allowUnmounted)) return;
    resetPermissionModeControls();
    syncPermissionsPanel();
    return;
  }
  if (!isCurrentModeMutation(requestModeMutationGeneration, requestMountedGeneration, requestRoot, allowUnmounted)) return;
  try {
    const response = await fetch("/api/permissions/mode", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode, ...(mode === "yes" ? { acknowledgeRisk: true } : {}) }),
    });
    const body = await response.json();
    if (!response.ok || !body.ok) throw new Error(body.error || `HTTP ${response.status}`);
    if (!isCurrentModeMutation(requestModeMutationGeneration, requestMountedGeneration, requestRoot, allowUnmounted)) return;
    _permissionMode = mode;
    updatePermissionModeBadge();
    syncPermissionsPanel();
    toast(`已切换为${mode === "yes" ? " Yes" : ""}权限模式`, "success");
  } catch (error) {
    if (!isCurrentModeMutation(requestModeMutationGeneration, requestMountedGeneration, requestRoot, allowUnmounted)) return;
    resetPermissionModeControls();
    syncPermissionsPanel();
    toast(`权限模式切换失败: ${(error as Error).message}`, "error");
  }
}

function isCurrentMountedRoot(requestMountedGeneration: number, requestRoot: HTMLElement | null): boolean {
  return requestMountedGeneration === mountedGeneration
    && requestRoot === mountedRoot
    && Boolean(requestRoot && requestRoot.parentElement === mountedContainer && requestRoot.isConnected);
}

function isCurrentModeMutation(
  requestModeMutationGeneration: number,
  requestMountedGeneration: number,
  requestRoot: HTMLElement | null,
  allowUnmounted: boolean,
): boolean {
  return requestModeMutationGeneration === modeMutationGeneration
    && (allowUnmounted || isCurrentMountedRoot(requestMountedGeneration, requestRoot));
}

function updatePermissionModeBadge(): void {
  const isYes = _permissionMode === "yes";
  const badges = [
    document.getElementById("permission-mode-badge"),
    mountedRoot?.querySelector<HTMLElement>("#perm-yes-badge"),
  ];
  badges.forEach((badge) => {
    if (!badge) return;
    badge.textContent = isYes ? "YES" : "";
    badge.classList.toggle("on", isYes);
  });
  const select = mountedRoot?.querySelector<HTMLSelectElement>("#perm-mode");
  if (select) select.value = _permissionMode;
  (window as any).App?.Chat?.refreshModeButton?.();
}

function resetPermissionModeControls(): void {
  updatePermissionModeBadge();
}

function confirmYesMode(): Promise<boolean> {
  dismissRiskOverlay();
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "modal-overlay permission-risk-overlay";
    overlay.innerHTML = `
      <div class="permission-risk-dialog" role="dialog" aria-modal="true" aria-labelledby="permission-risk-title">
        <div class="permission-risk-title" id="permission-risk-title">开启 Yes 模式（危险）</div>
        <div class="permission-risk-copy">Yes 模式会放行路径和普通命令授权。危险命令仍会被安全层拦截。</div>
        <label class="permission-risk-check"><input id="permission-risk-ack" type="checkbox"> 我理解不可逆风险</label>
        <div class="permission-risk-actions"><button type="button" data-risk-choice="cancel">取消</button><button type="button" class="danger" data-risk-choice="confirm" disabled>我已知晓并开启</button></div>
      </div>`;
    activeRiskOverlay = overlay;
    resolveRiskConfirmation = resolve;
    document.body.appendChild(overlay);
    const confirm = overlay.querySelector<HTMLButtonElement>('[data-risk-choice="confirm"]');
    overlay.querySelector<HTMLInputElement>("#permission-risk-ack")?.addEventListener("change", (event) => {
      if (confirm) confirm.disabled = !(event.target as HTMLInputElement).checked;
    });
    overlay.querySelectorAll<HTMLButtonElement>("[data-risk-choice]").forEach((button) => button.addEventListener("click", () => {
      if (activeRiskOverlay !== overlay) return;
      const allowed = button.dataset.riskChoice === "confirm" && confirm?.disabled === false;
      activeRiskOverlay = null;
      resolveRiskConfirmation = null;
      overlay.remove();
      resolve(allowed);
    }));
  });
}

function dismissRiskOverlay(): void {
  const overlay = activeRiskOverlay;
  const resolve = resolveRiskConfirmation;
  activeRiskOverlay = null;
  resolveRiskConfirmation = null;
  overlay?.remove();
  resolve?.(false);
}

function syncPermissionsPanel(): void {
  const root = mountedRoot;
  const content = root?.querySelector<HTMLElement>("#permissions-content");
  if (!root || !content) return;
  root.querySelectorAll("[data-perm-tab]").forEach((button) => {
    button.classList.toggle("active", (button as HTMLElement).dataset.permTab === _permissionsTab);
  });
  content.innerHTML = renderPermissionsContent();
  bindPermissionsContent(content);
}

function renderPermissionAudit(): string {
  const recent = _permissionsAudit.filter(isRecentPermissionDecision);
  if (recent.length === 0) return `<div class="perm-empty">暂无确认记录</div>`;
  return `
    <div class="perm-audit-list">
      ${recent.slice().reverse().map(renderAuditEntry).join("")}
    </div>
  `;
}

function isRecentPermissionDecision(entry: PermissionAuditEntry): boolean {
  return entry.decision === "deny"
    || (entry.decision === "allow" && entry.reason?.startsWith("Confirmed by user") === true);
}

function renderAuditEntry(entry: PermissionAuditEntry): string {
  const pathLabel = entry.relativePath || entry.path || entry.root || "";
  return `
    <div class="perm-audit-row perm-audit-row--${entry.decision}">
      <div class="perm-audit-top">
        <span class="perm-decision">${E(entry.decision)}</span>
        <span class="perm-source">${E(entry.source)}</span>
        <span class="perm-op">${E(formatPermissionOperation(entry.operation))}</span>
        ${entry.toolName ? `<span class="perm-tool">${E(entry.toolName)}</span>` : ""}
      </div>
      <div class="perm-path" title="${E(entry.path || pathLabel)}">${E(pathLabel)}</div>
      ${entry.reason || entry.code ? `<div class="perm-reason">${E(entry.reason || entry.code || "")}</div>` : ""}
      ${entry.riskLevel ? `<div class="perm-reason">Risk: ${E(entry.riskLevel)}</div>` : ""}
      ${renderAuditToolDetails(entry)}
      <div class="perm-time">${E(formatPermissionTime(entry.timestamp))}</div>
    </div>
  `;
}

function renderAuditToolDetails(entry: PermissionAuditEntry): string {
  if (entry.operation !== "tool") return "";
  const details = [
    Array.isArray(entry.toolOperations) && entry.toolOperations.length
      ? `Ops: ${entry.toolOperations.join(", ")}`
      : "",
    typeof entry.permissionRequired === "boolean"
      ? `Prompt: ${entry.permissionRequired ? "required" : "tracked"}`
      : "",
    typeof entry.workspaceBounded === "boolean"
      ? `Scope: ${entry.workspaceBounded ? "workspace" : "external"}`
      : "",
  ].filter(Boolean);
  return details.length ? `<div class="perm-reason">${E(details.join(" · "))}</div>` : "";
}

function formatPermissionOperation(operation: PermissionOperation): string {
  if (operation === "tool") return "Tool";
  if (operation === "read") return "Read";
  if (operation === "write") return "Write";
  if (operation === "create") return "Create";
  if (operation === "remove") return "Remove";
  return operation;
}

function renderPermissionRules(): string {
  const rules = _permissionsRules;
  if (!rules) return `<div class="perm-empty">加载中...</div>`;
  return `
    ${renderRuleSection("allow", "Allow", rules.alwaysAllowRules)}
    ${renderRuleSection("deny", "Deny", rules.alwaysDenyRules)}
    ${renderRuleSection("ask", "Ask", rules.alwaysAskRules)}
    ${renderWorkingDirectories(rules.additionalWorkingDirectories)}
  `;
}

function permissionScopeLabel(scope: PermissionRuleScope): string {
  return scope === "workspace" ? "项目" : "会话";
}

function renderRuleSection(list: PermissionRuleList, label: string, rules: PermissionRuleView[]): string {
  const body = rules.length
    ? rules.map((rule, index) => `
        <div class="perm-rule-row">
          <div class="perm-rule-meta">
            <span class="perm-rule-tool">${E(rule.toolName)}</span>
            <span class="perm-rule-match">${E(rule.match || "prefix")}</span>
            <span class="perm-rule-match">${permissionScopeLabel(rule.scope || "session")}</span>
          </div>
          <div class="perm-rule-content" title="${E(rule.ruleContent)}">${E(rule.ruleContent)}</div>
          <button class="perm-icon-btn danger" data-rule-remove="${list}:${rule.scope || "session"}:${Number.isInteger(rule.index) ? rule.index : index}" title="撤销" type="button">${S("itrash", 13)}</button>
        </div>
      `).join("")
    : `<div class="perm-empty small">无 ${label} 规则</div>`;
  return `<section class="perm-rule-section"><div class="perm-section-title">${label}</div>${body}</section>`;
}

function renderWorkingDirectories(items: Array<{ path: string; source: string }>): string {
  if (!items.length) return "";
  return `
    <section class="perm-rule-section">
      <div class="perm-section-title">Working Directories</div>
      ${items.map((item) => `
        <div class="perm-workdir-row">
          <span class="perm-rule-match">${E(item.source)}</span>
          <span class="perm-rule-content" title="${E(item.path)}">${E(item.path)}</span>
        </div>
      `).join("")}
    </section>
  `;
}

function bindPermissionsContent(container: HTMLElement): void {
  container.querySelectorAll("[data-rule-remove]").forEach((button) => {
    button.addEventListener("click", async () => {
      const raw = (button as HTMLElement).dataset.ruleRemove || "";
      const [list, scope, indexText] = raw.split(":");
      await removePermissionRule(list as PermissionRuleList, scope as PermissionRuleScope, Number(indexText));
    });
  });
}

async function removePermissionRule(list: PermissionRuleList, scope: PermissionRuleScope, index: number): Promise<void> {
  const requestMountedGeneration = mountedGeneration;
  const requestRoot = mountedRoot;
  try {
    const res = await fetch(`/api/permissions/rules?list=${encodeURIComponent(list)}&scope=${encodeURIComponent(scope)}&index=${index}`, { method: "DELETE" });
    const body = await res.json();
    if (!res.ok || !body.ok) throw new Error(body.error || `HTTP ${res.status}`);
    if (!isCurrentMountedRoot(requestMountedGeneration, requestRoot)) return;
    _permissionsRules = body.rules;
    syncPermissionsPanel();
    toast(`${permissionScopeLabel(scope)}权限规则已撤销`, "success");
  } catch (err) {
    if (!isCurrentMountedRoot(requestMountedGeneration, requestRoot)) return;
    toast(`撤销失败: ${(err as Error).message}`, "error");
  }
}

function formatPermissionTime(value: string): string {
  const time = new Date(value);
  if (Number.isNaN(time.getTime())) return "";
  return time.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

const permissionsApp = (window as any).App || ((window as any).App = {});
permissionsApp.Permissions = {
  ...(permissionsApp.Permissions || {}),
  mount: mountPermissionsPanel,
  refresh: refreshPermissionsPanel,
  unmount: unmountPermissionsPanel,
  getMode: () => _permissionMode,
  setMode: (mode: PermissionMode) => requestPermissionMode(mode, true),
  refreshMode: refreshPermissionMode,
};
(window as any).refreshPermissionsPanel = refreshPermissionsPanel;
