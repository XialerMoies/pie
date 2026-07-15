function handleSlash(ci) {
  const slashEl = $("fi-slash");
  if (!slashEl) return;
  const val = ci.value;
  if (val.startsWith("/") && !val.includes(" ")) {
    slashEl.style.display = "flex";
    slashEl.querySelectorAll(".fi-slash-item").forEach((item) => {
      const cmd = item.dataset.cmd || "";
      const match = cmd.startsWith(val);
      item.style.background = match ? "var(--bc)" : "";
      item.style.color = match ? "var(--tx)" : "";
    });
  } else {
    slashEl.style.display = "none";
  }
}
const MODE_LABELS = { auto: "\u81EA\u52A8", explain: "\u89E3\u91CA", plan: "\u8BA1\u5212" };
const EFFORT_LABELS = { low: "\u4F4E", medium: "\u4E2D", high: "\u9AD8", xhigh: "\u6781\u9AD8", max: "\u6700\u9AD8" };
const MODE_INSTRUCTIONS = {
  auto: "",
  explain: "\u4EC5\u89E3\u91CA\uFF0C\u4E0D\u8981\u4FEE\u6539\u4EFB\u4F55\u6587\u4EF6\u6216\u6267\u884C\u547D\u4EE4\u3002",
  plan: "\u4E0D\u8981\u6267\u884C\u4EFB\u4F55\u64CD\u4F5C\u3002\u8F93\u51FA\u7ED3\u6784\u5316\u65B9\u6848\uFF1A\u76EE\u6807 \u2192 \u6B65\u9AA4 \u2192 \u6D89\u53CA\u6587\u4EF6 \u2192 \u98CE\u9669\u3002"
};
const EFFORT_INSTRUCTIONS = {
  low: "\u7B80\u8981\u56DE\u7B54\u5373\u53EF\u3002",
  medium: "",
  high: "\u8BF7\u6DF1\u5165\u5206\u6790\uFF0C\u8003\u8651\u8FB9\u754C\u60C5\u51B5\u3002",
  xhigh: "\u8BF7\u8FDB\u884C\u6DF1\u5EA6\u5206\u6790\uFF0C\u8003\u8651\u591A\u79CD\u53EF\u80FD\u6027\u548C\u8FB9\u754C\u60C5\u51B5\u3002",
  max: "\u8BF7\u7A77\u5C3D\u6240\u6709\u53EF\u80FD\u6027\uFF0C\u8FDB\u884C\u5F7B\u5E95\u5206\u6790\u548C\u9A8C\u8BC1\u3002"
};
let _currentMode = "auto";
let _currentEffort = "medium";
function loadModeState() {
  try {
    _currentMode = localStorage.getItem("chat-mode") || "auto";
    _currentEffort = localStorage.getItem("chat-effort") || "medium";
    if (!MODE_LABELS[_currentMode]) _currentMode = "auto";
    if (!EFFORT_LABELS[_currentEffort]) _currentEffort = "medium";
  } catch {
    _currentMode = "auto";
    _currentEffort = "medium";
  }
  updateModeButton();
}
function setMode(mode) {
  _currentMode = mode;
  try {
    localStorage.setItem("chat-mode", mode);
  } catch {
  }
  updateModeButton();
}
function setEffort(effort) {
  _currentEffort = effort;
  try {
    localStorage.setItem("chat-effort", effort);
  } catch {
  }
}
function updateEffortControl(root, effortKeys) {
  const idx = Math.max(0, effortKeys.indexOf(_currentEffort));
  const pct = idx / (effortKeys.length - 1) * 100;
  const fill = root.querySelector("#effort-fill");
  const knob = root.querySelector("#effort-knob");
  const value = root.querySelector("#effort-value");
  if (fill) fill.style.width = pct + "%";
  if (knob) knob.style.left = pct + "%";
  if (value) value.textContent = EFFORT_LABELS[_currentEffort] || "\u4E2D";
  root.querySelectorAll(".effort-dot").forEach((dot, dotIndex) => {
    dot.classList.toggle("active", dotIndex <= idx);
    dot.classList.toggle("current", dotIndex === idx);
  });
}
function updateModeButton() {
  const el = $("fi-mode-name");
  if (el) el.textContent = MODE_LABELS[_currentMode] || "\u81EA\u52A8";
}
function showModePopup(btn) {
  const existing = document.getElementById("mode-popup");
  if (existing) {
    existing.remove();
    return;
  }
  const rect = btn.getBoundingClientRect();
  const popup = document.createElement("div");
  popup.id = "mode-popup";
  popup.className = "mode-popup";
  popup.style.bottom = window.innerHeight - rect.top + 4 + "px";
  popup.style.left = rect.left + "px";
  const modeKeys = Object.keys(MODE_LABELS);
  const effortKeys = Object.keys(EFFORT_LABELS);
  let html = "";
  html += '<div class="mode-popup-title">\u6A21\u5F0F</div><div class="mode-segment">';
  for (const [key, label] of Object.entries(MODE_LABELS)) {
    const active = key === _currentMode;
    html += `<button class="mode-option${active ? " active" : ""}" type="button" data-mode="${key}">${label}</button>`;
  }
  html += "</div>";
  const ec = effortKeys.indexOf(_currentEffort);
  const pct = ec / (effortKeys.length - 1) * 100;
  html += '<div class="effort-head"><span>\u601D\u8003\u6DF1\u5EA6</span><strong id="effort-value"></strong></div>';
  html += '<div class="effort-control">';
  html += '<div class="effort-rail-pad">';
  html += '<div id="effort-track" class="effort-track">';
  html += `<div id="effort-fill" class="effort-fill" style="width:${pct}%"></div>`;
  html += `<div id="effort-knob" class="effort-knob" style="left:${pct}%"></div>`;
  effortKeys.forEach((key, i) => {
    html += `<span class="effort-dot" data-effort="${key}" style="left:${i / (effortKeys.length - 1) * 100}%"></span>`;
  });
  html += "</div></div></div>";
  popup.innerHTML = html;
  document.body.appendChild(popup);
  updateEffortControl(popup, effortKeys);
  popup.querySelectorAll(".mode-option").forEach((el) => {
    el.addEventListener("click", () => {
      const mode = el.dataset.mode || "auto";
      setMode(mode);
      popup.querySelectorAll(".mode-option").forEach((b) => {
        b.classList.toggle("active", b.dataset.mode === mode);
      });
    });
  });
  const track = document.getElementById("effort-track");
  const fill = document.getElementById("effort-fill");
  const knob = document.getElementById("effort-knob");
  if (track && fill && knob) {
    let upd2 = function(clientX) {
      const r = track.getBoundingClientRect();
      let p = (clientX - r.left) / r.width;
      p = Math.max(0, Math.min(1, p));
      const idx = Math.round(p * (effortKeys.length - 1));
      const effort = effortKeys[idx] || "medium";
      setEffort(effort);
      updateEffortControl(popup, effortKeys);
    };
    var upd = upd2;
    track.addEventListener("mousedown", (e) => {
      upd2(e.clientX);
      function onMove(ev) {
        upd2(ev.clientX);
      }
      function onUp() {
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onUp);
      }
      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
    });
    track.addEventListener("touchstart", (e) => {
      const touch = e.touches[0];
      if (!touch) return;
      upd2(touch.clientX);
      function onMove(ev) {
        const t = ev.touches[0];
        if (t) upd2(t.clientX);
      }
      function onEnd() {
        document.removeEventListener("touchmove", onMove);
        document.removeEventListener("touchend", onEnd);
      }
      document.addEventListener("touchmove", onMove, { passive: true });
      document.addEventListener("touchend", onEnd);
    }, { passive: true });
  }
  setTimeout(() => {
    document.addEventListener("click", function close(ev) {
      if (!popup.contains(ev.target) && ev.target !== btn) {
        popup.remove();
        document.removeEventListener("click", close, true);
      }
    }, true);
  }, 0);
}
function buildInstruction(message) {
  const modeIns = MODE_INSTRUCTIONS[_currentMode] || "";
  const effortIns = EFFORT_INSTRUCTIONS[_currentEffort] || "";
  if (!modeIns && !effortIns) return message;
  const parts = [];
  if (modeIns) parts.push(modeIns);
  if (effortIns) parts.push(effortIns);
  return parts.join("\n") + "\n\n" + message;
}
function stripInstruction(text) {
  const prefixes = [...Object.values(MODE_INSTRUCTIONS), ...Object.values(EFFORT_INSTRUCTIONS)].filter((p) => p.length > 0).sort((a, b) => b.length - a.length);
  for (const prefix of prefixes) {
    if (text.startsWith(prefix)) {
      const stripped = text.slice(prefix.length).replace(/^\n+/, "");
      if (stripped.trim().length > 0) return stripped;
    }
  }
  return text;
}
{
  const AppChat = window.App?.Chat;
  if (AppChat) {
    AppChat.setMode = setMode;
    AppChat.setEffort = setEffort;
    AppChat.getMode = () => _currentMode;
    AppChat.getEffort = () => _currentEffort;
    AppChat.buildInstruction = buildInstruction;
    AppChat.handleSlash = handleSlash;
    AppChat.loadModeState = loadModeState;
    AppChat.showModePopup = showModePopup;
  }
}
