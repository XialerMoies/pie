// ═══════════════════════════════════════════════════════════════════
//  设置模态框
// ═══════════════════════════════════════════════════════════════════

let _st: string = 'model';
let _selectedProvider: string | null = null;
let _provKeys: Record<string, ProviderKeyInfo> = {};
let _revealRequestId = 0;
type CustomSubagent = {
  id: string;
  name: string;
  description: string;
  prompt: string;
  tools: string[];
  model?: { provider: string; id: string };
};
const SUBAGENT_READ_ONLY_TOOLS = [
  ['git-status', 'Git 状态'],
  ['search', '代码搜索'],
  ['file_read', '读取文件'],
  ['explorer_list', '目录浏览'],
  ['git_log', 'Git 历史'],
  ['file_outline', '文件大纲'],
] as const;
let _customSubagents: CustomSubagent[] = [];
let _subagentModels: Array<{ provider: string; id: string }> = [];
let _selectedSubagentId: string | null = null;
let _subagentDeleteArmedId: string | null = null;

const CHAT_TIMELINE_WINDOW_OPTIONS = ['5', '7', '9'];
const CHAT_JUMP_THRESHOLD_OPTIONS = ['48', '72', '120'];

function getAllowedSetting(key: string, fallback: string, allowed: string[]): string {
  const value = App.Preferences.get(key, fallback);
  return allowed.includes(value) ? value : fallback;
}

function providerListHTML(listOrder: string[]): string {
  return listOrder.map((prov, index) => {
    const onClass = prov === _selectedProvider || (!_selectedProvider && index === 0) ? ' on' : '';
    const has = _provKeys[prov]?.hasKey;
    return `<div class="msl-item${onClass}" draggable="true" data-prov="${E(prov)}" data-index="${index}">
      <span class="msl-name">${E(prov)}</span><span class="msl-drag">⠿</span><span class="msl-status${has?' on':''}"></span>
    </div>`;
  }).join('');
}

function bindSettingsModalEvents(overlay: HTMLElement): void {
  overlay.addEventListener('click', (event) => {
    const target = event.target as HTMLElement;
    const action = target.closest<HTMLElement>('[data-settings-action]')?.dataset.settingsAction;
    if (action === 'close') { closeSettingsModal(); return; }
    if (action === 'font-decrease') { changeFontSize(-1); return; }
    if (action === 'font-increase') { changeFontSize(1); return; }
    if (action === 'subagent-decrease' || action === 'subagent-increase') {
      const inputId = target.closest<HTMLElement>('[data-settings-target]')?.dataset.settingsTarget;
      if (inputId) changeSubagentSetting(inputId, action === 'subagent-increase' ? 1 : -1);
      return;
    }
    if (action === 'new-subagent') { startNewSubagent(); return; }
    if (action === 'save-subagent') { void saveCustomSubagent(); return; }
    if (action === 'delete-subagent') {
      const agentId = target.closest<HTMLElement>('[data-agent-id]')?.dataset.agentId;
      if (agentId) void deleteCustomSubagent(agentId);
      return;
    }
    if (action === 'toggle-key') {
      const provider = target.closest<HTMLElement>('[data-provider]')?.dataset.provider;
      if (provider) toggleKeyVis(provider);
      return;
    }
    if (action === 'save-key') {
      const provider = target.closest<HTMLElement>('[data-provider]')?.dataset.provider;
      if (provider) saveApiKey(provider);
      return;
    }
    if (action === 'choose-data-root') {
      void chooseDataRoot();
      return;
    }
    if (action === 'preview-storage-migration') {
      void previewStorageMigration();
      return;
    }
    if (action === 'confirm-storage-migration') {
      void confirmStorageMigration();
      return;
    }

    const tab = target.closest<HTMLElement>('.ms-item[data-st]')?.dataset.st;
    if (tab) { switchSettingsModal(tab); return; }

    const provider = target.closest<HTMLElement>('.msl-item[data-prov]')?.dataset.prov;
    if (provider) { selectProvider(provider); return; }

    const model = target.closest<HTMLElement>('.rp-model-item[data-model-id]');
    const modelProvider = model?.dataset.modelProvider;
    const modelId = model?.dataset.modelId;
    if (modelProvider && modelId) selectModel(modelProvider, modelId);

    const subagentId = target.closest<HTMLElement>('.sa-agent-item[data-agent-id]')?.dataset.agentId;
    if (subagentId) selectCustomSubagent(subagentId);
  });

  overlay.addEventListener('change', (event) => {
    const target = event.target as HTMLElement;
    if (target.id === 'gs-autosave') toggleAutoSaveSetting();
    else if (target.matches('#gs-indent-type, #gs-tab-size, #gs-theme')) applyGeneralSetting();
    else if (target.matches('#gs-timeline-enabled, #gs-timeline-window, #gs-jump-enabled, #gs-jump-smooth, #gs-jump-threshold')) applyReadingSetting(target);
    else if (target.matches('#gs-subagent-max-tasks, #gs-subagent-max-concurrent')) applySubagentSetting(target as HTMLInputElement);
  });

  overlay.addEventListener('dragstart', (event) => {
    const index = Number((event.target as HTMLElement).closest<HTMLElement>('.msl-item[data-index]')?.dataset.index);
    if (Number.isInteger(index)) provDragStart(event, index);
  });
  overlay.addEventListener('dragover', (event) => {
    const index = Number((event.target as HTMLElement).closest<HTMLElement>('.msl-item[data-index]')?.dataset.index);
    if (Number.isInteger(index)) provDragOver(event, index);
  });
  overlay.addEventListener('drop', (event) => {
    const index = Number((event.target as HTMLElement).closest<HTMLElement>('.msl-item[data-index]')?.dataset.index);
    if (Number.isInteger(index)) provDrop(event, index);
  });
}

