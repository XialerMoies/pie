// ═══════════════════════════════════════════════════════════════════
//  Slash Command Popup
// ═══════════════════════════════════════════════════════════════════

interface ChatModeDependencies {
  preferences: AppPreferences;
  permissions?: AppPermissions;
}

const chatModeApp = (window as any).App;
const chatModeDependencies: ChatModeDependencies = {
  preferences: chatModeApp.Preferences,
  permissions: chatModeApp.Permissions,
};
const { preferences, permissions } = chatModeDependencies;

function handleSlash(ci: HTMLTextAreaElement): void {
  const slashEl = $('fi-slash');
  if (!slashEl) return;
  const val = ci.value;
  if (val.startsWith('/') && !val.includes(' ')) {
    slashEl.style.display = 'flex';
    slashEl.querySelectorAll('.fi-slash-item').forEach(item => {
      const cmd = (item as HTMLElement).dataset.cmd || '';
      const match = cmd.startsWith(val);
      (item as HTMLElement).style.background = match ? 'var(--bc)' : '';
      (item as HTMLElement).style.color = match ? 'var(--tx)' : '';
    });
  } else {
    slashEl.style.display = 'none';
  }
}

// ═══════════════════════════════════════════════════════════════════
//  Mode & Effort — 模式选择（自动/解释/计划）
// ═══════════════════════════════════════════════════════════════════

const MODE_LABELS: Record<string, string> = { auto: '自动', explain: '解释', plan: '计划' };
const PERMISSION_MODE_ORDER = ['plan', 'standard', 'dontAsk', 'yes'] as const;
const PERMISSION_MODE_LABELS: Record<string, string> = { plan: '逐次确认', standard: '标准', dontAsk: '不询问', yes: 'Yes' };
const EFFORT_LABELS: Record<string, string> = { off: '关闭', minimal: '极少', low: '低', medium: '中', high: '高', xhigh: '极高', max: '最高' };

const MODE_INSTRUCTIONS: Record<string, string> = {
  auto: '',
  explain: '仅解释，不要修改任何文件或执行命令。',
  plan: '',
};

const EFFORT_INSTRUCTIONS: Record<string, string> = {
  low: '简要回答即可。',
  medium: '',
  high: '请深入分析，考虑边界情况。',
  xhigh: '请进行深度分析，考虑多种可能性和边界情况。',
  max: '请穷尽所有可能性，进行彻底分析和验证。',
};

type ProfileCatalogEntry = {
  id: string;
  health?: string;
  revision?: number;
  generation?: number;
  featureGates?: string[] | '*';
  tools?: Array<{ enabled?: boolean; executable?: boolean }>;
};

const PROFILE_LABELS: Record<string, string> = {
  standard: '标准',
  minimal: '极简',
};
const USER_PROFILE_ORDER = ['standard', 'minimal'] as const;

let _profileId = 'standard';
let _profileCatalog: ProfileCatalogEntry[] = [];
let _profileCatalogLoaded = false;

let _currentMode = 'auto';
let _currentEffort = 'medium';
let _availableLevels: string[] = Object.keys(EFFORT_LABELS);
let _supportsThinking = false;
let _planState: { status: 'active' | 'pending' | 'committed' | 'cancelled'; pendingTarget?: string } = { status: 'committed' };

function profileLabel(id: string): string {
  return PROFILE_LABELS[id] || id;
}

function profileStatusLabel(profile: ProfileCatalogEntry): string {
  if (profile.health === 'ready') return '可用';
  if (profile.health === 'broken') return '损坏';
  if (profile.health === 'unavailable') return '不可用';
  return profile.health || '未知';
}

