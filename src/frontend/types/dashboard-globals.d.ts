interface Window {
  electronAPI?: ElectronAPI;
  App: AppNamespace;
  __monaco: MonacoAPI;
  __problemsStore: ProblemsStoreAPI;
  ExplorerService: typeof ExplorerService;
}

// Legacy global-script bridge. These declarations are intentionally explicit;
// module migration can remove them without changing the frontend typecheck scope.
declare const App: any;
declare function reduceFrontendSubagentEvents(values: readonly unknown[]): FrontendSubagentBatch[];

// 公共函数声明（在 HTML onclick 中用）
declare function $(id: string): HTMLElement | null;
declare function S(name: string, size?: number): string;
declare function E(s: unknown): string;
declare function confirmAsync(msg: string): Promise<boolean>;
declare function confirmCommandAsync(input: {
  command: string;
  reason: string;
  permissionSuggestions?: any[];
}): Promise<'once' | 'session' | 'workspace' | 'deny'>;
declare function confirmPermissionAsync(input: {
  source?: string;
  operation?: string;
  toolName?: string;
  toolOperations?: string[];
  riskLevel?: string;
  workspaceBounded?: boolean;
  permissionRequired?: boolean;
  root?: string;
  path?: string;
  relativePath?: string;
  reason?: string;
  permissionSuggestions?: any[];
}): Promise<'once' | 'session' | 'workspace' | 'deny'>;
declare function F(s: number): string;
declare function sb(id: string): void;
declare function toast(msg: string, type?: 'info' | 'error' | 'success'): void;
declare function registerPane(name: string, render: (container: HTMLElement) => void | (() => void)): void;
declare function tabContextMenu(e: MouseEvent, id: string): void;
declare function tabMoreMenu(e: MouseEvent): void;

// Tree widget
interface TreeNode { id: string; label: string; icon: string; isDir: boolean; children?: TreeNode[]; }
declare class Tree {
  constructor(container: HTMLElement, opts?: { indent?: number });
  setData(data: TreeNode[]): void;
  setChildren(parentId: string, children: TreeNode[]): void;
  removeNode(id: string): boolean;
  onSelect: ((node: TreeNode) => void) | null;
  onExpand: ((node: TreeNode, cb: (children?: TreeNode[]) => void) => void) | null;
  contextMenu: { label: string; action: (node: TreeNode, tree: Tree) => void; disabled?: (node: TreeNode) => boolean }[];
  blankContextMenu: { label: string; action: () => void }[];
  inlineRename(id: string, cb: (newName: string) => void, onCancel?: () => void): void;
  inlineCreate(parentId: string, isDir: boolean, onCreate: (name: string) => void): void;
  onDragMove: ((srcId: string, dstId: string) => void) | null;
  clearChildCache(): void;
  refreshExpandedChildren(): Promise<void>;
}

// ─── Token / Session Stats (from API /api/token-usage) ────────
interface TokenUsage {
  tokens: number | null;
  contextWindow: number;
  percent: number | null;
  source?: 'exact' | 'mixed' | 'estimated';
  exactTokens?: number;
  estimatedTokens?: number;
}

interface SessionStats {
  tokens?: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
  };
  cost?: number;
  totalTokens?: number;
  toolCalls?: number;
  turns?: number;
}

// ─── Explorer API item ──────────────────────────────────────────
interface ExplorerItem {
  name: string;
  path: string;
  isDir: boolean;
}

// ─── ProblemsStore Types ──────────────────────────────────────────
interface ProblemItem {
  filePath: string;
  line: number;
  column: number;
  endLine: number;
  endColumn: number;
  severity: 'error' | 'warning' | 'info';
  message: string;
  code?: string | number;
  fixCount?: number;
  source: string;      // "typescript" | "eslint" | ...
}

interface ProblemsStoreAPI {
  getProblems(): ProblemItem[];
  getProblemsForFile(filePath: string): ProblemItem[];
  setProblems(filePath: string, items: ProblemItem[]): void;
  clearFile(filePath: string): void;
  clear(): void;
  subscribe(fn: () => void): () => void;
  getErrorCount(): number;
  getWarningCount(): number;
  getInfoCount(): number;
  getFileCount(): number;
  getAllFiles(): string[];
}

// ─── Chat Attachment Types ──────────────────────────────────────
type AttachmentKind = "file" | "folder" | "clip";

interface ChatAttachment {
  id: string;
  kind: AttachmentKind;
  path: string;      // relative to workspace root
  name: string;      // display name
  // clip only
  startLine?: number;
  endLine?: number;
  // folder only
  fileCount?: number;
  totalBytes?: number;
  truncated?: boolean;
}

// ExplorerService
declare class ExplorerService {
  static fetchDir(root: string, path: string): Promise<{ items: ExplorerItem[]; rootDir: string; relativePath: string }>;
  static getWorkspacePath(): string;
  static setWorkspacePath(p: string): void;
  static selectWorkspace(): Promise<string | null>;
  static applyWorkspace(): Promise<void>;
  static iconFor(name: string, dir: boolean): string;
  static toTreeNodes(items: ExplorerItem[]): TreeNode[];
  static _makeRefreshKey(items: TreeNode[], workspacePath?: string): string;
  static markDeleted(path: string): void;
  static clearDeletedMark(path: string): void;
  static reconcilePendingDeletes(parentPath: string, nodes: TreeNode[]): TreeNode[];
  static filterPendingDeletedNodes(nodes: TreeNode[]): TreeNode[];
  static fileOp(op: 'new' | 'rename' | 'delete' | 'move', root: string, path: string, newPath?: string): Promise<void>;
  static _setTree(t: Tree | null): void;
  static _getTree(): Tree | null;
  static refreshTree(): Promise<void>;
}