function openSettingsModal(): void {
  if ($('settings-modal')) { closeSettingsModal(); return; }
  _st = 'model';
  showSettingsModal();
}

function showSettingsModal(): void {
  const overlay = document.createElement('div');
  overlay.id = 'settings-modal';
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal-box">
      <div class="modal-header"><span class="modal-title">设置</span><button type="button" class="modal-close" data-settings-action="close" aria-label="关闭设置">✕</button></div>
      <div class="modal-body">
        <div class="modal-sidebar">
          <div class="ms-item on" data-st="model">模型</div>
          <div class="ms-item" data-st="general">通用</div>
          <div class="ms-item" data-st="subagents">子 Agent</div>
          <div class="ms-item" data-st="permissions">权限</div>
          <div class="ms-item" data-st="about">关于</div>
        </div>
        <div class="modal-content" id="mc-settings"></div>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);
  bindSettingsModalEvents(overlay);
  switchSettingsModal('model');
}

function closeSettingsModal(): void {
  if (_st === 'permissions') (window as any).App?.Permissions?.unmount?.();
  const el = $('settings-modal');
  if (el) el.remove();
}

function switchSettingsModal(tab: string): void {
  const previousTab = _st;
  _st = tab;
  if (previousTab === 'permissions' && tab !== 'permissions') {
    (window as any).App?.Permissions?.unmount?.();
  }
  document.querySelectorAll('.ms-item').forEach(e => e.classList.toggle('on', (e as HTMLElement).dataset.st === tab));
  const sc = $('mc-settings');
  if (!sc) return;

  if (tab === 'model') {
    sc.innerHTML = `
      <div class="model-split">
        <div class="ms-left">
          <div class="msl-title">厂商</div>
          <div class="msl-list" id="msl-list"><div class="sp" style="margin:20px auto"></div></div>
        </div>
        <div class="ms-right">
          <div id="ms-right-content"><div class="sp" style="margin:40px auto"></div></div>
        </div>
      </div>
    `;
    fetch('/api/auth').then(r => r.json()).then((ad: { providers: Array<{ provider: string; hasKey: boolean; keyPreview: string }> }) => {
      const list = $('msl-list')!;
      const cfg: Record<string, ProviderKeyInfo> = {};
      ad.providers && ad.providers.forEach(p => {
        cfg[p.provider] = { hasKey: p.hasKey, keyPreview: p.keyPreview || '' };
        _provKeys[p.provider] = cfg[p.provider];
      });
      const allProvs = ['anthropic', 'deepseek', 'openai', 'openrouter', 'google'];
      const configured = allProvs.filter(p => cfg[p] && cfg[p].hasKey);
      const unconfigured = allProvs.filter(p => !configured.includes(p));
      const savedOrder = App.Preferences.get('providers_order');
      let order: string[] = configured.concat(unconfigured);
      if (savedOrder) {
        try {
          const parsed = JSON.parse(savedOrder);
          if (Array.isArray(parsed)) order = parsed.filter((provider): provider is string => typeof provider === 'string');
        } catch {}
      }
      allProvs.forEach(p => { if (!order.includes(p)) order.push(p); });
      window._provOrder = order;
      list.innerHTML = providerListHTML(order);
      if (order.length > 0) selectProvider(order[0]);
    }).catch(() => { const l = $('msl-list'); if (l) l.innerHTML = '<p style="color:var(--rs);font-size:.72rem">加载失败</p>'; toast('加载厂商列表失败', 'error'); });
  } else if (tab === 'general') {
    const fontSize = String(App.Preferences.getNumber('editor-font-size', 13, 10, 24));
    const tabSize = String(App.Preferences.getNumber('editor-tab-size', 2, 1, 16));
    const useTabs = App.Preferences.getBoolean('editor-use-tabs');
    const theme = App.Preferences.get('editor-theme', 'vs-dark');
    const timelineEnabled = App.Preferences.getBoolean('chat-timeline-enabled', true);
    const timelineWindow = getAllowedSetting('chat-timeline-window-size', '9', CHAT_TIMELINE_WINDOW_OPTIONS);
    const jumpEnabled = App.Preferences.getBoolean('chat-jump-latest-enabled', true);
    const jumpSmooth = App.Preferences.getBoolean('chat-jump-latest-smooth', true);
    const jumpThreshold = getAllowedSetting('chat-jump-latest-threshold', '72', CHAT_JUMP_THRESHOLD_OPTIONS);
    sc.innerHTML = `
      <h3 class="s-title">通用设置</h3>
      <p class="s-desc">应用与编辑器偏好设置，即时生效。</p>

      <div class="gs-section">
        <div class="gs-section-title">应用设置</div>
        <div class="gs-group">
          <div class="gs-row" style="border:none">
            <span class="gs-label">自动保存</span>
            <div class="gs-control">
      <label class="gs-toggle"><input type="checkbox" id="gs-autosave"${App.Preferences.getBoolean('auto-save') ? ' checked' : ''}><span class="gs-toggle-slider"></span></label>
            </div>
          </div>
        </div>
      </div>

      <div class="gs-section">
        <div class="gs-section-title">编辑器设置</div>
        <div class="gs-group">
          <div class="gs-row">
            <span class="gs-label">字体大小</span>
            <div class="gs-control">
              <button type="button" class="gs-btn" data-settings-action="font-decrease">−</button>
              <span class="gs-value" id="gs-fontsize">${fontSize}</span>
              <button type="button" class="gs-btn" data-settings-action="font-increase">+</button>
            </div>
          </div>
          <div class="gs-row">
            <span class="gs-label">缩进</span>
            <div class="gs-control">
              <select class="gs-select" id="gs-indent-type">
                <option value="0"${useTabs?'':' selected'}>空格</option>
                <option value="1"${useTabs?' selected':''}>制表符</option>
              </select>
              <select class="gs-select" id="gs-tab-size">
                <option value="2"${tabSize==='2'?' selected':''}>2</option>
                <option value="4"${tabSize==='4'?' selected':''}>4</option>
                <option value="8"${tabSize==='8'?' selected':''}>8</option>
              </select>
            </div>
          </div>
          <div class="gs-row" style="border:none">
            <span class="gs-label">主题</span>
            <div class="gs-control">
              <select class="gs-select" id="gs-theme">
                <option value="vs-dark"${theme==='vs-dark'?' selected':''}>应用暗色</option>
                <option value="vs"${theme==='vs'?' selected':''}>应用亮色</option>
              </select>
            </div>
          </div>
        </div>
      </div>
      <div class="gs-section">
        <div class="gs-section-title">会话阅读</div>
        <div class="gs-group">
          <div class="gs-row">
            <span class="gs-label">显示会话时间线</span>
            <div class="gs-control">
              <label class="gs-toggle"><input type="checkbox" id="gs-timeline-enabled"${timelineEnabled ? ' checked' : ''}><span class="gs-toggle-slider"></span></label>
            </div>
          </div>
          <div class="gs-row">
            <span class="gs-label">时间线条目数</span>
            <div class="gs-control">
              <select class="gs-select" id="gs-timeline-window">
                <option value="5"${timelineWindow === '5' ? ' selected' : ''}>5</option>
                <option value="7"${timelineWindow === '7' ? ' selected' : ''}>7</option>
                <option value="9"${timelineWindow === '9' ? ' selected' : ''}>9</option>
              </select>
            </div>
          </div>
          <div class="gs-row">
            <span class="gs-label">启用跳转到最新消息</span>
            <div class="gs-control">
              <label class="gs-toggle"><input type="checkbox" id="gs-jump-enabled"${jumpEnabled ? ' checked' : ''}><span class="gs-toggle-slider"></span></label>
            </div>
          </div>
          <div class="gs-row">
            <span class="gs-label">回到最新位置效果</span>
            <div class="gs-control">
              <select class="gs-select" id="gs-jump-smooth">
                <option value="true"${jumpSmooth ? ' selected' : ''}>平滑滚动</option>
                <option value="false"${jumpSmooth ? '' : ' selected'}>立即到达</option>
              </select>
            </div>
          </div>
          <div class="gs-row" style="border:none">
            <span class="gs-label">最新消息阈值</span>
            <div class="gs-control">
              <select class="gs-select" id="gs-jump-threshold">
                <option value="48"${jumpThreshold === '48' ? ' selected' : ''}>48</option>
                <option value="72"${jumpThreshold === '72' ? ' selected' : ''}>72</option>
                <option value="120"${jumpThreshold === '120' ? ' selected' : ''}>120</option>
              </select>
            </div>
          </div>
        </div>
      </div>
    `;
    const timelineWindowEl = $('gs-timeline-window') as HTMLSelectElement | null;
    if (timelineWindowEl) timelineWindowEl.value = timelineWindow;
    const jumpThresholdEl = $('gs-jump-threshold') as HTMLSelectElement | null;
    if (jumpThresholdEl) jumpThresholdEl.value = jumpThreshold;
    renderStorageLocationSettings(sc);
  } else if (tab === 'subagents') {
    const maxTasks = String(App.Preferences.getNumber('subagent-max-tasks', 4, 1, 30));
    const maxConcurrent = String(App.Preferences.getNumber('subagent-max-concurrent', 2, 1, 30));
    sc.innerHTML = `
      <h3 class="s-title">子 Agent</h3>
      <p class="s-desc">控制主 Agent 单次委派的资源上限。主 Agent 可以按任务需要选择更小的值。</p>
      <div class="gs-section">
        <div class="gs-section-title">并行编排</div>
        <div class="gs-group">
          <div class="gs-row gs-subagent-row">
            <label class="gs-subagent-copy" for="gs-subagent-max-tasks"><span class="gs-label">子 Agent 上限</span><span class="gs-desc">单批最多创建的子任务数量</span></label>
            <div class="gs-control gs-number-stepper">
              <button type="button" class="gs-stepper-btn" data-settings-action="subagent-decrease" data-settings-target="gs-subagent-max-tasks" aria-label="减少子 Agent 上限">−</button>
              <input class="gs-number-input" id="gs-subagent-max-tasks" type="number" min="1" max="30" step="1" value="${maxTasks}" aria-label="子 Agent 上限">
              <button type="button" class="gs-stepper-btn" data-settings-action="subagent-increase" data-settings-target="gs-subagent-max-tasks" aria-label="增加子 Agent 上限">+</button>
            </div>
          </div>
          <div class="gs-row gs-subagent-row" style="border:none">
            <label class="gs-subagent-copy" for="gs-subagent-max-concurrent"><span class="gs-label">并发数</span><span class="gs-desc">同一时间最多运行的子 Agent 数量</span></label>
            <div class="gs-control gs-number-stepper">
              <button type="button" class="gs-stepper-btn" data-settings-action="subagent-decrease" data-settings-target="gs-subagent-max-concurrent" aria-label="减少并发数">−</button>
              <input class="gs-number-input" id="gs-subagent-max-concurrent" type="number" min="1" max="30" step="1" value="${maxConcurrent}" aria-label="并发数">
              <button type="button" class="gs-stepper-btn" data-settings-action="subagent-increase" data-settings-target="gs-subagent-max-concurrent" aria-label="增加并发数">+</button>
            </div>
          </div>
        </div>
      </div>
      <div class="gs-section sa-section">
        <h4 class="sa-section-title">自定义 Agent</h4>
        <div class="sa-section-note">保存后可通过 delegate_tasks 的 agentId 使用</div>
        <div class="sa-manager">
          <aside class="sa-agent-pane">
            <div class="sa-sidebar-head">
              <span>Agent 列表</span>
              <button type="button" class="sa-add-btn" data-settings-action="new-subagent" aria-label="新建 Agent" title="新建 Agent"><svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true"><use href="#iplus"></use></svg></button>
            </div>
            <div class="sa-agent-list" id="sa-agent-list"><div class="sa-empty">加载中...</div></div>
          </aside>
          <div class="sa-editor" id="sa-editor"><div class="sa-empty">选择或新建 Agent</div></div>
        </div>
      </div>
    `;
    void loadCustomSubagents();
  } else if (tab === 'permissions') {
    sc.innerHTML = '<div id="settings-permissions-root"></div>';
    const root = document.getElementById('settings-permissions-root');
    const permissions = (App as any).Permissions;
    if (root && typeof permissions?.mount === 'function') {
      permissions.mount(root);
    }
  } else if (tab === 'about') {
    sc.innerHTML = `
      <h3 class="s-title">关于</h3>
      <p class="s-desc">My Code Agent — 基于 PI 框架的自定义编程助手</p>
      <div class="s-section"><span class="s-label">版本</span><span class="s-value">0.0.1</span></div>
      <div class="s-section"><span class="s-label">框架</span><span class="s-value">@xiamol/pi-coding-agent v0.80.3</span></div>
    `;
  }
}

