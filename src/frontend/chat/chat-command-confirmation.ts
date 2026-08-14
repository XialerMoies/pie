/// <reference path="../dashboard.d.ts" />

interface ChatCommandConfirmationEvent {
  id?: string;
  command?: string;
  reason?: string;
  permissionSuggestions?: any[];
}

class ChatCommandConfirmationView {
  static async handle(event: ChatCommandConfirmationEvent): Promise<void> {
    const id = event.id || '';
    if (!id) return;

    const choice = await ChatCommandConfirmationView.choose(event);
    await fetch('/api/chat/command-confirm', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id,
        allow: choice !== 'deny',
        scope: choice === 'workspace'
          ? 'workspace'
          : choice === 'session' ? 'session' : 'once',
      }),
    }).catch(() => undefined);
  }

  private static choose(event: ChatCommandConfirmationEvent): Promise<CommandConfirmChoice> {
    if (typeof confirmCommandAsync === 'function') {
      return confirmCommandAsync({
        command: event.command || '',
        reason: event.reason || '该命令需要确认',
        permissionSuggestions: event.permissionSuggestions || [],
      });
    }

    return confirmAsync(`
      <div style="font-weight:700;margin-bottom:8px">确认执行命令</div>
      <div style="font-size:.76rem;color:var(--ts);margin-bottom:10px">${E(event.reason || '该命令需要确认')}</div>
      <pre style="margin:0;max-width:560px;max-height:220px;overflow:auto;white-space:pre-wrap;word-break:break-word;background:rgba(0,0,0,.18);border:1px solid var(--bd);border-radius:7px;padding:10px;font-family:var(--fm);font-size:.74rem;color:var(--tx)">${E(event.command || '')}</pre>
    `).then(accepted => accepted ? 'session' : 'deny');
  }
}

const chatCommandConfirmationApp = (window as any).App;
if (chatCommandConfirmationApp) {
  chatCommandConfirmationApp.ChatViews = {
    ...(chatCommandConfirmationApp.ChatViews || {}),
    ChatCommandConfirmationView,
  };
}

export {};