function applyProfileState(data: unknown): void {
  if (!data || typeof data !== 'object') return;
  const state = data as { current?: { id?: unknown }; profile?: { id?: unknown }; catalogs?: unknown };
  const selected = state.current?.id ?? state.profile?.id;
  if (typeof selected === 'string' && selected.trim()) _profileId = selected;
  if (Array.isArray(state.catalogs)) {
    _profileCatalog = state.catalogs.filter((entry): entry is ProfileCatalogEntry => {
      if (!entry || typeof entry !== 'object') return false;
      const id = (entry as { id?: unknown }).id;
      return typeof id === 'string' && id.trim().length > 0;
    });
    _profileCatalogLoaded = true;
  }
  updateModeButton();
}

async function syncProfiles(): Promise<void> {
  try {
    const response = await fetch('/api/profiles');
    if (!response.ok) return;
    applyProfileState(await response.json());
  } catch {}
}

async function setProfile(profileId: string, popup?: HTMLElement): Promise<void> {
  const previous = _profileId;
  if (!profileId || profileId === previous) return;
  const option = popup
    ? [...popup.querySelectorAll<HTMLElement>('[data-profile]')].find((candidate) => candidate.dataset.profile === profileId)
    : undefined;
  if (option) option.setAttribute('aria-busy', 'true');
  try {
    const response = await fetch('/api/sessions/profile', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ profileId }),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(typeof body?.error === 'string' ? body.error : '能力切换失败');
    applyProfileState({ profile: body.profile });
    popup?.remove();
    toast(`已切换 Agent 能力：${profileLabel(_profileId)}`, 'info');
  } catch (error) {
    if (option) option.removeAttribute('aria-busy');
    toast(error instanceof Error && error.message ? error.message : '能力切换失败', 'error');
    _profileId = previous;
    updateModeButton();
  }
}

function applyPlanState(data: unknown): void {
  const candidate = data && typeof data === 'object' && 'state' in data
    ? (data as { state?: unknown }).state
    : data;
  if (!candidate || typeof candidate !== 'object') return;
  const state = candidate as { status?: unknown; pendingTarget?: unknown };
  if (!['active', 'pending', 'committed', 'cancelled'].includes(String(state.status))) return;
  _planState = {
    status: state.status as typeof _planState.status,
    ...(typeof state.pendingTarget === 'string' ? { pendingTarget: state.pendingTarget } : {}),
  };
  if (_planState.status === 'active' || _planState.status === 'pending') _currentMode = 'plan';
  else if (_currentMode === 'plan') _currentMode = 'auto';
  preferences.set('chat-mode', _currentMode);
  updateModeButton();
}

async function syncPlanState(): Promise<void> {
  try {
    const response = await fetch('/api/plan-state');
    if (response.ok) applyPlanState(await response.json());
  } catch {}
}

function applyThinkingState(data: unknown): void {
  const state = data && typeof data === 'object' ? data as Record<string, unknown> : {};
  _supportsThinking = state.supportsThinking === true;
  if (Array.isArray(state.availableLevels)) {
    const knownLevels = state.availableLevels.filter(
      (level): level is string => typeof level === 'string' && Object.hasOwn(EFFORT_LABELS, level),
    );
    _availableLevels = [...new Set(knownLevels)];
    if (_availableLevels.length === 0) _availableLevels = Object.keys(EFFORT_LABELS);
  }
  if (!_supportsThinking) return;
  if (typeof state.level === 'string' && _availableLevels.includes(state.level)) {
    _currentEffort = state.level;
  } else if (!_availableLevels.includes(_currentEffort)) {
    _currentEffort = _availableLevels[0] || 'medium';
  }
}

/** 从服务端同步思考档位状态 */
async function syncThinkingLevel(): Promise<void> {
  try {
    const r = await fetch('/api/thinking-level');
    const d = await r.json();
    applyThinkingState(d);
  } catch {}
}