// ═══════════════════════════════════════════════════════════════════
//  模型配置 — 厂商选择 & API Key 管理 & 模型切换
// ═══════════════════════════════════════════════════════════════════

function selectProvider(prov: string): void {
  _selectedProvider = prov;
  document.querySelectorAll('.msl-item').forEach(el => (el as HTMLElement).classList.toggle('on', (el as HTMLElement).dataset.prov === prov));
  const rc = $('ms-right-content');
  if (!rc) return;
  const info = _provKeys[prov] || { hasKey: false, keyPreview: '' };
  const placeholder = info.hasKey
    ? `已保存: ${info.keyPreview || '********'}，输入新 Key 覆盖`
    : '输入 API Key...';
  let html = `
    <div class="rp-header">
      <div class="rp-prov-name">${E(prov)}</div>
      <span class="rp-status${info.hasKey?' on':''}">${info.hasKey?'已配置':'未配置'}</span>
    </div>
  `;
  if (info.hasKey) {
    html += `<div class="rp-models" id="rp-models" data-provider="${E(prov)}">加载中...</div>`;
  }
  html += `
    <div class="rp-key-section">
      <div class="rp-key-label">API Key</div>
      <div class="rp-key-row">
        <input class="rp-key-input" type="${info.hasKey ? 'text' : 'password'}" id="key-input" data-provider="${E(prov)}" placeholder="${E(placeholder)}" value="${E(info.keyPreview || '')}"/>
        <button type="button" class="rp-key-toggle" data-settings-action="toggle-key" data-provider="${E(prov)}" aria-label="显示或隐藏 API Key">👁</button>
        <button type="button" class="rp-save-btn" data-settings-action="save-key" data-provider="${E(prov)}">保存</button>
      </div>
    </div>
  `;
  rc.innerHTML = html;
  if (info.hasKey) {
    void revealProviderKey(prov);
    loadProviderModels(prov);
  }
}

