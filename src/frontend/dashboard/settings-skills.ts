/// <reference path="../dashboard.d.ts" />

class SettingsSkillsController implements SettingsSkillsApi {
  private root: HTMLElement | null = null;
  private removeArmed = '';
  private requestGeneration = 0;

  mount(container: HTMLElement): void {
    this.unmount();
    const root = document.createElement('section');
    root.className = 'skills-settings';
    const heading = document.createElement('div');
    heading.className = 'skills-heading';
    const copy = document.createElement('div');
    const title = document.createElement('h3');
    title.className = 's-title';
    title.textContent = '技能';
    const description = document.createElement('p');
    description.className = 's-desc';
    description.textContent = '管理本地技能的信任与启用状态';
    copy.append(title, description);
    const rescan = this.button('rescan', '重新扫描');
    heading.append(copy, rescan);
    const list = document.createElement('div');
    list.className = 'skills-list';
    list.dataset.skillsList = '';
    const loading = document.createElement('div');
    loading.className = 'skills-empty';
    loading.textContent = '加载中...';
    list.appendChild(loading);
    root.append(heading, list);
    root.addEventListener('click', event => void this.handleClick(event));
    container.replaceChildren(root);
    this.root = root;
    void this.load();
  }

  unmount(): void {
    this.requestGeneration += 1;
    this.root = null;
    this.removeArmed = '';
  }

  private async load(endpoint = '/api/settings/skills', method = 'GET'): Promise<void> {
    const generation = ++this.requestGeneration;
    try {
      const response = await fetch(endpoint, { method });
      const result = await response.json() as { skills?: SkillSettingsSummary[]; error?: string };
      if (!response.ok) throw new Error(result.error || '请求失败');
      if (generation !== this.requestGeneration || !this.root?.isConnected) return;
      this.render(result.skills || []);
    } catch (error) {
      if (generation !== this.requestGeneration || !this.root?.isConnected) return;
      const list = this.root.querySelector<HTMLElement>('[data-skills-list]');
      if (list) { list.textContent = `加载失败：${(error as Error).message}`; list.className = 'skills-list skills-empty'; }
    }
  }

  private render(skills: SkillSettingsSummary[]): void {
    const list = this.root?.querySelector<HTMLElement>('[data-skills-list]');
    if (!list) return;
    list.replaceChildren();
    if (skills.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'skills-empty';
      empty.textContent = '未发现技能';
      list.appendChild(empty);
      return;
    }
    const workspaceGroup = this.renderGroup('workspace', '工作区技能', skills);
    const userGroup = this.renderGroup('user', '应用技能', skills);
    if (workspaceGroup) list.appendChild(workspaceGroup);
    if (userGroup) list.appendChild(userGroup);
  }

  private renderGroup(source: SkillSettingsSummary['source'], label: string, skills: SkillSettingsSummary[]): HTMLElement | null {
    const matches = skills.filter(skill => skill.source === source);
    if (matches.length === 0) return null;
    const group = document.createElement('section');
    group.className = 'skills-group';
    const heading = document.createElement('h4');
    heading.className = 'skills-group-title';
    heading.textContent = label;
    const items = document.createElement('div');
    items.className = 'skills-group-list';
    for (const skill of matches) items.appendChild(this.renderSkill(skill));
    group.append(heading, items);
    return group;
  }

  private renderSkill(skill: SkillSettingsSummary): HTMLElement {
    const item = document.createElement('article');
    item.className = 'skill-item';
    item.dataset.skillId = skill.id;
    item.dataset.skillSource = skill.source;
    const header = document.createElement('div');
    header.className = 'skill-main';
    const copy = document.createElement('div');
    copy.className = 'skill-copy';
    const title = document.createElement('strong');
    title.className = 'skill-name';
    title.textContent = skill.name;
    const description = document.createElement('span');
    description.className = 'skill-description';
    description.textContent = skill.description || skill.diagnostic?.message || '技能格式无效';
    copy.append(title, description);
    const badges = document.createElement('div');
    badges.className = 'skill-badges';
    badges.append(this.badge(skill.source === 'workspace' ? '工作区' : '应用'), this.badge(skill.parse === 'valid' ? '有效' : '无效', skill.parse === 'invalid'), this.badge(skill.trust === 'trusted' ? '已信任' : '未信任', skill.trust !== 'trusted'), this.badge(skill.enabled ? '已启用' : '已禁用', false));
    header.append(copy, badges);
    const actions = document.createElement('div');
    actions.className = 'skill-actions';
    if (skill.parse === 'valid') {
      actions.append(this.button(skill.trust === 'trusted' ? 'untrust' : 'trust', skill.trust === 'trusted' ? '取消信任' : '信任'));
      actions.append(this.button(skill.enabled ? 'disable' : 'enable', skill.enabled ? '禁用' : '启用', skill.trust !== 'trusted'));
    }
    const key = `${skill.source}:${skill.id}`;
    actions.append(this.button('remove', this.removeArmed === key ? '确认删除' : '删除', false, this.removeArmed === key));
    item.append(header, actions);
    if (skill.diagnostic) {
      const diagnostic = document.createElement('div');
      diagnostic.className = 'skill-diagnostic';
      diagnostic.textContent = skill.diagnostic.message;
      item.appendChild(diagnostic);
    }
    return item;
  }

  private badge(label: string, warning = false): HTMLElement {
    const badge = document.createElement('span');
    badge.className = `skill-badge${warning ? ' warning' : ''}`;
    badge.textContent = label;
    return badge;
  }

  private button(action: string, label: string, disabled = false, danger = false): HTMLButtonElement {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `skills-action${danger ? ' danger' : ''}`;
    button.dataset.skillAction = action;
    button.textContent = label;
    button.disabled = disabled;
    return button;
  }

  private async handleClick(event: Event): Promise<void> {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-skill-action]');
    if (!button || button.disabled) return;
    const action = button.dataset.skillAction || '';
    if (action === 'rescan') { this.removeArmed = ''; await this.load('/api/settings/skills/rescan', 'POST'); return; }
    const item = button.closest<HTMLElement>('[data-skill-id][data-skill-source]');
    const id = item?.dataset.skillId;
    const source = item?.dataset.skillSource;
    if (!id || !source) return;
    const key = `${source}:${id}`;
    if (action === 'remove' && this.removeArmed !== key) {
      this.removeArmed = key;
      await this.load();
      return;
    }
    const endpoint = `/api/settings/skills/${encodeURIComponent(source)}/${encodeURIComponent(id)}${action === 'remove' ? '' : `/${action}`}`;
    this.removeArmed = '';
    await this.load(endpoint, action === 'remove' ? 'DELETE' : 'POST');
  }
}

const settingsSkillsApp = (window as any).App;
settingsSkillsApp.SettingsComponents = {
  ...(settingsSkillsApp.SettingsComponents || {}),
  skills: new SettingsSkillsController(),
};
