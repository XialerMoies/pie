/**
 * ProblemsStore — 问题数据中心
 *
 * 统一存储来自 tsserver（及其他诊断源）的问题数据，
 * 供 Problems 面板和 Monaco markers 共同消费。
 *
 * 使用方式（全局，非 ESM）：
 *   window.__problemsStore.getProblems()
 *   window.__problemsStore.setProblems(filePath, items)
 *   window.__problemsStore.subscribe(fn)
 *
 * 数据模型：
 *   ProblemItem — 单个诊断问题，含位置/严重度/消息/来源
 */

/// <reference path="../dashboard.d.ts" />

// ─── 类型已在 dashboard.d.ts 中定义 ──────────────────────────────

// ─── Store 实现 ──────────────────────────────────────────────────

(function() {
  const _problems = new Map<string, ProblemItem[]>();
  const _listeners = new Set<() => void>();

  function _notify(): void {
    for (const fn of _listeners) {
      try { fn(); } catch { /* ignore listener errors */ }
    }
  }

  const store: ProblemsStoreAPI = {
    getProblems(): ProblemItem[] {
      const all: ProblemItem[] = [];
      for (const items of _problems.values()) {
        all.push(...items);
      }
      return all;
    },

    getProblemsForFile(filePath: string): ProblemItem[] {
      return _problems.get(filePath) || [];
    },

    setProblems(filePath: string, items: ProblemItem[]): void {
      if (items.length > 0) {
        _problems.set(filePath, items);
      } else {
        _problems.delete(filePath);
      }
      _notify();
    },

    clearFile(filePath: string): void {
      _problems.delete(filePath);
      _notify();
    },

    clear(): void {
      _problems.clear();
      _notify();
    },

    subscribe(fn: () => void): () => void {
      _listeners.add(fn);
      return () => { _listeners.delete(fn); };
    },

    getErrorCount(): number {
      let count = 0;
      for (const items of _problems.values()) {
        count += items.filter(i => i.severity === 'error').length;
      }
      return count;
    },

    getWarningCount(): number {
      let count = 0;
      for (const items of _problems.values()) {
        count += items.filter(i => i.severity === 'warning').length;
      }
      return count;
    },

    getInfoCount(): number {
      let count = 0;
      for (const items of _problems.values()) {
        count += items.filter(i => i.severity === 'info').length;
      }
      return count;
    },

    getFileCount(): number {
      return _problems.size;
    },

    getAllFiles(): string[] {
      return Array.from(_problems.keys());
    },
  };

  (window as any).__problemsStore = store;
})();
