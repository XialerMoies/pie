/**
 * Chat (Session History) pane — 会话列表面板
 */
/// <reference path="../../dashboard.d.ts" />

function chatPaneRender(container: HTMLElement): void {
  container.innerHTML = [
    '<div class="sg-t">任务线程</div>',
    '<div class="session-kicker">按当前任务、历史任务和项目归档整理</div>',
    '<div class="session-list" id="sl">加载中...</div>',
  ].join('');
  loadSessions();
}

registerPane('chat', chatPaneRender);
