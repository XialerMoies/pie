/// <reference path="../dashboard.d.ts" />

const settingsFacadeApp = (window as any).App as AppNamespace;
const settingsComponents = settingsFacadeApp.SettingsComponents;
const settingsPermissions = settingsFacadeApp.Permissions;
let settingsActiveTab = 'model';

function bindSettingsModalEvents(overlay: HTMLElement): void {
  overlay.addEventListener('click', event => {
    const target = event.target as HTMLElement;
    const actionTarget = target.closest<HTMLElement>('[data-settings-action]');
    const action = actionTarget?.dataset.settingsAction;
    if (action === 'close') { closeSettingsModal(); return; }
    if (action === 'font-decrease') { changeFontSize(-1); return; }
    if (action === 'font-increase') { changeFontSize(1); return; }
    if (action === 'subagent-decrease' || action === 'subagent-increase') {
      const inputId = actionTarget?.dataset.settingsTarget;
      if (inputId) settingsComponents.general.changeSubagent(inputId, action === 'subagent-increase' ? 1 : -1);
      return;
    }
    if (action === 'new-subagent') { settingsComponents.subagents.startNew(); return; }
    if (action === 'save-subagent') { void settingsComponents.subagents.save(); return; }
    if (action === 'delete-subagent') {
      const agentId = actionTarget?.dataset.agentId;
      if (agentId) void settingsComponents.subagents.delete(agentId);
      return;
    }
    if (action === 'toggle-key') {
      const provider = actionTarget?.dataset.provider;
      if (provider) toggleKeyVis(provider);
      return;
    }
    if (action === 'save-key') {
      const provider = actionTarget?.dataset.provider;
      if (provider) saveApiKey(provider);
      return;
    }
    if (action === 'choose-data-root') { void settingsComponents.storage.chooseDataRoot(); return; }
    if (action === 'preview-storage-migration') { void settingsComponents.storage.previewMigration(); return; }
    if (action === 'confirm-storage-migration') { void settingsComponents.storage.confirmMigration(); return; }

    const tab = target.closest<HTMLElement>('.ms-item[data-st]')?.dataset.st;
    if (tab) { switchSettingsModal(tab); return; }
    const provider = target.closest<HTMLElement>('.msl-item[data-prov]')?.dataset.prov;
    if (provider) { selectProvider(provider); return; }
    const model = target.closest<HTMLElement>('.rp-model-item[data-model-id]');
    const modelProvider = model?.dataset.modelProvider;
    const modelId = model?.dataset.modelId;
    if (modelProvider && modelId) selectModel(modelProvider, modelId);
    const subagentId = target.closest<HTMLElement>('.sa-agent-item[data-agent-id]')?.dataset.agentId;
    if (subagentId) settingsComponents.subagents.select(subagentId);
  });

  overlay.addEventListener('change', event => {
    const target = event.target as HTMLElement;
    if (target.id === 'gs-autosave') toggleAutoSaveSetting();
    else if (target.matches('#gs-indent-type, #gs-tab-size, #gs-theme')) applyGeneralSetting();
    else if (target.matches('#gs-timeline-enabled, #gs-timeline-window, #gs-jump-enabled, #gs-jump-smooth, #gs-jump-threshold')) settingsComponents.general.applyReading(target);
    else if (target.matches('#gs-subagent-max-tasks, #gs-subagent-max-concurrent')) settingsComponents.general.applySubagent(target as HTMLInputElement);
  });

  overlay.addEventListener('dragstart', event => {
    const index = Number((event.target as HTMLElement).closest<HTMLElement>('.msl-item[data-index]')?.dataset.index);
    if (Number.isInteger(index)) provDragStart(event, index);
  });
  overlay.addEventListener('dragover', event => {
    const index = Number((event.target as HTMLElement).closest<HTMLElement>('.msl-item[data-index]')?.dataset.index);
    if (Number.isInteger(index)) provDragOver(event, index);
  });
  overlay.addEventListener('drop', event => {
    const index = Number((event.target as HTMLElement).closest<HTMLElement>('.msl-item[data-index]')?.dataset.index);
    if (Number.isInteger(index)) provDrop(event, index);
  });
}

function openSettingsModal(): void {
  if ($('settings-modal')) { closeSettingsModal(); return; }
  settingsActiveTab = 'model';
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
  if (settingsActiveTab === 'permissions') settingsPermissions?.unmount?.();
  $('settings-modal')?.remove();
}

function switchSettingsModal(tab: string): void {
  const previousTab = settingsActiveTab;
  settingsActiveTab = tab;
  if (previousTab === 'permissions' && tab !== 'permissions') settingsPermissions?.unmount?.();
  document.querySelectorAll('.ms-item').forEach(element => {
    element.classList.toggle('on', (element as HTMLElement).dataset.st === tab);
  });
  const sc = $('mc-settings');
  if (!sc) return;

  if (tab === 'model') {
    settingsComponents.providers.renderTab(sc);
  } else if (tab === 'general') {
    settingsComponents.general.renderGeneralTab(sc);
    settingsComponents.storage.mount(sc);
  } else if (tab === 'subagents') {
    settingsComponents.general.renderSubagentLimits(sc);
    settingsComponents.subagents.mount(sc);
  } else if (tab === 'permissions') {
    sc.innerHTML = '<div id="settings-permissions-root"></div>';
    const root = $('settings-permissions-root');
    if (root && typeof settingsPermissions?.mount === 'function') settingsPermissions.mount(root);
  } else if (tab === 'about') {
    sc.innerHTML = `
      <h3 class="s-title">关于</h3>
      <p class="s-desc">My Code Agent — 基于 PI 框架的自定义编程助手</p>
      <div class="s-section"><span class="s-label">版本</span><span class="s-value">0.0.1</span></div>
      <div class="s-section"><span class="s-label">框架</span><span class="s-value">@xiamol/pi-coding-agent v0.80.3</span></div>
    `;
  }
}

function selectProvider(provider: string): void {
  settingsComponents.providers.selectProvider(provider);
}

function toggleKeyVis(provider: string): void {
  settingsComponents.providers.toggleKeyVisibility(provider);
}

function saveApiKey(provider: string): void {
  settingsComponents.providers.saveApiKey(provider);
}

function loadProviderModels(provider: string): void {
  settingsComponents.providers.loadProviderModels(provider);
}

function selectModel(provider: string, modelId: string): void {
  settingsComponents.providers.selectModel(provider, modelId);
}

function provDragStart(event: DragEvent, index: number): void {
  settingsComponents.providers.dragStart(event, index);
}

function provDragOver(event: DragEvent, index: number): void {
  settingsComponents.providers.dragOver(event, index);
}

function provDrop(event: DragEvent, index: number): void {
  settingsComponents.providers.drop(event, index);
}

function changeFontSize(delta: number): void {
  settingsComponents.general.changeFontSize(delta);
}

function applyGeneralSetting(): void {
  settingsComponents.general.applyGeneral();
}

function toggleAutoSaveSetting(): void {
  settingsComponents.general.toggleAutoSave();
}

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

const settingsFacade = settingsFacadeApp.Settings;
if (settingsFacade) Object.assign(settingsFacade, {
  openSettingsModal,
  closeSettingsModal,
  switchSettingsModal,
  selectProvider,
  toggleKeyVis,
  saveApiKey,
  loadProviderModels,
  selectModel,
  provDragStart,
  provDragOver,
  provDrop,
  changeFontSize,
  applyGeneralSetting,
  toggleAutoSaveSetting,
});
