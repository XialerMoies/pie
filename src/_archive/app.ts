/**
 * Pi Desktop — 前端逻辑
 * 聊天 + 仪表盘，通过 IPC 与主进程通信
 */

// ─── Types ──────────────────────────────────────────────────────
interface ChatMessage {
  role: "user" | "assistant";
  content: string;
  streaming?: boolean;
}

// ─── State ──────────────────────────────────────────────────────
let messages: ChatMessage[] = [];
let isLoading = false;
let currentTab: "chat" | "dashboard" = "chat";
let paths: any = null;
let unsubscribers: (() => void)[] = [];

// ─── DOM ────────────────────────────────────────────────────────
const $app = document.getElementById("app")!;

// ─── Render ─────────────────────────────────────────────────────
function render() {
  if (currentTab === "chat") renderChat();
  else renderDashboard();
}

function esc(s: any): string {
  const d = document.createElement("div");
  d.textContent = String(s ?? "");
  return d.innerHTML;
}

function scrollToBottom() {
  const container = document.getElementById("chat-messages");
  if (container) container.scrollTop = container.scrollHeight;
}

// ─── Chat View ─────────────────────────────────────────────────
function renderChat() {
  const existing = document.getElementById("chat-view");
  if (existing) {
    const msgsDiv = document.getElementById("chat-messages");
    if (msgsDiv) msgsDiv.innerHTML = buildMessagesHTML();
    scrollToBottom();
    return;
  }

  let html = `
    <div class="nav">
      <button class="nav-btn active" onclick="switchTab('chat')">💬 对话</button>
      <button class="nav-btn" onclick="switchTab('dashboard')">📊 仪表盘</button>
    </div>
    <div class="content">
      <div class="chat-view" id="chat-view">
        <div class="chat-messages" id="chat-messages">
          ${buildMessagesHTML()}
        </div>
        <div class="chat-input-area">
          <input class="chat-input" id="chat-input" type="text"
            placeholder="输入消息，回车发送..." autocomplete="off"
            ${isLoading ? "disabled" : ""}>
          <button class="chat-send-btn" id="chat-send-btn"
            ${isLoading ? "disabled" : ""}>
            ${isLoading ? "思考中..." : "发送"}
          </button>
        </div>
      </div>
    </div>
    <div class="statusbar" id="statusbar"></div>
  `;

  $app.innerHTML = html;

  const input = document.getElementById("chat-input") as HTMLInputElement;
  const sendBtn = document.getElementById("chat-send-btn") as HTMLButtonElement;

  const sendMessage = () => {
    if (!input || !input.value.trim() || isLoading) return;
    const text = input.value.trim();
    input.value = "";
    addMessage("user", text);
    isLoading = true;
    updateChatLoading();
    (window as any).pi.chat.send(text);
  };

  input?.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  });

  sendBtn?.addEventListener("click", sendMessage);

  updateStatusbar();
  setTimeout(() => input?.focus(), 50);
  scrollToBottom();
}

function buildMessagesHTML(): string {
  if (messages.length === 0) {
    return `
      <div class="chat-welcome">
        <h2>💬 开始对话</h2>
        <p>直接在桌面应用中与 Pi 交谈<br>消息会保存在本地 data/pi/sessions/ 中</p>
      </div>
    `;
  }

  return messages.map((msg) => {
    const cls = msg.role === "user" ? "user" : "assistant" + (msg.streaming ? " streaming" : "");
    const dots = msg.streaming
      ? '<div class="chat-thinking"><span class="chat-dot"></span><span class="chat-dot"></span><span class="chat-dot"></span></div>'
      : "";
    return `<div class="chat-msg ${cls}"><div>${esc(msg.content || "")}</div>${dots}</div>`;
  }).join("\n");
}

function addMessage(role: "user" | "assistant", content: string, streaming = false) {
  messages.push({ role, content, streaming });
  renderChat();
}

function updateLastMessage(content: string, done = false) {
  const last = messages[messages.length - 1];
  if (last && last.role === "assistant") {
    last.content = content;
    if (done) last.streaming = false;
    renderChat();
  }
}

function updateChatLoading() {
  const input = document.getElementById("chat-input") as HTMLInputElement;
  const btn = document.getElementById("chat-send-btn") as HTMLButtonElement;
  if (input) input.disabled = isLoading;
  if (btn) {
    btn.disabled = isLoading;
    btn.textContent = isLoading ? "思考中..." : "发送";
  }
  updateStatusbar();
}

// ─── Dashboard View ────────────────────────────────────────────
function renderDashboard() {
  let html = `
    <div class="nav">
      <button class="nav-btn" onclick="switchTab('chat')">💬 对话</button>
      <button class="nav-btn active" onclick="switchTab('dashboard')">📊 仪表盘</button>
    </div>
    <div class="content">
      <div class="dash-view" id="dash-view">
        <div class="loading"><div class="spinner"></div> 加载中...</div>
      </div>
    </div>
    <div class="statusbar" id="statusbar"></div>
  `;

  $app.innerHTML = html;
  refreshDashboard();
}

