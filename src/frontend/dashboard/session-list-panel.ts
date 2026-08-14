/// <reference path="../dashboard.d.ts" />

interface SessionDataCache {
  sessions: SessionInfo[];
  others: { project: string; path?: string; sessions: SessionInfo[] }[];
}

function parseSessionTime(value?: string): number {
  if (!value) return 0;
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : 0;
}

function formatSessionTime(value?: string): string {
  const time = parseSessionTime(value);
  if (!time) return '时间未知';
  const diff = Date.now() - time;
  const minute = 60 * 1000;
  const hour = 60 * minute;
  const day = 24 * hour;
  if (diff < minute) return '刚刚';
  if (diff < hour) return `${Math.max(1, Math.floor(diff / minute))} 分钟前`;
  if (diff < day) return `${Math.max(1, Math.floor(diff / hour))} 小时前`;
  if (diff < 7 * day) return `${Math.max(1, Math.floor(diff / day))} 天前`;
  return new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit' }).format(new Date(time));
}

function getSessionTimeValue(session: SessionInfo): number {
  return parseSessionTime(session.updatedAt || session.createdAt);
}

function isActiveSession(session: SessionInfo, openSessionIds: Set<string>): boolean {
  return openSessionIds.has(session.id);
}

function deriveThreadStatus(session: SessionInfo, activeId: string): ThreadStatus {
  void activeId;
  if (session.archived) return 'archived';
  if (session.hasError) return 'error';
  if (session.isRunning) return 'running';
  if (session.pinned) return 'pinned';
  if (session.messageCount <= 0) return 'empty';
  return 'success';
}

function threadStatusLabel(status: ThreadStatus): string {
  if (status === 'running') return '运行中';
  if (status === 'error') return '需处理';
  if (status === 'archived') return '已归档';
  if (status === 'pinned') return '固定';
  if (status === 'empty') return '空线程';
  return '已完成';
}

function threadStatusHint(status: ThreadStatus): string {
  if (status === 'running') return '这条线程正在当前工作区推进';
  if (status === 'error') return '上次执行出现错误，建议先查看失败节点';
  if (status === 'archived') return '这条线程已归档，保留用于回看';
  if (status === 'pinned') return '固定线程会保留在顶部，方便继续';
  if (status === 'empty') return '这条线程还没有形成有效对话';
  return '这条任务线程可继续打开或作为分支起点';
}

class SessionEmptyStateView {
  static render(title: string, message: string, actions: string[]): string {
    return `<div class="session-empty">
    <div class="session-empty-icon">${S('imsg', 20)}</div>
    <div class="session-empty-title">${E(title)}</div>
    <div class="session-empty-text">${E(message)}</div>
    <div class="session-empty-actions">${actions.join('')}</div>
  </div>`;
  }
}

class SessionActionsView {
  static render(): string {
    return `<div class="session-actions"><button class="sa-btn primary" data-action="new-session">+ 新会话</button></div>`;
  }
}

class SessionCardView {
  static render(session: SessionInfo, openSessionIds: Set<string>, scopeLabel: string): string {
    const name = session.name || '未命名会话';
    const messageText = session.messageCount > 0 ? `${session.messageCount} 条消息` : '暂无消息';
    const active = isActiveSession(session, openSessionIds);
    const status = deriveThreadStatus(session, active ? session.id : '');
    const timeText = formatSessionTime(session.updatedAt || session.createdAt);
    const className = `sess-item thread-item thread-${status}${active ? ' active' : ''}`;
    const pinTitle = session.pinned ? '取消固定' : '固定线程';
    const pinIcon = session.pinned ? S('ipin-off', 14) : S('ipin', 14);
    const branchText = session.branchFrom?.name ? `从 ${session.branchFrom.name} 分支` : session.branchFrom?.id ? '分支线程' : '';
    const hint = [threadStatusHint(status), messageText, scopeLabel, branchText].filter(Boolean).join(' · ');
    return `<div class="${className}" title="${E(hint)}" data-session-id="${E(session.id)}">
    <div class="thread-row">
      <div class="sess-info thread-info">
        <div class="sess-name thread-name">
          <span class="thread-title">${E(name)}</span>
        </div>
      </div>
      <div class="thread-time">${E(timeText)}</div>
      <div class="sess-ops thread-ops">
        <button class="sess-pin" title="${pinTitle}" aria-label="${pinTitle}" data-action="pin" data-session-id="${E(session.id)}" data-pinned="${session.pinned ? 'true' : 'false'}">${pinIcon}</button>
        <button class="sess-branch" title="创建分支" aria-label="创建分支" data-action="branch" data-session-id="${E(session.id)}">${S('ibranch', 14)}</button>
        <button class="sess-rename" title="重命名" aria-label="重命名" data-action="rename" data-session-id="${E(session.id)}">${S('iedit', 14)}</button>
        <button class="sess-del" title="删除" aria-label="删除" data-action="delete" data-session-id="${E(session.id)}">${S('itrash', 14)}</button>
      </div>
    </div>
  </div>`;
  }
}