function loadModeState(): void {
  try {
    _currentMode = preferences.get('chat-mode', 'auto');
    const effort = preferences.get('chat-effort', 'medium');
    if (EFFORT_LABELS[effort]) _currentEffort = effort;
    if (!MODE_LABELS[_currentMode]) _currentMode = 'auto';
  } catch { _currentMode = 'auto'; }
  updateModeButton();
  // 启动时从服务端获取真实思考档位；不支持时保留本地 fallback 选择
  void syncThinkingLevel();
  void syncPlanState();
  // 启动时同步一次权限模式，避免按钮显示模块默认值直到首次打开弹窗
  syncPermissionMode();
  void syncProfiles();
}

async function setMode(mode: string): Promise<void> {
  const previous = _currentMode;
  _currentMode = mode;
  preferences.set('chat-mode', mode);
  updateModeButton();
  const target = mode === 'plan' ? 'active' : previous === 'plan' ? 'committed' : undefined;
  if (!target) return;
  try {
    const response = await fetch('/api/plan-state', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ target }),
    });
    const body = await response.json();
    if (!response.ok) throw new Error(body?.error || 'plan state update failed');
    applyPlanState(body);
  } catch {
    _currentMode = previous;
    preferences.set('chat-mode', previous);
    updateModeButton();
  }
}

/** 调用服务端 setThinkingLevel，替代 localStorage + 提示词前缀 */
async function setEffort(effort: string): Promise<void> {
  _currentEffort = effort;
  preferences.set('chat-effort', effort);
  if (!_supportsThinking) return;
  try {
    const r = await fetch('/api/thinking-level', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ level: effort }),
    });
    const d = await r.json();
    applyThinkingState(d);
  } catch {}
}

function updateEffortControl(root: HTMLElement, effortKeys: string[]): void {
  const idx = Math.max(0, effortKeys.indexOf(_currentEffort));
  const pct = idx / Math.max(1, effortKeys.length - 1) * 100;
  const fill = root.querySelector<HTMLElement>('#effort-fill');
  const knob = root.querySelector<HTMLElement>('#effort-knob');
  const value = root.querySelector<HTMLElement>('#effort-value');
  if (fill) fill.style.width = pct + '%';
  if (knob) knob.style.left = pct + '%';
  if (value) value.textContent = EFFORT_LABELS[_currentEffort] || '中';
  root.querySelectorAll<HTMLElement>('.effort-dot').forEach((dot, dotIndex) => {
    dot.classList.toggle('active', dotIndex <= idx);
    dot.classList.toggle('current', dotIndex === idx);
  });
}

function mountThinkingControl(root: HTMLElement): void {
  const effortKeys = _supportsThinking && _availableLevels.length > 0
    ? _availableLevels
    : Object.keys(EFFORT_LABELS);
  const control = document.createElement('div');
  control.className = 'model-thinking-control';
  control.innerHTML = `
    <div class="effort-head"><span>思考深度</span><strong id="effort-value"></strong></div>
    <div class="effort-control"><div class="effort-rail-pad"><div id="effort-track" class="effort-track">
      <div id="effort-fill" class="effort-fill"></div>
      <div id="effort-knob" class="effort-knob"></div>
      ${effortKeys.map((key, i) => `<span class="effort-dot" data-effort="${key}" style="left:${i / Math.max(1, effortKeys.length - 1) * 100}%"></span>`).join('')}
    </div></div></div>`;
  root.appendChild(control);
  updateEffortControl(control, effortKeys);

  const track = control.querySelector<HTMLElement>('#effort-track');
  if (!track) return;
  const updateFromPointer = (clientX: number) => {
    const rect = track.getBoundingClientRect();
    let position = (clientX - rect.left) / rect.width;
    position = Math.max(0, Math.min(1, position));
    const effort = effortKeys[Math.round(position * (effortKeys.length - 1))] || 'medium';
    void setEffort(effort);
    updateEffortControl(control, effortKeys);
  };
  track.addEventListener('mousedown', (event) => {
    updateFromPointer(event.clientX);
    const onMove = (moveEvent: MouseEvent) => updateFromPointer(moveEvent.clientX);
    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });
  track.addEventListener('touchstart', (event) => {
    const touch = event.touches[0];
    if (!touch) return;
    updateFromPointer(touch.clientX);
    const onMove = (moveEvent: TouchEvent) => {
      const nextTouch = moveEvent.touches[0];
      if (nextTouch) updateFromPointer(nextTouch.clientX);
    };
    const onEnd = () => {
      document.removeEventListener('touchmove', onMove);
      document.removeEventListener('touchend', onEnd);
    };
    document.addEventListener('touchmove', onMove, { passive: true });
    document.addEventListener('touchend', onEnd);
  }, { passive: true });
}

