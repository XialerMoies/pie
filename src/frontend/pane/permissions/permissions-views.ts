/// <reference path="../../dashboard.d.ts" />

interface PermissionPanelViewState {
  tab: "audit" | "rules";
  mode: PermissionMode;
  audit: PermissionAuditEntry[];
  rules: PermissionRulesSnapshot | null;
}

function permissionModeOptions(mode: PermissionMode): string {
  return ([
    ["plan", "计划模式"],
    ["standard", "标准模式"],
    ["dontAsk", "不询问模式"],
    ["yes", "Yes 模式"],
  ] as const).map(([value, label]) => `<option value="${value}"${mode === value ? " selected" : ""}>${label}</option>`).join("");
}

function isRecentPermissionDecision(entry: PermissionAuditEntry): boolean {
  return entry.decision === "deny"
    || (entry.decision === "allow" && entry.reason?.startsWith("Confirmed by user") === true);
}

function formatPermissionOperation(operation: PermissionOperation): string {
  if (operation === "tool") return "Tool";
  if (operation === "read") return "Read";
  if (operation === "write") return "Write";
  if (operation === "create") return "Create";
  if (operation === "remove") return "Remove";
  return operation;
}

function formatPermissionTime(value: string): string {
  const time = new Date(value);
  if (Number.isNaN(time.getTime())) return "";
  return time.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

class PermissionAuditView {
  static render(entries: PermissionAuditEntry[]): string {
    const recent = entries.filter(isRecentPermissionDecision);
    if (recent.length === 0) return `<div class="perm-empty">暂无确认记录</div>`;
    return `
      <div class="perm-audit-list">
        ${recent.slice().reverse().map(entry => PermissionAuditView.renderEntry(entry)).join("")}
      </div>
    `;
  }

  private static renderEntry(entry: PermissionAuditEntry): string {
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
        ${PermissionAuditView.renderToolDetails(entry)}
        <div class="perm-time">${E(formatPermissionTime(entry.timestamp))}</div>
      </div>
    `;
  }

  private static renderToolDetails(entry: PermissionAuditEntry): string {
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
}

class WorkingDirectoriesView {
  static render(items: Array<{ path: string; source: string }>): string {
    if (!items.length) return "";
    return `
      <section class="perm-rule-section">
        <div class="perm-section-title">Working Directories</div>
        ${items.map(item => `
          <div class="perm-workdir-row">
            <span class="perm-rule-match">${E(item.source)}</span>
            <span class="perm-rule-content" title="${E(item.path)}">${E(item.path)}</span>
          </div>
        `).join("")}
      </section>
    `;
  }
}

class PermissionRulesView {
  static render(snapshot: PermissionRulesSnapshot | null): string {
    if (!snapshot) return `<div class="perm-empty">加载中...</div>`;
    return `
      ${PermissionRulesView.renderSection("allow", "Allow", snapshot.alwaysAllowRules)}
      ${PermissionRulesView.renderSection("deny", "Deny", snapshot.alwaysDenyRules)}
      ${PermissionRulesView.renderSection("ask", "Ask", snapshot.alwaysAskRules)}
      ${WorkingDirectoriesView.render(snapshot.additionalWorkingDirectories)}
    `;
  }

  static scopeLabel(scope: PermissionRuleScope): string {
    return scope === "workspace" ? "项目" : "会话";
  }

  private static renderSection(list: PermissionRuleList, label: string, rules: PermissionRuleView[]): string {
    const body = rules.length
      ? rules.map((rule, index) => `
          <div class="perm-rule-row">
            <div class="perm-rule-meta">
              <span class="perm-rule-tool">${E(rule.toolName)}</span>
              <span class="perm-rule-match">${E(rule.match || "prefix")}</span>
              <span class="perm-rule-match">${PermissionRulesView.scopeLabel(rule.scope || "session")}</span>
            </div>
            <div class="perm-rule-content" title="${E(rule.ruleContent)}">${E(rule.ruleContent)}</div>
            <button class="perm-icon-btn danger" data-rule-remove="${list}:${rule.scope || "session"}:${Number.isInteger(rule.index) ? rule.index : index}" title="撤销" type="button">${S("itrash", 13)}</button>
          </div>
        `).join("")
      : `<div class="perm-empty small">无 ${label} 规则</div>`;
    return `<section class="perm-rule-section"><div class="perm-section-title">${label}</div>${body}</section>`;
  }
}

class PermissionsPanelView {
  static render(state: PermissionPanelViewState): string {
    return `
      <div class="perm-panel">
        <div class="perm-head">
          <div class="perm-title">${S("ishield", 16)}<span>权限</span></div>
          <select class="perm-mode-select" id="perm-mode" title="权限模式">
            ${permissionModeOptions(state.mode)}
          </select>
          <span class="perm-yes-badge${state.mode === "yes" ? " on" : ""}" id="perm-yes-badge">${state.mode === "yes" ? "YES" : ""}</span>
          <button class="perm-icon-btn" id="perm-refresh" title="刷新" type="button">${S("irefresh", 14)}</button>
        </div>
        <div class="perm-tabs" role="tablist">
          <button class="perm-tab${state.tab === "audit" ? " active" : ""}" data-perm-tab="audit" type="button">最近确认</button>
          <button class="perm-tab${state.tab === "rules" ? " active" : ""}" data-perm-tab="rules" type="button">规则</button>
        </div>
        <div class="perm-content" id="permissions-content">${PermissionsPanelView.renderContent(state)}</div>
      </div>
    `;
  }

  static renderContent(state: PermissionPanelViewState): string {
    return state.tab === "rules"
      ? PermissionRulesView.render(state.rules)
      : PermissionAuditView.render(state.audit);
  }

  static renderError(message: string): string {
    return `<div class="perm-empty perm-error">加载失败: ${E(message)}</div>`;
  }
}

const permissionsViewsApp = (window as any).App || ((window as any).App = {});
permissionsViewsApp.PermissionViews = {
  ...(permissionsViewsApp.PermissionViews || {}),
  renderPanel: (state: PermissionPanelViewState): string => PermissionsPanelView.render(state),
  renderContent: (state: PermissionPanelViewState): string => PermissionsPanelView.renderContent(state),
  renderError: (message: string): string => PermissionsPanelView.renderError(message),
  scopeLabel: (scope: PermissionRuleScope): string => PermissionRulesView.scopeLabel(scope),
};

export {};
