/**
 * HTTP 测试辅助工具 — makeReq / makeRes
 *
 * 统一的请求/响应 mock，替代在各测试文件中重复定义。
 *
 * 使用:
 *   import { makeReq, makeRes } from "../helpers/http.mjs";
 */

/** 模拟 IncomingMessage */
export function makeReq(method, url, body) {
  const handlers = {};
  return {
    url, method,
    headers: { host: "localhost", "content-type": "application/json" },
    on(event, cb) {
      handlers[event] = cb;
      if (event === "data" && body) cb(Buffer.from(JSON.stringify(body)));
      if (event === "end") cb();
      return this;
    },
    emitClose() { if (handlers.close) handlers.close(); },
  };
}

/** 模拟 ServerResponse（基础版，无 SSE 事件） */
export function makeRes() {
  return {
    _body: "", _status: 0,
    writeHead(s, h) { this._status = s; if (h) Object.assign(this, h); return this; },
    end(d) { if (d) this._body += d; return this; },
    write() { return true; },
    on() { return this; },
  };
}

/** 模拟 ServerResponse（带 SSE close 事件支持） */
export function makeResWithEvents() {
  const res = {
    _body: "", _status: 0, _headers: {}, _closed: false, _ended: false,
    _closeHandlers: [],
    writeHead(s, h) { this._status = s; if (h) Object.assign(this._headers, h); return this; },
    end(d) { if (d) this._body += d; this._ended = true; return this; },
    write(d) { this._body += d; return true; },
    on() { return this; },
    addEventListener(event, handler) {
      if (event === "close") this._closeHandlers.push(handler);
    },
    emitClose() {
      for (const h of this._closeHandlers) h();
      this._closed = true;
    },
  };
  return res;
}
