type ChatTimelineItem = {
  assistantMessageIndex: number;
  userMessageIndex: number;
  prompt: string;
};

const CHAT_TIMELINE_MIN_ITEMS = 3;
const CHAT_TIMELINE_DEFAULT_WINDOW_SIZE = 9;
const CHAT_TIMELINE_ALLOWED_WINDOW_SIZES = [5, 7, 9];
const CHAT_TIMELINE_PROMPT_MAX_LENGTH = 12;

class ChatTimelineView {
  private items: ChatTimelineItem[] = [];
  private activeIndex = 0;
  private enabled = true;
  private windowSize = CHAT_TIMELINE_DEFAULT_WINDOW_SIZE;
  private signature = '';
  private boundHost: HTMLElement | null = null;
  private scrollFrame: number | null = null;
  private lastWheelAt = 0;

  private host(): HTMLElement | null {
    return $('chat-timeline');
  }

  private deriveItems(messages: Message[]): ChatTimelineItem[] {
    const items: ChatTimelineItem[] = [];
    let pendingUserIndex: number | null = null;

    messages.forEach((message, index) => {
      if (message.role === 'user') {
        pendingUserIndex = index;
        return;
      }
      if (message.role !== 'assistant' || pendingUserIndex === null) return;

      items.push({
        assistantMessageIndex: index,
        userMessageIndex: pendingUserIndex,
        prompt: String(messages[pendingUserIndex].content || '').trim(),
      });
      pendingUserIndex = null;
    });

    return items;
  }

  private readBooleanPreference(key: string, fallback = true): boolean {
    const preferences = (App as any).Preferences;
    if (typeof preferences?.getBoolean !== 'function') return fallback;
    try {
      const value = preferences.getBoolean(key, fallback);
      return typeof value === 'boolean' ? value : fallback;
    } catch {
      return fallback;
    }
  }

  private readSettings(): void {
    this.enabled = this.readBooleanPreference('chat-timeline-enabled');
    const preferences = (App as any).Preferences;
    const windowSize = preferences?.getNumber
      ? preferences.getNumber('chat-timeline-window-size', CHAT_TIMELINE_DEFAULT_WINDOW_SIZE)
      : CHAT_TIMELINE_DEFAULT_WINDOW_SIZE;
    this.windowSize = CHAT_TIMELINE_ALLOWED_WINDOW_SIZES.includes(windowSize)
      ? windowSize
      : CHAT_TIMELINE_DEFAULT_WINDOW_SIZE;
  }

  private visibleRange(itemCount: number, activeIndex: number): { start: number; end: number } {
    const maxStart = Math.max(0, itemCount - this.windowSize);
    const centeredStart = activeIndex - Math.floor(this.windowSize / 2);
    const start = Math.min(maxStart, Math.max(0, centeredStart));
    return { start, end: Math.min(itemCount, start + this.windowSize) };
  }

  private promptPreview(prompt: string): string {
    const normalized = prompt.replace(/\s+/g, ' ').trim();
    const chars = Array.from(normalized);
    if (chars.length <= CHAT_TIMELINE_PROMPT_MAX_LENGTH) return normalized;
    return `${chars.slice(0, CHAT_TIMELINE_PROMPT_MAX_LENGTH - 1).join('')}…`;
  }

  private hide(host: HTMLElement): void {
    host.classList.remove('on');
    host.setAttribute('aria-hidden', 'true');
    host.replaceChildren();
    this.signature = '';
  }

  private updateActiveState(host: HTMLElement): void {
    host.querySelectorAll<HTMLElement>('[data-timeline-index]').forEach((element) => {
      const active = Number(element.dataset.timelineIndex) === this.activeIndex;
      element.classList.toggle('active', active);
      if (active) element.setAttribute('aria-current', 'true');
      else element.removeAttribute('aria-current');
    });
  }

  private render(host: HTMLElement): void {
    const { start, end } = this.visibleRange(this.items.length, this.activeIndex);
    const visibleItems = this.items.slice(start, end);
    const signature = `${start}|${visibleItems.map((item) => `${item.userMessageIndex}:${item.assistantMessageIndex}:${item.prompt}`).join('|')}`;

    host.classList.add('on');
    host.setAttribute('aria-hidden', 'false');
    if (signature === this.signature) {
      this.updateActiveState(host);
      return;
    }

    this.signature = signature;
    host.innerHTML = `<div class="chat-timeline-directory">${visibleItems.map((item, visibleIndex) => {
      const itemIndex = start + visibleIndex;
      const fullPrompt = item.prompt || '空消息';
      const prompt = E(this.promptPreview(fullPrompt));
      const title = E(fullPrompt);
      return `<button class="chat-timeline-item" type="button" data-timeline-index="${itemIndex}" data-user-message-index="${item.userMessageIndex}" data-prompt="${title}" title="${title}"><span class="chat-timeline-prompt">${prompt}</span><span class="chat-timeline-mark" aria-hidden="true"></span></button>`;
    }).join('')}</div>`;
    this.updateActiveState(host);
  }

