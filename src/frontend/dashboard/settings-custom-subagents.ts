/// <reference path="../dashboard.d.ts" />

type SettingsCustomSubagent = {
  id: string;
  name: string;
  description: string;
  prompt: string;
  tools: string[];
  model?: { provider: string; id: string };
};

const SETTINGS_SUBAGENT_READ_ONLY_TOOLS = [
  ['git-status', 'Git 状态'],
  ['search', '代码搜索'],
  ['file_read', '读取文件'],
  ['explorer_list', '目录浏览'],
  ['git_log', 'Git 历史'],
  ['file_outline', '文件大纲'],
] as const;

class SettingsCustomSubagentController implements SettingsCustomSubagentApi {
  private agents: SettingsCustomSubagent[] = [];
  private models: Array<{ provider: string; id: string }> = [];
  private selectedId: string | null = null;
  private deleteArmedId: string | null = null;

  constructor(private readonly notify: typeof toast) {}

  mount(container: HTMLElement): void {
    container.insertAdjacentHTML('beforeend', `
      <div class="gs-section sa-section">
        <h4 class="sa-section-title">自定义 Agent</h4>
        <div class="sa-section-note">保存后可通过 delegate_tasks 的 agentId 使用</div>
        <div class="sa-manager">
          <aside class="sa-agent-pane">
            <div class="sa-sidebar-head">
              <span>Agent 列表</span>
            </div>
            <div class="list-add-action-mount" data-list-add-action-mount></div>
            <div class="sa-agent-list" id="sa-agent-list"><div class="sa-empty">加载中...</div></div>
          </aside>
          <div class="sa-editor" id="sa-editor"><div class="sa-empty">选择或新建 Agent</div></div>
        </div>
      </div>
    `);
    const addActionMount = container.querySelector<HTMLElement>('[data-list-add-action-mount]');
    addActionMount?.prepend(settingsSubagentApp.Ui.ListAddAction.create({
      label: '新建 Agent',
      onActivate: () => this.startNew(),
    }));
    void this.load();
  }

  startNew(): void {
    this.selectedId = null;
    this.deleteArmedId = null;
    this.render({ id: '', name: '', description: '', prompt: '', tools: ['search', 'file_read'] });
  }

  select(id: string): void {
    this.selectedId = id;
    this.deleteArmedId = null;
    this.render();
  }

  async save(): Promise<void> {
    const agent = this.readForm();
    if (!agent) return;
    const existingIndex = this.agents.findIndex(item => item.id === agent.id);
    const next = [...this.agents];
    if (existingIndex >= 0) next[existingIndex] = agent;
    else next.push(agent);
    if (!await this.persist(next)) return;
    this.selectedId = agent.id;
    this.deleteArmedId = null;
    this.render();
    this.notify('Agent 已保存', 'success');
  }

  async delete(id: string): Promise<void> {
    if (!this.agents.some(agent => agent.id === id)) return;
    if (this.deleteArmedId !== id) {
      this.deleteArmedId = id;
      this.render();
      return;
    }
    const next = this.agents.filter(agent => agent.id !== id);
    if (!await this.persist(next)) return;
    if (this.selectedId === id) this.selectedId = next[0]?.id ?? null;
    this.deleteArmedId = null;
    this.render();
    this.notify('Agent 已删除');
  }

  private async load(): Promise<void> {
    try {
      const [agentsResponse, modelsResponse] = await Promise.all([
        fetch('/api/subagents'),
        fetch('/api/models'),
      ]);
      if (!agentsResponse.ok || !modelsResponse.ok) throw new Error('加载失败');
      const agentsData = await agentsResponse.json() as { agents?: SettingsCustomSubagent[] };
      const modelsData = await modelsResponse.json() as { models?: Array<{ provider: string; id: string }> };
      this.agents = Array.isArray(agentsData.agents) ? agentsData.agents : [];
      this.models = Array.isArray(modelsData.models) ? modelsData.models : [];
      this.selectedId = this.agents[0]?.id ?? null;
      this.deleteArmedId = null;
      this.render();
    } catch {
      const list = $('sa-agent-list');
      if (list) list.innerHTML = '<div class="sa-empty sa-error">Agent 配置加载失败</div>';
    }
  }

