/**
 * Context 测试辅助工具 — mockCtx / mockChatCtx
 *
 * 适配新版 ServerContext（使用 runtime 替代 session + modelRegistry）
 */

import { PiAgentEngineAdapter } from "../../src/agent-engine/index.ts";

function makeMockRuntime(overrides = {}) {
  const cwd = overrides.cwd || "/test";
  return {
    session: {
      model: {},
      _cwd: cwd,
      reload: async () => {},
      sessionManager: {
        getSessionId: () => "sess-" + Date.now().toString(36),
      },
      prompt: async () => {},
      dispose: () => {},
      abort: async () => {},
      subscribe: () => () => {},
      get state() { return { messages: [] }; },
    },
    modelRegistry: {},
    currentWorkspace: cwd,
    switchWorkspace: async (ws) => {},
    onEvent: () => () => {},
    dispose: () => {},
  };
}

export function withServerGroups(context) {
  context.engine ||= new PiAgentEngineAdapter(context.runtime);
  context.groups = {
    core: {
      get engine() { return context.engine; },
      get runtime() { return context.runtime; },
      get chatStream() { return context.chatStream; },
      get appEvents() { return context.appEvents || { publish() {} }; },
      get recordUserNote() { return context.recordUserNote; },
      get skillService() { return context.skillService; },
    },
    security: {
      get config() { return context.security; },
      get permissionService() { return context.permissionService; },
      get rootRegistry() { return context.rootRegistry; },
      get permissionMode() { return context.permissionMode; },
    },
    storage: {
      get paths() { return context.paths; },
      get workspaceLock() { return context.workspaceLock; },
    },
    providers: {
      get customProviderService() { return context.customProviderService; },
      get providerReferenceLock() { return context.providerReferenceLock; },
      model: {
        get modelRuntime() { return context.runtime.modelRuntime; },
        get modelRegistry() { return context.runtime.modelRegistry; },
        syncModelProviders: (...args) => context.runtime.syncModelProviders?.(...args) || Promise.resolve(0),
        runWithStableSession: (operation) => context.runtime.runWithStableSession(operation),
      },
    },
    infra: {
      get tsServer() { return context.tsServer; },
      get observability() { return context.observability; },
    },
  };
  return context;
}

/**
 * 通用 mock context
 * @param {object} overrides - 要覆盖的字段
 */
export function mockCtx(overrides = {}) {
  const runtime = overrides.runtime || makeMockRuntime(overrides);
  const context = {
    runtime,
    engine: new PiAgentEngineAdapter(runtime),
    chatStream: { textBuffer: "", thinkingBuffer: "", response: null, currentWorkspace: "" },
    sseClients: [],
    paths: {
      APP_ROOT: "/test",
      DATA_DIR: "/test/data",
      PI_CONFIG_DIR: "/test/data/pi",
      SESSIONS_DIR: "/test/data/pi/sessions",
      SETTINGS_FILE: "/test/data/pi/settings.json",
      FRONTEND_DIR: "/test/dist/frontend",
      FRONTEND_SRC_DIR: "/test/src/frontend",
      HAS_BUILT_FRONTEND: false,
    },
    ...overrides,
  };
  return withServerGroups(context);
}

/**
 * 聊天测试专用的 mock context
 * 捕获 runtime.session.prompt 的参数
 * @param {Array} captured - 用于收集 prompt 参数的数组
 * @param {string} root - APP_ROOT 路径
 */
export function mockChatCtx(captured = [], root = "/test") {
  const runtime = makeMockRuntime({ cwd: root });
  runtime.session.prompt = async (msg) => { captured.push(msg); };
  return withServerGroups({
    runtime,
    engine: new PiAgentEngineAdapter(runtime),
    paths: { APP_ROOT: root },
    chatStream: { textBuffer: "", thinkingBuffer: "", response: null, currentWorkspace: "" },
    sseClients: [],
  });
}
