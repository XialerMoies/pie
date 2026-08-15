/// <reference path="../dashboard.d.ts" />

interface SettingsStorageDependencies {
  session: AppSession;
  notify: typeof toast;
  getDesktopApi: () => ElectronAPI | undefined;
}

interface SettingsStorageMigrationPreview {
  fileCount: number;
  bytes: number;
  conflicts: string[];
  previewId: string;
}

class SettingsStorageController implements SettingsStorageApi {
  private migrationPreviewId: string | null = null;
  private migrationPreviewSequence = 0;

  constructor(private readonly dependencies: SettingsStorageDependencies) {}

  mount(container: HTMLElement): void {
    container.insertAdjacentHTML('beforeend', this.render());
    const section = container.querySelector<HTMLElement>('[data-storage-location]');
    const status = section?.querySelector<HTMLElement>('#gs-data-root-status');
    const instance = section?.querySelector<HTMLElement>('#gs-instance-id');
    const lock = section?.querySelector<HTMLElement>('#gs-workspace-lock');
    if (!section || !status) return;
    fetch('/api/storage-location').then(response => response.json()).then((info: Partial<StorageLocationInfo>) => {
      if (!status.isConnected) return;
      if (!info.dataRoot) throw new Error('missing data root');
      status.textContent = info.restartRequired ? `${info.dataRoot}（重启后生效）` : String(info.dataRoot);
      status.title = status.textContent;
      if (instance) {
        instance.textContent = String(info.instanceId || '未知');
        instance.title = instance.textContent;
      }
      if (lock) {
        const owner = info.workspaceLock?.owner;
        lock.textContent = info.workspaceLock?.locked ? `已锁定：${owner?.pid || '未知进程'}` : '未锁定';
        lock.title = owner?.workspace || lock.textContent;
      }
    }).catch(() => {
      if (status.isConnected) status.textContent = '读取失败';
    });
  }

  async previewMigration(root: ParentNode = document): Promise<void> {
    const sequence = ++this.migrationPreviewSequence;
    const status = root.querySelector<HTMLElement>('#gs-migration-status');
    const confirm = root.querySelector<HTMLElement>('#gs-migration-confirm');
    if (!status) return;
    this.migrationPreviewId = null;
    if (confirm) confirm.style.display = 'none';
    try {
      const response = await fetch('/api/storage-migration/preview');
      const result = await response.json() as SettingsStorageMigrationPreview & { error?: string };
      if (!response.ok) throw new Error(result.error || '检查失败');
      if (sequence !== this.migrationPreviewSequence || !status.isConnected) return;
      if (!result.previewId) throw new Error('检查结果缺少预览 ID');
      this.migrationPreviewId = result.previewId;
      status.textContent = result.conflicts.length > 0
        ? `${result.fileCount} 个文件 · ${this.formatBytes(result.bytes)} · ${result.conflicts.length} 个冲突`
        : result.fileCount > 0
          ? `${result.fileCount} 个文件 · ${this.formatBytes(result.bytes)}`
          : '无待迁移数据';
      if (confirm) confirm.style.display = result.fileCount > 0 ? '' : 'none';
    } catch (error) {
      if (sequence !== this.migrationPreviewSequence || !status.isConnected) return;
      status.textContent = `检查失败: ${(error as Error).message}`;
      if (confirm) confirm.style.display = 'none';
    }
  }

  async confirmMigration(): Promise<void> {
    const previewId = this.migrationPreviewId;
    if (!previewId) {
      this.dependencies.notify('请先检查待迁移数据', 'error');
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
      this.dependencies.notify(`已迁移 ${result.migration?.copied?.length || 0} 个文件，旧数据未删除`, 'success');
      this.dependencies.session.loadSessions();
      await this.previewMigration();
    } catch (error) {
      this.dependencies.notify(`旧数据迁移失败: ${(error as Error).message}`, 'error');
      await this.previewMigration();
    }
  }

  async chooseDataRoot(): Promise<void> {
    const api = this.dependencies.getDesktopApi();
    if (!api?.selectFolder) {
      this.dependencies.notify('当前环境不支持选择数据目录', 'error');
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
      this.dependencies.notify('数据目录已保存，重启后生效', 'success');
    } catch (error) {
      this.dependencies.notify(`数据目录保存失败: ${(error as Error).message}`, 'error');
    }
  }

  private render(): string {
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

  private formatBytes(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }
}

const settingsStorageApp = (window as any).App;
settingsStorageApp.SettingsComponents = {
  ...(settingsStorageApp.SettingsComponents || {}),
  storage: new SettingsStorageController({
    session: settingsStorageApp.Session,
    notify: toast,
    getDesktopApi: () => window.electronAPI,
  }),
};