async function revealProviderKey(prov: string): Promise<void> {
  const requestId = ++_revealRequestId;
  try {
    const response = await fetch('/api/auth/reveal', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider: prov }),
    });
    if (!response.ok) return;
    const data = await response.json() as { apiKey?: string };
    const input = $('key-input') as HTMLInputElement | null;
    if (requestId === _revealRequestId && _selectedProvider === prov && input?.dataset.provider === prov && typeof data.apiKey === 'string') {
      input.value = data.apiKey;
    }
  } catch {}
}

function toggleKeyVis(prov: string): void {
  const input = $('key-input') as HTMLInputElement | null;
  if (!input || input.dataset.provider !== prov) return;
  input.type = (input.type === 'password' ? 'text' : 'password');
}

function saveApiKey(provider: string): void {
  const input = $('key-input') as HTMLInputElement | null;
  if (!input || input.dataset.provider !== provider || !input.value.trim()) { toast('请输入 API Key'); return; }
  fetch('/api/auth', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ provider, apiKey: input.value.trim() }) })
    .then(r => r.json()).then((r: { ok: boolean }) => {
      if (r.ok) {
        toast('已保存');
        _provKeys[provider] = { hasKey: true, keyPreview: input.value.trim().slice(0, 8) + '...' };
        selectProvider(provider);
      } else toast('保存失败');
    }).catch(() => toast('保存失败'));
}

