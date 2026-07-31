/// <reference path="../../dashboard.d.ts" />

type PermissionDecision = "allow" | "ask" | "deny";
type PermissionOperation = "read" | "write" | "create" | "remove" | "tool";
type PermissionRuleList = "allow" | "deny" | "ask";

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
        <button class="perm-tab${_permissionsTab === "audit" ? " active" : ""}" data-perm-tab="audit" type="button">审计</button>
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
      fetch("/api/permissions/audit?limit=200"),
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
  if (_permissionsAudit.length === 0) {
    return `<div class="perm-empty">暂无权限审计记录</div>`;
  }
  const stats = {
    allow: _permissionsAudit.filter((entry) => entry.decision === "allow").length,
    ask: _permissionsAudit.filter((entry) => entry.decision === "ask").length,
    deny: _permissionsAudit.filter((entry) => entry.decision === "deny").length,
  };
  return `
    <div class="perm-stats">
      <span class="perm-stat perm-stat--allow">Allow ${stats.allow}</span>
      <span class="perm-stat perm-stat--ask">Ask ${stats.ask}</span>
      <span class="perm-stat perm-stat--deny">Deny ${stats.deny}</span>
    </div>
    <div class="perm-audit-list">
      ${_permissionsAudit.slice().reverse().map(renderAuditEntry).join("")}
    </div>
  `;
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
  const totalRules = rules.alwaysAllowRules.length + rules.alwaysDenyRules.length + rules.alwaysAskRules.length;
  return `
    <div class="perm-rule-toolbar">
      <span class="perm-rule-count">Session ${totalRules}</span>
      <button class="perm-mini-btn danger" id="perm-clear-all" type="button">清空</button>
    </div>
    ${renderRuleSection("allow", "Allow", rules.alwaysAllowRules)}
    ${renderRuleSection("deny", "Deny", rules.alwaysDenyRules)}
    ${renderRuleSection("ask", "Ask", rules.alwaysAskRules)}
    ${renderWorkingDirectories(rules.additionalWorkingDirectories)}
    ${renderRuleAddForm()}
  `;
}

function renderRuleSection(list: PermissionRuleList, label: string, rules: PermissionRuleView[]): string {
  const body = rules.length
    ? rules.map((rule, index) => `
        <div class="perm-rule-row">
          <div class="perm-rule-meta">
            <span class="perm-rule-tool">${E(rule.toolName)}</span>
            <span class="perm-rule-match">${E(rule.match || "prefix")}</span>
          </div>
          <div class="perm-rule-content" title="${E(rule.ruleContent)}">${E(rule.ruleContent)}</div>
          <button class="perm-icon-btn danger" data-rule-remove="${list}:${index}" title="撤销" type="button">${S("itrash", 13)}</button>
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

function renderRuleAddForm(): string {
  return `
    <section class="perm-rule-add">
      <div class="perm-section-title">新增规则</div>
      <div class="perm-add-grid">
        <select id="perm-add-list" class="perm-input">
          <option value="allow">Allow</option>
          <option value="deny">Deny</option>
          <option value="ask">Ask</option>
        </select>
        <select id="perm-add-tool" class="perm-input">
          <option value="Read">Read</option>
          <option value="Write">Write</option>
          <option value="Create">Create</option>
          <option value="Remove">Remove</option>
          <option value="Command">Command</option>
          <option value="Tool">Tool</option>
        </select>
        <select id="perm-add-match" class="perm-input">
          <option value="exact">exact</option>
          <option value="prefix">prefix</option>
          <option value="wildcard">wildcard</option>
        </select>
      </div>
      <input id="perm-add-content" class="perm-input perm-rule-input" placeholder="Write(C:\\path\\**)" />
      <button id="perm-add-rule" class="perm-primary-btn" type="button">添加</button>
    </section>
  `;
}

function bindPermissionsContent(container: HTMLElement): void {
  container.querySelectorAll("[data-rule-remove]").forEach((button) => {
    button.addEventListener("click", async () => {
      const raw = (button as HTMLElement).dataset.ruleRemove || "";
      const [list, indexText] = raw.split(":");
      await removePermissionRule(list as PermissionRuleList, Number(indexText));
    });
  });
  container.querySelector("#perm-clear-all")?.addEventListener("click", async () => {
    if (!await confirmAsync("清空本会话权限规则？")) return;
    await clearPermissionRules();
  });
  container.querySelector("#perm-add-rule")?.addEventListener("click", async () => {
    await addPermissionRule(container);
  });
}

async function removePermissionRule(list: PermissionRuleList, index: number): Promise<void> {
  try {
    const res = await fetch(`/api/permissions/rules?list=${encodeURIComponent(list)}&index=${index}`, { method: "DELETE" });
    const body = await res.json();
    if (!res.ok || !body.ok) throw new Error(body.error || `HTTP ${res.status}`);
    _permissionsRules = body.rules;
    syncPermissionsPanel();
    toast("权限规则已撤销", "success");
  } catch (err) {
    toast(`撤销失败: ${(err as Error).message}`, "error");
  }
}

async function clearPermissionRules(): Promise<void> {
  try {
    const res = await fetch("/api/permissions/rules/clear", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ list: "all" }),
    });
    const body = await res.json();
    if (!res.ok || !body.ok) throw new Error(body.error || `HTTP ${res.status}`);
    _permissionsRules = body.rules;
    syncPermissionsPanel();
    toast("本会话权限规则已清空", "success");
  } catch (err) {
    toast(`清空失败: ${(err as Error).message}`, "error");
  }
}

async function addPermissionRule(container: HTMLElement): Promise<void> {
  const list = (container.querySelector("#perm-add-list") as HTMLSelectElement | null)?.value || "allow";
  const toolName = (container.querySelector("#perm-add-tool") as HTMLSelectElement | null)?.value || "Read";
  const match = (container.querySelector("#perm-add-match") as HTMLSelectElement | null)?.value || "exact";
  const input = container.querySelector("#perm-add-content") as HTMLInputElement | null;
  const ruleContent = input?.value.trim() || "";
  if (!ruleContent) {
    toast("请输入规则内容", "error");
    return;
  }

  try {
    const res = await fetch("/api/permissions/rules", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ list, rule: { toolName, ruleContent, match } }),
    });
    const body = await res.json();
    if (!res.ok || !body.ok) throw new Error(body.error || `HTTP ${res.status}`);
    if (input) input.value = "";
    _permissionsRules = body.rules;
    syncPermissionsPanel();
    toast(body.added ? "权限规则已添加" : "规则已存在", body.added ? "success" : "info");
  } catch (err) {
    toast(`添加失败: ${(err as Error).message}`, "error");
  }
}

function formatPermissionTime(value: string): string {
  const time = new Date(value);
  if (Number.isNaN(time.getTime())) return "";
  return time.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

registerPane("permissions", permissionsPaneRender);
