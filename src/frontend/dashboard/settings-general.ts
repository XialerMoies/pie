/// <reference path="../dashboard.d.ts" />

interface SettingsGeneralDependencies {
  preferences: AppPreferences;
  chatTimeline: AppChatTimeline;
  chat: AppChat;
  notify: typeof toast;
  updateEditor: () => void;
}

class SettingsGeneralController implements SettingsGeneralApi {
  constructor(private readonly dependencies: SettingsGeneralDependencies) {}

  renderGeneralTab(container: HTMLElement): void {
    const preferences = this.dependencies.preferences;
    const fontSize = String(preferences.getNumber('editor-font-size', 13, 10, 24));
    const tabSize = String(preferences.getNumber('editor-tab-size', 2, 1, 16));
    const useTabs = preferences.getBoolean('editor-use-tabs');
    const theme = preferences.get('editor-theme', 'vs-dark');
    const timelineEnabled = preferences.getBoolean('chat-timeline-enabled', true);
    const timelineWindow = this.getAllowedSetting('chat-timeline-window-size', '9', ['5', '7', '9']);
    const jumpEnabled = preferences.getBoolean('chat-jump-latest-enabled', true);
    const jumpSmooth = preferences.getBoolean('chat-jump-latest-smooth', true);
    const jumpThreshold = this.getAllowedSetting('chat-jump-latest-threshold', '72', ['48', '72', '120']);
    container.innerHTML = `
      <h3 class="s-title">通用设置</h3>
      <p class="s-desc">应用与编辑器偏好设置，即时生效。</p>

      <div class="gs-section">
        <div class="gs-section-title">应用设置</div>
        <div class="gs-group">
          <div class="gs-row" style="border:none">
            <span class="gs-label">自动保存</span>
            <div class="gs-control">
              <label class="gs-toggle"><input type="checkbox" id="gs-autosave"${preferences.getBoolean('auto-save') ? ' checked' : ''}><span class="gs-toggle-slider"></span></label>
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
                <option value="0"${useTabs ? '' : ' selected'}>空格</option>
                <option value="1"${useTabs ? ' selected' : ''}>制表符</option>
              </select>
              <select class="gs-select" id="gs-tab-size">
                <option value="2"${tabSize === '2' ? ' selected' : ''}>2</option>
                <option value="4"${tabSize === '4' ? ' selected' : ''}>4</option>
                <option value="8"${tabSize === '8' ? ' selected' : ''}>8</option>
              </select>
            </div>
          </div>
          <div class="gs-row" style="border:none">
            <span class="gs-label">主题</span>
            <div class="gs-control">
              <select class="gs-select" id="gs-theme">
                <option value="vs-dark"${theme === 'vs-dark' ? ' selected' : ''}>应用暗色</option>
                <option value="vs"${theme === 'vs' ? ' selected' : ''}>应用亮色</option>
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
    const timelineWindowElement = $('gs-timeline-window') as HTMLSelectElement | null;
    if (timelineWindowElement) timelineWindowElement.value = timelineWindow;
    const jumpThresholdElement = $('gs-jump-threshold') as HTMLSelectElement | null;
    if (jumpThresholdElement) jumpThresholdElement.value = jumpThreshold;
  }

  renderSubagentLimits(container: HTMLElement): void {
    const maxTasks = String(this.dependencies.preferences.getNumber('subagent-max-tasks', 4, 1, 30));
    const maxConcurrent = String(this.dependencies.preferences.getNumber('subagent-max-concurrent', 2, 1, 30));
    container.innerHTML = `
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
    `;
  }

  toggleAutoSave(): void {
    const element = $('gs-autosave') as HTMLInputElement | null;
    if (!element) return;
    this.dependencies.preferences.setBoolean('auto-save', element.checked);
    this.dependencies.notify('自动保存: ' + (element.checked ? '开' : '关'));
  }

  changeFontSize(delta: number): void {
    const element = $('gs-fontsize');
    if (!element) return;
    const size = Math.max(10, Math.min(24, parseInt(element.textContent || '13', 10) + delta));
    element.textContent = String(size);
    this.dependencies.preferences.set('editor-font-size', String(size));
    this.dependencies.updateEditor();
  }

  applyGeneral(): void {
    const typeElement = $('gs-indent-type') as HTMLSelectElement | null;
    const sizeElement = $('gs-tab-size') as HTMLSelectElement | null;
    const themeElement = $('gs-theme') as HTMLSelectElement | null;
    if (typeElement) this.dependencies.preferences.set('editor-use-tabs', typeElement.value);
    if (sizeElement) this.dependencies.preferences.set('editor-tab-size', sizeElement.value);
    if (themeElement) this.dependencies.preferences.set('editor-theme', themeElement.value);
    this.dependencies.updateEditor();
  }

  applyReading(target: HTMLElement): void {
    const preferences = this.dependencies.preferences;
    if (target.id === 'gs-timeline-enabled') {
      preferences.setBoolean('chat-timeline-enabled', (target as HTMLInputElement).checked);
      this.dependencies.chatTimeline.refreshSettings();
    } else if (target.id === 'gs-timeline-window') {
      preferences.set('chat-timeline-window-size', (target as HTMLSelectElement).value);
      this.dependencies.chatTimeline.refreshSettings();
    } else if (target.id === 'gs-jump-enabled') {
      preferences.setBoolean('chat-jump-latest-enabled', (target as HTMLInputElement).checked);
      this.dependencies.chat.refreshReadingSettings();
    } else if (target.id === 'gs-jump-smooth') {
      preferences.setBoolean('chat-jump-latest-smooth', (target as HTMLSelectElement).value === 'true');
      this.dependencies.chat.refreshReadingSettings();
    } else if (target.id === 'gs-jump-threshold') {
      preferences.set('chat-jump-latest-threshold', (target as HTMLSelectElement).value);
      this.dependencies.chat.refreshReadingSettings();
    }
  }

  applySubagent(target: HTMLInputElement): void {
    const value = Math.min(30, Math.max(1, Math.trunc(Number(target.value) || 1)));
    target.value = String(value);
    const key = target.id === 'gs-subagent-max-tasks' ? 'subagent-max-tasks' : 'subagent-max-concurrent';
    this.dependencies.preferences.set(key, String(value));
    void this.dependencies.preferences.flush();
  }

  changeSubagent(inputId: string, delta: number): void {
    const input = $(inputId) as HTMLInputElement | null;
    if (!input) return;
    input.value = String(Number(input.value) + delta);
    this.applySubagent(input);
  }

  private getAllowedSetting(key: string, fallback: string, allowed: string[]): string {
    const value = this.dependencies.preferences.get(key, fallback);
    return allowed.includes(value) ? value : fallback;
  }
}

const settingsGeneralApp = (window as any).App;
const settingsGeneralController = new SettingsGeneralController({
  preferences: settingsGeneralApp.Preferences,
  chatTimeline: settingsGeneralApp.ChatTimeline,
  chat: settingsGeneralApp.Chat,
  notify: toast,
  updateEditor: () => {
    const theme = settingsGeneralApp.Preferences.get('editor-theme', 'vs-dark');
    document.documentElement.classList.toggle('theme-light', theme === 'vs');
    (window as any).__monaco?.updateSettings?.();
  },
});
settingsGeneralApp.SettingsComponents = {
  ...(settingsGeneralApp.SettingsComponents || {}),
  general: settingsGeneralController,
};