function loadProviderModels(prov: string): void {
  const container = $('rp-models') as HTMLElement | null;
  if (!container || container.dataset.provider !== prov) return;
  fetch('/api/models').then(r => r.json()).then((data: { models?: Array<{ provider: string; id: string }> }) => {
    if (_selectedProvider !== prov || $('rp-models') !== container) return;
    const models = (data.models || []).filter(m => m.provider === prov);
    if (models.length === 0) { container.innerHTML = '<p style="color:var(--tm);font-size:.72rem">无可用模型</p>'; return; }
    let html = '<div class="rp-models-title">可用模型</div>';
    models.forEach(m => {
      const stD = (window as any).App?.ChatState?.getDashboard?.() || null;
      const active = (m.provider === stD?.modelProvider && m.id === stD?.modelId);
      html += `<div class="rp-model-item${active?' on':''}" data-model-provider="${E(m.provider)}" data-model-id="${E(m.id)}">${E(m.id)}</div>`;
    });
    container.innerHTML = html;
  }).catch(() => { container.innerHTML = '<p style="color:var(--rs);font-size:.72rem">加载失败</p>'; toast('加载模型列表失败', 'error'); });
}

function selectModel(provider: string, modelId: string): void {
  fetch('/api/model/switch', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ provider, modelId }) })
    .then(r => r.json()).then((r: { ok: boolean; error?: string }) => {
      if (r.ok) {
        toast('已切换: ' + modelId, 'success');
        getD();
        document.querySelectorAll('.rp-model-item').forEach(el => {
          const item = el as HTMLElement;
          item.classList.toggle('on', item.dataset.modelProvider === provider && item.dataset.modelId === modelId);
        });
      } else { toast('切换失败: ' + (r.error || ''), 'error'); }
    }).catch(() => { toast('切换失败', 'error'); });
}

// ═══════════════════════════════════════════════════════════════════
//  通用设置 — 字体/缩进/主题
// ═══════════════════════════════════════════════════════════════════

function toggleAutoSaveSetting(): void {
  const el = document.getElementById('gs-autosave') as HTMLInputElement | null;
  if (el) {
    App.Preferences.setBoolean('auto-save', el.checked);
    toast('自动保存: ' + (el.checked ? '开' : '关'));
  }
}

function changeFontSize(delta: number): void {
  const el = $('gs-fontsize');
  if (!el) return;
  let size = parseInt(el.textContent || '13', 10);
  size = Math.max(10, Math.min(24, size + delta));
  el.textContent = String(size);
  App.Preferences.set('editor-font-size', String(size));
  applyEditorSettings();
}

function applyGeneralSetting(): void {
  const typeEl = $('gs-indent-type') as HTMLSelectElement | null;
  const sizeEl = $('gs-tab-size') as HTMLSelectElement | null;
  const themeEl = $('gs-theme') as HTMLSelectElement | null;
  if (typeEl) App.Preferences.set('editor-use-tabs', typeEl.value);
  if (sizeEl) App.Preferences.set('editor-tab-size', sizeEl.value);
  if (themeEl) App.Preferences.set('editor-theme', themeEl.value);
  applyEditorSettings();
}

function applyReadingSetting(target: HTMLElement): void {
  if (target.id === 'gs-timeline-enabled') {
    App.Preferences.setBoolean('chat-timeline-enabled', (target as HTMLInputElement).checked);
    (App.ChatTimeline as any).refreshSettings();
    return;
  }
  if (target.id === 'gs-timeline-window') {
    App.Preferences.set('chat-timeline-window-size', (target as HTMLSelectElement).value);
    (App.ChatTimeline as any).refreshSettings();
    return;
  }
  if (target.id === 'gs-jump-enabled') {
    App.Preferences.setBoolean('chat-jump-latest-enabled', (target as HTMLInputElement).checked);
    (App.Chat as any).refreshReadingSettings();
    return;
  }
  if (target.id === 'gs-jump-smooth') {
    App.Preferences.setBoolean('chat-jump-latest-smooth', (target as HTMLSelectElement).value === 'true');
    (App.Chat as any).refreshReadingSettings();
    return;
  }
  if (target.id === 'gs-jump-threshold') {
    App.Preferences.set('chat-jump-latest-threshold', (target as HTMLSelectElement).value);
    (App.Chat as any).refreshReadingSettings();
  }
}

function applySubagentSetting(target: HTMLInputElement): void {
  const value = Math.min(30, Math.max(1, Math.trunc(Number(target.value) || 1)));
  target.value = String(value);
  const key = target.id === 'gs-subagent-max-tasks'
    ? 'subagent-max-tasks'
    : 'subagent-max-concurrent';
  App.Preferences.set(key, String(value));
  void App.Preferences.flush();
}

function changeSubagentSetting(inputId: string, delta: number): void {
  const input = $(inputId) as HTMLInputElement | null;
  if (!input) return;
  input.value = String(Number(input.value) + delta);
  applySubagentSetting(input);
}

async function loadCustomSubagents(): Promise<void> {
  try {
    const [agentsResponse, modelsResponse] = await Promise.all([
      fetch('/api/subagents'),
      fetch('/api/models'),
    ]);
    if (!agentsResponse.ok || !modelsResponse.ok) throw new Error('加载失败');
    const agentsData = await agentsResponse.json() as { agents?: CustomSubagent[] };
    const modelsData = await modelsResponse.json() as { models?: Array<{ provider: string; id: string }> };
    _customSubagents = Array.isArray(agentsData.agents) ? agentsData.agents : [];
    _subagentModels = Array.isArray(modelsData.models) ? modelsData.models : [];
    _selectedSubagentId = _customSubagents[0]?.id ?? null;
    _subagentDeleteArmedId = null;
    renderCustomSubagentManager();
  } catch {
    const list = $('sa-agent-list');
    if (list) list.innerHTML = '<div class="sa-empty sa-error">Agent 配置加载失败</div>';
  }
}

