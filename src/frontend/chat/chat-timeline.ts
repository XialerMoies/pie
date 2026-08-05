type ChatTimelineItem = {
  assistantMessageIndex: number;
  userMessageIndex: number;
  prompt: string;
};

const CHAT_TIMELINE_MIN_ITEMS = 3;
const CHAT_TIMELINE_DEFAULT_WINDOW_SIZE = 9;
const CHAT_TIMELINE_ALLOWED_WINDOW_SIZES = [5, 7, 9];
const CHAT_TIMELINE_PROMPT_MAX_LENGTH = 12;

let chatTimelineItems: ChatTimelineItem[] = [];
let chatTimelineActiveIndex = 0;
let chatTimelineEnabled = true;
let chatTimelineWindowSize = CHAT_TIMELINE_DEFAULT_WINDOW_SIZE;
let chatTimelineSignature = '';
let chatTimelineBoundHost: HTMLElement | null = null;
let chatTimelineScrollFrame: number | null = null;
let chatTimelineLastWheelAt = 0;

function chatTimelineHost(): HTMLElement | null {
  return $('chat-timeline');
}

function chatTimelineDeriveItems(messages: Message[]): ChatTimelineItem[] {
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

function chatTimelineReadBooleanPreference(key: string, fallback = true): boolean {
  const preferences = (App as any).Preferences;
  if (typeof preferences?.getBoolean !== 'function') return fallback;
  try {
    const value = preferences.getBoolean(key, fallback);
    return typeof value === 'boolean' ? value : fallback;
  } catch {
    return fallback;
  }
}

function chatTimelineReadSettings(): void {
  chatTimelineEnabled = chatTimelineReadBooleanPreference('chat-timeline-enabled');
  const preferences = (App as any).Preferences;
  const windowSize = preferences?.getNumber
    ? preferences.getNumber('chat-timeline-window-size', CHAT_TIMELINE_DEFAULT_WINDOW_SIZE)
    : CHAT_TIMELINE_DEFAULT_WINDOW_SIZE;
  chatTimelineWindowSize = CHAT_TIMELINE_ALLOWED_WINDOW_SIZES.includes(windowSize)
    ? windowSize
    : CHAT_TIMELINE_DEFAULT_WINDOW_SIZE;
}

function chatTimelineVisibleRange(itemCount: number, activeIndex: number): { start: number; end: number } {
  const maxStart = Math.max(0, itemCount - chatTimelineWindowSize);
  const centeredStart = activeIndex - Math.floor(chatTimelineWindowSize / 2);
  const start = Math.min(maxStart, Math.max(0, centeredStart));
  return { start, end: Math.min(itemCount, start + chatTimelineWindowSize) };
}

function chatTimelinePromptPreview(prompt: string): string {
  const normalized = prompt.replace(/\s+/g, ' ').trim();
  const chars = Array.from(normalized);
  if (chars.length <= CHAT_TIMELINE_PROMPT_MAX_LENGTH) return normalized;
  return `${chars.slice(0, CHAT_TIMELINE_PROMPT_MAX_LENGTH - 1).join('')}…`;
}

function chatTimelineHide(host: HTMLElement): void {
  host.classList.remove('on');
  host.setAttribute('aria-hidden', 'true');
  host.replaceChildren();
  chatTimelineSignature = '';
}

function chatTimelineUpdateActiveState(host: HTMLElement): void {
  host.querySelectorAll<HTMLElement>('[data-timeline-index]').forEach((element) => {
    const active = Number(element.dataset.timelineIndex) === chatTimelineActiveIndex;
    element.classList.toggle('active', active);
    if (active) element.setAttribute('aria-current', 'true');
    else element.removeAttribute('aria-current');
  });
}

function chatTimelineRender(host: HTMLElement): void {
  const { start, end } = chatTimelineVisibleRange(chatTimelineItems.length, chatTimelineActiveIndex);
  const visibleItems = chatTimelineItems.slice(start, end);
  const signature = `${start}|${visibleItems.map((item) => `${item.userMessageIndex}:${item.assistantMessageIndex}:${item.prompt}`).join('|')}`;

  host.classList.add('on');
  host.setAttribute('aria-hidden', 'false');
  if (signature === chatTimelineSignature) {
    chatTimelineUpdateActiveState(host);
    return;
  }

  chatTimelineSignature = signature;
  host.innerHTML = `<div class="chat-timeline-directory">${visibleItems.map((item, visibleIndex) => {
    const itemIndex = start + visibleIndex;
    const fullPrompt = item.prompt || '空消息';
    const prompt = E(chatTimelinePromptPreview(fullPrompt));
    const title = E(fullPrompt);
    return `<button class="chat-timeline-item" type="button" data-timeline-index="${itemIndex}" data-user-message-index="${item.userMessageIndex}" data-prompt="${title}" title="${title}"><span class="chat-timeline-prompt">${prompt}</span><span class="chat-timeline-mark" aria-hidden="true"></span></button>`;
  }).join('')}</div>`;
  chatTimelineUpdateActiveState(host);
}

function chatTimelineSync(): void {
  const host = chatTimelineHost();
  if (!host) return;

  chatTimelineReadSettings();
  if (!chatTimelineEnabled) {
    chatTimelineItems = [];
    chatTimelineActiveIndex = 0;
    chatTimelineHide(host);
    return;
  }

  chatTimelineItems = chatTimelineDeriveItems(App.ChatState.getMessages());
  if (chatTimelineItems.length < CHAT_TIMELINE_MIN_ITEMS) {
    chatTimelineActiveIndex = 0;
    chatTimelineHide(host);
    return;
  }

  chatTimelineActiveIndex = Math.min(chatTimelineActiveIndex, chatTimelineItems.length - 1);
  chatTimelineRender(host);
}

function chatTimelineNavigateTo(itemIndex: number): void {
  const messages = $('ms');
  if (!messages || chatTimelineItems.length === 0) return;

  const nextIndex = Math.min(chatTimelineItems.length - 1, Math.max(0, itemIndex));
  const item = chatTimelineItems[nextIndex];
  const target = messages.querySelector<HTMLElement>(`[data-message-index="${item.userMessageIndex}"]`);
  if (!target) return;

  chatTimelineActiveIndex = nextIndex;
  const host = chatTimelineHost();
  if (host) chatTimelineRender(host);
  if (typeof messages.scrollTo === 'function') {
    messages.scrollTo({ top: target.offsetTop, behavior: 'auto' });
  } else {
    messages.scrollTop = target.offsetTop;
  }
}

function chatTimelineOnClick(event: MouseEvent): void {
  const button = (event.target as HTMLElement | null)?.closest<HTMLElement>('[data-timeline-index]');
  if (!button) return;
  chatTimelineNavigateTo(Number(button.dataset.timelineIndex));
}

function chatTimelineOnWheel(event: WheelEvent): void {
  if (event.deltaY === 0 || chatTimelineItems.length === 0) return;
  event.preventDefault();

  const now = Date.now();
  if (now - chatTimelineLastWheelAt < 180) return;
  chatTimelineLastWheelAt = now;
  chatTimelineNavigateTo(chatTimelineActiveIndex + (event.deltaY > 0 ? 1 : -1));
}

function chatTimelineBind(): void {
  const host = chatTimelineHost();
  if (host && host !== chatTimelineBoundHost) {
    host.addEventListener('click', chatTimelineOnClick);
    host.addEventListener('wheel', chatTimelineOnWheel, { passive: false });
    chatTimelineBoundHost = host;
  }
  chatTimelineSync();
}

function chatTimelineSyncActiveFromScroll(): void {
  const messages = $('ms');
  const host = chatTimelineHost();
  if (!messages || !host || chatTimelineItems.length < CHAT_TIMELINE_MIN_ITEMS) return;

  let nextActiveIndex = 0;
  const atBottom = messages.scrollHeight - messages.scrollTop - messages.clientHeight <= 1;
  if (atBottom) {
    nextActiveIndex = chatTimelineItems.length - 1;
  } else {
    const anchor = messages.scrollTop + messages.clientHeight * 0.38;
    for (let index = 0; index < chatTimelineItems.length; index++) {
      const item = chatTimelineItems[index];
      const target = messages.querySelector<HTMLElement>(`[data-message-index="${item.userMessageIndex}"]`);
      if (!target || target.offsetTop > anchor) break;
      nextActiveIndex = index;
    }
  }

  if (nextActiveIndex === chatTimelineActiveIndex) return;
  chatTimelineActiveIndex = nextActiveIndex;
  chatTimelineRender(host);
}

function chatTimelineHandleMessagesScroll(): void {
  if (chatTimelineScrollFrame !== null) return;
  chatTimelineScrollFrame = requestAnimationFrame(() => {
    chatTimelineScrollFrame = null;
    chatTimelineSyncActiveFromScroll();
  });
}

function chatTimelineReset(): void {
  const host = chatTimelineHost();
  chatTimelineItems = [];
  chatTimelineActiveIndex = 0;
  chatTimelineSignature = '';
  chatTimelineLastWheelAt = 0;
  if (chatTimelineScrollFrame !== null) cancelAnimationFrame(chatTimelineScrollFrame);
  chatTimelineScrollFrame = null;
  if (host) chatTimelineHide(host);
}

function chatTimelineRefreshSettings(): void {
  chatTimelineSync();
  if (chatTimelineEnabled) chatTimelineSyncActiveFromScroll();
}

const chatTimelineApp = (window as any).App || ((window as any).App = {});
chatTimelineApp.ChatTimeline = {
  bind: chatTimelineBind,
  sync: chatTimelineSync,
  refreshSettings: chatTimelineRefreshSettings,
  handleMessagesScroll: chatTimelineHandleMessagesScroll,
  reset: chatTimelineReset,
};

export {};
