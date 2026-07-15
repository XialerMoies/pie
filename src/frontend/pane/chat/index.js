function chatPaneRender(container) {
  container.innerHTML = [
    '<div class="sg-t">\u4F1A\u8BDD\u5386\u53F2</div>',
    '<div class="session-actions"><button class="sa-btn" onclick="newSession()">+ \u65B0\u4F1A\u8BDD</button></div>',
    '<div class="session-list" id="sl">\u52A0\u8F7D\u4E2D...</div>'
  ].join("");
  loadSessions();
}
registerPane("chat", chatPaneRender);