class SettingsCustomSubagentManagerView {
  static render(draft?: CustomSubagent): void {
    const list = $('sa-agent-list');
    const editor = $('sa-editor');
    if (!list || !editor) return;
    list.innerHTML = _customSubagents.length > 0
      ? _customSubagents.map((agent) => `
      <div class="sa-agent-item${agent.id === _selectedSubagentId ? ' on' : ''}" data-agent-id="${E(agent.id)}">
        <button type="button" class="sa-agent-select" data-agent-id="${E(agent.id)}">
          <span class="sa-agent-name">${E(agent.name)}</span>
          <span class="sa-agent-id">${E(agent.id)}</span>
        </button>
        <button type="button" class="sa-delete-btn${_subagentDeleteArmedId === agent.id ? ' armed' : ''}" data-settings-action="delete-subagent" data-agent-id="${E(agent.id)}" aria-label="${_subagentDeleteArmedId === agent.id ? '再次点击删除' : '删除'} ${E(agent.name)}" title="${_subagentDeleteArmedId === agent.id ? '再次点击确认删除' : '删除 Agent'}"><svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true"><use href="#itrash"></use></svg></button>
      </div>`).join('')
      : '<div class="sa-empty">暂无自定义 Agent</div>';
    const selected = draft ?? _customSubagents.find((agent) => agent.id === _selectedSubagentId);
    if (!selected) {
      editor.innerHTML = '<div class="sa-empty">新建一个 Agent，为常用分析任务固定角色和工具</div>';
      return;
    }
    const modelValue = selected.model ? JSON.stringify(selected.model) : '';
    const modelOptions = _subagentModels.map((model) => {
      const value = JSON.stringify(model);
      return `<option value="${E(value)}"${value === modelValue ? ' selected' : ''}>${E(model.provider)} / ${E(model.id)}</option>`;
    }).join('');
    const isPersisted = _customSubagents.some((agent) => agent.id === selected.id);
    editor.innerHTML = `
    <div class="sa-form-grid">
      <label class="sa-field"><span>名称</span><input id="sa-name" maxlength="80" value="${E(selected.name)}" placeholder="例如：安全审计"></label>
      <label class="sa-field"><span>Agent ID</span><input id="sa-id" maxlength="64" value="${E(selected.id)}" placeholder="security-reviewer"${isPersisted ? ' readonly' : ''}></label>
      <label class="sa-field sa-field-wide"><span>描述</span><input id="sa-description" maxlength="240" value="${E(selected.description)}" placeholder="告诉主 Agent 何时使用它"></label>
      <label class="sa-field sa-field-wide"><span>默认模型</span><select id="sa-model"><option value="">继承主 Agent</option>${modelOptions}</select></label>
      <fieldset class="sa-field sa-field-wide sa-tools"><legend>只读工具</legend>${SUBAGENT_READ_ONLY_TOOLS.map(([id, label]) => `<label><input id="sa-tool-${E(id)}" type="checkbox" value="${E(id)}"${selected.tools.includes(id) ? ' checked' : ''}><span>${E(label)}</span></label>`).join('')}</fieldset>
      <label class="sa-field sa-field-wide"><span>角色指令</span><textarea id="sa-prompt" maxlength="8000" rows="7" placeholder="描述职责、关注点和输出要求">${E(selected.prompt)}</textarea></label>
    </div>
    <div class="sa-form-actions">
      <span></span>
      <button type="button" class="sa-save-btn" data-settings-action="save-subagent">保存 Agent</button>
    </div>`;
  }
}

function renderCustomSubagentManager(draft?: CustomSubagent): void {
  return SettingsCustomSubagentManagerView.render(draft);
}

function startNewSubagent(): void {
  _selectedSubagentId = null;
  _subagentDeleteArmedId = null;
  renderCustomSubagentManager({ id: '', name: '', description: '', prompt: '', tools: ['search', 'file_read'] });
}

function selectCustomSubagent(id: string): void {
  _selectedSubagentId = id;
  _subagentDeleteArmedId = null;
  renderCustomSubagentManager();
}

function customSubagentFromForm(): CustomSubagent | null {
  const id = ($('sa-id') as HTMLInputElement | null)?.value.trim() || '';
  const name = ($('sa-name') as HTMLInputElement | null)?.value.trim() || '';
  const description = ($('sa-description') as HTMLInputElement | null)?.value.trim() || '';
  const prompt = ($('sa-prompt') as HTMLTextAreaElement | null)?.value.trim() || '';
  const modelRaw = ($('sa-model') as HTMLSelectElement | null)?.value || '';
  const tools = SUBAGENT_READ_ONLY_TOOLS
    .map(([tool]) => tool)
    .filter((tool) => ($(`sa-tool-${tool}`) as HTMLInputElement | null)?.checked);
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(id)) { toast('Agent ID 只能使用小写字母、数字和短横线', 'error'); return null; }
  if (!name || !prompt) { toast('请填写名称和角色指令', 'error'); return null; }
  if (tools.length === 0) { toast('至少选择一个只读工具', 'error'); return null; }
  let model: { provider: string; id: string } | undefined;
  if (modelRaw) {
    try { model = JSON.parse(modelRaw); } catch { toast('模型配置无效', 'error'); return null; }
  }
  return { id, name, description, prompt, tools, ...(model ? { model } : {}) };
}