async function refreshDashboard() {
  const container = document.getElementById("dash-view");
  if (!container) return;

  try {
    const data = await (window as any).pi.dashboard.getData();
    const p = await (window as any).pi.app.getPaths();
    paths = p;

    if (!data) {
      container.innerHTML = '<div class="loading" style="color:var(--accent-red)">⚠ 无法获取数据</div>';
      return;
    }

    container.innerHTML = `
      <div class="dash-grid">
        <div class="dash-card">
          <div class="dash-card-title">🤖 模型</div>
          <div class="dash-row"><span class="dash-label">提供商</span><span class="dash-value">${esc(data.modelProvider)}</span></div>
          <div class="dash-row"><span class="dash-label">模型 ID</span><span class="dash-value">${esc(data.modelId)}</span></div>
          <div class="dash-row"><span class="dash-label">上下文窗口</span><span class="dash-value">${esc(data.modelContextWindow)}</span></div>
          <div class="dash-row"><span class="dash-label">最大输出</span><span class="dash-value">${esc(data.modelMaxTokens)}</span></div>
          <div class="dash-row"><span class="dash-label">思考等级</span><span class="dash-value">${esc(data.thinkingLevel)}</span></div>
        </div>
        <div class="dash-card">
          <div class="dash-card-title">📊 会话</div>
          <div class="dash-row"><span class="dash-label">运行时间</span><span class="dash-value">${formatUptime(data.runtime)}</span></div>
          <div class="dash-row"><span class="dash-label">消息数</span><span class="dash-value">${data.messagesCount}</span></div>
          <div class="dash-row"><span class="dash-label">状态</span><span class="dash-value">${data.isIdle ? "空闲" : "响应中..."}</span></div>
        </div>
      </div>
      <div class="dash-card" style="margin-top:0;">
        <div class="dash-card-title">📁 存储路径（便携）</div>
        <div class="dash-row"><span class="dash-label">数据目录</span></div>
        <div class="dash-path">${esc(p.dataDir)}</div>
        <div class="dash-row" style="margin-top:8px;"><span class="dash-label">会话目录</span></div>
        <div class="dash-path">${esc(p.sessionsDir)}</div>
      </div>
    `;
  } catch (err: any) {
    container.innerHTML = `<div class="loading" style="color:var(--accent-red)">⚠ 加载失败: ${esc(err.message)}</div>`;
  }
}

function formatUptime(seconds: number): string {
  if (seconds < 60) return Math.floor(seconds) + "秒";
  if (seconds < 3600) return Math.floor(seconds / 60) + "分" + Math.floor(seconds % 60) + "秒";
  return Math.floor(seconds / 3600) + "时" + Math.floor((seconds % 3600) / 60) + "分";
}

function updateStatusbar() {
  const sb = document.getElementById("statusbar");
  if (!sb) return;
  const color = isLoading ? "yellow" : "green";
  const text = isLoading ? "响应中..." : "就绪";
  sb.innerHTML = `
    <span class="dot ${color}"></span>
    <span>${text}</span>
    <span class="sep">|</span>
    <span>${messages.length} 条消息</span>
    <span class="sep">|</span>
    <span>Pi Desktop</span>
  `;
}

// ─── Tab switching ─────────────────────────────────────────────
(window as any).switchTab = (tab: "chat" | "dashboard") => {
  currentTab = tab;
  render();
};

// ─── IPC 事件监听 ──────────────────────────────────────────────
function setupListeners() {
  unsubscribers.forEach((fn) => fn());
  unsubscribers = [];

  unsubscribers.push(
    (window as any).pi.chat.onDelta((data: { text: string; thinking?: boolean }) => {
      const last = messages[messages.length - 1];
      if (!last || last.role !== "assistant" || !last.streaming) {
        addMessage("assistant", data.text, true);
      } else {
        updateLastMessage(last.content + data.text);
      }
    })
  );

  unsubscribers.push(
    (window as any).pi.chat.onStart(() => {})
  );

  unsubscribers.push(
    (window as any).pi.chat.onDone(() => {
      const last = messages[messages.length - 1];
      if (last && last.role === "assistant") {
        last.streaming = false;
        renderChat();
      }
      isLoading = false;
      updateChatLoading();
    })
  );
}

// ─── Init ──────────────────────────────────────────────────────
async function init() {
  setupListeners();
  render();

  setInterval(async () => {
    if (currentTab === "dashboard") refreshDashboard();
    else updateStatusbar();
  }, 3000);
}

init();

// ─── HMR 支持 ─────────────────────────────────────────────────
if (import.meta.hot) {
  import.meta.hot.accept(() => {
    console.log("🔥 HMR updated");
  });
}
