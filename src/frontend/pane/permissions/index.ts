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

function permissionsPaneRender(container: HTMLElement): void {
  container.innerHTML = `<div id="${PERMISSION_PANEL_ID}">${renderPermissionsPanel()}</div>`;
  bindPermissionsPanel(container);
  void refreshPermissionsPanel();
}

function renderPermissionsPanel(): string {
  return `
    <div class="perm-panel">
      <div class="perm-head">
        <div class="perm-title">${S("ishield", 16)}<span>权限</span></div>
        <select class="perm-mode-select" id="perm-mode" title="权限模式">
          ${permissionModeOptions()}
        </select>
        <span class="perm-yes-badge${_permissionMode === "yes" ? " on" : ""}" id="perm-yes-badge">YES</span>
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
  try {
    const [auditRes, rulesRes] = await Promise.all([
      fetch("/api/permissions/audit?limit=50"),
      fetch("/api/permissions/rules"),
    ]);
    if (!auditRes.ok) throw new Error(`audit HTTP ${auditRes.status}`);
    if (!rulesRes.ok) throw new Error(`rules HTTP ${rulesRes.status}`);
    const auditBody = await auditRes.json();
    _permissionsAudit = Array.isArray(auditBody.audit) ? auditBody.audit : [];
    _permissionsRules = await rulesRes.json();
    const modeRes = await fetch("/api/permissions/mode");
    if (modeRes.ok) {
      const modeBody = await modeRes.json();
      if (isPermissionMode(modeBody.mode)) _permissionMode = modeBody.mode;
    }
    updatePermissionModeBadge();
    syncPermissionsPanel();
    if (forceToast) toast("权限信息已刷新", "success");
  } catch (err) {
    const content = document.getElementById("permissions-content");
    if (content) {
      content.innerHTML = `<div class="perm-empty perm-error">加载失败: ${E((err as Error).message)}</div>`;
    }
  }
}

function isPermissionMode(value: unknown): value is PermissionMode {
  return value === "plan" || value === "standard" || value === "dontAsk" || value === "yes";
}

function permissionModeOptions(): string {
  return ([
    ["plan", "计划模式"],
    ["standard", "标准模式"],
    ["dontAsk", "不询问模式"],
    ["yes", "Yes 模式"],
  ] as const).map(([value, label]) => `<option value="${value}"${_permissionMode === value ? " selected" : ""}>${label}</option>`).join("");
}

async function requestPermissionMode(mode: PermissionMode): Promise<void> {
  if (mode === "yes" && !(await confirmYesMode())) {
    syncPermissionsPanel();
    return;
  }
  try {
    const response = await fetch("/api/permissions/mode", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode, ...(mode === "yes" ? { acknowledgeRisk: true } : {}) }),
    });
    const body = await response.json();
    if (!response.ok || !body.ok) throw new Error(body.error || `HTTP ${response.status}`);
    _permissionMode = mode;
    updatePermissionModeBadge();
    syncPermissionsPanel();
    toast(`已切换为${mode === "yes" ? " Yes" : ""}权限模式`, "success");
  } catch (error) {
    syncPermissionsPanel();
    toast(`权限模式切换失败: ${(error as Error).message}`, "error");
  }
}

function updatePermissionModeBadge(): void {
  const badge = document.getElementById("permission-mode-badge");
  if (!badge) return;
  badge.textContent = _permissionMode === "yes" ? "YES" : "";
  badge.classList.toggle("on", _permissionMode === "yes");
}

function confirmYesMode(): Promise<boolean> {
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
    document.body.appendChild(overlay);
    const confirm = overlay.querySelector<HTMLButtonElement>('[data-risk-choice="confirm"]');
    overlay.querySelector<HTMLInputElement>("#permission-risk-ack")?.addEventListener("change", (event) => {
      if (confirm) confirm.disabled = !(event.target as HTMLInputElement).checked;
    });
    overlay.querySelectorAll<HTMLButtonElement>("[data-risk-choice]").forEach((button) => button.addEventListener("click", () => {
      const allowed = button.dataset.riskChoice === "confirm" && confirm?.disabled === false;
      overlay.remove();
      resolve(allowed);
    }));
  });
}

(window as any).refreshPermissionsPanel = refreshPermissionsPanel;

function syncPermissionsPanel(): void {
  const root = document.getElementById(PERMISSION_PANEL_ID);
  const content = document.getElementById("permissions-content");
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
  try {
    const res = await fetch(`/api/permissions/rules?list=${encodeURIComponent(list)}&scope=${encodeURIComponent(scope)}&index=${index}`, { method: "DELETE" });
    const body = await res.json();
    if (!res.ok || !body.ok) throw new Error(body.error || `HTTP ${res.status}`);
    _permissionsRules = body.rules;
    syncPermissionsPanel();
    toast(`${permissionScopeLabel(scope)}权限规则已撤销`, "success");
  } catch (err) {
    toast(`撤销失败: ${(err as Error).message}`, "error");
  }
}

function formatPermissionTime(value: string): string {
  const time = new Date(value);
  if (Number.isNaN(time.getTime())) return "";
  return time.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

registerPane("permissions", permissionsPaneRender);