async function persistCustomSubagents(agents: CustomSubagent[]): Promise<boolean> {
  try {
    const response = await fetch('/api/subagents', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agents }),
    });
    const result = await response.json() as { agents?: CustomSubagent[]; error?: string };
    if (!response.ok) throw new Error(result.error || '保存失败');
    _customSubagents = result.agents ?? agents;
    return true;
  } catch (error) {
    toast(error instanceof Error ? error.message : '保存失败', 'error');
    return false;
  }
}

async function saveCustomSubagent(): Promise<void> {
  const agent = customSubagentFromForm();
  if (!agent) return;
  const existingIndex = _customSubagents.findIndex((item) => item.id === agent.id);
  const next = [..._customSubagents];
  if (existingIndex >= 0) next[existingIndex] = agent;
  else next.push(agent);
  if (!await persistCustomSubagents(next)) return;
  _selectedSubagentId = agent.id;
  _subagentDeleteArmedId = null;
  renderCustomSubagentManager();
  toast('Agent 已保存', 'success');
}

async function deleteCustomSubagent(id: string): Promise<void> {
  if (!_customSubagents.some((agent) => agent.id === id)) return;
  if (_subagentDeleteArmedId !== id) {
    _subagentDeleteArmedId = id;
    renderCustomSubagentManager();
    return;
  }
  const next = _customSubagents.filter((agent) => agent.id !== id);
  if (!await persistCustomSubagents(next)) return;
  if (_selectedSubagentId === id) _selectedSubagentId = next[0]?.id ?? null;
  _subagentDeleteArmedId = null;
  renderCustomSubagentManager();
  toast('Agent 已删除');
}

function applyEditorSettings(): void {
  const theme = App.Preferences.get('editor-theme', 'vs-dark');
  document.documentElement.classList.toggle('theme-light', theme === 'vs');
  const m = (window as any).__monaco;
  if (m?.updateSettings) m.updateSettings();
}

class SettingsStorageLocationView {
  static mount(container: HTMLElement): void {
    container.insertAdjacentHTML('beforeend', SettingsStorageLocationView.render());

    const section = container.querySelector<HTMLElement>('[data-storage-location]');
    const status = section?.querySelector<HTMLElement>('#gs-data-root-status');
    const instance = section?.querySelector<HTMLElement>('#gs-instance-id');
    const lock = section?.querySelector<HTMLElement>('#gs-workspace-lock');
    if (!section || !status) return;
    fetch('/api/storage-location').then(r => r.json()).then((info: Partial<StorageLocationInfo>) => {
      if (!status.isConnected) return;
      if (!info.dataRoot) throw new Error('missing data root');
      status.textContent = info.restartRequired
        ? `${info.dataRoot}（重启后生效）`
        : String(info.dataRoot);
      status.title = status.textContent;
      if (instance) {
        instance.textContent = String(info.instanceId || '未知');
        instance.title = instance.textContent;
      }
      if (lock) {
        const owner = info.workspaceLock?.owner;
        lock.textContent = info.workspaceLock?.locked
          ? `已锁定：${owner?.pid || '未知进程'}`
          : '未锁定';
        lock.title = owner?.workspace || lock.textContent;
      }
    }).catch(() => {
      if (status.isConnected) status.textContent = '读取失败';
    });
  }

  static render(): string {
    return `
      <div class="gs-section" data-storage-location>
        <div class="gs-section-title">存储位置</div>
        <div class="gs-group">
          <div class="gs-row gs-storage-row">
            <span class="gs-label">数据根目录</span>
            <span class="gs-value gs-storage-value" id="gs-data-root-status">读取中...</span>
            <div class="gs-storage-actions">
              <button type="button" class="gs-btn gs-storage-btn" data-settings-action="choose-data-root"><svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true"><use href="#ifolder"></use></svg><span>选择目录</span></button>
            </div>
          </div>
          <div class="gs-row gs-storage-row">
            <span class="gs-label">实例 ID</span>
            <span class="gs-value gs-storage-value gs-storage-value-wide" id="gs-instance-id">读取中...</span>
          </div>
          <div class="gs-row gs-storage-row">
            <span class="gs-label">工作区锁</span>
            <span class="gs-value gs-storage-value gs-storage-value-wide" id="gs-workspace-lock">读取中...</span>
          </div>
          <div class="gs-row gs-storage-row">
            <span class="gs-label">旧数据迁移</span>
            <span class="gs-value gs-storage-value" id="gs-migration-status">检查中...</span>
            <div class="gs-storage-actions">
              <button type="button" class="gs-btn gs-storage-btn" data-settings-action="preview-storage-migration">检查</button>
              <button type="button" class="gs-btn gs-storage-btn" data-settings-action="confirm-storage-migration" id="gs-migration-confirm" style="display:none">确认迁移</button>
            </div>
          </div>
          <div class="gs-row gs-storage-row gs-storage-note-row" style="border:none">
            <span class="gs-desc gs-storage-note">新位置将在重启后使用，当前会话与缓存不会在运行中移动。</span>
          </div>
        </div>
      </div>
    `;
  }
}

function renderStorageLocationSettings(container: HTMLElement): void {
  return SettingsStorageLocationView.mount(container);
}

interface StorageMigrationPreview {
  fileCount: number;
  bytes: number;
  conflicts: string[];
  previewId: string;
}

let _storageMigrationPreviewId: string | null = null;
let _storageMigrationPreviewSeq = 0;

function formatStorageBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

