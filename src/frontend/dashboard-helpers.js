window.__state = {
  D: null,
  M: [],
  IL: false,
  CS: null,
  CT: "chat",
  _activePanel: "explorer",
  _fileTabs: [],
  _activeFileTab: null
};
window.App = {
  UI: {},
  Chat: {},
  File: {},
  Session: {},
  Settings: {}
};
function $(i) {
  return document.getElementById(i);
}
function S(n, z = 16) {
  return `<svg width="${z}" height="${z}" viewBox="0 0 24 24"><use href="#${n}"/></svg>`;
}
function E(s) {
  const d = document.createElement("div");
  d.textContent = String(s ?? "");
  return d.innerHTML;
}
function F(s) {
  if (s < 60) return Math.floor(s) + "\u79D2";
  if (s < 3600) return Math.floor(s / 60) + "\u5206" + Math.floor(s % 60) + "\u79D2";
  return Math.floor(s / 3600) + "\u65F6" + Math.floor(s % 3600 / 60) + "\u5206";
}
function sb(id) {
  const e = $(id);
  if (e) e.scrollTop = e.scrollHeight;
}
function toast(msg, type) {
  let t = $("toast-el");
  if (!t) {
    t = document.createElement("div");
    t.id = "toast-el";
    document.body.appendChild(t);
  }
  t.textContent = msg;
  t.className = "toast-el" + (type ? " " + type : "");
  clearTimeout(t._t);
  t._t = setTimeout(() => {
    t.className = "toast-el" + (type ? " " + type : "") + " out";
  }, 3e3);
}
async function getD() {
  try {
    const r = await fetch("/api/dashboard");
    window.__state.D = await r.json();
    const fn = window.App?.Chat?.updateModelName;
    if (fn) fn();
    else {
      const mn = $("fi-model-name");
      if (mn && window.__state.D?.modelId) mn.textContent = window.__state.D.modelId;
    }
  } catch {
  }
}
async function refresh() {
  await getD();
}
function confirmAsync(msg) {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "modal-overlay";
    overlay.style.cssText = "position:fixed;inset:0;z-index:99999;background:rgba(0,0,0,.55);display:flex;align-items:center;justify-content:center";
    overlay.innerHTML = `
      <div style="background:var(--bs);border:1px solid var(--bd);border-radius:12px;padding:24px;min-width:300px;box-shadow:0 16px 64px rgba(0,0,0,.5)">
        <div style="font-size:.85rem;color:var(--tx);margin-bottom:16px;line-height:1.5">${msg}</div>
        <div style="display:flex;gap:8px;justify-content:flex-end">
          <button id="confirm-cancel" style="padding:6px 18px;border-radius:6px;border:1px solid var(--bd);background:0 0;color:var(--ts);font-size:.78rem;font-family:var(--fb);cursor:pointer;white-space:nowrap">\u53D6\u6D88</button>
          <button id="confirm-ok" style="padding:6px 18px;border-radius:6px;border:none;background:var(--am);color:#0A0A0F;font-size:.78rem;font-family:var(--fb);font-weight:600;cursor:pointer;white-space:nowrap">\u786E\u5B9A</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    const close = (val) => {
      overlay.remove();
      resolve(val);
    };
    overlay.querySelector("#confirm-ok").addEventListener("click", () => close(true));
    overlay.querySelector("#confirm-cancel").addEventListener("click", () => close(false));
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) close(false);
    });
  });
}
function winCtrl(action) {
  const api = window.electronAPI;
  if (!api) return;
  if (action === "minimize") api.minimize();
  else if (action === "maximize") api.maximize();
  else if (action === "close") api.close();
}
const _panes = {};
function registerPane(name, render) {
  _panes[name] = render;
  console.log(`[pane] registered: "${name}"`);
}
function getPane(name) {
  return _panes[name];
}
const App = window.App;
App.UI.$ = $;
App.UI.S = S;
App.UI.E = E;
App.UI.F = F;
App.UI.sb = sb;
App.UI.toast = toast;
App.UI.getD = getD;
App.UI.refresh = refresh;
App.UI.winCtrl = winCtrl;
App.UI.registerPane = registerPane;
App.UI.getPane = getPane;
window.$ = $;
window.S = S;
window.E = E;
window.F = F;
window.sb = sb;
window.toast = toast;
window.getD = getD;
window.refresh = refresh;
window.winCtrl = winCtrl;