function updateModeButton(): void {
  const el = $('fi-mode-name');
  if (!el) return;
  const conversationLabel = MODE_LABELS[_currentMode] || '自动';
  const planLabel = _planState.status === 'pending' ? '计划待处理' : conversationLabel;
  const permissionMode = permissions?.getMode?.() || 'standard';
  el.textContent = `${planLabel} · ${PERMISSION_MODE_LABELS[permissionMode] || '标准'}`;
  el.title = `策略：${planLabel}；权限：${PERMISSION_MODE_LABELS[permissionMode] || '标准'}；能力：${profileLabel(_profileId)}`;
}

let permissionModeSynced = false;

/** 从服务端同步权限模式一次；成功后刷新策略按钮，可选的弹窗在其中一并更新 active 状态 */
function syncPermissionMode(popup?: HTMLElement): void {
  void permissions?.refreshMode?.().then((mode) => {
    permissionModeSynced = true;
    updateModeButton();
    if (!popup?.isConnected) return;
    popup.querySelectorAll<HTMLElement>('[data-permission-mode]').forEach((option) => {
      option.classList.toggle('active', option.dataset.permissionMode === mode);
    });
  });
}

function showModePopup(btn: HTMLElement): void {
  const existing = document.getElementById('mode-popup');
  if (existing) { existing.remove(); return; }
  const rect = btn.getBoundingClientRect();
  const popup = document.createElement('div');
  popup.id = 'mode-popup';
  popup.className = 'mode-popup';
  popup.style.bottom = (window.innerHeight - rect.top + 4) + 'px';
  popup.style.left = rect.left + 'px';

  const permissionMode = permissions?.getMode?.() || 'standard';
  if (!_profileCatalogLoaded) void syncProfiles();
  let html = '';

  html += '<div class="mode-popup-title">对话方式</div><div class="mode-segment">';
  for (const [key, label] of Object.entries(MODE_LABELS)) {
    const active = key === _currentMode;
    html += `<button class="mode-option${active ? ' active' : ''}" type="button" data-mode="${key}">${label}</button>`;
  }
  html += '</div>';

  html += '<div class="mode-popup-title permission-popup-title">执行权限</div><div class="mode-segment permission-segment">';
  for (const key of PERMISSION_MODE_ORDER) {
    html += `<button class="mode-option permission-option${key === permissionMode ? ' active' : ''}" type="button" data-permission-mode="${key}">${PERMISSION_MODE_LABELS[key]}</button>`;
  }
  html += '</div>';

  html += '<div class="mode-popup-title profile-popup-title">能力模式</div><div class="mode-segment profile-segment" role="listbox" aria-label="能力模式">';
  const profiles = USER_PROFILE_ORDER
    .map((id) => _profileCatalog.find((profile) => profile.id === id))
    .filter((profile): profile is ProfileCatalogEntry => Boolean(profile));
  if (profiles.length === 0) {
    html += '<span class="profile-empty">能力目录加载中…</span>';
  } else {
    for (const profile of profiles) {
      const disabled = profile.health !== 'ready';
      html += `<button class="mode-option profile-option${profile.id === _profileId ? ' active' : ''}" type="button" role="option" aria-selected="${profile.id === _profileId}"${disabled ? ' disabled' : ''} data-profile="${E(profile.id)}" title="${E(profileStatusLabel(profile))}">${E(profileLabel(profile.id))}</button>`;
    }
  }
  html += '</div>';

  popup.innerHTML = html;
  document.body.appendChild(popup);

  popup.querySelectorAll('.mode-option[data-mode]').forEach(el => {
    el.addEventListener('click', () => {
      const mode = (el as HTMLElement).dataset.mode || 'auto';
      void setMode(mode);
      popup.querySelectorAll('.mode-option').forEach(b => {
        b.classList.toggle('active', (b as HTMLElement).dataset.mode === mode);
      });
    });
  });

  popup.querySelectorAll<HTMLElement>('[data-permission-mode]').forEach((option) => {
    option.addEventListener('click', () => {
      const mode = option.dataset.permissionMode as 'plan' | 'standard' | 'dontAsk' | 'yes';
      permissions?.setMode?.(mode);
      popup.remove();
    });
  });
  popup.querySelectorAll<HTMLElement>('[data-profile]').forEach((option) => {
    option.addEventListener('click', () => {
      const profileId = option.dataset.profile || '';
      void setProfile(profileId, popup);
    });
  });
  // 启动已同步过一次；弹窗仅在从未同步时再查一次服务器，其余情况用本地缓存
  if (!permissionModeSynced) syncPermissionMode(popup);

  setTimeout(() => {
    document.addEventListener('click', function close(ev) {
      if (!popup.contains(ev.target as Node) && ev.target !== btn) {
        popup.remove();
        document.removeEventListener('click', close, true);
      }
    }, true);
  }, 0);
}

