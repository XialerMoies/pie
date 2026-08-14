interface ChatReadingControlsCallbacks {
  onScroll?: () => void;
}

interface ChatReadingControlsOptions {
  force?: boolean;
  smooth?: boolean;
}

const CHAT_LATEST_DEFAULT_THRESHOLD = 72;
const CHAT_LATEST_ALLOWED_THRESHOLDS = [48, 72, 120];

class ChatReadingControlsView {
  private messages: HTMLElement | null = null;
  private jumpLatest: HTMLButtonElement | null = null;
  private smoothScrollTimer: ReturnType<typeof setTimeout> | null = null;
  private latestEnabled = true;
  private latestSmooth = true;
  private latestThreshold = CHAT_LATEST_DEFAULT_THRESHOLD;
  private followLatest = true;
  private bound = false;
  private readonly onScroll: () => void;
  private readonly onJumpLatest = (): void => {
    this.scrollToLatest({ force: true });
  };

  constructor(callbacks: ChatReadingControlsCallbacks = {}) {
    this.onScroll = () => {
      if (this.smoothScrollTimer !== null) this.scheduleSmoothScrollSync();
      else this.syncLatestState();
      callbacks.onScroll?.();
    };
  }

  bind(): void {
    const messages = this.currentMessages();
    const jumpLatest = $('chat-jump-latest') as HTMLButtonElement | null;
    if (this.bound && messages === this.messages && jumpLatest === this.jumpLatest) return;
    this.detach();
    this.messages = messages;
    this.jumpLatest = jumpLatest;
    this.messages?.addEventListener('scroll', this.onScroll, { passive: true });
    this.jumpLatest?.addEventListener('click', this.onJumpLatest);
    this.bound = true;
  }

  refreshSettings(): void {
    const preferences = (App as any).Preferences;
    this.latestEnabled = this.readBooleanPreference('chat-jump-latest-enabled');
    this.latestSmooth = this.readBooleanPreference('chat-jump-latest-smooth');
    const threshold = preferences?.getNumber
      ? preferences.getNumber('chat-jump-latest-threshold', CHAT_LATEST_DEFAULT_THRESHOLD)
      : CHAT_LATEST_DEFAULT_THRESHOLD;
    this.latestThreshold = CHAT_LATEST_ALLOWED_THRESHOLDS.includes(threshold)
      ? threshold
      : CHAT_LATEST_DEFAULT_THRESHOLD;
    const messages = this.currentMessages();
    if (messages) this.syncLatestState();
    else this.setJumpLatestVisible(false);
  }

  scrollToLatest(options: ChatReadingControlsOptions = {}): boolean {
    const messages = this.currentMessages();
    if (!messages) return false;
    if (!options.force && !this.followLatest) {
      this.setJumpLatestVisible(true);
      return false;
    }

    this.followLatest = true;
    this.setJumpLatestVisible(false);
    const smooth = options.smooth === undefined ? this.latestSmooth : options.smooth;
    if (smooth && typeof messages.scrollTo === 'function') {
      messages.scrollTo({ top: messages.scrollHeight, behavior: 'smooth' });
      this.scheduleSmoothScrollSync();
    } else {
      messages.scrollTop = messages.scrollHeight;
    }
    return true;
  }

  reset(): void {
    this.clearSmoothScrollTimer();
    this.followLatest = true;
    this.setJumpLatestVisible(false);
  }

  dispose(): void {
    this.clearSmoothScrollTimer();
    this.detach();
    this.messages = null;
    this.jumpLatest = null;
    this.bound = false;
  }

  private currentMessages(): HTMLElement | null {
    const messages = $('ms');
    if (messages !== this.messages && this.bound) {
      this.detach();
      this.bound = false;
    }
    return messages;
  }

  private detach(): void {
    this.messages?.removeEventListener('scroll', this.onScroll);
    this.jumpLatest?.removeEventListener('click', this.onJumpLatest);
  }

  private clearSmoothScrollTimer(): void {
    if (this.smoothScrollTimer !== null) clearTimeout(this.smoothScrollTimer);
    this.smoothScrollTimer = null;
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

  private setJumpLatestVisible(visible: boolean): void {
    const button = this.jumpLatest || ($('chat-jump-latest') as HTMLButtonElement | null);
    if (!button) return;
    visible = visible && this.latestEnabled;
    button.classList.toggle('on', visible);
    button.setAttribute('aria-hidden', visible ? 'false' : 'true');
    button.tabIndex = visible ? 0 : -1;
  }

  private isNearLatest(messages: HTMLElement): boolean {
    return messages.scrollHeight - messages.scrollTop - messages.clientHeight <= this.latestThreshold;
  }

  private syncLatestState(): void {
    const messages = this.currentMessages();
    if (!messages) return;
    const nearLatest = this.isNearLatest(messages);
    this.followLatest = nearLatest;
    this.setJumpLatestVisible(!nearLatest);
  }

  private scheduleSmoothScrollSync(): void {
    this.clearSmoothScrollTimer();
    this.smoothScrollTimer = setTimeout(() => {
      this.smoothScrollTimer = null;
      this.syncLatestState();
    }, 120);
  }
}

interface AppChatReadingControls {
  bind(): void;
  refreshSettings(): void;
  scrollToLatest(options?: ChatReadingControlsOptions): boolean;
  reset(): void;
  dispose(): void;
}

const chatReadingControlsApp = (window as any).App;
if (chatReadingControlsApp) {
  chatReadingControlsApp.ChatViews = {
    ...(chatReadingControlsApp.ChatViews || {}),
    ChatReadingControlsView,
    createReadingControls: (callbacks?: ChatReadingControlsCallbacks): AppChatReadingControls => new ChatReadingControlsView(callbacks),
  };
}

export {};
