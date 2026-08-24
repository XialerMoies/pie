/// <reference path="../dashboard.d.ts" />

interface ChatComposerCallbacks {
  isBusy: () => boolean;
  getInputHistory?: () => string[];
  onInput: (input: HTMLTextAreaElement) => void;
  onSubmit: (text: string) => void;
  onSubmitNote: (text: string, mode: 'steer' | 'followUp') => void;
  onAbort: () => void;
}

class ChatComposerView {
  private static readonly INPUT_MIN_HEIGHT = 34;
  private static readonly INPUT_MAX_HEIGHT = 144;
  private readonly callbacks: ChatComposerCallbacks;
  private input: HTMLTextAreaElement | null = null;
  private sendButton: HTMLButtonElement | null = null;
  private noteMode: 'steer' | 'followUp' = 'steer';
  private inputHistory: string[] = [];
  private historyIndex = -1;
  private historyDraft = '';
  private applyingHistory = false;
  private cleanups: Array<() => void> = [];

  constructor(callbacks: ChatComposerCallbacks) {
    this.callbacks = callbacks;
  }

  static resizeComposerInput(input: HTMLTextAreaElement): void {
    input.style.height = 'auto';
    const contentHeight = Math.max(ChatComposerView.INPUT_MIN_HEIGHT, input.scrollHeight);
    const cappedHeight = Math.min(contentHeight, ChatComposerView.INPUT_MAX_HEIGHT);
    input.style.height = `${cappedHeight}px`;
    input.style.overflowY = contentHeight > ChatComposerView.INPUT_MAX_HEIGHT ? 'auto' : 'hidden';
  }

  bind(): void {
    if (this.input?.isConnected && this.sendButton?.isConnected) return;
    if (this.input || this.sendButton || this.cleanups.length > 0) this.dispose();
    const input = $('ci') as HTMLTextAreaElement | null;
    const sendButton = $('cs') as HTMLButtonElement | null;
    if (!input || !sendButton) return;
    this.input = input;
    this.sendButton = sendButton;

    this.listen(input, 'input', () => {
      if (!this.applyingHistory) this.resetHistoryNavigation();
      ChatComposerView.resizeComposerInput(input);
      this.callbacks.onInput(input);
    });
    this.listen(input, 'keydown', (event) => this.handleKeydown(event as KeyboardEvent));
    this.listen(sendButton, 'click', () => this.sendOrStop());

    const stopButton = $('chat-stop') as HTMLButtonElement | null;
    if (stopButton) this.listen(stopButton, 'click', () => this.callbacks.onAbort());

    const noteModeButton = $('chat-note-mode') as HTMLButtonElement | null;
    if (noteModeButton) {
      this.listen(noteModeButton, 'click', () => {
        this.noteMode = this.noteMode === 'steer' ? 'followUp' : 'steer';
        this.refresh();
      });
    }

    const slash = $('fi-slash');
    slash?.querySelectorAll('.fi-slash-item').forEach(item => {
      this.listen(item, 'click', () => {
        const command = (item as HTMLElement).dataset.cmd || '';
        input.value = command + ' ';
        input.focus();
        slash.style.display = 'none';
        ChatComposerView.resizeComposerInput(input);
      });
    });

  }

  refresh(): void {
    const input = this.input || ($('ci') as HTMLTextAreaElement | null);
    const sendButton = this.sendButton || ($('cs') as HTMLButtonElement | null);
    const busy = this.callbacks.isBusy();
    if (input) input.disabled = false;
    if (sendButton) {
      sendButton.disabled = !input?.value.trim();
      sendButton.innerHTML = S('iup', 16);
      sendButton.title = busy ? '发送补充' : '发送消息';
    }
    const stopButton = $('chat-stop') as HTMLButtonElement | null;
    if (stopButton) stopButton.style.display = busy ? '' : 'none';
    const noteModeButton = $('chat-note-mode') as HTMLButtonElement | null;
    if (noteModeButton) {
      noteModeButton.style.display = busy ? '' : 'none';
      noteModeButton.textContent = this.noteMode === 'followUp' ? '做完再处理' : '当前步骤后';
      noteModeButton.title = this.noteMode === 'followUp'
        ? '补充将在任务完成后处理'
        : '补充将在当前步骤完成后处理';
    }
  }