/** 根据当前 mode/effort 构建消息指令前缀 */
function buildInstruction(message: string): string {
  const modeIns = MODE_INSTRUCTIONS[_currentMode] || ''
  // 思考深度优先走 SDK 原生控制；不支持时才降级为提示词前缀
  const effortIns = _supportsThinking
    ? ''
    : (EFFORT_INSTRUCTIONS[_currentEffort] || '')
  if (!modeIns && !effortIns) return message
  const parts: string[] = []
  if (modeIns) parts.push(modeIns)
  if (effortIns) parts.push(effortIns)
  return parts.join('\n') + '\n\n' + message
}

/** 从历史消息中剥离已知的指令前缀，还原用户原文 */
function stripInstruction(text: string): string {
  const prefixes = [...Object.values(MODE_INSTRUCTIONS), ...Object.values(EFFORT_INSTRUCTIONS)]
    .filter(p => p.length > 0)
    // 按长度降序排列，避免"简要回答即可"被"请深入分析"的部分匹配误伤
    .sort((a, b) => b.length - a.length)
  for (const prefix of prefixes) {
    if (text.startsWith(prefix)) {
      const stripped = text.slice(prefix.length).replace(/^\n+/, '')
      // 确保剥离后还有内容
      if (stripped.trim().length > 0) return stripped
    }
  }
  return text
}

// ─── App 命名空间绑定 ──────────────────────────────────────
{ const AppChat = (window as any).App?.Chat; if (AppChat) {
  AppChat.setMode = setMode;
  AppChat.setEffort = setEffort;
  AppChat.mountThinkingControl = mountThinkingControl;
  AppChat.syncThinkingLevel = syncThinkingLevel;
  AppChat.syncPlanState = syncPlanState;
  AppChat.applyPlanState = applyPlanState;
  AppChat.getMode = () => _currentMode;
  AppChat.getEffort = () => _currentEffort;
  AppChat.refreshModeButton = updateModeButton;
  AppChat.buildInstruction = buildInstruction;
  AppChat.handleSlash = handleSlash;
  AppChat.loadModeState = loadModeState;
  AppChat.showModePopup = showModePopup;
  AppChat.applyProfile = applyProfileState;
  AppChat.syncProfiles = syncProfiles;
  AppChat.getProfile = () => _profileId;
} }