async function previewStorageMigration(root: ParentNode = document): Promise<void> {
  const seq = ++_storageMigrationPreviewSeq;
  const status = root.querySelector<HTMLElement>('#gs-migration-status');
  const confirm = root.querySelector<HTMLElement>('#gs-migration-confirm');
  if (!status) return;
  _storageMigrationPreviewId = null;
  if (confirm) confirm.style.display = 'none';
  try {
    const response = await fetch('/api/storage-migration/preview');
    const result = await response.json() as StorageMigrationPreview & { error?: string };
    if (!response.ok) throw new Error(result.error || '检查失败');
    if (seq !== _storageMigrationPreviewSeq || !status.isConnected) return;
    if (!result.previewId) throw new Error('检查结果缺少预览 ID');
    _storageMigrationPreviewId = result.previewId;
    status.textContent = result.conflicts.length > 0
      ? `${result.fileCount} 个文件 · ${formatStorageBytes(result.bytes)} · ${result.conflicts.length} 个冲突`
      : result.fileCount > 0
        ? `${result.fileCount} 个文件 · ${formatStorageBytes(result.bytes)}`
        : '无待迁移数据';
    if (confirm) confirm.style.display = result.fileCount > 0 ? '' : 'none';
  } catch (error) {
    if (seq !== _storageMigrationPreviewSeq || !status.isConnected) return;
    status.textContent = `检查失败: ${(error as Error).message}`;
    if (confirm) confirm.style.display = 'none';
  }
}

async function confirmStorageMigration(): Promise<void> {
  const previewId = _storageMigrationPreviewId;
  if (!previewId) {
    toast('请先检查待迁移数据', 'error');
    return;
  }
  try {
    const response = await fetch('/api/storage-migration/confirm', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirm: true, previewId }),
    });
    const result = await response.json() as { ok?: boolean; error?: string; migration?: { copied?: string[] } };
    if (!response.ok || !result.ok) throw new Error(result.error || '迁移失败');
    toast(`已迁移 ${result.migration?.copied?.length || 0} 个文件，旧数据未删除`, 'success');
    App.Session.loadSessions();
    await previewStorageMigration();
  } catch (error) {
    toast(`旧数据迁移失败: ${(error as Error).message}`, 'error');
    await previewStorageMigration();
  }
}

async function chooseDataRoot(): Promise<void> {
  const api = window.electronAPI;
  if (!api?.selectFolder) {
    toast('当前环境不支持选择数据目录', 'error');
    return;
  }

  try {
    const selected = await api.selectFolder();
    if (!selected) return;

    const response = await fetch('/api/storage-location', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ dataRoot: selected }),
    });
    const result = await response.json() as { ok?: boolean; error?: string; restartRequired?: boolean };
    if (!response.ok || !result.ok) throw new Error(result.error || '保存失败');
    const status = $('gs-data-root-status');
    if (status) {
      status.textContent = `${selected}（重启后生效）`;
      status.title = status.textContent;
    }
    toast('数据目录已保存，重启后生效', 'success');
  } catch (error) {
    toast(`数据目录保存失败: ${(error as Error).message}`, 'error');
  }
}

// ═══════════════════════════════════════════════════════════════════
//  厂商拖拽排序 (HTML5 DnD)
// ═══════════════════════════════════════════════════════════════════

let _dragIdx: number = -1;

function provDragStart(ev: DragEvent, idx: number): void {
  _dragIdx = idx;
  if (ev.dataTransfer) {
    ev.dataTransfer.effectAllowed = 'move';
    ev.dataTransfer.setData('text/plain', String(idx));
  }
}
function provDragOver(ev: DragEvent, _idx: number): void {
  ev.preventDefault();
  if (ev.dataTransfer) ev.dataTransfer.dropEffect = 'move';
}

function provDrop(ev: DragEvent, idx: number): void {
  ev.preventDefault();
  if (_dragIdx < 0 || _dragIdx === idx) return;
  const order = window._provOrder || [];
  const item = order.splice(_dragIdx, 1)[0];
  order.splice(idx, 0, item);
  window._provOrder = order;
  App.Preferences.setJson('providers_order', order);
  const list = $('msl-list');
  if (!list) return;
  list.innerHTML = providerListHTML(order);
  _dragIdx = -1;
}

// 公开 API
window.openSettingsModal = openSettingsModal;
window.closeSettingsModal = closeSettingsModal;
window.switchSettingsModal = switchSettingsModal;
window.selectProvider = selectProvider as any;
window.toggleKeyVis = toggleKeyVis;
window.saveApiKey = saveApiKey;
window.loadProviderModels = loadProviderModels;
window.selectModel = selectModel;
window.provDragStart = provDragStart as any;
window.provDragOver = provDragOver as any;
window.provDrop = provDrop as any;
window.changeFontSize = changeFontSize;
window.applyGeneralSetting = applyGeneralSetting;
window.toggleAutoSaveSetting = toggleAutoSaveSetting;

// ─── App 命名空间绑定 ──────────────────────────────────────
const AppSett = (window as any).App?.Settings;
if (AppSett) {
  AppSett.openSettingsModal = openSettingsModal;
  AppSett.closeSettingsModal = closeSettingsModal;
  AppSett.switchSettingsModal = switchSettingsModal;
  AppSett.selectProvider = selectProvider;
  AppSett.toggleKeyVis = toggleKeyVis;
  AppSett.saveApiKey = saveApiKey;
  AppSett.loadProviderModels = loadProviderModels;
  AppSett.selectModel = selectModel;
  AppSett.provDragStart = provDragStart;
  AppSett.provDragOver = provDragOver;
  AppSett.provDrop = provDrop;
  AppSett.changeFontSize = changeFontSize;
  AppSett.applyGeneralSetting = applyGeneralSetting;
  AppSett.toggleAutoSaveSetting = toggleAutoSaveSetting;
}
