// ═══════════════════════════════════════════════════════════════════
//  Slash Command Popup
// ═══════════════════════════════════════════════════════════════════

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
const EFFORT_LABELS: Record<string, string> = { off: '关闭', minimal: '极少', low: '低', medium: '中', high: '高', xhigh: '极高', max: '最高' };

const MODE_INSTRUCTIONS: Record<string, string> = {
  auto: '',
  explain: '仅解释，不要修改任何文件或执行命令。',
  plan: '不要执行任何操作。输出结构化方案：目标 → 步骤 → 涉及文件 → 风险。',
};

const EFFORT_INSTRUCTIONS: Record<string, string> = {
  low: '简要回答即可。',
  medium: '',
  high: '请深入分析，考虑边界情况。',
  xhigh: '请进行深度分析，考虑多种可能性和边界情况。',
  max: '请穷尽所有可能性，进行彻底分析和验证。',
};

let _currentMode = 'auto';
let _currentEffort = 'medium';
let _availableLevels: string[] = Object.keys(EFFORT_LABELS);
let _supportsThinking = false;

/** 从服务端同步思考档位状态 */
async function syncThinkingLevel(): Promise<void> {
  try {
    const r = await fetch('/api/thinking-level');
    const d = await r.json();
    if (Array.isArray(d.availableLevels)) _availableLevels = d.availableLevels;
    _supportsThinking = !!d.supportsThinking;
    if (_supportsThinking && d.level) _currentEffort = d.level;
  } catch {}
}

function loadModeState(): void {
  try {
    _currentMode = localStorage.getItem('chat-mode') || 'auto';
    const effort = localStorage.getItem('chat-effort') || 'medium';
    if (EFFORT_LABELS[effort]) _currentEffort = effort;
    if (!MODE_LABELS[_currentMode]) _currentMode = 'auto';
  } catch { _currentMode = 'auto'; }
  updateModeButton();
  // 启动时从服务端获取真实思考档位；不支持时保留本地 fallback 选择
  void syncThinkingLevel();
}

function setMode(mode: string): void {
  _currentMode = mode;
  try { localStorage.setItem('chat-mode', mode); } catch {}
  updateModeButton();
}

/** 调用服务端 setThinkingLevel，替代 localStorage + 提示词前缀 */
async function setEffort(effort: string): Promise<void> {
  _currentEffort = effort;
  try { localStorage.setItem('chat-effort', effort); } catch {}
  if (!_supportsThinking) return;
  try {
    const r = await fetch('/api/thinking-level', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ level: effort }),
    });
    const d = await r.json();
    _supportsThinking = !!d.supportsThinking;
    if (Array.isArray(d.availableLevels)) _availableLevels = d.availableLevels;
    if (_supportsThinking && d.level) _currentEffort = d.level;
  } catch {}
}

function updateEffortControl(root: HTMLElement, effortKeys: string[]): void {
  const idx = Math.max(0, effortKeys.indexOf(_currentEffort));
  const pct = idx / (effortKeys.length - 1) * 100;
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

function updateModeButton(): void {
  const el = $('fi-mode-name');
  if (el) el.textContent = MODE_LABELS[_currentMode] || '自动';
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

  const modeKeys = Object.keys(MODE_LABELS);
  // 使用服务端返回的可用档位，而非硬编码
  const effortKeys = _supportsThinking && _availableLevels.length > 0 ? _availableLevels : Object.keys(EFFORT_LABELS);
  let html = '';

  html += '<div class="mode-popup-title">模式</div><div class="mode-segment">';
  for (const [key, label] of Object.entries(MODE_LABELS)) {
    const active = key === _currentMode;
    html += `<button class="mode-option${active ? ' active' : ''}" type="button" data-mode="${key}">${label}</button>`;
  }
  html += '</div>';

  const ec = effortKeys.indexOf(_currentEffort);
  const pct = ec / (effortKeys.length - 1) * 100;
  html += '<div class="effort-head"><span>思考深度</span><strong id="effort-value"></strong></div>';
  html += '<div class="effort-control">';
  html += '<div class="effort-rail-pad">';
  html += '<div id="effort-track" class="effort-track">';
  html += `<div id="effort-fill" class="effort-fill" style="width:${pct}%"></div>`;
  html += `<div id="effort-knob" class="effort-knob" style="left:${pct}%"></div>`;
  effortKeys.forEach((key, i) => {
    html += `<span class="effort-dot" data-effort="${key}" style="left:${i/(effortKeys.length-1)*100}%"></span>`;
  });
  html += '</div></div></div>';

  popup.innerHTML = html;
  document.body.appendChild(popup);
  updateEffortControl(popup, effortKeys);

  popup.querySelectorAll('.mode-option').forEach(el => {
    el.addEventListener('click', () => {
      const mode = (el as HTMLElement).dataset.mode || 'auto';
      setMode(mode);
      popup.querySelectorAll('.mode-option').forEach(b => {
        b.classList.toggle('active', (b as HTMLElement).dataset.mode === mode);
      });
    });
  });

  const track = document.getElementById('effort-track') as HTMLElement | null;
  const fill = document.getElementById('effort-fill') as HTMLElement | null;
  const knob = document.getElementById('effort-knob') as HTMLElement | null;
  if (track && fill && knob) {
    function upd(clientX: number) {
      const r = track!.getBoundingClientRect();
      let p = (clientX - r.left) / r.width;
      p = Math.max(0, Math.min(1, p));
      const idx = Math.round(p * (effortKeys.length - 1));
      const effort = effortKeys[idx] || 'medium';
      setEffort(effort);
      updateEffortControl(popup, effortKeys);
    }
    track.addEventListener('mousedown', (e) => {
      upd(e.clientX);
      function onMove(ev: MouseEvent) { upd(ev.clientX); }
      function onUp() { document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp); }
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });
    track.addEventListener('touchstart', (e) => {
      const touch = e.touches[0];
      if (!touch) return;
      upd(touch.clientX);
      function onMove(ev: TouchEvent) { const t = ev.touches[0]; if (t) upd(t.clientX); }
      function onEnd() { document.removeEventListener('touchmove', onMove); document.removeEventListener('touchend', onEnd); }
      document.addEventListener('touchmove', onMove, { passive: true });
      document.addEventListener('touchend', onEnd);
    }, { passive: true });
  }

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
  AppChat.getMode = () => _currentMode;
  AppChat.getEffort = () => _currentEffort;
  AppChat.buildInstruction = buildInstruction;
  AppChat.handleSlash = handleSlash;
  AppChat.loadModeState = loadModeState;
  AppChat.showModePopup = showModePopup;
} }
