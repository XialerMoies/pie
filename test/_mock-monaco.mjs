// Monaco mock — 仅供测试用
export default {};

const noop = () => {};

export const languages = {
  registerCompletionItemProvider: noop,
  registerHoverProvider: noop,
  registerDefinitionProvider: noop,
  registerReferenceProvider: noop,
  typescript: {
    typescriptDefaults: { setDiagnosticsOptions: noop },
    javascriptDefaults: { setDiagnosticsOptions: noop },
  },
  CompletionItemKind: {},
  setModelLanguage: noop,
};

export const editor = {
  defineTheme: noop,
  create: () => ({
    dispose: noop,
    getValue: () => "",
    setValue: noop,
    getModel: () => null,
    getSelection: () => null,
    onDidChangeModelContent: noop,
    addAction: noop,
    getAction: () => null,
    hasTextFocus: () => false,
    blur: noop,
    updateOptions: noop,
    revealLineInCenter: noop,
    setPosition: noop,
  }),
  setTheme: noop,
  setModelMarkers: noop,
  createModel: () => null,
  IStandaloneCodeEditor: {},
  IMarkerData: {},
};

export const Uri = { parse: () => ({}) };
export const Range = class { constructor() {} };
export const KeyMod = { CtrlCmd: 2048, Shift: 1024 };
export const KeyCode = { Space: 84, Tab: 18 };
export const MarkerSeverity = { Error: 8, Warning: 4, Info: 2 };
