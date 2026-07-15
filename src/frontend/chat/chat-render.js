function mdRender(text) {
  const md = window.marked;
  if (!md || !text) return E(text || "");
  try {
    const html = md.parse(text, { breaks: true, gfm: true });
    return html.replace(/<link[^>]*>/gi, "");
  } catch {
    return E(text);
  }
}
function shortText(value, max = 1200) {
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  if (!text) return "";
  return text.length > max ? text.slice(0, max) + "\n... truncated" : text;
}
function toolTitle(name) {
  const lower = String(name || "tool").toLowerCase().replace(/[-_]+/g, "-");
  if (lower === "search") return "\u641C\u7D22\u4EE3\u7801";
  if (lower === "file-read" || lower === "fileread") return "\u8BFB\u53D6\u6587\u4EF6";
  if (lower === "file-write" || lower === "filewrite" || lower === "apply-patch" || lower === "edit") return "\u4FEE\u6539\u6587\u4EF6";
  if (lower === "explorer-list" || lower === "explorerlist") return "\u6D4F\u89C8\u76EE\u5F55";
  if (lower === "git-status") return "\u9A8C\u8BC1\u7ED3\u679C";
  if (lower === "git-log") return "\u67E5\u770B\u63D0\u4EA4\u5386\u53F2";
  return (name || "\u5DE5\u5177").replace(/[-_]+/g, " ");
}
function traceStageLabel(t) {
  if (!t || t.type !== "tool") return "";
  const name = String(t.name || "").toLowerCase().replace(/[-_]+/g, "-");
  if (name === "search") return "\u641C\u7D22\u4EE3\u7801";
  if (name === "file-read" || name === "fileread") return "\u8BFB\u53D6\u6587\u4EF6";
  if (name === "file-write" || name === "filewrite" || name === "apply-patch" || name === "edit") return "\u4FEE\u6539\u6587\u4EF6";
  if (name === "explorer-list" || name === "explorerlist") return "\u6D4F\u89C8\u76EE\u5F55";
  if (name === "git-status") return "\u9A8C\u8BC1\u7ED3\u679C";
  if (name === "git-log") return "\u67E5\u770B\u63D0\u4EA4\u5386\u53F2";
  return "\u5DE5\u5177\u8C03\u7528";
}
function traceStageKey(t) {
  const label = traceStageLabel(t);
  if (label === "\u641C\u7D22\u4EE3\u7801") return "search";
  if (label === "\u8BFB\u53D6\u6587\u4EF6") return "read";
  if (label === "\u4FEE\u6539\u6587\u4EF6") return "write";
  if (label === "\u6D4F\u89C8\u76EE\u5F55") return "browse";
  if (label === "\u9A8C\u8BC1\u7ED3\u679C" || label === "\u67E5\u770B\u63D0\u4EA4\u5386\u53F2") return "verify";
  return "other";
}
function readTracePath(input) {
  if (!input) return "";
  if (typeof input === "string") return input.trim();
  if (typeof input !== "object") return "";
  const obj = input;
  return String(obj.path || obj.filePath || obj.root || obj.cwd || obj.query || obj.dir || obj.directory || obj.name || "").trim();
}
function traceOverviewText(trace) {
  const stages = [];
  const indexByKey = /* @__PURE__ */ new Map();
  for (const item of trace) {
    if (item.type !== "tool") continue;
    const key = traceStageKey(item);
    if (key === "other") continue;
    const label = traceStageLabel(item);
    if (indexByKey.has(key)) {
      stages[indexByKey.get(key)].count += 1;
    } else {
      indexByKey.set(key, stages.length);
      stages.push({ key, label, count: 1 });
    }
  }
  return stages.map((stage) => `${stage.label}${stage.count > 1 ? ` \xD7${stage.count}` : ""}`);
}
function traceOverview(trace) {
  if (!trace || trace.length === 0) return "";
  const labels = traceOverviewText(trace);
  if (labels.length === 0) return "";
  return `<div class="trace-overview"><span class="trace-overview-label">\u4EFB\u52A1\u8F68\u8FF9</span>${labels.map((label) => `<span class="trace-overview-chip">${E(label)}</span>`).join("")}</div>`;
}
function shouldCollapseTrace(t, output) {
  if (t.type === "thinking") return false;
  if (t.type === "tool" && t.status === "error") return false;
  return output.length > 260;
}
function traceSummaryText(t, input, output) {
  if (t.type === "thinking") return "";
  if (t.type === "tool" && t.status === "error") {
    const errorText = shortText(t.error || output || "\u5DE5\u5177\u5931\u8D25", 220);
    return errorText;
  }
  const stage = traceStageLabel(t);
  const path = readTracePath(t.input);
  if (stage === "\u641C\u7D22\u4EE3\u7801") {
    const firstLine = String(output || "").split("\n").find((line) => line.trim()) || "";
    const match = firstLine.match(/共\s*(\d+)\s*处匹配，\s*(\d+)\s*个文件/);
    if (match) return `\u627E\u5230 ${match[1]} \u5904\u5339\u914D\uFF0C${match[2]} \u4E2A\u6587\u4EF6`;
    if (path) return `\u641C\u7D22\u5173\u952E\u8BCD\uFF1A${path}`;
    return firstLine || "\u641C\u7D22\u4EE3\u7801";
  }
  if (stage === "\u8BFB\u53D6\u6587\u4EF6") {
    return path ? `\u8BFB\u53D6\u6587\u4EF6\uFF1A${path}` : "\u8BFB\u53D6\u6587\u4EF6";
  }
  if (stage === "\u4FEE\u6539\u6587\u4EF6") {
    return path ? `\u4FEE\u6539\u6587\u4EF6\uFF1A${path}` : "\u4FEE\u6539\u6587\u4EF6";
  }
  if (stage === "\u6D4F\u89C8\u76EE\u5F55") {
    return path ? `\u6D4F\u89C8\u76EE\u5F55\uFF1A${path}` : "\u6D4F\u89C8\u76EE\u5F55";
  }
  if (stage === "\u9A8C\u8BC1\u7ED3\u679C") {
    const firstLine = String(output || "").split("\n").find((line) => line.trim()) || "";
    return firstLine || "\u9A8C\u8BC1\u7ED3\u679C";
  }
  if (stage === "\u67E5\u770B\u63D0\u4EA4\u5386\u53F2") {
    return "\u67E5\u770B\u63D0\u4EA4\u5386\u53F2";
  }
  return shortText(output || input || "", 180);
}
function renderErrorCard(error) {
  const nextSteps = Array.isArray(error.nextSteps) ? error.nextSteps.filter(Boolean) : [];
  const raw = error.raw ? `<details class="msg-error-raw"><summary>\u9519\u8BEF\u8BE6\u60C5</summary><pre>${E(error.raw)}</pre></details>` : "";
  const reason = error.reason ? `<div class="msg-error-block"><div class="msg-error-label">\u53EF\u80FD\u539F\u56E0</div><div class="msg-error-text">${E(error.reason)}</div></div>` : "";
  const steps = nextSteps.length > 0 ? `<div class="msg-error-block"><div class="msg-error-label">\u4E0B\u4E00\u6B65\u64CD\u4F5C</div><ul class="msg-error-steps">${nextSteps.map((step) => `<li>${E(step)}</li>`).join("")}</ul></div>` : "";
  return `<details class="msg-error"><summary><span class="msg-error-title">${E(error.title || "\u53D1\u751F\u4E86\u9519\u8BEF")}</span><span class="msg-error-summary">${E(error.message || "\u70B9\u51FB\u67E5\u770B\u8BE6\u60C5")}</span></summary><div class="msg-error-body"><div class="msg-error-message">${E(error.message || "\u53D1\u751F\u4E86\u9519\u8BEF")}</div>${reason}${steps}${raw}<div class="msg-error-actions"><button type="button" class="msg-error-btn" onclick="App.Chat.retryLastTurn()">\u91CD\u65B0\u53D1\u9001</button><button type="button" class="msg-error-btn" onclick="App.Chat.copyLastError()">\u590D\u5236\u9519\u8BEF</button><button type="button" class="msg-error-btn" onclick="App.Chat.refreshWorkspaceState()">\u5237\u65B0\u5DE5\u4F5C\u533A</button><button type="button" class="msg-error-btn" onclick="openSettingsModal()">\u6253\u5F00\u8BBE\u7F6E</button></div></div></details>`;
}
function visibleTrace(trace) {
  if (!trace || trace.length === 0) return [];
  const compact = [];
  for (const item of trace) {
    if (item.type === "step") continue;
    if (item.type === "thinking" && item.status !== "streaming" && compact.some((t) => t.type === "thinking")) continue;
    const idx = compact.findIndex((t) => t.type === item.type && t.id === item.id);
    if (idx >= 0) compact[idx] = item;
    else compact.push(item);
  }
  const maxItems = 24;
  if (compact.length <= maxItems) return compact;
  return compact.slice(0, 8).concat([{ type: "step", status: "info", text: `\u5DF2\u6298\u53E0 ${compact.length - 16} \u4E2A\u4E2D\u95F4\u6B65\u9AA4`, id: "trace-folded" }], compact.slice(-8));
}
function hasTraceValue(value) {
  if (value === void 0 || value === null) return false;
  if (typeof value === "string") return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "object") return Object.keys(value).length > 0;
  return true;
}
function renderTraceItem(t) {
  if (t.type === "thinking") {
    const text = shortText(t.text || "\u601D\u8003\u4E2D...", 1e3);
    const status = t.status === "done" ? "done" : "streaming";
    return `<div class="trace-node trace-thinking trace-${status}"><div class="trace-dot"></div><details class="trace-thought"${status === "streaming" ? " open" : ""}><summary>Thought${status === "streaming" ? "..." : ""}</summary><div class="trace-thinking-text">${mdRender(text)}</div></details></div>`;
  }
  if (t.type === "tool") {
    const status = t.status || "running";
    const input = hasTraceValue(t.input) ? shortText(t.input, 900) : "";
    const result = t.error || t.output;
    const output = hasTraceValue(result) ? shortText(result, 1200) : "";
    const inputBlock = input ? `<div class="trace-card"><div class="trace-card-label">IN</div><pre>${E(input)}</pre></div>` : "";
    const outputLabel = t.status === "error" ? "ERROR" : "OUT";
    const outputBlock = output ? `<div class="trace-card"><div class="trace-card-label${t.status === "error" ? " error" : ""}">${outputLabel}</div><pre>${E(output)}</pre></div>` : "";
    const collapsed = shouldCollapseTrace(t, output);
    const title = toolTitle(t.name);
    const rawSummary = traceSummaryText(t, input, output);
    const summary = rawSummary !== title && (!output || collapsed || !output.includes(rawSummary)) ? rawSummary : "";
    const summaryBlock = summary ? `<div class="trace-summary-text">${E(summary)}</div>` : "";
    const head = `<div class="trace-head"><div class="trace-title"><span class="trace-summary-title">${E(title)}</span></div>${summaryBlock}</div>`;
    if (!inputBlock && !outputBlock) {
      return `<div class="trace-node trace-tool trace-${status}"><div class="trace-dot"></div>${head}</div>`;
    }
    return `<details class="trace-node trace-tool trace-${status} trace-details"${collapsed ? "" : " open"}><summary class="trace-summary"><div class="trace-dot"></div>${head}</summary><div class="trace-body">${inputBlock}${outputBlock}</div></details>`;
  }
  if (t.type === "step") {
    return `<div class="trace-node trace-step trace-${t.status || "info"}"><div class="trace-dot"></div><div class="trace-body"><div class="trace-title"><span class="trace-summary-title">${E(t.text || "")}</span></div></div></div>`;
  }
  return "";
}
function renderTrace(trace) {
  const shown = visibleTrace(trace);
  if (shown.length === 0) return "";
  const items = shown.map(renderTraceItem).filter(Boolean).join("");
  const overview = traceOverview(shown);
  return items ? `<div class="trace">${overview}${items}</div>` : "";
}
function blockId(b) {
  return String(b.blockId || `${b.type || "block"}-${b.seq || 0}`);
}
function renderEventBlock(b, blocks) {
  if (b.type === "thinking") {
    return renderTraceItem({
      type: "thinking",
      status: b.status || "streaming",
      text: b.text || "",
      id: blockId(b)
    });
  }
  if (b.type === "tool_use") {
    const result = blocks.find((item) => item.type === "tool_result" && item.toolUseId && item.toolUseId === b.toolCallId);
    const status = result ? result.isError ? "error" : "success" : b.status || "running";
    return renderTraceItem({
      type: "tool",
      status,
      name: b.name || "tool",
      input: b.input,
      output: result?.isError ? void 0 : result?.output,
      error: result?.isError ? result?.output : void 0,
      id: blockId(b)
    });
  }
  if (b.type === "tool_result") {
    const toolUse = blocks.find((item) => item.type === "tool_use" && item.toolCallId && item.toolCallId === b.toolUseId);
    if (toolUse) return "";
    return renderTraceItem({
      type: "tool",
      status: b.isError ? "error" : "success",
      name: "\u7ED3\u679C",
      output: b.isError ? void 0 : b.output,
      error: b.isError ? b.output : void 0,
      id: blockId(b)
    });
  }
  if (b.type === "step") {
    return renderTraceItem({
      type: "step",
      status: b.status || "info",
      text: b.text || "",
      id: blockId(b)
    });
  }
  return "";
}
function renderBlocks(blocks) {
  const sorted = [...blocks].sort((a, b) => a.seq - b.seq);
  const parts = [];
  let eventBlocks = [];
  const flushEvents = () => {
    if (eventBlocks.length === 0) return;
    parts.push(`<div class="trace block-trace">${eventBlocks.join("")}</div>`);
    eventBlocks = [];
  };
  for (const block of sorted) {
    const id = E(blockId(block));
    if (block.type === "text") {
      flushEvents();
      parts.push(`<div class="assistant-block block-text" data-block-id="${id}">${mdRender(block.text || "")}</div>`);
      continue;
    }
    const eventHtml = renderEventBlock(block, sorted);
    if (eventHtml) {
      eventBlocks.push(`<div class="assistant-block block-event" data-block-id="${id}">${eventHtml}</div>`);
    }
  }
  flushEvents();
  return `<div class="assistant-blocks">${parts.join("")}</div>`;
}
function renderMessage(m) {
  const c = m.role + (m.streaming ? " go" : ""), lb = m.role === "user" ? "\u4F60" : "Pi";
  const ty = m.streaming ? `<div class="ty"><span class="ty-d"></span><span class="ty-d"></span><span class="ty-d"></span></div>` : "";
  const error = m.error ? renderErrorCard(m.error) : "";
  if (m.blocks && m.blocks.length > 0) {
    return `<div class="m ${c}${m.error ? " error" : ""}"><div class="ml">${lb}</div>${error}<div class="mt block-flow">${renderBlocks(m.blocks)}</div>${ty}</div>`;
  }
  const content = m.content ? mdRender(m.content) : "";
  const think = m.thinking ? `<details class="think"><summary>\u{1F914} \u601D\u8003\u8FC7\u7A0B</summary>${mdRender(m.thinking)}</details>` : "";
  const traceHtml = renderTrace(m.trace);
  return `<div class="m ${c}${m.error ? " error" : ""}"><div class="ml">${lb}</div>${error}${think}${traceHtml}<div class="mt">${content}</div>${ty}</div>`;
}
function msgs() {
  const M = window.__state.M;
  if (M.length === 0) return '<div class="wl"><h2>Pi \u2014 \u4F60\u7684\u4EE3\u7801\u52A9\u624B</h2><p>\u5728\u4E0B\u65B9\u8F93\u5165\uFF0C\u5F00\u59CB\u7F16\u7801</p></div>';
  return M.map(renderMessage).join("\n");
}
function updateLastBlock(block) {
  const messages = window.__state.M;
  const message = messages[messages.length - 1];
  const messagesElement = $("ms");
  if (!message?.blocks?.length || !messagesElement) return false;
  const messageElements = messagesElement.querySelectorAll(".m");
  const lastMessageElement = messageElements[messageElements.length - 1];
  if (!lastMessageElement) return false;
  const flow = lastMessageElement.querySelector(".assistant-blocks");
  if (!flow) {
    const wrapper = document.createElement("div");
    wrapper.innerHTML = renderMessage(message);
    const replacement = wrapper.firstElementChild;
    if (!replacement) return false;
    lastMessageElement.replaceWith(replacement);
    return true;
  }
  const target = Array.from(flow.querySelectorAll("[data-block-id]")).find((element) => element.dataset.blockId === blockId(block));
  if (target && block.type === "text") {
    target.innerHTML = mdRender(block.text || "");
    return true;
  }
  if (target && block.type === "thinking") {
    const textElement = target.querySelector(".trace-thinking-text");
    if (textElement) {
      textElement.innerHTML = mdRender(block.text || "");
      return true;
    }
  }
  flow.outerHTML = renderBlocks(message.blocks);
  return true;
}
function appendDelta(text) {
  const M = window.__state.M;
  const msgsEl = $("ms");
  if (!msgsEl) return;
  const last = M[M.length - 1];
  if (!last) return;
  if (last.blocks && last.blocks.length > 0) {
    const textBlocks = last.blocks.filter((b) => b.type === "text");
    if (textBlocks.length > 0) {
      textBlocks[textBlocks.length - 1].text += text;
    } else {
      last.blocks.push({ type: "text", text, blockId: "text-live", seq: last.blocks.length + 1 });
    }
    updateLastBlock(textBlocks[textBlocks.length - 1] || last.blocks[last.blocks.length - 1]);
    return;
  }
  last.content += text;
  const msgDivs = msgsEl.querySelectorAll(".m");
  const lastMsg = msgDivs[msgDivs.length - 1];
  if (lastMsg) {
    const cd = lastMsg.querySelector(".mt");
    if (cd) {
      cd.innerHTML = mdRender(last.content);
      return;
    }
  }
  msgsEl.innerHTML = msgs();
}
window.msgs = msgs;
{
  const AppChat = window.App?.Chat;
  if (AppChat) {
    AppChat.msgs = msgs;
    AppChat.appendDelta = appendDelta;
    AppChat.renderTrace = renderTrace;
    AppChat.updateLastBlock = updateLastBlock;
  }
}