  private render(draft?: SettingsCustomSubagent): void {
    const list = $('sa-agent-list');
    const editor = $('sa-editor');
    if (!list || !editor) return;
    list.innerHTML = this.agents.length > 0
      ? this.agents.map(agent => `
      <div class="sa-agent-item${agent.id === this.selectedId ? ' on' : ''}" data-agent-id="${E(agent.id)}">
        <button type="button" class="sa-agent-select" data-agent-id="${E(agent.id)}">
          <span class="sa-agent-name">${E(agent.name)}</span>
          <span class="sa-agent-id">${E(agent.id)}</span>
        </button>
        <button type="button" class="sa-delete-btn${this.deleteArmedId === agent.id ? ' armed' : ''}" data-settings-action="delete-subagent" data-agent-id="${E(agent.id)}" aria-label="${this.deleteArmedId === agent.id ? '再次点击删除' : '删除'} ${E(agent.name)}" title="${this.deleteArmedId === agent.id ? '再次点击确认删除' : '删除 Agent'}"><svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true"><use href="#itrash"></use></svg></button>
      </div>`).join('')
      : '<div class="sa-empty">暂无自定义 Agent</div>';
    const selected = draft ?? this.agents.find(agent => agent.id === this.selectedId);
    if (!selected) {
      editor.innerHTML = '<div class="sa-empty">新建一个 Agent，为常用分析任务固定角色和工具</div>';
      return;
    }
    const modelValue = selected.model ? JSON.stringify(selected.model) : '';
    const modelOptions = this.models.map(model => {
      const value = JSON.stringify(model);
      return `<option value="${E(value)}"${value === modelValue ? ' selected' : ''}>${E(model.provider)} / ${E(model.id)}</option>`;
    }).join('');
    const persisted = this.agents.some(agent => agent.id === selected.id);
    editor.innerHTML = `
      <div class="sa-form-grid">
        <label class="sa-field"><span>名称</span><input id="sa-name" maxlength="80" value="${E(selected.name)}" placeholder="例如：安全审计"></label>
        <label class="sa-field"><span>Agent ID</span><input id="sa-id" maxlength="64" value="${E(selected.id)}" placeholder="security-reviewer"${persisted ? ' readonly' : ''}></label>
        <label class="sa-field sa-field-wide"><span>描述</span><input id="sa-description" maxlength="240" value="${E(selected.description)}" placeholder="告诉主 Agent 何时使用它"></label>
        <label class="sa-field sa-field-wide"><span>默认模型</span><select id="sa-model"><option value="">继承主 Agent</option>${modelOptions}</select></label>
        <fieldset class="sa-field sa-field-wide sa-tools"><legend>只读工具</legend>${SETTINGS_SUBAGENT_READ_ONLY_TOOLS.map(([id, label]) => `<label><input id="sa-tool-${E(id)}" type="checkbox" value="${E(id)}"${selected.tools.includes(id) ? ' checked' : ''}><span>${E(label)}</span></label>`).join('')}</fieldset>
        <label class="sa-field sa-field-wide"><span>角色指令</span><textarea id="sa-prompt" maxlength="8000" rows="7" placeholder="描述职责、关注点和输出要求">${E(selected.prompt)}</textarea></label>
      </div>
      <div class="sa-form-actions">
        <span></span>
        <button type="button" class="sa-save-btn" data-settings-action="save-subagent">保存 Agent</button>
      </div>
    `;
  }

  private readForm(): SettingsCustomSubagent | null {
    const id = ($('sa-id') as HTMLInputElement | null)?.value.trim() || '';
    const name = ($('sa-name') as HTMLInputElement | null)?.value.trim() || '';
    const description = ($('sa-description') as HTMLInputElement | null)?.value.trim() || '';
    const prompt = ($('sa-prompt') as HTMLTextAreaElement | null)?.value.trim() || '';
    const modelRaw = ($('sa-model') as HTMLSelectElement | null)?.value || '';
    const tools = SETTINGS_SUBAGENT_READ_ONLY_TOOLS
      .map(([tool]) => tool)
      .filter(tool => ($(`sa-tool-${tool}`) as HTMLInputElement | null)?.checked);
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(id)) {
      this.notify('Agent ID 只能使用小写字母、数字和短横线', 'error');
      return null;
    }
    if (!name || !prompt) {
      this.notify('请填写名称和角色指令', 'error');
      return null;
    }
    if (tools.length === 0) {
      this.notify('至少选择一个只读工具', 'error');
      return null;
    }
    let model: { provider: string; id: string } | undefined;
    if (modelRaw) {
      try { model = JSON.parse(modelRaw); }
      catch {
        this.notify('模型配置无效', 'error');
        return null;
      }
    }
    return { id, name, description, prompt, tools, ...(model ? { model } : {}) };
  }

  private async persist(agents: SettingsCustomSubagent[]): Promise<boolean> {
    try {
      const response = await fetch('/api/subagents', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agents }),
      });
      const result = await response.json() as { agents?: SettingsCustomSubagent[]; error?: string };
      if (!response.ok) throw new Error(result.error || '保存失败');
      this.agents = result.agents ?? agents;
      return true;
    } catch (error) {
      this.notify(error instanceof Error ? error.message : '保存失败', 'error');
      return false;
    }
  }
}

const settingsSubagentApp = (window as any).App;
settingsSubagentApp.SettingsComponents = {
  ...(settingsSubagentApp.SettingsComponents || {}),
  subagents: new SettingsCustomSubagentController(toast),
};