  dispose(): void {
    for (const cleanup of this.cleanups.splice(0)) cleanup();
    this.input = null;
    this.sendButton = null;
    this.resetHistoryNavigation();
  }

  private handleKeydown(event: KeyboardEvent): void {
    const input = this.input;
    if (!input) return;
    if (this.handleHistoryKey(event)) return;
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      this.sendOrStop();
    }
    if (event.key === 'Escape') {
      const slash = $('fi-slash');
      if (slash) slash.style.display = 'none';
    }
    if (event.key === 'Tab' && input.value.startsWith('/')) {
      event.preventDefault();
      const slash = $('fi-slash');
      if (slash && slash.style.display !== 'none') {
        slash.querySelector<HTMLElement>('.fi-slash-item')?.click();
      }
    }
  }

  private sendOrStop(): void {
    const text = this.input?.value || '';
    this.resetHistoryNavigation();
    if (this.callbacks.isBusy()) this.callbacks.onSubmitNote(text, this.noteMode);
    else this.callbacks.onSubmit(text);
  }

  private handleHistoryKey(event: KeyboardEvent): boolean {
    const input = this.input;
    if (!input || this.callbacks.isBusy() || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return false;
    const start = input.selectionStart ?? input.value.length;
    const end = input.selectionEnd ?? start;
    if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return false;
    const singleLine = !input.value.includes('\n');
    if (event.key === 'ArrowUp' && !singleLine && (start !== 0 || end !== 0)) return false;
    if (event.key === 'ArrowDown' && !singleLine && (start !== input.value.length || end !== input.value.length)) return false;

    if (event.key === 'ArrowDown' && this.historyIndex < 0) return false;
    if (this.historyIndex < 0) {
      this.inputHistory = (this.callbacks.getInputHistory?.() || []).filter((text) => text.trim().length > 0);
      if (this.inputHistory.length === 0) return false;
      this.historyDraft = input.value;
      this.historyIndex = this.inputHistory.length;
    }

    const nextIndex = event.key === 'ArrowUp' ? this.historyIndex - 1 : this.historyIndex + 1;
    if (nextIndex < 0) {
      event.preventDefault();
      return true;
    }
    if (nextIndex >= this.inputHistory.length) {
      this.historyIndex = -1;
      this.setInputValue(this.historyDraft);
    } else {
      this.historyIndex = nextIndex;
      this.setInputValue(this.inputHistory[nextIndex]);
    }
    event.preventDefault();
    return true;
  }

  private setInputValue(value: string): void {
    const input = this.input;
    if (!input) return;
    this.applyingHistory = true;
    input.value = value;
    const cursor = value.length;
    input.setSelectionRange?.(cursor, cursor);
    ChatComposerView.resizeComposerInput(input);
    this.callbacks.onInput(input);
    this.applyingHistory = false;
  }

  private resetHistoryNavigation(): void {
    this.inputHistory = [];
    this.historyIndex = -1;
    this.historyDraft = '';
  }

  private listen(target: EventTarget, type: string, listener: EventListener): void {
    target.addEventListener(type, listener);
    this.cleanups.push(() => target.removeEventListener(type, listener));
  }
}

const chatComposerApp = (window as any).App;
if (chatComposerApp) {
  chatComposerApp.ChatViews = {
    ...(chatComposerApp.ChatViews || {}),
    ChatComposerView,
    createComposer: (callbacks: ChatComposerCallbacks) => new ChatComposerView(callbacks),
    resizeComposerInput: ChatComposerView.resizeComposerInput,
  };
}

export {};
