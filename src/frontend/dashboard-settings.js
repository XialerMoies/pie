let _st = "model";
let _selectedProvider = null;
let _provKeys = {};
let _allProvData = [];
function openSettingsModal() {
  _st = "model";
  showSettingsModal();
}
function showSettingsModal() {
  const existing = $("settings-modal");
  if (existing) {
    existing.remove();
    return;
  }
  const overlay = document.createElement("div");
  overlay.id = "settings-modal";
  overlay.className = "modal-overlay";
  overlay.innerHTML = `
    <div class="modal-box">
      <div class="modal-header"><span class="modal-title">\u8BBE\u7F6E</span><button class="modal-close" onclick="closeSettingsModal()">\u2715</button></div>
      <div class="modal-body">
        <div class="modal-sidebar">
          <div class="ms-item on" data-st="model" onclick="switchSettingsModal('model')">\u6A21\u578B</div>
          <div class="ms-item" data-st="general" onclick="switchSettingsModal('general')">\u901A\u7528</div>
          <div class="ms-item" data-st="about" onclick="switchSettingsModal('about')">\u5173\u4E8E</div>
        </div>
        <div class="modal-content" id="mc-settings"></div>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);
  switchSettingsModal("model");
}
function closeSettingsModal() {
  const el = $("settings-modal");
  if (el) el.remove();
}
function switchSettingsModal(tab) {
  _st = tab;
  document.querySelectorAll(".ms-item").forEach((e) => e.classList.toggle("on", e.dataset.st === tab));
  const sc = $("mc-settings");
  if (!sc) return;
  if (tab === "model") {
    sc.innerHTML = `
      <div class="model-split">
        <div class="ms-left">
          <div class="msl-title">\u5382\u5546</div>
          <div class="msl-list" id="msl-list"><div class="sp" style="margin:20px auto"></div></div>
        </div>
        <div class="ms-right">
          <div id="ms-right-content"><div class="sp" style="margin:40px auto"></div></div>
        </div>
      </div>
    `;
    fetch("/api/auth").then((r) => r.json()).then((ad) => {
      const list = $("msl-list");
      const cfg = {};
      ad.providers && ad.providers.forEach((p) => {
        cfg[p.provider] = p;
        _provKeys[p.provider] = { hasKey: p.hasKey, keyPreview: p.keyPreview || "", keyFull: p.keyFull || "" };
      });
      const allProvs = ["anthropic", "deepseek", "openai", "openrouter", "google"];
      const configured = allProvs.filter((p) => cfg[p] && cfg[p].hasKey);
      const unconfigured = allProvs.filter((p) => !configured.includes(p));
      const savedOrder = localStorage.getItem("providers_order");
      const order = savedOrder ? JSON.parse(savedOrder) : configured.concat(unconfigured);
      allProvs.forEach((p) => {
        if (!order.includes(p)) order.push(p);
      });
      function renderList(listOrder) {
        list.innerHTML = listOrder.map((prov, i) => {
          const onClass = i === 0 ? " on" : "";
          const has = cfg[prov] && cfg[prov].hasKey;
          return `<div class="msl-item${onClass}" draggable="true" data-prov="${prov}" ondragstart="provDragStart(event,${i})" ondragover="provDragOver(event,${i})" ondrop="provDrop(event,${i})" onclick="selectProvider('${prov}')">
            <span class="msl-name">${prov}</span><span class="msl-drag">\u283F</span><span class="msl-status${has ? " on" : ""}"></span>
          </div>`;
        }).join("");
        if (listOrder.length > 0) selectProvider(listOrder[0]);
      }
      renderList(order);
      window._provOrder = order;
    }).catch(() => {
      const l = $("msl-list");
      if (l) l.innerHTML = '<p style="color:var(--rs);font-size:.72rem">\u52A0\u8F7D\u5931\u8D25</p>';
      toast("\u52A0\u8F7D\u5382\u5546\u5217\u8868\u5931\u8D25", "error");
    });
  } else if (tab === "general") {
    const fontSize = localStorage.getItem("editor-font-size") || "13";
    const tabSize = localStorage.getItem("editor-tab-size") || "2";
    const useTabs = localStorage.getItem("editor-use-tabs") === "1";
    const theme = localStorage.getItem("editor-theme") || "vs-dark";
    sc.innerHTML = `
      <h3 class="s-title">\u901A\u7528\u8BBE\u7F6E</h3>
      <p class="s-desc">\u5E94\u7528\u4E0E\u7F16\u8F91\u5668\u504F\u597D\u8BBE\u7F6E\uFF0C\u5373\u65F6\u751F\u6548\u3002</p>

      <div class="gs-section">
        <div class="gs-section-title">\u5E94\u7528\u8BBE\u7F6E</div>
        <div class="gs-group">
          <div class="gs-row">
            <span class="gs-label">\u542F\u52A8\u65F6\u6062\u590D\u4E0A\u6B21\u4F1A\u8BDD</span>
            <div class="gs-control">
              <label class="gs-toggle"><input type="checkbox" id="gs-restore-session" onchange="toggleRestoreSession()" checked><span class="gs-toggle-slider"></span></label>
            </div>
          </div>
          <div class="gs-row" style="border:none">
            <span class="gs-label">\u81EA\u52A8\u4FDD\u5B58</span>
            <div class="gs-control">
              <label class="gs-toggle"><input type="checkbox" id="gs-autosave" onchange="toggleAutoSaveSetting()"${localStorage.getItem("auto-save") === "1" ? " checked" : ""}><span class="gs-toggle-slider"></span></label>
            </div>
          </div>
        </div>
      </div>

      <div class="gs-section">
        <div class="gs-section-title">\u7F16\u8F91\u5668\u8BBE\u7F6E</div>
        <div class="gs-group">
          <div class="gs-row">
            <span class="gs-label">\u5B57\u4F53\u5927\u5C0F</span>
            <div class="gs-control">
              <button class="gs-btn" onclick="changeFontSize(-1)">\u2212</button>
              <span class="gs-value" id="gs-fontsize">${fontSize}</span>
              <button class="gs-btn" onclick="changeFontSize(1)">+</button>
            </div>
          </div>
          <div class="gs-row">
            <span class="gs-label">\u7F29\u8FDB</span>
            <div class="gs-control">
              <select class="gs-select" id="gs-indent-type" onchange="applyGeneralSetting()">
                <option value="0"${useTabs ? "" : " selected"}>\u7A7A\u683C</option>
                <option value="1"${useTabs ? " selected" : ""}>\u5236\u8868\u7B26</option>
              </select>
              <select class="gs-select" id="gs-tab-size" onchange="applyGeneralSetting()">
                <option value="2"${tabSize === "2" ? " selected" : ""}>2</option>
                <option value="4"${tabSize === "4" ? " selected" : ""}>4</option>
                <option value="8"${tabSize === "8" ? " selected" : ""}>8</option>
              </select>
            </div>
          </div>
          <div class="gs-row" style="border:none">
            <span class="gs-label">\u4E3B\u9898</span>
            <div class="gs-control">
              <select class="gs-select" id="gs-theme" onchange="applyGeneralSetting()">
                <option value="vs-dark"${theme === "vs-dark" ? " selected" : ""}>\u5E94\u7528\u6697\u8272</option>
                <option value="vs"${theme === "vs" ? " selected" : ""}>\u5E94\u7528\u4EAE\u8272</option>
              </select>
            </div>
          </div>
        </div>
      </div>
    `;
  } else if (tab === "about") {
    sc.innerHTML = `
      <h3 class="s-title">\u5173\u4E8E</h3>
      <p class="s-desc">My Code Agent \u2014 \u57FA\u4E8E PI \u6846\u67B6\u7684\u81EA\u5B9A\u4E49\u7F16\u7A0B\u52A9\u624B</p>
      <div class="s-section"><span class="s-label">\u7248\u672C</span><span class="s-value">0.0.1</span></div>
      <div class="s-section"><span class="s-label">\u6846\u67B6</span><span class="s-value">@earendil-works/pi-coding-agent v0.80.3</span></div>
    `;
  }
}
function selectProvider(prov) {
  _selectedProvider = prov;
  document.querySelectorAll(".msl-item").forEach((el) => el.classList.toggle("on", el.dataset.prov === prov));
  const rc = $("ms-right-content");
  if (!rc) return;
  const info = _provKeys[prov] || { hasKey: false, keyPreview: "", keyFull: "" };
  let html = `
    <div class="rp-header">
      <div class="rp-prov-name">${prov}</div>
      <span class="rp-status${info.hasKey ? " on" : ""}">${info.hasKey ? "\u5DF2\u914D\u7F6E" : "\u672A\u914D\u7F6E"}</span>
    </div>
  `;
  if (info.hasKey) {
    html += `<div class="rp-models" id="rp-models-${prov}">\u52A0\u8F7D\u4E2D...</div>`;
  }
  html += `
    <div class="rp-key-section">
      <div class="rp-key-label">API Key</div>
      <div class="rp-key-row">
        <input class="rp-key-input" type="password" id="key-input-${prov}" placeholder="\u8F93\u5165 API Key..." value="${E(info.keyFull || "")}"/>
        <button class="rp-key-toggle" onclick="toggleKeyVis('${prov}')">\u{1F441}</button>
        <button class="rp-save-btn" onclick="saveApiKey('${prov}')">\u4FDD\u5B58</button>
      </div>
    </div>
  `;
  rc.innerHTML = html;
  if (info.hasKey) loadProviderModels(prov);
}
function toggleKeyVis(prov) {
  const input = document.getElementById("key-input-" + prov);
  if (!input) return;
  input.type = input.type === "password" ? "text" : "password";
}
function saveApiKey(provider) {
  const input = document.getElementById("key-input-" + provider);
  if (!input || !input.value.trim()) {
    toast("\u8BF7\u8F93\u5165 API Key");
    return;
  }
  fetch("/api/auth", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ provider, apiKey: input.value.trim() }) }).then((r) => r.json()).then((r) => {
    if (r.ok) {
      toast("\u5DF2\u4FDD\u5B58");
      _provKeys[provider] = { hasKey: true, keyPreview: input.value.trim().slice(0, 8) + "...", keyFull: input.value.trim() };
      selectProvider(provider);
    } else toast("\u4FDD\u5B58\u5931\u8D25");
  }).catch(() => toast("\u4FDD\u5B58\u5931\u8D25"));
}
function loadProviderModels(prov) {
  const container = document.getElementById("rp-models-" + prov);
  if (!container) return;
  fetch("/api/models").then((r) => r.json()).then((data) => {
    const models = (data.models || []).filter((m) => m.provider === prov);
    if (models.length === 0) {
      container.innerHTML = '<p style="color:var(--tm);font-size:.72rem">\u65E0\u53EF\u7528\u6A21\u578B</p>';
      return;
    }
    let html = '<div class="rp-models-title">\u53EF\u7528\u6A21\u578B</div>';
    models.forEach((m) => {
      const stD = window.__state.D;
      const active = m.provider === stD?.modelProvider && m.id === stD?.modelId;
      html += `<div class="rp-model-item${active ? " on" : ""}" onclick="selectModel('${m.provider}','${m.id}')">${E(m.id)}</div>`;
    });
    container.innerHTML = html;
  }).catch(() => {
    container.innerHTML = '<p style="color:var(--rs);font-size:.72rem">\u52A0\u8F7D\u5931\u8D25</p>';
    toast("\u52A0\u8F7D\u6A21\u578B\u5217\u8868\u5931\u8D25", "error");
  });
}
function selectModel(provider, modelId) {
  fetch("/api/model/switch", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ provider, modelId }) }).then((r) => r.json()).then((r) => {
    if (r.ok) {
      toast("\u5DF2\u5207\u6362: " + modelId, "success");
      getD();
      document.querySelectorAll(".rp-model-item").forEach((el) => el.classList.toggle("on", el.textContent.trim() === modelId));
    } else {
      toast("\u5207\u6362\u5931\u8D25: " + (r.error || ""), "error");
    }
  }).catch(() => {
    toast("\u5207\u6362\u5931\u8D25", "error");
  });
}
function toggleAutoSaveSetting() {
  const el = document.getElementById("gs-autosave");
  if (el) {
    if (el.checked) localStorage.setItem("auto-save", "1");
    else localStorage.removeItem("auto-save");
    toast("\u81EA\u52A8\u4FDD\u5B58: " + (el.checked ? "\u5F00" : "\u5173"));
  }
}
function toggleRestoreSession() {
  const el = document.getElementById("gs-restore-session");
  if (el) {
    if (el.checked) localStorage.removeItem("no-restore-session");
    else localStorage.setItem("no-restore-session", "1");
    toast("\u542F\u52A8\u6062\u590D: " + (el.checked ? "\u5F00" : "\u5173"));
  }
}
function changeFontSize(delta) {
  const el = $("gs-fontsize");
  if (!el) return;
  let size = parseInt(el.textContent || "13", 10);
  size = Math.max(10, Math.min(24, size + delta));
  el.textContent = String(size);
  localStorage.setItem("editor-font-size", String(size));
  applyEditorSettings();
}
function applyGeneralSetting() {
  const typeEl = $("gs-indent-type");
  const sizeEl = $("gs-tab-size");
  const themeEl = $("gs-theme");
  if (typeEl) localStorage.setItem("editor-use-tabs", typeEl.value);
  if (sizeEl) localStorage.setItem("editor-tab-size", sizeEl.value);
  if (themeEl) localStorage.setItem("editor-theme", themeEl.value);
  applyEditorSettings();
}
function applyEditorSettings() {
  const m = window.__monaco;
  if (m?.updateSettings) m.updateSettings();
}
let _dragIdx = -1;
function provDragStart(ev, idx) {
  _dragIdx = idx;
  ev.dataTransfer.effectAllowed = "move";
  ev.dataTransfer.setData("text/plain", String(idx));
}
function provDragOver(ev, _idx) {
  ev.preventDefault();
  ev.dataTransfer.dropEffect = "move";
}
function provDrop(ev, idx) {
  ev.preventDefault();
  if (_dragIdx < 0 || _dragIdx === idx) return;
  const order = window._provOrder || [];
  const item = order.splice(_dragIdx, 1)[0];
  order.splice(idx, 0, item);
  window._provOrder = order;
  localStorage.setItem("providers_order", JSON.stringify(order));
  const list = $("msl-list");
  if (!list) return;
  list.innerHTML = order.map((prov, i) => {
    const onClass = prov === _selectedProvider ? " on" : "";
    const has = _provKeys[prov] && _provKeys[prov].hasKey;
    return `<div class="msl-item${onClass}" draggable="true" data-prov="${prov}" ondragstart="provDragStart(event,${i})" ondragover="provDragOver(event,${i})" ondrop="provDrop(event,${i})" onclick="selectProvider('${prov}')">
      <span class="msl-name">${prov}</span><span class="msl-drag">\u283F</span><span class="msl-status${has ? " on" : ""}"></span>
    </div>`;
  }).join("");
  _dragIdx = -1;
}
window.openSettingsModal = openSettingsModal;
window.closeSettingsModal = closeSettingsModal;
window.switchSettingsModal = switchSettingsModal;
window.selectProvider = selectProvider;
window.toggleKeyVis = toggleKeyVis;
window.saveApiKey = saveApiKey;
window.loadProviderModels = loadProviderModels;
window.selectModel = selectModel;
window.provDragStart = provDragStart;
window.provDragOver = provDragOver;
window.provDrop = provDrop;
window.changeFontSize = changeFontSize;
window.applyGeneralSetting = applyGeneralSetting;
window.toggleAutoSaveSetting = toggleAutoSaveSetting;
window.toggleRestoreSession = toggleRestoreSession;
const AppSett = window.App?.Settings;
if (AppSett) {
  AppSett.openSettingsModal = openSettingsModal;
  AppSett.closeSettingsModal = closeSettingsModal;
  AppSett.switchSettingsModal = switchSettingsModal;
  AppSett.selectProvider = selectProvider;
  AppSett.toggleKeyVis = toggleKeyVis;
  AppSett.saveApiKey = saveApiKey;
  AppSett.loadProviderModels = loadProviderModels;
  AppSett.selectModel = selectModel;
  AppSett.provDragStart = provDragStart;
  AppSett.provDragOver = provDragOver;
  AppSett.provDrop = provDrop;
}
