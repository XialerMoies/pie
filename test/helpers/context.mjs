/**
 * Context 测试辅助工具 — mockCtx / mockChatCtx
 *
 * 适配新版 ServerContext（使用 runtime 替代 session + modelRegistry）
 */

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

/**
 * 通用 mock context
 * @param {object} overrides - 要覆盖的字段
 */
export function mockCtx(overrides = {}) {
  return {
    runtime: makeMockRuntime(overrides),
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
  return {
    runtime,
    paths: { APP_ROOT: root },
    chatStream: { textBuffer: "", thinkingBuffer: "", response: null, currentWorkspace: "" },
    sseClients: [],
  };
}
