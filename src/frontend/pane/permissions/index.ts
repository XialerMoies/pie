/// <reference path="../../dashboard.d.ts" />

type PermissionDecision = "allow" | "ask" | "deny";
type PermissionOperation = "read" | "write" | "create" | "remove" | "tool";
type PermissionRuleList = "allow" | "deny" | "ask";
type PermissionRuleScope = "session" | "workspace";

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
    syncPermissionsPanel();
    if (forceToast) toast("权限信息已刷新", "success");
  } catch (err) {
    const content = document.getElementById("permissions-content");
    if (content) {
      content.innerHTML = `<div class="perm-empty perm-error">加载失败: ${E((err as Error).message)}</div>`;
    }
  }
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