class SessionGroupView {
  static render(title: string, hint: string, sessions: SessionInfo[], openSessionIds: Set<string>, scopeLabel: string): string {
    const count = sessions.length;
    const items = sessions.length > 0
      ? sessions.map(session => SessionCardView.render(session, openSessionIds, scopeLabel)).join('')
      : `<div class="session-group-empty">${E(hint)}</div>`;
    return `<div class="session-group">
    <div class="session-group-head"><span>${E(title)}</span><span class="session-group-count">${count}</span></div>
    ${items}
  </div>`;
  }
}

function buildSessionRenderKey(
  sessions: SessionInfo[],
  others: { project: string; path?: string; sessions: SessionInfo[] }[],
  openSessionIds: Set<string>,
): string {
  return JSON.stringify({
    openSessionIds: [...openSessionIds].sort(),
    sessions: sessions.map(session => ({
      id: session.id,
      name: session.name,
      active: session.active,
      messageCount: session.messageCount,
      updatedAt: session.updatedAt || session.createdAt,
      workspace: session.workspace || '',
      pinned: Boolean(session.pinned),
      archived: Boolean(session.archived),
      hasError: Boolean(session.hasError),
      isRunning: Boolean(session.isRunning),
      status: deriveThreadStatus(session, ''),
      branchFrom: session.branchFrom?.id || '',
    })),
    others: others.map(project => ({
      project: project.project,
      path: project.path || '',
      sessions: project.sessions.map(session => ({
        id: session.id,
        name: session.name,
        active: session.active,
        messageCount: session.messageCount,
        updatedAt: session.updatedAt || session.createdAt,
        pinned: Boolean(session.pinned),
        archived: Boolean(session.archived),
        hasError: Boolean(session.hasError),
        isRunning: Boolean(session.isRunning),
        status: deriveThreadStatus(session, ''),
        branchFrom: session.branchFrom?.id || '',
      })),
    })),
  });
}

class SessionListPanelView implements AppSessionListPanel {
  private readonly callbacks: SessionListPanelCallbacks;
  private dataCache: SessionDataCache | null = null;
  private lastRenderKey = '';

  constructor(callbacks: SessionListPanelCallbacks) {
    this.callbacks = callbacks;
  }

  fetchIndex(): Promise<void> {
    const workspace = App.State.getWorkspacePath();
    return fetch('/api/sessions?workspace=' + encodeURIComponent(workspace) + '&other=1')
      .then(response => {
        if (!response.ok) throw new Error('HTTP ' + response.status);
        return response.json();
      })
      .then((data: { sessions?: SessionInfo[]; other?: { project: string; path?: string; sessions: SessionInfo[] }[]; error?: string }) => {
        if (data.error) throw new Error(data.error);
        const sessions = (data.sessions || []).slice().sort((a, b) => getSessionTimeValue(b) - getSessionTimeValue(a));
        const others = data.other || [];
        this.dataCache = { sessions, others };
        this.callbacks.indexSessionTabs(sessions, others);
        this.callbacks.renderSessionTabs(this.callbacks.getActiveSessionTabId() || undefined);
      });
  }