  sync(): void {
    const host = this.host();
    if (!host) return;

    this.readSettings();
    if (!this.enabled) {
      this.items = [];
      this.activeIndex = 0;
      this.hide(host);
      return;
    }

    this.items = this.deriveItems(App.ChatState.getMessages());
    if (this.items.length < CHAT_TIMELINE_MIN_ITEMS) {
      this.activeIndex = 0;
      this.hide(host);
      return;
    }

    this.activeIndex = Math.min(this.activeIndex, this.items.length - 1);
    this.render(host);
  }

  private navigateTo(itemIndex: number): void {
    const messages = $('ms');
    if (!messages || this.items.length === 0) return;

    const nextIndex = Math.min(this.items.length - 1, Math.max(0, itemIndex));
    const item = this.items[nextIndex];
    const target = messages.querySelector<HTMLElement>(`[data-message-index="${item.userMessageIndex}"]`);
    if (!target) return;

    this.activeIndex = nextIndex;
    const host = this.host();
    if (host) this.render(host);
    if (typeof messages.scrollTo === 'function') {
      messages.scrollTo({ top: target.offsetTop, behavior: 'auto' });
    } else {
      messages.scrollTop = target.offsetTop;
    }
  }

  private readonly onClick = (event: MouseEvent): void => {
    const button = (event.target as HTMLElement | null)?.closest<HTMLElement>('[data-timeline-index]');
    if (!button) return;
    this.navigateTo(Number(button.dataset.timelineIndex));
  };

  private readonly onWheel = (event: WheelEvent): void => {
    if (event.deltaY === 0 || this.items.length === 0) return;
    event.preventDefault();

    const now = Date.now();
    if (now - this.lastWheelAt < 180) return;
    this.lastWheelAt = now;
    this.navigateTo(this.activeIndex + (event.deltaY > 0 ? 1 : -1));
  };

  bind(): void {
    const host = this.host();
    if (host && host !== this.boundHost) {
      this.unbindHost();
      host.addEventListener('click', this.onClick);
      host.addEventListener('wheel', this.onWheel, { passive: false });
      this.boundHost = host;
    }
    this.sync();
  }

  private syncActiveFromScroll(): void {
    const messages = $('ms');
    const host = this.host();
    if (!messages || !host || this.items.length < CHAT_TIMELINE_MIN_ITEMS) return;

    let nextActiveIndex = 0;
    const atBottom = messages.scrollHeight - messages.scrollTop - messages.clientHeight <= 1;
    if (atBottom) {
      nextActiveIndex = this.items.length - 1;
    } else {
      const anchor = messages.scrollTop + messages.clientHeight * 0.38;
      for (let index = 0; index < this.items.length; index++) {
        const item = this.items[index];
        const target = messages.querySelector<HTMLElement>(`[data-message-index="${item.userMessageIndex}"]`);
        if (!target || target.offsetTop > anchor) break;
        nextActiveIndex = index;
      }
    }

    if (nextActiveIndex === this.activeIndex) return;
    this.activeIndex = nextActiveIndex;
    this.render(host);
  }

  handleMessagesScroll(): void {
    if (this.scrollFrame !== null) return;
    this.scrollFrame = requestAnimationFrame(() => {
      this.scrollFrame = null;
      this.syncActiveFromScroll();
    });
  }

  reset(): void {
    const host = this.host();
    this.items = [];
    this.activeIndex = 0;
    this.signature = '';
    this.lastWheelAt = 0;
    this.cancelScrollFrame();
    if (host) this.hide(host);
  }

  refreshSettings(): void {
    this.sync();
    if (this.enabled) this.syncActiveFromScroll();
  }

  dispose(): void {
    this.unbindHost();
    this.cancelScrollFrame();
  }

  private unbindHost(): void {
    if (!this.boundHost) return;
    this.boundHost.removeEventListener('click', this.onClick);
    this.boundHost.removeEventListener('wheel', this.onWheel);
    this.boundHost = null;
  }

  private cancelScrollFrame(): void {
    if (this.scrollFrame !== null) cancelAnimationFrame(this.scrollFrame);
    this.scrollFrame = null;
  }
}

const timelineView = new ChatTimelineView();
const chatTimelineApp = (window as any).App || ((window as any).App = {});
chatTimelineApp.ChatTimeline = {
  bind: () => timelineView.bind(),
  sync: () => timelineView.sync(),
  refreshSettings: () => timelineView.refreshSettings(),
  handleMessagesScroll: () => timelineView.handleMessagesScroll(),
  reset: () => timelineView.reset(),
};

export {};