  load(): Promise<void> {
    const element = $('sl');
    if (!element) return this.fetchIndex().catch(() => {});
    if (this.callbacks.isConversationSearchActive()) return Promise.resolve();
    element.classList.add('is-loading');
    return this.fetchIndex().then(() => this.render()).catch(() => {
      const list = $('sl');
      if (list) {
        this.invalidate();
        element.classList.remove('is-loading');
        list.innerHTML = SessionEmptyStateView.render(
          '网络错误',
          '会话列表暂时无法加载，可能是后端未启动或网络被中断。',
          [`<button class="sa-btn primary" data-action="retry">重新加载</button>`, `<button class="sa-btn" data-action="new-session">+ 新会话</button>`],
        );
        this.callbacks.setupListHandler();
      }
      toast('加载会话列表失败', 'error');
    });
  }

  render(): void {
    if (this.callbacks.isConversationSearchActive()) return;
    const element = $('sl');
    if (!element) return;
    if (!this.dataCache) {
      void this.load();
      return;
    }

    const { sessions, others } = this.dataCache;
    const openSessionIds = this.callbacks.getOpenSessionIds();
    const renderKey = buildSessionRenderKey(sessions, others, openSessionIds);
    const needsInitialRender = !element.querySelector('.session-toolbar')
      && !element.querySelector('.session-empty')
      && !element.querySelector('.session-group');
    const hasChanged = needsInitialRender || renderKey !== this.lastRenderKey;
    const pinnedSessions = sessions.filter(session => session.pinned);

    if (sessions.length === 0 && others.length === 0) {
      this.lastRenderKey = renderKey;
      element.classList.remove('is-loading');
      element.innerHTML = SessionEmptyStateView.render(
        '暂无任务线程',
        '新会话会出现在这里，按时间和活跃状态整理成可继续的任务线程。',
        [`<button class="sa-btn primary" data-action="new-session">+ 新会话</button>`],
      );
      this.callbacks.setupListHandler();
      return;
    }

    element.classList.remove('is-loading');
    if (!hasChanged) return;

    let html = '';
    if (pinnedSessions.length > 0) {
      html += SessionGroupView.render('固定线程', '固定的重要任务会留在这里。', pinnedSessions, openSessionIds, '当前项目');
    }
    html += sessions
      .filter(session => !session.pinned)
      .map(session => SessionCardView.render(session, openSessionIds, '当前项目'))
      .join('');

    if (others.length > 0) {
      html += `<div class="sess-other-header" data-action="toggle-other" data-label="其他项目 (${others.length})">? 其他项目 (${others.length})</div>`;
      html += '<div class="sess-other-list" style="display:none">';
      for (const project of others) {
        const projectLabel = project.project === '未分类' ? '未分类（旧会话）' : E(project.project);
        const projectPath = project.path ? ` <span class="sess-other-path">${E(project.path)}</span>` : '';
        const ordered = project.sessions.slice().sort((a, b) => getSessionTimeValue(b) - getSessionTimeValue(a));
        html += `<div class="sess-other-project"><div class="sess-other-title">${projectLabel}${projectPath}</div>`;
        html += ordered.map(session => SessionCardView.render(session, openSessionIds, projectLabel)).join('');
        html += '</div>';
      }
      html += '</div>';
    }

    element.innerHTML = html;
    this.lastRenderKey = renderKey;
    this.callbacks.setupListHandler();
  }

  invalidate(): void {
    this.lastRenderKey = '';
  }

  getSession(id: string): SessionInfo | undefined {
    if (!this.dataCache) return undefined;
    const current = this.dataCache.sessions.find(session => session.id === id);
    if (current) return current;
    for (const project of this.dataCache.others) {
      const session = project.sessions.find(item => item.id === id);
      if (session) return session;
    }
    return undefined;
  }
}

App.SessionViews = {
  ...(App.SessionViews || {}),
  createSessionListPanel: (callbacks: SessionListPanelCallbacks): AppSessionListPanel => new SessionListPanelView(callbacks),
};
